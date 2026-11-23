/**
 * dsh-inherit-compression · 启动前瘦身（温和版）
 *
 * 干什么：把「已经被遮蔽、已经不参与上下文」的那些消息的正文，换成零宽空格占位。
 * 行数不变、seq 不变、轮次结构不变，所以宿主的加载器看不出任何区别；模型也看不到
 * 任何区别（这些节点本来就已经被遮蔽出表面了）。变的只有文件体积。
 *
 * 什么时候做：**启动时、会话还没被打开之前**。会话活着的时候动文件一定会和宿主
 * 内存里的序号/表面分家，重启就判损坏——这条边界是用三条真会话换来的，不再试。
 *
 * 安全协议（每一步都不能省）：
 *   ① 只做已经被遮蔽的节点，表面上还看得见的一个字节都不碰；
 *   ② 改完先写临时文件，用 dsh-log-contract 自己的严格扫描 + 全量校验判卷；
 *   ③ 判卷不过就删临时文件、原文件一个字节不动；
 *   ④ 判卷通过才备份原件、再原子替换。
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 占位正文：零宽空格。不是空字符串——空 content 会投影成一条 len:0 的空消息。 */
const BLANK = '\u200B'

/** 表面类型（与官方 foldSurface 同口径）。 */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])

let contract = null

/**
 * 取 dsh-log-contract 的底层模块。
 *
 * 包里只导出了 index / contracts / prewrite 三个入口，而我们要用的
 * decompressZstd / scanZstdFrames / rebuildZstdText / validateSessionLog 在
 * lib/ 下的子模块里——所以先解析包入口，再按目录直接 import 那几个文件。
 */
async function loadContract() {
  if (contract) return contract
  const require = createRequire(import.meta.url)
  const entry = require.resolve('dsh-log-contract')
  const dir = dirname(entry)
  const [reader, repair] = await Promise.all([
    import(pathToFileURL(join(dir, 'log-reader.js')).href),
    import(pathToFileURL(join(dir, 'repair.js')).href),
  ])
  // 全量校验器依赖 @deepseek-ai/dsh-session，个别环境解析不到。解析不到就降级：
  // 仍然做严格连续扫描 + 帧重建 roundtrip，只是少了规则体检。降级要留痕。
  let validateFn = null
  try {
    const validate = await import(pathToFileURL(join(dir, 'validate.js')).href)
    validateFn = validate.validateSessionLog
  } catch { validateFn = null }
  contract = {
    decompressZstd: reader.decompressZstd,
    scanZstdFrames: reader.scanZstdFrames,
    loadSessionLog: reader.loadSessionLog,
    rebuildZstdText: repair.rebuildZstdText,
    strictScanText: repair.strictScanText,
    validateSessionLog: validateFn,
  }
  return contract
}

/**
 * 折叠出当前表面上的 seq 集合（与官方一致：只有 append 与 replace 两种操作）。
 * 不在这个集合里的表面节点 = 已经被遮蔽掉、不再进模型上下文的。
 */
function foldSurfaceSeqs(events) {
  const nodes = []
  for (const ev of events) {
    if (!ev || !SURFACE_TYPES.has(ev.type)) continue
    const op = ev.surfaceOp
    if (op === 'append') { nodes.push(ev.seq); continue }
    if (op && typeof op === 'object' && op.op === 'replace') {
      const start = op.startSeq !== undefined ? op.startSeq : op.start
      const end = op.endSeq !== undefined ? op.endSeq : op.end
      const s = nodes.indexOf(start)
      const e = nodes.indexOf(end)
      if (s !== -1 && e !== -1 && s <= e) nodes.splice(s, e - s + 1)
      nodes.push(ev.seq)
    }
  }
  return new Set(nodes)
}

/** 把一条消息里的文本块换成占位（工具调用块等非文本块原样留）。 */
function blankContent(content) {
  if (!Array.isArray(content) || content.length === 0) return { content, changed: false }
  let changed = false
  const out = content.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    if (block.text === BLANK) return block
    changed = true
    return { ...block, text: BLANK }
  })
  return { content: out, changed }
}

/**
 * 所有"遮蔽区间"——replace 事件的 [start,end]。
 *
 * 为什么用它而不是"算出哪些节点不在表面上"：区间里除了表面节点，还夹着一堆
 * log-only 的行（request/header、inbox、chunk…），它们不在表面上、永远不进上下文，
 * 但体积一点不小。用区间判定才能把它们一起收掉。
 */
