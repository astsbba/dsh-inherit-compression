/**
 * 冒烟：只在 node 里把客户端 bundle 跑一遍，确认
 *   ① 文件还能被当成一个模块注册（没被我们那段注入搞坏）
 *   ② 工厂返回的东西仍然有 apply / inject
 *   ③ 我们的注入代码确实在里面，并且把 apply 包住了
 * 不调用 apply（那需要真的 cordis ctx），只验证启动期不会炸。
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
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => { captured = reg } }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }),
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
    createElement: () => ({ dataset: {}, style: {}, set textContent(v) {}, remove() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
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
