/**
 * dsh-inherit-compression · 继承功能（宿主半边）
 *
 * 挂在 retrace 自己的 apply 末尾：lib/index.js 调 mountInherit(ctx, { markerWriter, log })。
 *
 * 干的事：
 *   ① 锚点：点「继承」时记下那条消息的 seq
 *   ② 盯线：每轮结束量一次上下文，到线就动手
 *   ③ 压缩：只把锚点之后新增的对话交给你指定的模型和你自己的提示词压成一块记忆
 *   ④ 撤回：走 retrace 的 marker 写入器（审计段 + 载体段成对落盘、官方令牌记账），
 *      把那段从对话面上原地换成这块记忆。不切分支、不新建会话。
 *   ⑤ 注入：「最近 N 轮原文」在压完之后贴到你下一条消息的最前面，用一次就清
 *   ⑥ 排队：压缩没写完之前，同一会话的新请求在 pre-step 里等着，不拒收也不丢
 */
import { dataRoot, loadState, saveState, rootOf, newRoot, log, logPath, readLogTail, trimLog } from './inherit-store.js'
import { compressBlock, flattenMessages, DEFAULT_PROMPT } from './inherit-compress.js'
import { runBootSlim } from './slim.js'
import { sessionFilePath } from './platform/session-paths.js'
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 注入块末尾那句指令的内置版（用户可在设置里改，留空就回到这一版）。 */
const DEFAULT_INJECT_PROMPT = '以上是你与对方近期的对话记录，下面是对方当前发送的消息。请结合注入的记忆和近期对话，自然延续此前的交流。在保持核心人设的基础上，根据后续经历、关系变化及记忆内容动态更新和调整当前人设，并严格仿照近期对话中的说话方式、语气和表达习惯，给出符合当前情境的回答。'

const DEFAULTS = {
  triggerTokens: 600000,
  hardCapTokens: 900000,
  maxBlockChars: 4000,
  recentRounds: 5,
  recentCharsPerRound: 500,
  pollMs: 3000,
  tag: '[记忆注入]',
  prompt: DEFAULT_PROMPT,
  injectPrompt: DEFAULT_INJECT_PROMPT,
  provider: '',
  model: '',
}

const LIMITS = {
  maxBlockChars: { min: 500, max: 100000 },
  recentRounds: { min: 0, max: 300 },
  recentCharsPerRound: { min: 50, max: 5000 },
  triggerTokens: { min: 1000, max: 10000000 },
}

const ROUTE_BASE = '/dsh-inherit-compression/api'

/** 构建标记：每次改都抬一手，日志里能看出跑的是哪一版。 */
const BUILD = 'inherit-70'

/** 进程级单例钥匙：热重载时用它找到上一份实例并拆掉。 */
const SINGLETON = Symbol.for('dsh-inherit-compression.singleton')

