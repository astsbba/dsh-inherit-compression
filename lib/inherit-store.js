/**
 * dsh-inherit-compression · 状态存储
 *
 * 一份纯 JSON，写到 ~/.dsh/inherit-compression/state.json。
 * 写入用「临时文件 + rename」，崩了不会留半个文件。
 * 日志单独一份 log.txt，和 retrace 自己的日志不混。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function dataRoot() {
  return join(homedir(), '.dsh', 'inherit-compression')
}

/**
 * 改名搬家：旧目录 `~/.dsh/retrace-inherit` 里的设置与日志拷一份过来。
 *
 * 只拷要用的两份，旧目录原样留着不删——搬错了还能回去找。
 * 新目录里已经有了就跳过，不会覆盖你后来改的设置。
 */
function migrateLegacyDir() {
  try {
    const next = dataRoot()
    const prev = join(homedir(), '.dsh', 'retrace-inherit')
    if (!existsSync(prev)) return
    for (const name of ['state.json', 'log.txt']) {
      const to = join(next, name)
      if (existsSync(to)) continue
      const from = join(prev, name)
      if (!existsSync(from)) continue
      mkdirSync(next, { recursive: true })
      copyFileSync(from, to)
    }
  } catch { /* 搬不过来就从空状态起步，不能因为迁移把插件搞崩 */ }
}

function statePath() {
  return join(dataRoot(), 'state.json')
}

/**
 * 本地时间戳（带时区偏移）。
 *
 * 为什么不用 toISOString：那是 UTC，界面上会显示成早八小时，看日志的人全会懵。
 * 这里给出 2026-11-16T19:02:33.123+08:00 这种形状——本地钟点 + 明确的偏移量，
 * 既对得上墙上的钟，也没有歧义。
 */
function localStamp() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function log(line, extra) {
  try {
    mkdirSync(dataRoot(), { recursive: true })
    const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
    appendFileSync(join(dataRoot(), 'log.txt'), `${localStamp()} ${line}${tail}\n`, 'utf8')
  } catch { /* 日志写不了就算了，不能因为日志把插件搞崩 */ }
}

export function logPath() {
  return join(dataRoot(), 'log.txt')
}

/** 日志尾巴。给设置面板用：出问题时直接把这段发我。 */
export function readLogTail(maxLines = 200) {
  try {
    const raw = readFileSync(logPath(), 'utf8')
    const lines = raw.split('\n')
    const take = Math.max(1, Math.min(2000, Number(maxLines) || 200))
    return lines.slice(Math.max(0, lines.length - take)).join('\n')
  } catch {
    return ''
  }
}

/**
 * 日志超限就截断：保留最后一半。
 * 日志只用于排障，不保留历史价值，越积越多只会拖慢面板。
 */
export function trimLog(maxBytes = 200 * 1024) {
  try {
    const file = logPath()
    const stat = statSync(file)
    if (stat.size <= maxBytes) return false
    const keep = Math.floor(maxBytes / 2)
    const raw = readFileSync(file)
    const tail = raw.subarray(Math.max(0, raw.length - keep)).toString('utf8')
    // 从第一个完整行开始，避免留下半行
    const cut = tail.indexOf('\n')
    writeFileSync(file, cut >= 0 ? tail.slice(cut + 1) : tail, 'utf8')
    return true
  } catch {
    return false
  }
}

const EMPTY = () => ({ version: 1, settings: {}, roots: {} })

/** 老插件（dsh-session-inherit）的设置搬一次过来，别让他重填提示词。 */
function migrateSettingsFromOld() {
  try {
    const old = join(homedir(), '.dsh', 'session-inherit', 'state.json')
    if (!existsSync(old)) return {}
    const parsed = JSON.parse(readFileSync(old, 'utf8'))
    const s = parsed && typeof parsed === 'object' ? parsed.settings : null
    if (!s || typeof s !== 'object') return {}
    const out = {}
    if (Number.isFinite(Number(s.triggerTokens))) out.triggerTokens = Math.floor(Number(s.triggerTokens))
    if (typeof s.prompt === 'string' && s.prompt.trim() !== '') out.prompt = s.prompt
    if (typeof s.provider === 'string' && s.provider.trim() !== '') out.provider = s.provider.trim()
    if (typeof s.model === 'string' && s.model.trim() !== '') out.model = s.model.trim()
    log('MIGRATE', `从 session-inherit 搬来 ${Object.keys(out).join(',') || '（无）'}`)
    return out
  } catch (e) {
    log('MIGRATE_FAIL', String(e && e.message || e))
    return {}
  }
}

export function loadState() {
  migrateLegacyDir()
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.version === 1) {
      parsed.roots = parsed.roots && typeof parsed.roots === 'object' ? parsed.roots : {}
      parsed.settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
      return parsed
    }
  } catch { /* 首次运行或文件坏了，都从空状态起步 */ }
  const fresh = EMPTY()
  fresh.settings = migrateSettingsFromOld()
  return fresh
}

export function saveState(state) {
  const root = dataRoot()
  mkdirSync(root, { recursive: true })
  const target = statePath()
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, target)
}

/** 这条会话的继承记录（key 就是会话 id）。 */
export function rootOf(state, sessionId) {
  const id = String(sessionId ?? '')
  return state.roots[id] || null
}

export function newRoot(sessionId, anchorSeq, anchorMessageId) {
  const id = String(sessionId)
  return {
    rootId: id,
    anchorSeq: Number(anchorSeq),
    anchorMessageId: String(anchorMessageId ?? ''),
    cursorSeq: Number(anchorSeq),
    enabled: true,
    chain: '',
    createdAt: Date.now(),
    lastCompressedAt: 0,
    lastAttemptAt: 0,
    compressions: 0,
  }
}