function maskedRanges(events) {
  const ranges = []
  for (const ev of events) {
    const op = ev && ev.surfaceOp
    if (!op || typeof op !== 'object' || op.op !== 'replace') continue
    const start = Number(op.startSeq !== undefined ? op.startSeq : op.start)
    const end = Number(op.endSeq !== undefined ? op.endSeq : op.end)
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) ranges.push([start, end])
  }
  return ranges
}

function inMaskedRange(seq, ranges) {
  const n = Number(seq)
  if (!Number.isSafeInteger(n)) return false
  for (const [start, end] of ranges) {
    if (n >= start && n <= end) return true
  }
  return false
}

/** 一条消息对象里的正文换占位（保留 content 数组与其它块类型）。 */
function blankMessageLike(message) {
  if (!message || typeof message !== 'object') return false
  const r = blankContent(message.content)
  if (!r.changed) return false
  message.content = r.content
  return true
}

/**
 * 对被遮蔽区里的一条事件做"能压都压"的处理。
 *
 * 原则：**只动正文和纯审计字段，骨架一个字节都不碰**——轮步边界、工具调用与结果、
 * seq、turn/step 号、sourceEventSeqs、surfaceOp、以及在表面上的消息，全部原样。
 * 返回是否真的改了。
 */
function slimRow(ev, keepFullTools = null) {
  if (!ev || !ev.data || typeof ev.data !== 'object') return false
  // 载体（我们自己的 replace 事件）里装的是记忆摘要，动了就没记忆了
  if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') return false

  switch (ev.type) {
    case 'user/message':
    case 'system/message':
      return blankMessageLike(ev.data)
    // developer/message 不能动：它可能是"工具增补声明"（tool-addition），
    // 正文里写着工具名，改了 foldSurface 重放会直接失败（实测 S8）。
    case 'assistant/message':
    case 'tool/result': {
      const message = ev.data && ev.data.message
      let changed = blankMessageLike(message)
      if (ev.type === 'assistant/message' && ev.data) {
        // 这里只处理"整轮都不可见"的轮（调用方已经筛过）：
        // 那种轮在界面上整段收起，流式快照没人看，直接清成空数组最省。
        // 半遮半掩的轮一律不碰——那行「已完成」还要靠这些过程片画箭头。
        const stream = ev.data.stream
        if (Array.isArray(stream)) {
          if (stream.length > 0) { ev.data.stream = []; changed = true }
        } else if (stream && typeof stream === 'object') {
          ev.data.stream = []
          changed = true
        }
        // 正文块里的 reasoning / thinking 也是正文，一起换成占位；工具调用块必须留
        const blocks = message && Array.isArray(message.content) ? message.content : []
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'tool-call') continue
          if (typeof b.text === 'string' && b.text !== BLANK) { b.text = BLANK; changed = true }
        }
      }
      return changed
    }
    case 'request/header': {
      // 大头是工具清单：一条十万字节里九万多都是每个 tool 的 description/parameters。
      // 但**名字不能删**——developer/message 里的 tool-addition/tool-removal 是按名字
      // 跟清单对账的，删了清单 foldSurface 重放会直接失败（实测 S8）。
      // 所以只留 {name}，把描述与 schema 清空。
      const header = ev.data.header
      if (!header || typeof header !== 'object' || !Array.isArray(header.tools) || header.tools.length === 0) return false
      let changed = false
      header.tools = header.tools.map((tool) => {
        if (!tool || typeof tool !== 'object') return tool
        // developer/message 里宣布过增补的工具，清单里必须是完整定义，
        // 否则 foldSurface 重放报 "requires a complete tool definition"（实测 S8）。
        if (keepFullTools && keepFullTools.has(tool.name)) return tool
        const keys = Object.keys(tool)
        if (keys.length === 1 && keys[0] === 'name') return tool
        changed = true
        return { name: tool.name }
      })
      return changed
    }
    case 'agent/inbox/spliced': {
      const inserted = ev.data.inserted
      if (!Array.isArray(inserted) || inserted.length === 0) return false
      let changed = false
      for (const item of inserted) {
        if (!item || typeof item !== 'object') continue
        if (blankMessageLike(item)) changed = true
      }
      return changed
    }
    default:
      return false
  }
}

