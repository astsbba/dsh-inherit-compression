/**
 * dsh-inherit-compression — HTTP route aggregation for `/api/plugins/retrace/*`.
 *
 * Serves both the published-client transports and the versioning surface:
 *
 *   POST /api/plugins/retrace/{recall|editAndResend|regenerate}
 *     — the L1 editor ops (unchanged wire shape from 0.2.x).
 *   GET  /api/plugins/retrace/versions?sessionId=
 *     — live projection snapshot (HTTP fallback channel; the push channel is
 *       `session/projection` frames via dsh-host-apiproxy).
 *   GET  /api/plugins/retrace/forkmap?sessionId=
 *     — the fork-map projection snapshot (branch topology, P2.1; same
 *       push-frame + HTTP fallback dual channel as /versions).
 *   GET  /api/plugins/retrace/event?sessionId=&seq=&before=&after=
 *     — one event + context window (sessionQuery.readEvent, lazy reads).
 *   GET  /api/plugins/retrace/surface?sessionId=
 *     — current model surface (sessionQuery.readSurface).
 *   POST /api/plugins/retrace/rollback/preview
 *     — dry-run: messages removed + artifact actions (no side effects).
 *   POST /api/plugins/retrace/rollback
 *     — execute the rollback ({sessionId, versionId, scope}); the outcome carries
 *       `undoId`/`undoExpiresInMs` when the overwritten bytes were captured.
 *   POST /api/plugins/retrace/rollback/undo
 *     — undo one rollback ({sessionId, undoId}); partial failures keep the ticket.
 *   GET  /api/plugins/retrace/git/status?sessionId=
 *     — repo detection + HEAD + dirty (timeline git banner).
 *   POST /api/plugins/retrace/git/init
 *     — one-click git init for a non-repository workspace (user-confirmed).
 *   GET  /api/plugins/retrace/doctor?sessionId=
 *     — compression pre-check: scan for token-meter-breaking turn-null markers
 *       (B1, regression root cause 3) — read-only.
 *   GET  /api/plugins/retrace/snapshot?sessionId=&versionId=&path=
 *     — read one version's snapshot content (rollback preview / detail).
 *   GET|POST /api/plugins/retrace/runningState[?sessionId=]
 * — 关闭守卫 V2 :全会话运行中清单 { running: [...] }(或单会话
 *       runningState)——client beforeunload 阻止的同步读缓存源(纯读,复用
 *       lib/close-guard.js runningSessions)。
 *       全会话形状另带宿主承载面 `{ surface, quitVeto }`(外部 issue #1:
 *       桌面端托盘退出死锁)。surface 由**宿主**按请求头 + 宿主痕迹判定
 *       (lib/close-guard.js pageSurfaceOf);客户端只在 quitVeto === true 时武装原生
 *       beforeunload 门 —— 桌面 Electron 页面回报 false:退出入口随 Desktop 版本/
 *       平台而变,会经过 beforeunload 的那类版本(外部报告的 0.9.0)上否决被壳静默
 *       吞掉、退出卡住;不经过它的版本(2.0.9 的 requestQuit → app.exit)上那扇门
 *       本来就是空转。
 *
 * Per  the client carries its localStorage config on every
 * request as `x-retrace-config: {"versioning":bool,"git":bool,
 * "retentionLimit":n}`; the host honors it per request and does not persist
 * it. A missing/malformed header falls back to the plugin defaults.
 *
 * 安全边界（Phase 1，设计来源：外部 fork 0.4.79/0.4.82 的对抗性审计，按本仓风格重写）：
 *   · 路由无鉴权 ⇒ 唯一真实边界是"来自 loopback"：socket peer + Host 双查
 *     （lib/request-guard.js）。浏览器带 Origin 时还须与 Host **同源**，否则
 *     DNS-rebinding / 跨站页面可凭"Host 与 Origin 天生一致"打进来。任一不满足
 *     ⇒ 403 fail-closed；隧道/LAN 需 `DSH_RETRACE_ALLOW_REMOTE=1` 显式放行。
 *   · `prewrite` 守卫 **host-only**：客户端头里写 `prewrite:false` 一律忽略
 *     （否则客户端可自关写前校验）；宿主侧 `DSH_RETRACE_PREWRITE=0` 才可关。
 *   · fold 端点要求**原始安全整数**区间（isFoldRange）；非法 ⇒ 400。
 *     调用方自带的 `span` 一律忽略，宿主从会话日志重算（防伪造遮蔽区间）。
 */
