// 六个页签全遍历冒烟：每个页签都要能渲染出内容，且不报 ReferenceError / 不崩
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(path.join(HERE, '..', 'package.json'))
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom')
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = (process.argv.find(a => a.startsWith('--file=')) || '').slice(7)
          || path.join(HERE, '..', 'lib', 'client.js')
const code = readFileSync(FILE, 'utf8')
let def = null
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom
window.__ModuleLoader__ = { load: (d) => { def = d } }
globalThis.window = window; globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node
globalThis.MutationObserver = window.MutationObserver; globalThis.Event = window.Event; globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = false

const B = (u) => {
  if (u.startsWith('/mc/state')) return { ok: true, minecraftDir: 'C:/x', defaults: { memoryMb: 4096, username: 'Steve' }, javaList: [], versions: [{ id: '26.2', type: 'release', loader: 'vanilla', base: '26.2', javaMajor: 25, hasJar: true, missingCount: 0 }], selected: '26.2', running: false, msAccount: { loggedIn: false }, msConfig: { flow: 'auth-code' } }
  if (u.startsWith('/mc/settings')) return { ok: true, values: { memoryMb: 4096, gameDirMode: 'isolated', downloadSourcePreference: 'mirror-first' }, fields: [{ key: 'memoryMb', label: '内存', type: 'number', min: 256, max: 32768 }], files: { config: 'C:/x.json' } }
  if (u.startsWith('/mc/advice')) return { ok: true, author: '龙腾猫跃（LTCat）', stats: { launches: 3 } }
  if (u.startsWith('/mc/mod/search') || u.startsWith('/mc/pack/list')) return { ok: true, total: 0, hits: [] }
  if (u.startsWith('/mc/mod/installed')) return { ok: true, dir: 'C:/x/mods', entries: [] }
  if (u.startsWith('/mc/dl/state')) return { ok: true, config: { dir: 'C:/x', concurrency: 16 }, task: null }
  if (u.startsWith('/mc/java/runtimes')) return { ok: true, platform: 'windows-x64', installed: 0, runtimes: [] }
  if (u.startsWith('/mc/java/state') || u.startsWith('/mc/loader/state') || u.startsWith('/mc/pack/state')) return { ok: true, task: null }
  if (u.startsWith('/mc/loader/list')) return { ok: true, loaders: [] }
  if (u.startsWith('/mc/loader/instances')) return { ok: true, instances: [] }
  if (u.startsWith('/mc/inst/summary')) return { ok: true, versionId: '26.2', gameDir: 'C:/x', counts: { mods: { enabled: 0, disabled: 0 }, resourcepacks: 0, shaderpacks: 0, saves: 0, config: 0, logs: 0, crashReports: 0 }, sizeBytes: 0, lastPlayed: null, latestLog: null, latestCrash: null }
  if (u.startsWith('/mc/inst/content')) return { ok: true, kind: 'mods', dir: 'C:/x/mods', entries: [] }
  return { ok: true }
}
const fetchStub = (url, opts) => {
  const u = String(url); const b = B(u)
  return Promise.resolve({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })
}
window.fetch = fetchStub
const sb = { window, document: window.document, console, fetch: fetchStub, setTimeout, clearTimeout, setInterval, clearInterval, MutationObserver: window.MutationObserver, Promise, JSON, Object, Array, String, Number, Boolean, Error, Math, Date, URLSearchParams: globalThis.URLSearchParams, URL: globalThis.URL, navigator: window.navigator, encodeURIComponent, decodeURIComponent, isFinite }
sb.globalThis = sb
vm.createContext(sb); vm.runInContext(code, sb)
const mod = def.factory(require)
const regs = []
const slots = { inject: (n, f) => f(), register: (o, c) => { regs.push({ o, c }); return () => {} } }
mod.apply({ slots, effect: (f) => f(), get: () => slots })
const PanelMain = regs.find(r => r.o && r.o.key === 'mc-toolbox').c

const React = require('react'); const { createRoot } = require('react-dom/client')
const host = window.document.createElement('div'); window.document.body.appendChild(host)
const errors = []
const origErr = console.error
console.error = (...a) => { errors.push(a.map(x => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' ')) }
process.on('uncaughtException', (e) => {
  console.log(`  ✘ 未捕获渲染错误: ${String(e && e.message || e).slice(0, 140)}`)
  process.exit(1)
})
const root = createRoot(host); root.render(React.createElement(PanelMain))
const tick = (ms = 700) => new Promise(r => setTimeout(r, ms))
const txt = () => host.textContent || ''

await tick(1100)
const TABS = [
  ['启动', ['启动配置', '版本', '内存']],
  ['版本', ['概览', 'Java 运行时']],
  ['资源', ['模组市场', '搜索']],
  ['下载', ['下载']],
  ['设置', ['设置', '保存']],
  ['关于', ['龙腾猫跃', '赞助', 'MIT']],
]
let pass = 0, fail = 0
for (const [label, marks] of TABS) {
  const btn = [...host.querySelectorAll('button,div,span')].find(e => (e.textContent || '').trim() === label && e.childElementCount === 0)
  if (!btn) { console.log(`  ✘ ${label}: 找不到页签按钮`); fail++; continue }
  errors.length = 0
  try {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick(1100)
  } catch (e) {
    fail++
    console.log(`  ✘ ${label}: 渲染抛错 → ${String(e && e.message || e).slice(0, 120)}`)
    continue
  }
  const body = txt()
  const missing = marks.filter(m => !body.includes(m))
  const crashed = errors.some(e => /is not defined|Cannot read|undefined is not|Minified React error/i.test(e))
  const empty = body.trim().length < 40
  if (crashed || empty || missing.length) {
    fail++
    console.log(`  ✘ ${label}: ${crashed ? '渲染抛错' : empty ? '内容为空（白屏）' : '缺标记 ' + JSON.stringify(missing)}`)
    if (errors[0]) console.log(`      首个错误: ${errors[0].slice(0, 140)}`)
    console.log(`      实际文本: ${body.replace(/\s+/g, ' ').slice(0, 180)}`)
  } else { pass++; console.log(`  ✔ ${label}: 渲染正常（${body.trim().length} 字符）`) }
}
// 再切回启动，确认来回切换不会崩
const back = [...host.querySelectorAll('button,div,span')].find(e => (e.textContent || '').trim() === '启动' && e.childElementCount === 0)
back.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(900)
const roundTrip = (txt().trim().length > 40)
console.log(`  ${roundTrip ? '✔' : '✘'} 切回「启动」仍正常`)
const warns = errors.filter(e => /warning/i.test(e))
console.log(`\n结果：${pass} 通过 / ${fail} 失败 | 切回=${roundTrip} | React warning=${warns.length}`)
root.unmount()
process.exit(fail === 0 && roundTrip ? 0 : 1)