/** 取整数并夹到区间内；不是数字就返回 null（调用方保留旧值）。 */
function clampInt(value, { min, max }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * 挂上继承功能。任何异常都内部吃掉——这里在 retrace 的 apply 里跑，
 * 抛出去会把整个 retrace 判成激活失败，整台应用都起不来。
 */
export function mountInherit(ctx, deps = {}) {
  try {
    const previous = globalThis[SINGLETON]
    if (previous && typeof previous.dispose === 'function') {
      try { previous.dispose() } catch (e) { log('MOUNT_PREV_DISPOSE_FAIL', String((e && e.message) || e)) }
      log('MOUNT_REPLACE', '上一份继承实例已卸下（宿主热重载）')
    }
    globalThis[SINGLETON] = null
    const handle = mountInner(ctx, deps)
    globalThis[SINGLETON] = handle
    try {
      ctx.effect(() => () => {
        try { handle.dispose() } catch { /* 卸载失败就算了 */ }
        if (globalThis[SINGLETON] === handle) globalThis[SINGLETON] = null
      })
    } catch { /* 没有 effect 就靠下次热重载时拆 */ }
  } catch (error) {
    log('MOUNT_FATAL', (error && error.stack) || String(error))
  }
}

function mountInner(ctx, deps) {
  const writer = deps.markerWriter || null
  const state = loadState()
  const disposers = []
  const busy = new Set()
  let disposed = false

  /**
   * 压缩闸：压缩没写完之前，同一会话的请求在 pre-step 里排队等，不放行也不拒绝。
   * 拒收在宿主那边就是一句 Reject、没有文案，你发的话会像被吞掉；排队则是
   * 「压缩中，先等着」，既不丢字，也不会跟正在改写的对话面抢日志。
   */
  const gates = new Map()

  function openGate(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '' || gates.has(id)) return
    let release = () => {}
    const promise = new Promise((resolve) => { release = resolve })
    gates.set(id, { promise, release })
  }

  function closeGate(sessionId) {
    const id = String(sessionId ?? '')
    const gate = gates.get(id)
    if (!gate) return
    gates.delete(id)
    try { gate.release() } catch { /* 忽略 */ }
  }

  const svc = (name) => { try { return ctx.get?.(name) ?? null } catch { return null } }
  const persist = () => { try { saveState(state) } catch (e) { log('SAVE_FAIL', String((e && e.message) || e)) } }

  /**
   * 登记"这条会话有东西可以瘦身"。
   *
   * 压缩时**不碰文件**——只记一笔，等下次启动、会话还没被打开的时候再去改。
   * 会话活着的时候改日志会跟宿主内存里的序号/表面分家，重启必判损坏（实测三条会话）。
   */
  function markSlimPending(sessionId) {
    try {
      if (!state.pendingSlim || typeof state.pendingSlim !== 'object' || Array.isArray(state.pendingSlim)) state.pendingSlim = {}
      state.pendingSlim[String(sessionId)] = { at: Date.now(), build: BUILD, attempts: 0 }
      log('SLIM_PENDING', `session=${String(sessionId)} 下次启动时瘦身`)
    } catch (e) { log('SLIM_PENDING_FAIL', String((e && e.message) || e)) }
  }

  const cur = () => {
    const s = state.settings || {}
    return {
      triggerTokens: Number(s.triggerTokens ?? DEFAULTS.triggerTokens),
      hardCapTokens: Number(s.hardCapTokens ?? DEFAULTS.hardCapTokens),
      maxBlockChars: clampInt(s.maxBlockChars ?? DEFAULTS.maxBlockChars, LIMITS.maxBlockChars),
      recentRounds: clampInt(s.recentRounds ?? DEFAULTS.recentRounds, LIMITS.recentRounds),
      recentCharsPerRound: clampInt(s.recentCharsPerRound ?? DEFAULTS.recentCharsPerRound, LIMITS.recentCharsPerRound),
      provider: s.provider ?? DEFAULTS.provider,
      model: s.model ?? DEFAULTS.model,
      prompt: s.prompt ?? DEFAULTS.prompt,
      injectPrompt: s.injectPrompt ?? DEFAULTS.injectPrompt,
      tag: s.tag ?? DEFAULTS.tag,
    }
  }

  const estTokens = (text) => (typeof text === 'string' ? Math.ceil(text.length * 0.95) : 0)

  // ── 启动清扫：抹僵尸快照、删空记录、日志截断 ────────────────
  try {
    if (trimLog(200 * 1024)) log('LOG_TRIM', '日志超过上限，保留最后一半')
    // 旧版本每压一次会留一个 recent-<会话>.txt，现已废弃：启动时顺手清掉
    try {
      for (const name of readdirSync(dataRoot())) {
        if (!name.startsWith('recent-') || !name.endsWith('.txt')) continue
        try { unlinkSync(join(dataRoot(), name)) } catch { /* 忽略 */ }
      }
    } catch { /* 目录还没有就算了 */ }
    let dropped = 0
    let cleaned = 0
    for (const id of Object.keys(state.roots)) {
      const r = state.roots[id]
      if (r && typeof r.chain === 'string' && r.chain !== '') {
        r.chain = ''
        cleaned += 1
      }
      if (r && r.recentPending !== true && typeof r.recent === 'string' && r.recent !== '') {
        r.recent = ''
        cleaned += 1
      }
      if (r && r.recentPending === true) {
        const at = Number(r.recentAt ?? 0)
        if (at > 0 && Date.now() - at > 2 * 60 * 60 * 1000) {
          r.recent = ''
          r.recentPending = false
          cleaned += 1
        }
      }
      const hasRecent = typeof r?.recent === 'string' && r.recent.trim() !== ''
      if (r?.enabled === true || hasRecent) continue
      delete state.roots[id]
      dropped += 1
    }
    if (dropped > 0 || cleaned > 0) {
      saveState(state)
      log('STATE_PRUNE', `抹掉 ${cleaned} 份旧摘要副本，清掉 ${dropped} 条空记录`)
    }
  } catch { /* 清扫失败不影响功能 */ }

  log('MOUNT', `build=${BUILD} writer=${writer ? 'ok' : 'missing'} trigger=${cur().triggerTokens}`)

  // ── 启动前瘦身：把上次压缩留下的、已经不参与上下文的正文换成占位 ──────
  // 必须在会话被打开之前跑；跑的时候再判一次"这条会话现在开着没有"，开着就跳过。
  try {
    setTimeout(() => {
      let sessions = null
      try { sessions = ctx.get?.('sessions') ?? null } catch { sessions = null }
      void runBootSlim({
        state,
        persist,
        log,
        sessions,
        sessionFilePath: (id) => sessionFilePath(id),
        backupsDir: join(dataRoot(), 'backups'),
      }).catch((e) => log('SLIM_BOOT_CRASH', String((e && e.stack) || e)))
    }, 300)
  } catch (e) { log('SLIM_BOOT_ARM_FAIL', String((e && e.message) || e)) }

  // ── 基础读取 ────────────────────────────────────────────
  function eventsOf(session) {
    try {
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() || []
    } catch (e) { log('EVENTS_FAIL', String((e && e.message) || e)) }
    return Array.isArray(session.events) ? session.events : []
  }

  function messageOf(session, event) {
    try { return session.deriveEventMessage?.(event) ?? null } catch { return null }
  }

  function surfaceSeqs(session) {
    const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
    return nodes.map((seq) => Number(seq))
  }

  function seqOfMessage(session, messageId) {
    const want = String(messageId ?? '')
    if (!session || want === '') return null
    const events = eventsOf(session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const msg = messageOf(session, events[i])
      if (msg && String(msg.id ?? '') === want) return Number(events[i].seq)
    }
    return null
  }

  /** /state 里最多带多少条"锚点之后的 id"（避免快照过大）。 */
  const AFTER_IDS_MAX = 200

  /**
   * 锚点之后那些消息的 id（客户端据此判断按钮该不该出现），以及最新一条助手回复的 id。
   * 一遍建映射、一遍扫表面，并按"事件数+表面数+锚点"缓存——别退回 O(n²)。
   */
  const idsCache = new WeakMap()
  function idsAfterAnchor(session, anchorSeq) {
    const seqs = surfaceSeqs(session)
    const events = eventsOf(session)
    const sig = `${events.length}:${seqs.length}:${Number(anchorSeq)}`
    const hit = idsCache.get(session)
    if (hit && hit.sig === sig) return hit.value

    const idBySeq = new Map()
    for (const ev of events) {
      const seq = Number(ev?.seq)
      if (!Number.isSafeInteger(seq) || idBySeq.has(seq)) continue
      const msg = messageOf(session, ev)
      const id = msg && msg.id !== undefined ? String(msg.id) : ''
      if (id !== '') idBySeq.set(seq, id)
    }

    const afterIds = []
    let seen = false
    for (const seq of seqs) {
      if (!seen) {
        if (seq === Number(anchorSeq)) seen = true
        continue
      }
      const id = idBySeq.get(seq)
      if (id) afterIds.push(id)
    }

    const surfaceSet = new Set(seqs)
    let tailMessageId = ''
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (String(ev?.type ?? '') !== 'assistant/message') continue
      if (surfaceSet.size > 0 && !surfaceSet.has(Number(ev.seq))) continue
      const msg = messageOf(session, ev)
      const id = msg && msg.id !== undefined ? String(msg.id) : ''
      if (id !== '') { tailMessageId = id; break }
    }

    const value = {
      afterIds: afterIds.length > AFTER_IDS_MAX ? afterIds.slice(-AFTER_IDS_MAX) : afterIds,
      tailMessageId,
    }
    idsCache.set(session, { sig, value })
    return value
  }

  /** 我们自己写进去的脚手架事件（记账段 / 记忆载体），不算真实消息。 */
  function isOurScaffold(event) {
    if (!event) return false
    if (String(event.type ?? '') === 'compaction/prune') return true
    const src = event.data && event.data.source
    return !!(event.type === 'user/message' && src && src.kind === 'model')
  }

  /**
   * 锚点之后、还没被换掉的表面节点 → 一个合法的 span。
   * shadowedSeqs 必须是「位置连续段」，首尾分别是 start/end。
   */
  function tailSpanAfter(session, cursorSeq) {
    const seqs = surfaceSeqs(session)
    if (seqs.length === 0) return null
    const at = seqs.indexOf(Number(cursorSeq))
    const slice = at >= 0 ? seqs.slice(at + 1) : seqs.filter((seq) => seq > Number(cursorSeq))
    if (slice.length === 0) return null
    return { start: slice[0], end: slice[slice.length - 1], shadowedSeqs: slice }
  }

  /**
   * 把一串事件拍平成文本，喂给压缩模型。
   * 上次那条记忆摘要要算进输入（标成【此前的记忆摘要】），模型才不会断片。
   */
  function textOf(session, seqs) {
    const bySeq = new Map()
    for (const ev of eventsOf(session)) {
      if (ev && Number.isSafeInteger(Number(ev.seq))) bySeq.set(Number(ev.seq), ev)
    }
    const pieces = []
    for (const seq of seqs) {
      const ev = bySeq.get(Number(seq))
      if (!ev) continue
      if (String(ev.type ?? '') === 'compaction/prune') continue
      const msg = messageOf(session, ev)
      if (!msg) continue
      const flat = flattenMessages([msg])
      if (flat.trim() === '') continue
      pieces.push(isOurScaffold(ev) ? `【此前的记忆摘要】\n${flat}` : flat)
    }
    return pieces.join('\n\n')
  }

  /** 锚点那条消息还在对话面上吗？ */
  function anchorStillVisible(root) {
    try {
      const session = svc('sessions')?.get?.(root.rootId)
      if (!session) return true
      const seqs = surfaceSeqs(session)
      if (seqs.length === 0) return true
      return seqs.indexOf(Number(root.anchorSeq)) >= 0
    } catch {
      return true
    }
  }

  /** 锚点被别的操作遮蔽了 → 直接关掉继承（返回是否刚关掉）。 */
  function dropIfAnchorGone(root) {
    if (anchorStillVisible(root)) return false
    root.enabled = false
    persist()
    log('ANCHOR_GONE', `session=${root.rootId} 锚点 ${root.anchorSeq} 已不在对话面上，自动关闭继承`)
    return true
  }

  /** 宿主每轮追加上来的运行环境快照：属于系统话，不是人设样本。 */
  function isRuntimeBlock(text) {
    return /^Current runtime context\./i.test(String(text ?? '').trim())
  }

  function plainTextOf(message) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    const parts = []
    for (const block of blocks) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('')
  }

  function normText(text) {
    return String(text ?? '').replace(/\s+/g, '')
  }

  /** 截断尽量落在句读上，别把半句话塞给模型。 */
  function clipAtSentence(text, max) {
    if (typeof text !== 'string' || text === '') return ''
    if (!Number.isFinite(max) || max <= 0) return ''
    if (text.length <= max) return text
    const head = text.slice(0, max)
    let cut = -1
    for (const mark of ['。', '！', '？', '!', '?', '\n', '；', ';', '…']) {
      const at = head.lastIndexOf(mark)
      if (at > cut) cut = at
    }
    if (cut >= Math.floor(max * 0.5)) return `${head.slice(0, cut + 1)}…`
    return `${head}…`
  }

  /**
   * 本会话的「出生时间」（会话头事件的 createdAt）。
   *
   * 为什么需要：从别的会话派生出来的会话（fork/复制历史）日志里会抄着父会话的旧事件，
   * 时间戳还是父会话那会儿的。取材时把它们当成本会话的「近期对话」，就会看着像
   * 两个会话的对话混在一起。拿创建时间当界线，旧事件自然被排除。
   * 取不到就返回 0（等于不过滤，宁可照旧也别把功能卡死）。
   */
  function sessionStartedAt(session) {
    try {
      for (const ev of eventsOf(session)) {
        if (String(ev?.type ?? '') === 'session' && Number.isFinite(Number(ev.createdAt))) {
          return Number(ev.createdAt)
        }
      }
    } catch { /* 取不到就算了 */ }
    return 0
  }

  /**
   * 取「最近 N 轮对话的正文」快照，给注入用。
   * 这些消息很快就要被撤回、面上不再有，只能现在存一份。
   * 规则：每轮正文截到 500 字，合计最多 N×500 字；一轮 = 一条真实用户输入 + 它后面的产出。
   */
  function recentRoundsOf(session, seqs, { rounds = 5, perRound = 500, total = null } = {}) {
    const cap = total === null ? Math.max(0, Math.floor(rounds) * perRound) : total
    const bornAt = sessionStartedAt(session)
    try {
      const bySeq = new Map()
      for (const ev of eventsOf(session)) {
        if (ev && Number.isSafeInteger(Number(ev.seq))) bySeq.set(Number(ev.seq), ev)
      }
      const buckets = []
      let current = null
      let skippedForeign = 0
      for (const seq of seqs) {
        const ev = bySeq.get(Number(seq))
        if (!ev || isOurScaffold(ev)) continue
        // 派生会话里抄来的旧事件（时间早于本会话创建）不算「本会话的近期对话」
        if (bornAt > 0 && Number.isFinite(Number(ev.time)) && Number(ev.time) < bornAt) { skippedForeign += 1; continue }
        if (ev.type === 'user/message' && ((ev.data && ev.data.source && ev.data.source.kind) || '') !== 'user') continue
        const startsRound = ev.type === 'user/message' && ev.data != null && ev.data.source != null && ev.data.source.kind === 'user'
        if (current === null || startsRound) {
          current = []
          buckets.push(current)
        }
        const msg = messageOf(session, ev)
        if (msg && isRuntimeBlock(plainTextOf(msg))) continue
        if (msg) current.push(msg)
      }

      const texts = []
      for (const parts of buckets) {
        const text = flattenMessages(parts, { tools: false, compact: true }).trim()
        if (text === '') continue
        texts.push(clipAtSentence(text, perRound))
      }

      const picked = texts.slice(Math.max(0, texts.length - rounds))
      const out = []
      let used = 0
      for (const text of picked) {
        if (used >= cap) break
        const piece = clipAtSentence(text, cap - used)
        out.push(piece)
        used += piece.length
      }
      // 轮与轮之间空一行：太密了看不清谁跟谁是一轮
      if (skippedForeign > 0) {
        log('RECENT_SKIP_FOREIGN', `跳过 ${skippedForeign} 条派生会话带来的旧事件（时间早于本会话创建，bornAt=${bornAt}）`)
      }
      return out.join('\n\n')
    } catch (e) {
      log('RECENT_FAIL', (e && e.stack) || String(e))
      return ''
    }
  }

  function routeOf(session) {
    const s = cur()
    if (s.provider && s.model) return { provider: s.provider, model: s.model }
    try {
      const h = session?.requestHeader?.()
      const cfg = h && h.config
      if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    } catch { /* 用默认 */ }
    try {
      const sel = svc('agentDefaultModel')?.currentSelection?.()
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch { /* 认命 */ }
    return null
  }

  function pressureOf(session) {
    const meter = svc('tokenMeter')
    if (!meter || !session) return null
    try {
      const p = meter.contextPressure?.(session)
      if (p && typeof p.pressureTokens === 'number') return p.pressureTokens
      const m = meter.measure?.(session)
      if (m && typeof m.totalTokens === 'number') return m.totalTokens
    } catch (e) { log('METER_FAIL', String((e && e.message) || e)) }
    return null
  }

  function writeCarrier(session, target, body) {
    return writer.writeMarker(session, target, {
      op: 'recall',
      targetSeq: target.start,
      originalText: '',
      content: [{ type: 'text', text: body }],
      // 用户点「继承」就是显式发起：放行大幅遮蔽的业务闸
      explicitUserTarget: true,
      userInitiated: true,
    })
  }

  // ── 到线自动压：锚点之后整段 ──────────────────────────────
  async function compressOnce(sessionId) {
    const root = rootOf(state, sessionId)
    if (!root || !root.enabled) return { ok: false, error: '这条会话没有在继承' }
    if (busy.has(root.rootId)) return { ok: false, error: '正在压，别催' }
    if (!writer) return { ok: false, error: '写入器没装配，没法撤回' }

    const session = svc('sessions')?.get?.(root.rootId)
    if (!session) return { ok: false, error: '这个会话现在没活着' }

    const anchorSeq = Number.isFinite(Number(root.anchorSeq)) ? Number(root.anchorSeq) : 0
    const cursor = Number.isFinite(Number(root.cursorSeq)) ? Number(root.cursorSeq) : anchorSeq
    // 每次都以锚点为起点：上一次注入的记忆块也要一起撤回（内容已并进这次的输入）
    const span = tailSpanAfter(session, anchorSeq)
    if (!span) return { ok: false, error: '锚点之后没有内容可压' }

    const llm = svc('llm')
    if (!llm) return { ok: false, error: '没有模型服务' }
    const route = routeOf(session)
    if (!route) return { ok: false, error: '拿不到可用的模型路由，先去会话里选一个模型' }

    busy.add(root.rootId)
    openGate(root.rootId)
    try {
      const pressure = pressureOf(session)
      if (pressure !== null && pressure >= cur().hardCapTokens) {
        try { svc('toolResultPruner')?.pruneSession?.(session) } catch (e) { log('PRUNE_FAIL', String((e && e.message) || e)) }
      }

      const text = textOf(session, span.shadowedSeqs)
      if (text.trim() === '') {
        log('COMPRESS_EMPTY', `root=${root.rootId} span=${span.start}..${span.end}`)
        return { ok: false, error: '锚点之后没有文字可压' }
      }

      log('COMPRESS_START', `root=${root.rootId} span=${span.start}..${span.end} nodes=${span.shadowedSeqs.length} chars=${text.length} model=${route.provider}/${route.model}`)

      const block = await compressBlock(llm, {
        provider: route.provider,
        model: route.model,
        prompt: cur().prompt,
        prevBlock: '',
        text,
        maxChars: cur().maxBlockChars,
      })

      // 压缩期间你可能又发了消息：只撤「开始那一刻」的快照，后来的一律不动
      const after = tailSpanAfter(session, anchorSeq)
      const newcomers = after ? Math.max(0, after.shadowedSeqs.length - span.shadowedSeqs.length) : 0

      let carrier = null
      let used = span
      try {
        carrier = await writeCarrier(session, span, `${cur().tag}\n${block}`)
      } catch (firstError) {
        const altSeqs = span.shadowedSeqs.filter((seq) => Number(seq) > cursor)
        const alt = altSeqs.length > 0
          ? { start: altSeqs[0], end: altSeqs[altSeqs.length - 1], shadowedSeqs: altSeqs }
          : null
        if (!alt) throw firstError
        log('COMPRESS_RETRY', `整段替换被拒（${String((firstError && firstError.message) || firstError)}），退回只撤上一次之后`)
        carrier = await writeCarrier(session, alt, `${cur().tag}\n${block}`)
        used = alt
      }

      if (newcomers > 0) log('COMPRESS_NEWCOMERS', `root=${root.rootId} 压缩期间新增 ${newcomers} 个节点，一律不撤`)

      const recent = recentRoundsOf(session, used.shadowedSeqs, { rounds: cur().recentRounds, perRound: cur().recentCharsPerRound })

      root.chain = ''
      root.recent = recent
      root.recentPending = true
      root.recentAt = Date.now()
      root.cursorSeq = Number(carrier && carrier.seq !== undefined ? carrier.seq : used.end)
      root.lastCompressedAt = Date.now()
      root.compressions = (root.compressions || 0) + 1
      // 到线自动压这条一定调了模型：记时间戳，客户端据此弹那条 5 秒提示
      root.lastModelCompressAt = root.lastCompressedAt
      markSlimPending(root.rootId)
      persist()

      log('COMPRESS_DONE', `root=${root.rootId} blockChars=${block.length} 撤回 ${used.shadowedSeqs.length} 节点 recentChars=${recent.length} cursor=${root.cursorSeq}`)
      return { ok: true, blockChars: block.length, removedNodes: used.shadowedSeqs.length, cursorSeq: root.cursorSeq }
    } catch (e) {
      log('COMPRESS_FAIL', (e && e.stack) || String(e))
      return { ok: false, error: String((e && e.message) || e) }
    } finally {
      busy.delete(root.rootId)
      closeGate(root.rootId)
    }
  }

  // ── d 类按钮：立刻把锚点之后整段收一次 ────────────────────
  async function trimNow(sessionId) {
    const root = rootOf(state, sessionId)
    if (!root || !root.enabled) return { ok: false, error: '这条会话没有在继承' }
    if (busy.has(root.rootId)) return { ok: false, error: '正在压，别催' }
    if (!writer) return { ok: false, error: '写入器没装配，没法撤回' }

    const session = svc('sessions')?.get?.(root.rootId)
    if (!session) return { ok: false, error: '这个会话现在没活着' }

    const anchorSeq = Number.isFinite(Number(root.anchorSeq)) ? Number(root.anchorSeq) : 0
    const all = tailSpanAfter(session, anchorSeq)
    if (!all) return { ok: false, error: '锚点之后没有内容' }

    const bySeq = new Map()
    for (const ev of eventsOf(session)) {
      if (ev && Number.isSafeInteger(Number(ev.seq))) bySeq.set(Number(ev.seq), ev)
    }
    const real = all.shadowedSeqs.filter((seq) => {
      const ev = bySeq.get(Number(seq))
      return ev && !isOurScaffold(ev)
    })
    if (real.length === 0) return { ok: false, error: '锚点之后没有可压的消息' }

    const limit = clampInt(cur().recentRounds, LIMITS.recentRounds)
    if (limit === null || limit <= 0) {
      return { ok: false, error: '设置里的「近期对话条数」是 0，没有可搬可压的内容；先把它调大' }
    }

    // 红色按钮 = 整段收一次；条数只决定用哪种做法：不超过就原样搬，超过就压成摘要
    const useRaw = real.length <= limit
    const span = all
    const llm = svc('llm')

    busy.add(root.rootId)
    openGate(root.rootId)
    try {
      if (useRaw) {
        const raw = textOf(session, span.shadowedSeqs)
        if (raw.trim() === '') return { ok: false, error: '这几条里没有文字可搬' }
        log('TRIM_RAW', `root=${root.rootId} 取材=${real.length} 条 chars=${raw.length}（条数以内，原样搬，不调模型）`)
        // 只撤开始那一刻的快照：期间新进来的消息一律不动
        const after = tailSpanAfter(session, anchorSeq)
        const newcomers = after ? Math.max(0, after.shadowedSeqs.length - span.shadowedSeqs.length) : 0
        if (newcomers > 0) log('TRIM_NEWCOMERS', `root=${root.rootId} 期间新增 ${newcomers} 个节点，一律不撤`)
        const carrier = await writeCarrier(session, span, raw)

        root.chain = ''
        root.recent = ''
        root.recentPending = false
        root.cursorSeq = Number(carrier && carrier.seq !== undefined ? carrier.seq : span.end)
        root.lastCompressedAt = Date.now()
        root.compressions = (root.compressions || 0) + 1
        persist()

        log('TRIM_RAW_DONE', `root=${root.rootId} 放入 ${real.length} 条原文 撤回 ${span.shadowedSeqs.length} 节点 chars=${raw.length}`)
        return { ok: true, raw: true, picked: real.length, removedNodes: span.shadowedSeqs.length, chars: raw.length }
      }

      if (!llm) return { ok: false, error: '没有模型服务' }
      const route = routeOf(session)
      if (!route) return { ok: false, error: '拿不到可用的模型路由，先去会话里选一个模型' }

      const text = textOf(session, span.shadowedSeqs)
      if (text.trim() === '') return { ok: false, error: '这几条里没有文字可压' }

      log('TRIM_START', `root=${root.rootId} span=${span.start}..${span.end} 取材=${real.length} 条 chars=${text.length}`)

      const block = await compressBlock(llm, {
        provider: route.provider,
        model: route.model,
        prompt: cur().prompt,
        prevBlock: '',
        text,
        maxChars: cur().maxBlockChars,
      })

      const late = tailSpanAfter(session, anchorSeq)
      const lateCount = late ? Math.max(0, late.shadowedSeqs.length - span.shadowedSeqs.length) : 0
      if (lateCount > 0) log('TRIM_NEWCOMERS', `root=${root.rootId} 压缩期间新增 ${lateCount} 个节点，一律不撤`)

      const carrier = await writeCarrier(session, span, `${cur().tag}\n${block}`)

      root.chain = ''
      root.recent = recentRoundsOf(session, real, { rounds: cur().recentRounds, perRound: cur().recentCharsPerRound })
      root.recentPending = true
      root.recentAt = Date.now()
      root.cursorSeq = Number(carrier && carrier.seq !== undefined ? carrier.seq : span.end)
      root.lastCompressedAt = Date.now()
      root.compressions = (root.compressions || 0) + 1
      root.lastModelCompressAt = root.lastCompressedAt
      markSlimPending(root.rootId)
      persist()

      log('TRIM_DONE', `root=${root.rootId} blockChars=${block.length} 撤回 ${span.shadowedSeqs.length} 节点 recentChars=${root.recent.length}`)
      return { ok: true, blockChars: block.length, removedNodes: span.shadowedSeqs.length, picked: real.length }
    } catch (e) {
      log('TRIM_FAIL', (e && e.stack) || String(e))
      return { ok: false, error: String((e && e.message) || e) }
    } finally {
      busy.delete(root.rootId)
      closeGate(root.rootId)
    }
  }

  // ── 动作 ────────────────────────────────────────────────
  /**
   * 锚点消息属于第几轮（按 turn/start 计，从 1 开始）。
   * 客户端跳锚点时靠这个数字去认 DOM 那一行：聊天气泡上带着 data-chat-turn，
   * 比"按 key 反查"稳得多（key 是内部结构，换个版本就变）。
   */
  function turnOfSeq(session, seq) {
    try {
      let turn = 0
      const events = eventsOf(session)
      for (const ev of events) {
        if (!ev) continue
        if (ev.type === 'turn/start') turn += 1
        if (Number(ev.seq) === Number(seq)) return turn > 0 ? turn : null
      }
    } catch { /* 算不出就算了 */ }
    return null
  }

  async function attach(sessionId, messageId) {
    const session = svc('sessions')?.get?.(String(sessionId))
    if (!session) return { ok: false, error: '这个会话还没活着，先打开它再点' }

    const existing = rootOf(state, sessionId)
    if (existing && existing.enabled) {
      if (existing.anchorMessageId === String(messageId ?? '')) {
        return { ok: true, rootId: existing.rootId, anchorSeq: existing.anchorSeq, already: true }
      }
      return { ok: false, error: '这条会话的锚点已经立在另一条消息上了，先取消再重立' }
    }

    let anchorSeq = messageId ? seqOfMessage(session, messageId) : null
    if (anchorSeq === null || anchorSeq === undefined) {
      anchorSeq = Math.max(0, Number(session.seq ?? 0) - 1)
      log('ANCHOR_FALLBACK', `session=${sessionId} seq=${anchorSeq}`)
    }
    // 锚点消息已经被官方压缩吞掉 / 不在面上 → 向后落到最近的存活节点
    const seqs = surfaceSeqs(session)
    if (seqs.length > 0 && seqs.indexOf(Number(anchorSeq)) < 0) {
      const next = seqs.find((seq) => seq >= Number(anchorSeq))
      if (next !== undefined) {
        log('ANCHOR_SNAP', `session=${sessionId} ${anchorSeq} → ${next}（原消息已不在对话面上，向后落到最近的存活节点）`)
        anchorSeq = next
      }
    }

    const root = newRoot(sessionId, anchorSeq, messageId)
    root.anchorTurn = turnOfSeq(session, anchorSeq)
    state.roots[String(sessionId)] = root
    persist()
    log('ATTACH', `session=${sessionId} anchor=${anchorSeq} turn=${String(root.anchorTurn ?? '?')} msg=${String(messageId ?? '')}`)
    return { ok: true, rootId: root.rootId, anchorSeq, anchorTurn: root.anchorTurn ?? null }
  }

  async function detach(sessionId) {
    const root = rootOf(state, sessionId)
    if (!root) {
      log('DETACH_MISS', `session=${sessionId} 不在继承里`)
      return { ok: false, error: '这条会话没在继承' }
    }
    if (busy.has(root.rootId)) {
      log('DETACH_BLOCKED', `root=${root.rootId} 正在压缩，拒绝取消`)
      return { ok: false, error: '正在压缩，等这一趟走完再取消' }
    }
    root.enabled = false
    root.recent = ''
    root.recentPending = false
    persist()
    log('DETACH', `root=${root.rootId}`)
    return { ok: true, rootId: root.rootId }
  }

  // ── 钩子①：一轮结束后量一次，到线就压 ────────────────────
  /** 最近活跃的继承会话（pre-step 拿不到 agent 时的兜底，带时间戳防贴错会话）。 */
  let lastActive = { id: '', at: 0 }
  try {
    const offSessionEvent = ctx.on('session/event', (session, event) => {
      try {
        // 0.2.3 起 agent/pre-step 的入参里**没有 agent 了**（只剩 messages/position/signal/
        // modelSelection），拿不到会话 id 就没法找继承记录——注入会因为查不到记录而静默跳过。
        // 所以在这里顺手记下"最近活跃的会话"，pre-step 时用它兜底。
        if (event && (event.type === 'turn/start' || event.type === 'user/message')) {
          const live = String(session?.id ?? '')
          if (live !== '' && rootOf(state, live)) lastActive = { id: live, at: Date.now() }
        }
        if (disposed || !event || event.type !== 'turn/end') return
        const sid = String(session?.id ?? '')
        if (sid === '') return
        const root = rootOf(state, sid)
        if (!root || !root.enabled || busy.has(sid)) return
        if (dropIfAnchorGone(root)) return

        const pressure = pressureOf(session)
        if (pressure === null) return
        const total = pressure + estTokens(root.chain)
        if (total < cur().triggerTokens) return

        const now = Date.now()
        if (root.lastAttemptAt && now - root.lastAttemptAt < 60_000) return
        root.lastAttemptAt = now
        persist()

        log('TRIGGER', `root=${sid} total=${total} line=${cur().triggerTokens}`)
        setTimeout(() => { compressOnce(sid).catch(() => {}) }, 80)
      } catch (e) {
        log('HOOK_FAIL', (e && e.stack) || String(e))
      }
    })
    if (typeof offSessionEvent === 'function') disposers.push(offSessionEvent)
  } catch (e) {
    log('HOOK_MOUNT_FAIL', String((e && e.message) || e))
  }

  // ── 开分支：新会话要把锚点一起带过去 ──────────────────────
  //
  // 宿主的分支就是把源会话的事件原样复制一份到新会话，事件 id 一个不差；所以"新会话
  // 里有没有我们的锚点消息"这个问题可以直接靠 id 去认，不需要去挂钩子里的 fork。
  function inheritAnchorOnFork(session, attempt = 0) {
    try {
      const id = String(session?.id ?? '')
      if (id === '') return
      if (rootOf(state, id)) return
      const parents = Object.values(state.roots).filter((r) => r && r.anchorMessageId && r.rootId !== id)
      if (parents.length === 0) return

      for (const parent of parents) {
        let seq = null
        try { seq = seqOfMessage(session, parent.anchorMessageId) } catch { seq = null }
        if (seq === null || seq === undefined) continue

        const root = newRoot(id, seq, parent.anchorMessageId)
        // 开关跟着母体走：母体在压就接着压，母体冻着就只把锚点位置带过去
        root.enabled = parent.enabled === true
        // 母体压过的话，锚点那条已经被遮蔽出表面了：向后落到最近的存活节点
        let anchorSeq = seq
        const seqs = surfaceSeqs(session)
        if (seqs.length > 0 && seqs.indexOf(Number(anchorSeq)) < 0) {
          const next = seqs.find((s) => s >= Number(anchorSeq))
          if (next !== undefined) {
            log('FORK_SNAP', `child=${id} ${anchorSeq} → ${next}`)
            anchorSeq = next
          }
        }
        root.anchorSeq = anchorSeq
        root.cursorSeq = anchorSeq
        root.forkedFrom = parent.rootId
        state.roots[id] = root
        persist()
        log('FORK_INHERIT', `child=${id} from=${parent.rootId} anchor=${anchorSeq} msg=${parent.anchorMessageId} enabled=${root.enabled}`)
        return
      }

      if (attempt < 4) setTimeout(() => inheritAnchorOnFork(session, attempt + 1), 400 * (attempt + 1))
    } catch (e) {
      log('FORK_INHERIT_FAIL', (e && e.stack) || String(e))
    }
  }

  try {
    const offCreated = ctx.on('session/created', (session) => {
      try { inheritAnchorOnFork(session, 0) } catch (e) { log('FORK_HOOK_FAIL', String((e && e.message) || e)) }
    })
    if (typeof offCreated === 'function') disposers.push(offCreated)
  } catch (e) {
    log('FORK_HOOK_MOUNT_FAIL', String((e && e.message) || e))
  }

  /** 「这条材料这次为什么不发」只记一次，别每步刷一行。 */
  const skipLogged = new Set()
  const logSkipOnce = (key, line) => {
    if (skipLogged.has(key)) return
    skipLogged.add(key)
    log(line)
  }

  // ── 钩子②：压缩中排队 + 压完之后注入最近 N 轮原文 ──────────
  try {
    /**
     * 从 pre-step 的 agent 上认出「这条请求属于哪个会话」。
     *
     * 老版本 agent.id 就是会话 id，直接用没问题；0.2.3 起 agent 可能换了命名，
     * 所以按优先级取：session.id → sessionId → session.header.id → agent.id。
     * 认错的后果很直接：rootOf 查不到记录，注入这一步就静默跳过（近期对话不见了）。
     */
    const sessionIdOfAgent = (agent) => {
      try {
        const cands = [
          agent?.session?.id,
          agent?.sessionId,
          agent?.session?.header?.id,
          agent?.session?.header?.sessionId,
          agent?.id,
        ]
        for (const c of cands) {
          if (typeof c === 'string' && c !== '') return c
        }
      } catch { /* 认不出就当没有 */ }
      return ''
    }

    const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
      // 0.2.3 起 payload 里没有 agent 了，只能退到"最近活跃会话"（5 分钟内才算，避免贴错会话）。
      const fromPayload = sessionIdOfAgent(payload?.agent)
      const fresh = Date.now() - lastActive.at < 5 * 60 * 1000
      const waitId = fromPayload || (fresh ? lastActive.id : '')

      // 压缩没写完就先等——不拒收、不丢字，闸一开自己继续
      const gate = waitId ? gates.get(waitId) : null
      if (gate) {
        log('PRE_STEP_WAIT', `session=${waitId} 正在压缩，这条请求排队等着`)
        await Promise.race([gate.promise, new Promise((resolve) => setTimeout(resolve, 120000))])
        log('PRE_STEP_WAIT_DONE', `session=${waitId}`)
      }

      let decision
      try {
        decision = await next()
      } catch (error) {
        log('PRE_STEP_NEXT_FAIL', String((error && error.message) || error))
        throw error
      }

      try {
        if (disposed || !decision || decision.kind !== 'enter') return decision
        const root = waitId ? rootOf(state, waitId) : null
        if (!root || root.recentPending !== true) return decision
        if (root.enabled !== true) {
          root.recent = ''
          root.recentPending = false
          persist()
          log('INJECT_DROP', `session=${waitId} reason=detached`)
          return decision
        }
        const recent = typeof root.recent === 'string' ? root.recent.trim() : ''
        if (recent === '') return decision

        const messages = Array.isArray(decision.messages) && decision.messages.length > 0
          ? decision.messages
          : (Array.isArray(payload?.messages) ? payload.messages : [])
        if (messages.length === 0) return decision

        // 从尾巴往前找真正属于主人的那条消息。
        // 判据必须看 source.kind：0.2.3 里「运行环境上下文」也是 role=user、内容还很长，
        // 光看文字开头拦不住（实测 target 一直贴在它身上，落盘和模型都看不到我们的前缀）。
        let targetIndex = -1
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const candidate = messages[i]
          if (!candidate || candidate.role !== 'user') continue
          const srcKind = String((candidate.source && candidate.source.kind) || '')
          if (srcKind !== '' && srcKind !== 'user') continue
          const raw = plainTextOf(candidate)
          const flat = normText(raw)
          if (flat === '') continue
          if (flat.startsWith(normText(cur().tag))) continue
          if (isRuntimeBlock(raw)) continue
          targetIndex = i
          break
        }
        if (targetIndex < 0) {
          logSkipOnce(`no-target:${waitId}`, `INJECT_SKIP session=${waitId} reason=no-user-message-to-attach msgs=${messages.length}`)
          return decision
        }

        // 只在「主人刚发了一条新消息」这一拍发材料。
        // 0.2.3 起一次用户消息会走多个 pre-step（含自动续跑），材料是一次性的，
        // 被中间那些步吃掉，真正的那条消息就什么都看不到了——这就是"注入没生效"的真相。
        // 判据：目标用户消息必须在队尾，后面最多跟一条运行环境快照。
        const tailAfter = messages.slice(targetIndex + 1)
        const ignorableAfter = (m) => {
          if (!m) return false
          const k = String((m.source && m.source.kind) || '')
          return k === 'runtime-context' || isRuntimeBlock(plainTextOf(m))
        }
        const onlyRuntimeAfter = tailAfter.every(ignorableAfter)
        if (!onlyRuntimeAfter || tailAfter.length > 1) {
          logSkipOnce(
            `hold:${waitId}:${targetIndex}${messages.length}`,
            `INJECT_HOLD session=${waitId} reason=not-the-new-user-turn`,
          )
          return decision
        }

        const last = messages[targetIndex]
        const blocks = Array.isArray(last.content) ? last.content : []
        const prefix = `[近期对话]\n${recent}\n\n${cur().injectPrompt}\n\n\n`

        const outBlocks = []
        let merged = false
        for (const block of blocks) {
          if (!merged && block && block.type === 'text' && typeof block.text === 'string') {
            outBlocks.push({ ...block, text: `${prefix}${block.text}` })
            merged = true
          } else {
            outBlocks.push(block)
          }
        }
        if (!merged) outBlocks.unshift({ type: 'text', text: prefix.trimEnd() })

        // 除了返回新数组，还把原消息对象就地改掉：
        // 0.2.3 的循环会拿 decision.messages 里的对象直接落盘，就地改能保证下游无论怎么拷
        // 都带走这段前缀（之前只换数组，落盘那份可能还是原对象）。
        try {
          last.content = outBlocks
        } catch { /* 冻结对象就算了，下面还有整数组替换 */ }

        const out = messages.slice()
        out[targetIndex] = { ...last, content: outBlocks }

        root.recentPending = false
        root.recent = ''
        persist()
        // 只记一行到日志（含开头一小段便于核对），不再另落文件：
        // 每压一次多一个 txt 只会堆垃圾，正文在会话里那条消息上本就看得见。
        log('INJECT', `session=${waitId} recent=${recent.length} msg=${String(last.id ?? '')} head=${JSON.stringify(recent.slice(0, 80))}`)

        return { ...decision, messages: out }
      } catch (e) {
        log('INJECT_FAIL', (e && e.stack) || String(e))
        return decision
      }
    })
    if (typeof offPreStep === 'function') disposers.push(offPreStep)
  } catch (e) {
    log('INJECT_MOUNT_FAIL', String((e && e.message) || e))
  }

  // ── HTTP：客户端那一半靠这几条接口读写 ──────────────────
  const json = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    } catch { /* 连接没了就算了 */ }
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })

  function setupApi(webServer) {
    const offs = []
    try {
      ctx.effect(() => () => {
        for (const off of offs) { try { off() } catch { /* 忽略 */ } }
        offs.length = 0
      })
    } catch (e) { log('API_EFFECT_FAIL', String((e && e.message) || e)) }

    const route = (path, handler) => {
      try {
        const off = webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try { await handler(req, res) } catch (e) {
              log('API_ERROR', `${path} ${(e && e.message) || e}`)
              json(res, 500, { ok: false, error: String((e && e.message) || e) })
            }
          },
        })
        if (typeof off === 'function') offs.push(off)
        log('API_MOUNTED', path)
      } catch (e) {
        log('API_MOUNT_FAIL', `${path} ${(e && e.message) || e}`)
      }
    }

    const view = () => {
      const sessions = svc('sessions')
      const roots = {}
      for (const [id, r] of Object.entries(state.roots)) {
        const session = sessions?.get?.(r.rootId) || null
        const extra = session ? idsAfterAnchor(session, r.anchorSeq) : { afterIds: [], tailMessageId: '' }
        roots[id] = {
          rootId: r.rootId,
          enabled: r.enabled === true,
          anchorSeq: r.anchorSeq,
          anchorTurn: Number.isSafeInteger(r.anchorTurn) ? r.anchorTurn : (session ? turnOfSeq(session, r.anchorSeq) : null),
          anchorMessageId: r.anchorMessageId || '',
          cursorSeq: r.cursorSeq,
          compressions: r.compressions || 0,
          lastModelCompressAt: r.lastModelCompressAt || 0,
          chainChars: (r.chain || '').length,
          afterIds: extra.afterIds,
          tailMessageId: extra.tailMessageId,
          working: busy.has(r.rootId),
        }
      }
      return {
        ok: true,
        roots,
        pollMs: cur().pollMs ?? DEFAULTS.pollMs,
        triggerTokens: cur().triggerTokens,
        busy: [...busy],
      }
    }

    route(`${ROUTE_BASE}/state`, async (req, res) => json(res, 200, view()))

    route(`${ROUTE_BASE}/attach`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' })
      const body = JSON.parse((await readBody(req)) || '{}')
      if (!body.sessionId) return json(res, 400, { ok: false, error: '缺 sessionId' })
      const out = await attach(String(body.sessionId), body.messageId ? String(body.messageId) : '')
      return json(res, out.ok ? 200 : 400, out)
    })

    route(`${ROUTE_BASE}/detach`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' })
      const body = JSON.parse((await readBody(req)) || '{}')
      if (!body.sessionId) return json(res, 400, { ok: false, error: '缺 sessionId' })
      const out = await detach(String(body.sessionId))
      return json(res, out.ok ? 200 : 400, out)
    })

    route(`${ROUTE_BASE}/compress`, async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      const root = body.sessionId ? rootOf(state, String(body.sessionId)) : null
      if (!root) return json(res, 400, { ok: false, error: '这条会话没在继承' })
      const out = await compressOnce(root.rootId)
      return json(res, out.ok ? 200 : 400, out)
    })

    route(`${ROUTE_BASE}/trim`, async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      const root = body.sessionId ? rootOf(state, String(body.sessionId)) : null
      if (!root) return json(res, 400, { ok: false, error: '这条会话没在继承' })
      const out = await trimNow(root.rootId)
      return json(res, out.ok ? 200 : 400, out)
    })

    route(`${ROUTE_BASE}/settings`, async (req, res) => {
      if (req.method === 'GET') return json(res, 200, { ok: true, settings: cur(), defaults: { ...DEFAULTS }, limits: LIMITS })
      const body = JSON.parse((await readBody(req)) || '{}')
      const next = { ...(state.settings || {}) }
      if (body.triggerTokens !== undefined) {
        const n = clampInt(body.triggerTokens, LIMITS.triggerTokens)
        if (n !== null) next.triggerTokens = n
      }
      if (body.maxBlockChars !== undefined) {
        const n = clampInt(body.maxBlockChars, LIMITS.maxBlockChars)
        if (n !== null) next.maxBlockChars = n
      }
      if (body.recentRounds !== undefined) {
        const n = clampInt(body.recentRounds, LIMITS.recentRounds)
        if (n !== null) next.recentRounds = n
      }
      if (body.recentCharsPerRound !== undefined) {
        const n = clampInt(body.recentCharsPerRound, LIMITS.recentCharsPerRound)
        if (n !== null) next.recentCharsPerRound = n
      }
      if (typeof body.provider === 'string') next.provider = body.provider.trim()
      if (typeof body.model === 'string') next.model = body.model.trim()
      if (typeof body.prompt === 'string' && body.prompt.trim() !== '') next.prompt = body.prompt.slice(0, 20000)
      if (body.injectPrompt !== undefined) {
        const inject = String(body.injectPrompt ?? '').trim()
        // 留空 = 用内置那版，而不是留一句空指令（空指令会让模型不知道这段原文是干嘛的）
        if (inject === '') delete next.injectPrompt
        else next.injectPrompt = inject.slice(0, 4000)
      }
      state.settings = next
      persist()
      log('SETTINGS', `trigger=${cur().triggerTokens} model=${cur().provider}/${cur().model} maxChars=${cur().maxBlockChars} recent=${cur().recentRounds}x${cur().recentCharsPerRound}字`)
      return json(res, 200, { ok: true, settings: cur() })
    })

    route(`${ROUTE_BASE}/models`, async (req, res) => {
      const out = { ok: true, groups: [], default: null }
      try {
        const sc = svc('sessionController')
        if (sc && typeof sc.modelCatalog === 'function') {
          const cat = await sc.modelCatalog()
          out.groups = Array.isArray(cat && cat.groups) ? cat.groups : []
          out.default = (cat && cat.default) ?? null
        }
      } catch (e) {
        log('MODELS_FAIL', String((e && e.message) || e))
        out.ok = false
        out.error = String((e && e.message) || e)
      }
      return json(res, 200, out)
    })

    route(`${ROUTE_BASE}/log`, async (req, res) => {
      return json(res, 200, { ok: true, path: logPath(), text: readLogTail(400) })
    })

    route(`${ROUTE_BASE}/clienterror`, async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      log('CLIENT_ERROR', `phase=${body.phase || '?'} message=${body.message || '?'}`)
      if (body.stack) {
        for (const line of String(body.stack).split('\n').slice(0, 8)) log('CLIENT_STACK', line.trim())
      }
      return json(res, 200, { ok: true })
    })

    route(`${ROUTE_BASE}/status`, async (req, res) => {
      const sessions = svc('sessions')
      const rows = Object.values(state.roots).map((r) => {
        const s = sessions?.get?.(r.rootId)
        return {
          rootId: r.rootId,
          enabled: r.enabled === true,
          anchorSeq: r.anchorSeq,
          anchorMessageId: r.anchorMessageId || '',
          pressure: s ? pressureOf(s) : null,
          chainChars: (r.chain || '').length,
          blockTokens: estTokens(r.chain),
          compressions: r.compressions || 0,
          lastModelCompressAt: r.lastModelCompressAt || 0,
          working: busy.has(r.rootId),
        }
      })
      return json(res, 200, { ok: true, build: BUILD, dataDir: dataRoot(), triggerTokens: cur().triggerTokens, roots: rows })
    })
  }

  const ws = svc('webServer')
  if (ws && typeof ws.register === 'function') setupApi(ws)
  else log('API_SKIP', '没有 webServer 服务')

  log('MOUNT_DONE', `build=${BUILD}`)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of disposers) { try { off() } catch { /* 忽略 */ } }
      disposers.length = 0
      for (const id of [...gates.keys()]) closeGate(id)
      busy.clear()
    },
  }
}