import { createEditorApi } from './host-core.js'
import { dshAdapter } from './adapter/dsh.js'
// 请求边界：loopback peer / Host 回环 / Origin 同源 / fold 原始整数区间 / span 由宿主重算
import { isFoldRange, isLoopbackRequest, originAllowed, remoteAllowed, withoutClientSpan } from './request-guard.js'
// span 显式状态 → 业务层判定输入(与 index.js harness 入口同一处理)
import { spanMissArgsOf } from './span-semantics.js'
import { runningSessions, sessionRunningState, guardSurfaceOf } from './close-guard.js'
// 诊断用：把 4xx/5xx 的请求写进我们自己的运行日志（官方宿主日志不落盘，看不见）。
import { log as ownLog } from './inherit-store.js'

export const ROUTE_PREFIX = '/api/plugins/retrace'
const MAX_BODY_BYTES = 64 * 1024
/** Ops whose span is computed host-side; a caller-supplied span is always dropped. */
const SPAN_OPS = new Set(['recall', 'editAndResend', 'regenerate', 'fold'])

/**
 * Host-side defaults. `prewrite` is HOST-ONLY: the request header can neither
 * enable nor disable the marker guard any more (a client that can turn the
 * guard off defeats the whole point of the pre-write validation). The host
 * operator opts out with `DSH_RETRACE_PREWRITE=0`.
 */
export const DEFAULT_CONFIG = {
  versioning: true,
  git: true,
  retentionLimit: 50,
  prewrite: process.env.DSH_RETRACE_PREWRITE !== '0',
  summary: false,
}

/** Parse the `x-retrace-config` request header (tolerant of garbage). */
export function parseRetraceConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'string' || raw.length === 0) return config
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.versioning === 'boolean') config.versioning = parsed.versioning
    if (typeof parsed.git === 'boolean') config.git = parsed.git
    if (Number.isInteger(parsed.retentionLimit) && parsed.retentionLimit > 0) {
      config.retentionLimit = parsed.retentionLimit
    }
    // `prewrite` intentionally NOT read from the header: the marker guard is
    // host-only (see DEFAULT_CONFIG).
    // OPT-IN (default off): the LLM boundary summary. Off ⇒ no call, no artifact.
    if (typeof parsed.summary === 'boolean') config.summary = parsed.summary
  } catch {
    // malformed header → defaults
  }
  return config
}

