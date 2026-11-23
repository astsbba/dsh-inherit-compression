/**
 * 冒烟：在 node 里把客户端 bundle 跑一遍。
 *   ① 文件还能被当成一个模块注册（没被注入搞坏）
 *   ② 工厂返回的东西仍然有 apply / inject
 *   ③ 注入代码确实在里面，并且把 apply 包住了
 *   ④ **真的调用一次 apply**，用一个假 ctx 把所有槽挂一遍——
 *      之前吃过亏：注入段里引用了删掉的函数（installEditAffordance），
 *      文件加载没问题、apply 一跑就抛，界面上只是"没反应"。这一步就是防这个。
 *
 *   node smoke-inherit.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const file = fileURLToPath(new URL('./lib/client.bundle.js', import.meta.url))
const code = readFileSync(file, 'utf8')

if (!code.includes('dsh-inherit-compression: 继承功能')) throw new Error('注入代码没进 bundle')
if (!code.includes('var originalApply = apply')) throw new Error('apply 包装没进 bundle')

let captured = null
const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useContext: () => null,
  useSyncExternalStore: () => null,
  Component: class { constructor(props) { this.props = props } setState() {} },
  PureComponent: class { constructor(props) { this.props = props } setState() {} },
  createContext: () => ({ Provider: () => null, Consumer: () => null }),
}
const reports = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: (reg) => { captured = reg } },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setInterval: (fn, ms) => 0,
    clearInterval() {},
    setTimeout: (fn, ms) => 0,
    clearTimeout() {},
    confirm: () => false,
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  fetch: (url, opts) => {
    if (String(url).includes('/clienterror') && opts && opts.body) {
      try { reports.push(JSON.parse(String(opts.body))) } catch { /* 忽略 */ }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: false, roots: {} }) })
  },
  TextEncoder,
  TextDecoder,
  URL,
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  addEventListener() {},
  removeEventListener() {},
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, set textContent(v) {}, remove() {}, appendChild() {}, addEventListener() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  },
  globalThis: null,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.bundle.js' })

if (captured === null) throw new Error('bundle 没有注册模块')
if (captured.id !== 'dsh-inherit-compression') throw new Error(`模块 id 不对：${captured.id}`)

const mod = captured.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error(`意外的外部依赖：${spec}`)
})

if (typeof mod !== 'object' || mod === null) throw new Error('工厂没有返回模块对象')
if (typeof mod.apply !== 'function') throw new Error('模块没有 apply')
if (!String(mod.apply).includes('mountInherit')) throw new Error('apply 没被我们包住（注入没生效）')
if (mod.inject === undefined) throw new Error('模块没有 inject')

console.log('ok  id =', captured.id)
console.log('ok  exports =', Object.keys(mod).slice(0, 8).join(','), '…')
console.log('ok  inject =', JSON.stringify(mod.inject))

// ── 真的跑一次 apply：假 ctx 把槽全挂一遍 ──────────────────────────
const mountLog = []
function fakeCtx() {
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { get: () => undefined, binding: () => null }
      if (name === 'conversation') return null
      if (name === 'uiConversation') return undefined
      if (name === 'conversationEvents') return { register: () => () => {} }
      return undefined
    },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    inject: (names, cb) => { try { cb(ctx) } catch { /* 忽略 */ } },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (seat, fn) => { mountLog.push('inject:' + seat); return fn() },
      register: (spec) => { mountLog.push('register:' + spec.name + '#' + (spec.id || spec.key || '?')); return () => {} },
    },
  }
  return ctx
}

let applyError = null
try {
  mod.apply(fakeCtx(), {})
} catch (error) {
  applyError = error
}
if (applyError) throw new Error(`apply 抛错了：${applyError && applyError.message}`)
const bad = reports.filter((r) => !/^(mount-ok|apply-ok)/.test(String(r.phase || '')))
if (bad.length > 0) {
  throw new Error(`apply 期间有失败上报：${JSON.stringify(bad.slice(0, 3))}`)
}
console.log('ok  apply 挂载：', mountLog.join(' → '))
process.exit(0)