/** 把一次体检结果压成 {规则: 条数}，用来比"改前 vs 改后"有没有变差。 */
function violationFingerprint(verdict) {
  const out = new Map()
  for (const v of verdict?.violations || []) {
    const key = String(v.rule ?? v.id ?? v.ruleId ?? 'unknown')
    out.set(key, (out.get(key) || 0) + 1)
  }
  return out
}

/**
 * 瘦一个文件。
 * @returns {Promise<{ ok: boolean, reason?: string, before?: number, after?: number, blanked?: number }>}
 */
export async function slimSessionFile({ file, sessionId, log = () => {}, backupsDir, isOpen = () => false }) {
  const c = await loadContract()

  let buf
  try { buf = readFileSync(file) } catch (e) { return { ok: false, reason: `读不到文件：${String(e && e.message)}` } }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0xfd2fb528) return { ok: false, reason: '不是 zstd 文件' }

  let frameInfo
  try { frameInfo = c.scanZstdFrames(buf) } catch (e) { return { ok: false, reason: `帧扫描失败：${String(e && e.message)}` } }
  if (frameInfo && frameInfo.torn) return { ok: false, reason: '尾帧撕裂（可能正在写），这轮不动' }

  let plain
  try { plain = c.decompressZstd(buf) } catch (e) { return { ok: false, reason: `解压失败：${String(e && e.message)}` } }

  const text = plain.toString('utf8')
  if (!text.endsWith('\n')) return { ok: false, reason: 'JSONL 结尾不是单个换行' }
  const lines = text.split('\n')

  const parsed = []
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (!raw.trim()) continue
    let v
    try { v = JSON.parse(raw) } catch { continue }
    parsed.push({ line: i, v })
  }
  if (parsed.length === 0) return { ok: false, reason: '没有可解析的事件行' }

  const events = parsed.map((r) => r.v)
  const surface = foldSurfaceSeqs(events)
  const ranges = maskedRanges(events)
  if (ranges.length === 0) return { ok: false, reason: '没有被遮蔽的区间，不用动' }

  // 注：这里不按"遮蔽占比过高就跳过"来躲问题——那样等于不干活。
  // 遮蔽占比高的会话（>40%）客户端会"降级"、让被遮蔽的行照常显示，那个降级
  // 已经在客户端关掉了（build-inherit-client.mjs 里改写 shadowDegraded），
  // 被遮蔽的行一律隐藏，所以这里可以照常瘦。

  // 工具增补声明里点过名的工具，清单必须留完整定义（否则重放失败）
  const keepFullTools = new Set()
  for (const ev of events) {
    if (!ev || ev.type !== 'developer/message') continue
    const blocks = ev.data && ev.data.message && Array.isArray(ev.data.message.content) ? ev.data.message.content : []
    for (const b of blocks) {
      // 只有 tool-addition 要求"清单里必须有完整定义"；tool-removal 只是撤，不需要留。
      if (b && b.type === 'tool-addition' && typeof b.toolName === 'string') keepFullTools.add(b.toolName)
    }
  }

  let blanked = 0
  // 哪些轮是"整轮都不可见"。只有这种轮里的助手消息才能连 stream / reasoning 一起清——
  // 半遮半掩的轮，界面上那条「已完成，用时 N 秒」还在，展开思考过程要读这些块，
  // 清空了箭头就消失（实测）。宁可少省一点，也不许把界面弄坏。
  const turnStats = new Map()
  for (const ev of events) {
    if (!ev || !SURFACE_TYPES.has(ev.type)) continue
    const turn = Number(ev.data && ev.data.turn)
    if (!Number.isSafeInteger(turn)) continue
    const stat = turnStats.get(turn) || { total: 0, masked: 0 }
    stat.total += 1
    if (!surface.has(ev.seq)) stat.masked += 1
    turnStats.set(turn, stat)
  }
  const fullyMaskedTurns = new Set()
  for (const [turn, stat] of turnStats) {
    if (stat.total > 0 && stat.masked === stat.total) fullyMaskedTurns.add(turn)
  }

  for (const row of parsed) {
    if (!inMaskedRange(row.v.seq, ranges)) continue
    // 表面节点必须还在表面上（它们本来就被遮蔽掉了，保险起见再判一次）
    if (SURFACE_TYPES.has(row.v.type) && surface.has(row.v.seq)) continue
    // 助手消息只在"整轮都不可见"时才动：界面上那条「已完成」还挂着的轮，
    // 它的过程片要留着（实测：清了这个，没被遮蔽的那一行也展不开）。
    if (row.v.type === 'assistant/message') {
      const turn = Number(row.v.data && row.v.data.turn)
      if (!Number.isSafeInteger(turn) || !fullyMaskedTurns.has(turn)) continue
    }
    if (!slimRow(row.v, keepFullTools)) continue
    lines[row.line] = JSON.stringify(row.v)
    blanked += 1
  }
  if (blanked === 0) return { ok: false, reason: '被遮蔽区里已经是占位了' }

  const next = lines.join('\n')

  // ① 严格连续扫描：seq 必须还是 0..n-1 一条挨一条
  const scan = c.strictScanText(next)
  if (scan.failures.length > 0) {
    return { ok: false, reason: `严格扫描不过：${JSON.stringify(scan.failures.slice(0, 3))}` }
  }

  // ② 按官方帧格式重建，并逐帧 roundtrip
  let rebuilt
  try { rebuilt = c.rebuildZstdText(next) } catch (e) { return { ok: false, reason: `重建失败：${String(e && e.message)}` } }

  // ③ 先落临时文件，用宿主自己的校验器判卷
  const tmp = `${file}.slim-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tmp, rebuilt)
    if (typeof c.validateSessionLog !== 'function') {
      // 降级：只做严格连续扫描（上面已过）+ 帧 roundtrip（重建时已校验）
      log('SLIM_VALIDATOR', 'degraded（拿不到全量校验器，只做了严格扫描）')
      unlinkSync(tmp)
      return { ok: false, reason: '校验器不可用，这轮不改（避免瞎改）' }
    }
    const baseline = violationFingerprint(c.validateSessionLog(c.loadSessionLog(file)))
    const after = c.validateSessionLog(c.loadSessionLog(tmp))
    const afterPrint = violationFingerprint(after)
    // 判卷口径：**不许比改前更差**。原文件本来就有历史毛病的（比如中断留下的孤儿工具
    // 调用 P3），不能因为它不干净就永远不瘦；只看我们有没有引入新问题。
    const worse = []
    for (const [rule, count] of afterPrint) {
      const base = baseline.get(rule) || 0
      if (count > base) worse.push(`${rule} ${base} → ${count}`)
    }
    if (worse.length > 0) {
      const sample = (after.violations || []).slice(0, 3).map((v) => `${v.rule ?? '?'}: ${String(v.message ?? '').slice(0, 120)}`)
      unlinkSync(tmp)
      return { ok: false, reason: `引入了新问题（${worse.join(', ')}）：${sample.join(' | ')}` }
    }
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, reason: `校验阶段异常：${String(e && e.message)}` }
  }

  // ④ 判卷过了才动真文件：先备份，再原子替换
  try {
    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(file, join(backupsDir, `${sessionId}-slim-${stamp}.jsonl.zstd`))
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, reason: `备份失败，不动原文件：${String(e && e.message)}` }
  }

  if (isOpen()) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, reason: '会话这时候被打开了，放弃这次改写' }
  }

  const before = buf.length
  try {
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, reason: `替换失败：${String(e && e.message)}` }
  }
  let after = before
  try { after = statSync(file).size } catch { /* 忽略 */ }

  log('SLIM_FILE', `session=${sessionId} 占位 ${blanked} 条（遮蔽区间 ${ranges.length} 段）${before} → ${after} 字节`)
  return { ok: true, before, after, blanked }
}

/**
 * 启动时跑一遍。
 *
 * 判断标准不是"压缩时有没有登记过"，而是**这个文件现在有没有被遮蔽的区间**——
 * 分叉出来的新会话、老版本压过的会话、别人复制来的文件，只要里面有遮蔽，就该被瘦。
 * 所以候选来自：所有继承记录里的会话 + 显式待办。
 *
 * 两个开销控制：
 *   · 上次瘦完记下的尺寸跟现在一样 ⇒ 中间没新内容，跳过（不读文件）；
 *   · 一次启动最多做几条，剩下的下次再说（日志写 SLIM_BOOT_DEFER）。
 */
export async function runBootSlim({ state, persist = () => {}, log = () => {}, sessions = null, sessionFilePath, backupsDir, maxPerBoot = Infinity }) {
  if (!state) return
  // 空数组是老版本留下的坑：数组上挂字符串键，JSON.stringify 会把它丢掉
  if (Array.isArray(state.pendingSlim)) {
    state.pendingSlim = {}
    log('SLIM_BOOT_REPAIR', '待办曾是数组（键会丢），已重置为空对象')
  }
  if (!state.pendingSlim || typeof state.pendingSlim !== 'object') state.pendingSlim = {}
  const pending = state.pendingSlim
  const roots = state.roots && typeof state.roots === 'object' ? state.roots : {}

  const isOpen = (id) => Boolean(sessions && typeof sessions.get === 'function' && sessions.get(id))
  const ids = new Set([...Object.keys(pending), ...Object.keys(roots)])

  const candidates = []
  let openSkipped = 0
  let unchanged = 0
  let missing = 0
  for (const id of ids) {
    if (isOpen(id)) { openSkipped += 1; continue }
    const file = sessionFilePath(id)
    if (!file || !existsSync(file)) {
      missing += 1
      const rec = pending[id]
      if (rec) {
        rec.attempts = (rec.attempts || 0) + 1
        if (rec.attempts >= 3) delete pending[id]
      }
      continue
    }
    let size = 0
    try { size = statSync(file).size } catch { continue }
    const root = roots[id]
    // 上次瘦完的尺寸 == 现在 ⇒ 中间没写过东西，不用再看
    if (root && Number.isFinite(root.slimSize) && Number(root.slimSize) === size) { unchanged += 1; continue }
    candidates.push({ id, file, size, slimmed: root && Number.isFinite(root.slimSize) ? 1 : 0 })
  }

  log('SLIM_BOOT_START', `候选 ${candidates.length} 条（已开 ${openSkipped}／没变 ${unchanged}／缺文件 ${missing}）`)
  if (candidates.length === 0) return

  // 没瘦过的先做；同档按体积大的先做（省得多）
  candidates.sort((a, b) => a.slimmed - b.slimmed || b.size - a.size)
  // 有多少做多少：不再按每次三条截断（哥的话：谁让你自作主张超过40就不干活的）。
  const limit = Number.isFinite(maxPerBoot) && maxPerBoot > 0 ? Math.floor(maxPerBoot) : candidates.length
  const take = candidates.slice(0, limit)
  if (candidates.length > take.length) {
    log('SLIM_BOOT_DEFER', `这次做 ${take.length} 条，其余 ${candidates.length - take.length} 条下次启动接着做`)
  }

  const tally = { ok: 0, none: 0, fail: 0, saved: 0 }
  for (const cand of take) {
    const id = cand.id
    try {
      const out = await slimSessionFile({
        file: cand.file,
        sessionId: id,
        log,
        backupsDir,
        isOpen: () => isOpen(id),
      })
      const root = roots[id]
      if (out.ok) {
        const saved = out.before - out.after
        tally.ok += 1
        tally.saved += saved > 0 ? saved : 0
        log('SLIM_BOOT_OK', `session=${id} ${out.before} → ${out.after} 字节（省 ${saved}）`)
        if (root) { root.slimSize = out.after; root.slimAt = Date.now() }
        delete pending[id]
      } else if (/已经是占位了|没有被遮蔽的区间/.test(String(out.reason || ''))) {
        tally.none += 1
        log('SLIM_BOOT_NONE', `session=${id} ${out.reason}`)
        if (root) { root.slimSize = cand.size; root.slimAt = Date.now() }
        delete pending[id]
      } else {
        tally.fail += 1
        log('SLIM_BOOT_FAIL', `session=${id} ${out.reason || '未知原因'}`)
        const rec = pending[id] || (pending[id] = { at: Date.now(), attempts: 0 })
        rec.attempts = (rec.attempts || 0) + 1
        if (rec.attempts >= 3) delete pending[id]
      }
    } catch (e) {
      tally.fail += 1
      log('SLIM_BOOT_ERROR', `session=${id} ${String((e && e.stack) || e)}`)
      const rec = pending[id] || (pending[id] = { at: Date.now(), attempts: 0 })
      rec.attempts = (rec.attempts || 0) + 1
      if (rec.attempts >= 3) delete pending[id]
    }
  }
  log('SLIM_BOOT_DONE', `这轮 ${take.length} 条：瘦了 ${tally.ok}／本来就干净 ${tally.none}／失败 ${tally.fail}，共省 ${tally.saved} 字节`)
  try { persist() } catch (e) { log('SLIM_PERSIST_FAIL', String((e && e.message) || e)) }
}