function sendJson(res, status, value) {
  // 记一行：谁、什么状态码、哪个 op。界面上一闪而过的 "HTTP 400" 就是从这里出来的，
  // 没这行只能靠猜（客户端把非 2xx 一律变成 `HTTP ${status}`）。
  try {
    if (status >= 400) {
      const body = value && value.error ? String(value.error.message ?? '') : ''
      ownLog(`HTTP ${status} op=${String(res.__retraceOp ?? '-')} url=${String(res.req?.url ?? '-')} ${body}`)
    }
  } catch { /* 诊断日志绝不影响响应 */ }
  // 【本 fork 加固】已经发过就别再发：重复响应会抛 ERR_HTTP_HEADERS_SENT，
  // 而这条路径上的抛错会把宿主进程带崩（实测过一次）。宁可静默丢弃第二次。
  if (res.headersSent === true || res.writableEnded === true) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Error path — never silent. The wire keeps only code/message (+details), so
 * without this log an internal TypeError disappeared into a clean host log:
 * that is how the "cannot recall / cannot edit" regression stayed hidden.
 * @param {object} res
 * @param {unknown} error
 * @param {(line: string) => void} [log]
 */
function sendError(res, error, log = () => {}) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '(no stack)'
    const code = error && typeof error.code === 'string' ? error.code : 'internal'
    log(`retrace: http error [${code}] ${message}\n${stack}`)
  } catch { /* logging must never break the response */ }
  sendJson(res, 200, {
    ok: false,
    error: {
      // editorError 附带的排查信息(messageId/seq)透传到 wire(同 op 信封)
      ...(error && typeof error.details === 'object' && error.details ? error.details : {}),
      code: error && typeof error.code === 'string' ? error.code : 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

/** Route one request. `seam` is the versioning seam (lib/versioning.js). */
export function createRetraceHttpHandler(ctx, { sessions, agents, seam, rollback, hooks = {}, log = () => {}, extraOps = {} }) {
  // extraOps = 客户端半会用、但**不在编辑器 API 上**的 op（标题相关：sessionBadge / badgeMap 等只读接口）。真回归：
  // 这些 op 曾只挂 harness，而 App 走 HTTP ⇒ 客户端 callOp('badgeMap') 拿到 **404**。
  //
  // ⚠️ **不要**把 extraOps 展开进 api：index.js 那边是"先声明 holder、再在更深闭包里
  // 无条件写入"的**晚绑定**（`extraOpsHolder`）。早拷贝一次就只是把当时的空对象拷走，
  // 晚赋值永远传不过来 ⇒ 分发时按**同一对象引用**现取（`extraOps[op]`）。
  const api = createEditorApi(ctx, sessions, agents, log, hooks)

  // 【本 fork 改动】读档点那批只读处理器（versions/forkmap/lineage/event/surface/
  // status/doctor/snapshot/summaries）已随版本记录一并拆除。

  function handleRunningState(req, res, hostCtx, sessions, agents, searchParams) {
    try {
      // 与 index.js 的 harness `retrace.runningState` 同构(动态桥入口已有,
      // index.js);HTTP 面补发布模式 client 的 fetch 通道。
      const guardCtx = { sessions, agents, jobs: hostCtx?.jobs }
      const sessionId = searchParams.get('sessionId') ?? ''
      const value = sessionId
        ? sessionRunningState(guardCtx, sessionId)
        // url 一并传 + 宿主自己读 Referer:报告人那套壳把桌面标记放在查询参数里
        // (`?…&dsh-desktop-mode=…`),而**我们自己的轮询 URL 没有 query** ⇒ 标记只在 Referer 里
        // (见 close-guard.js refererOf / pageSurfaceOf)。
        : { running: runningSessions(guardCtx), ...guardSurfaceOf(hostCtx, req?.headers, req?.url) }
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  /**
   * POST body parse + dispatch shared by the rollback/git ops.
   * `validate(args)` returns `null` or a wire `{code,message}` problem object;
   * a problem is answered with HTTP 400 **before** any side effect (setConfig /
   * dispatch), so a malformed range never reaches the executor.
   */
  function handleJsonPost(req, res, fn, { validate = null } = {}) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        sendJson(res, 413, {
          ok: false,
          error: { code: 'payload-too-large', message: 'payload exceeds 64 KiB' },
        })
        req.destroy()
      }
    })
    req.on('error', () => { /* socket errors are terminal; nothing to send */ })
    req.on('end', async () => {
      let args = {}
      if (body.length > 0) {
        try {
          args = JSON.parse(body)
        } catch {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-json', message: 'request body is not valid JSON' },
          })
          return
        }
      }
      const sessionId = String(args?.sessionId ?? '')
      if (typeof validate === 'function') {
        const problem = validate(args)
        if (problem !== null && problem !== undefined) {
          sendJson(res, 400, { ok: false, error: problem })
          return
        }
      }
      if (sessionId && seam) seam.setConfig(sessionId, parseRetraceConfig(req.headers['x-retrace-config']))
      try {
        const value = await fn(args)
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        sendError(res, error, log)
      }
    })
  }

  function handlePost(req, res, op) {
    try {
      res.__retraceOp = op
      res.__retraceLog = log
    } catch { /* res 上加属性失败也照常处理 */ }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        sendJson(res, 413, {
          ok: false,
          error: { code: 'payload-too-large', message: 'payload exceeds 64 KiB' },
        })
        req.destroy()
      }
    })
    req.on('error', () => { /* socket errors are terminal; nothing to send */ })
    req.on('end', async () => {
      let args = {}
      if (body.length > 0) {
        try {
          args = JSON.parse(body)
        } catch {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-json', message: 'request body is not valid JSON' },
          })
          return
        }
      }
      // fold 端点：区间必须是**原始安全整数**（Number(null)=0 / Number('')=0 /
      // Number(true)=1 曾把缺参折成 seq 0，把首节点折掉）。end 缺省 = 自动边界，
      // 属合法路径，行为不变。
      if (op === 'fold' && !isFoldRange(args)) {
        sendJson(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: 'fold 需要原始整数 start；提供 end 时须为原始整数且 end ≥ start' },
        })
        return
      }
      // 调用方自带的 span 一律忽略：宿主始终从会话日志重算（防伪造遮蔽区间）。
      if (SPAN_OPS.has(op)) args = withoutClientSpan(args)
      const sessionId = String(args?.sessionId ?? '')
      if (sessionId && seam) seam.setConfig(sessionId, parseRetraceConfig(req.headers['x-retrace-config']))
      // 晚绑定：编辑器 API 优先，其余从 extraOps **同一对象引用**现取（见上面的说明）。
      const opFn = api[op] ?? extraOps[op]
      if (typeof opFn !== 'function') {
        sendJson(res, 404, {
          ok: false,
          error: { code: 'unknown-op', message: `unknown operation "${op}"` },
        })
        return
      }
      // 自动收起默认关闭闸的来源判定:HTTP fold = 客户端用户显式发起 ⇒ 打 userInitiated
      // (写入器只放行显式用户折叠;自动层走 foldOneChunk,不经过这里)。
      if (op === 'fold') args = { ...args, userInitiated: true }
      // 编辑操作前从文件算遮蔽(绕开 host 稀疏 events,用户方案)
      // recall mode 改 tail(遮蔽目标轮及之后全部)——与 index.js harness 入口
      // 同语义(HTTP 入口此前漏改仍 round,两入口分叉违反"编辑走哪个入口都生效")
      if ((op === 'recall' || op === 'editAndResend' || op === 'regenerate') && !args?.span) {
        try {
          const target = typeof args?.seq === 'number' ? args.seq : args?.messageId
          if (target !== undefined && target !== null && !args?.span) {
            const mode = op === 'recall' || (op === 'editAndResend' && args?.fromScratch) ? 'tail' : 'round'
            // 与 index.js harness 入口对齐——**单次**
            // spanProbeFromFile(span + 文件快照事实一次读回)。旧实现 spanFromFile
            // 主调 + span null 才补 spanProbeFromFile = 同一请求两次读文件,两次快照
            // 之间文件可能被 flush(TOCTOU:span 与 facts 来自不同快照,判定可能自相
            // 矛盾);一次 probe 结果内部自洽,两入口零分叉。
            const probe = await dshAdapter.spanProbeFromFile(sessionId, target, mode)
            if (probe?.span) {
              args = { ...args, span: probe.span }
              // regenerate 的重发原文 = 该轮前置
              // user 的**文件侧**原文(probe.prompt = round span 起点 user 原文),
              // 与 index.js harness 入口同源——host-core 不直扫内存稀疏 events。
              if (op === 'regenerate' && probe.prompt) args = { ...args, regeneratePrompt: probe.prompt }
            } else {
              // 按**显式状态**下传(不再靠"span 为 null + 事实"猜)——
              // not-persisted → message-pending;already-shadowed → target-shadowed;
              // not-found → message-not-found;replay-failed → 内部错误。
              // spanMissArgsOf 只在文件侧确有快照证据时返回,无证据 → 业务层按内存视图判定。
              //
              // ⚠️ 公开层安全:这里**不能**用「行级删除标记」挂在
              // `else if (op !== 'fold') {` 那一行上——整行(含收尾 `}` 与开头 `{`)被删掉后,
              // 分支体被上层 if 吸收成死代码(HTTP 入口状态判定全失效,语法却仍合法)。
              // 折叠的分支差异改用**块级替换**(私有分支 / 公开分支各自完整、括号自洽)。
              const miss = spanMissArgsOf(probe)
              if (miss) args = { ...args, ...miss }
            }
          }
        } catch { /* span 计算失败 fallback 内部 */ }
      }
      try {
        const result = await opFn(args)
        sendJson(res, 200, result)
      } catch (error) {
        sendError(res, error, log)
      }
    })
  }

  return (req, res) => {
    // 【本 fork 加固】同一次请求只处理一遍。
    // 宿主重载插件时旧的 prefix 处理器可能还挂在路由表上，同一个 res 会进到两个
    // handler：两遍都跑 op（副作用翻倍，比如重新生成跑两次），再各自发一次响应
    // ⇒ 第二个撞 ERR_HTTP_HEADERS_SENT，宿主直接退出（实测过一次）。
    if (res.__retraceServed === true) return
    res.__retraceServed = true
    // 安全边界（文件头）：loopback socket peer + Host 回环；浏览器 Origin 必须同源。
    // fail-closed —— 任一项对不上都 403，且不触达任何 handler / seam / 会话读。
    if (!isLoopbackRequest(req, { allowRemote: remoteAllowed() })) {
      return sendJson(res, 403, {
        ok: false,
        error: { code: 'origin-not-allowed', message: 'request must arrive on the loopback interface' },
      })
    }
    if (!originAllowed(req.headers?.origin, req.headers?.host)) {
      return sendJson(res, 403, {
        ok: false,
        error: { code: 'origin-not-allowed', message: 'browser origin does not match this host' },
      })
    }
    const url = new URL(req.url ?? '/', 'http://inherit.local')
    const segments = url.pathname.split('/').filter(Boolean)
    const op = segments.at(-1) ?? ''
    const searchParams = url.searchParams
    const sessionId = searchParams.get('sessionId') ?? ''
    const config = parseRetraceConfig(req.headers['x-retrace-config'])

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-retrace-config',
      })
      res.end()
      return
    }
    if (req.method === 'GET') {
      switch (op) {
        // 【本 fork 改动】versions / forkmap / lineage / event / surface / status /
        // doctor / summaries / snapshot 这些只读接口随「读档点」一起拆掉了：
        // 它们全靠 versioning seam，界面上已经没有任何入口。
        // 关闭守卫 V2:运行中状态(client 轮询缓存;纯读)。
        case 'runningState':
          return void handleRunningState(req, res, ctx, sessions, agents, searchParams)
        default:
          return sendJson(res, 404, {
            ok: false,
            error: { code: 'unknown-op', message: `unknown operation "${op}"` },
          })
      }
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: 'POST or GET only' },
      })
    }
    // 【本 fork 改动】rollback / git POST 分支随读档功能一起拆除（回档执行器已卸）。
    if (segments.includes('rollback') || (segments.includes('git') && op === 'init')) {
      return sendJson(res, 410, {
        ok: false,
        error: { code: 'removed', message: 'timeline rollback was removed from this build' },
      })
    }
    // 关闭守卫 V2:POST 形状与 harness 动态桥(retrace.runningState)
    // 对齐——client 的 callOp 通道无论走 wire 还是 HTTP 都拿到同一形状。
    if (op === 'runningState') {
      return handleJsonPost(req, res, async (args) => {
        const guardCtx = { sessions, agents, jobs: ctx?.jobs }
        const sid = String(args?.sessionId ?? '')
        return sid
          ? sessionRunningState(guardCtx, sid)
          : { running: runningSessions(guardCtx), ...guardSurfaceOf(ctx, req?.headers, req?.url) }
      })
    }
    // 客户端半自报：证明"客户端半装载了 + 注册了
    // 几个会话 Definition / 槽位、走的是哪个注册入口"。**只打日志**（ctx.logger.info
    // ⇒ 宿主日志里的 `[dsh-inherit-compression] …`），不落盘、不写会话、不改任何状态。
    // 客户端不再"静默降级"：取不到注册入口时也会带着 definitions=0 报到这行。
    if (op === 'clientReport') {
      return handleJsonPost(req, res, (args) => {
        // ⚠️ 只有**注册上报**才配叫 "client: loaded"。通用上报（失败/诊断，如
        // `badgeMap-failed: HTTP 404`）载荷里没有 inject/definitions/slots/seats；
        // 此前它们被同一行格式打印成 `inject=[] definitions=0 slots=0 seats=0`，
        // 看上去像"客户端半完全没注册"——就是这么误判的。分两行打。
        const isLoadReport = Array.isArray(args?.inject)
          || args?.definitions !== undefined || args?.slots !== undefined || args?.seats !== undefined
        if (!isLoadReport) {
          log(`[dsh-inherit-compression] client report  id=${String(args?.id ?? '')}  source=${String(args?.source ?? 'none')}`)
          return { logged: true }
        }
        const injectList = Array.isArray(args?.inject) ? args.inject.join(',') : ''
        log(
          `[dsh-inherit-compression] client: loaded  id=${String(args?.id ?? '')}  inject=[${injectList}]`
          + `  definitions=${Number(args?.definitions) || 0}  slots=${Number(args?.slots) || 0}`
          + `  seats=${Number(args?.seats) || 0}  uiConversationSource=${String(args?.source ?? 'none')}`,
        )
        return { logged: true }
      })
    }

    // 通用分发(handles every `createEditorApi` op, including 0.4.124's
    // `unhide`): `api[op]` — recall / editAndResend / regenerate / **unhide** /
    // fold… 都从这里出去。
    // ⚠️ 路由选择(与 rollback 的**手写分支**不同,这是有意的):
    //   · `unhide` 是 host-core 的一等 op ⇒ 通用分发天然覆盖它,**不需要**新增手写
    //     分支,也不可能出现"只挂一条通道"的错(rollback 手写分支是为了带 preview
    //     子路由与 rollback-unavailable 差异化错误码,这里没有这些需求);
    //   · 因此 `unhide` **不**进 test/op-channel-parity.test.js 的
    //     HTTP_ONLY_BY_DESIGN 名单 —— 它 harness(`retrace.unhide`)与 HTTP
    //     (`api[op]`)两条通道都可达,更严的规则(两条都在)成立。
    // 兜住整条 POST 通道：任何抛错都只回 500，绝不让它变成未处理的 Promise 拒绝。
    // 实测过一次教训：这条路径上一旦抛错，宿主进程会直接退出（点撤回 = 应用崩掉）。
    return void handlePost(req, res, op).catch((error) => {
      try { sendError(res, error, log) } catch { /* 连接已断就算了 */ }
    })
  }
}
