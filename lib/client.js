/**
 * @dsh-external/pcl-toolbox —— 「PCL 工具箱」浏览器半边（经典脚本，无打包器）。
 *
 * 一个侧栏入口 + 一个面板，面板内部用页签切换三个子面板：
 *   页签「启动」= 原 dsh-pcl-launch 的启动面板（宿主路由前缀 /mc）
 *   页签「版本」= 实例内容管理面板（模组/资源包/光影/存档/配置/日志/崩溃 + 崩溃分析，
 *               宿主路由前缀 /mc/inst；后端见 lib/inst-routes.js、lib/instance.js）
 *   页签「下载」= 原 dsh-mc-downloader 的下载面板（宿主路由前缀 /mc/dl）
 * 两个旧包已合并进这一个 client，因此本文件同时保留两种 API 前缀，
 * 宿主侧需要同时挂载 /mc 与 /mc/dl 两条同源路由。
 *
 * 结构性约定（都是踩过的坑，别改回去）：
 *   1. 外层 幂等护栏 + 唯一一次模块加载调用：id 必须逐字等于包名，重复执行时
 *      第二次直接 return，最坏退化成「侧栏没图标」，而不是整个 web boot 起不来。
 *   2. 三个面板的实现体各自包在 (function(){ ... })() 里靠闭包隔离：它们存在大量
 *      同名顶层标识符（PANEL_ID / API / API_BASE / store / useDark / palette /
 *      Btn / PanelMain / PanelIcon ...），隔离后各自遮蔽，互不影响，逻辑一字未改。
 *      体内只删掉了取 react 与取 createElement 的声明行（统一用外层那两份），
 *      以及原来的 exports/inject/apply 注册尾巴（改由外层一次注册）。
 *   3. apply() 整体 try/catch，绝不外抛：它抛异常会让 entry 激活失败、连带 web boot 失败。
 *   4. 只用内联 style（不注入 style 标签、不查别人 DOM）；只从宿主拿一份 react。
 *
 * 合并前的两个源文件：dsh-pcl-launch/lib/client.js（906 行）、
 * dsh-mc-downloader/lib/client.js（1304 行）。行号区间见体内注释。
 */
;(function () {
  if (window.__dshMcToolboxRegistered) return
  window.__dshMcToolboxRegistered = true
  window.__ModuleLoader__.load({
    id: '@dsh-external/pcl-toolbox',
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      // 整个文件唯一一次取 react，两个面板体与外壳共用。
      const React = require('react')
      const h = React.createElement


      // ══════════════════════════════════════════════════════════════════════
      // 页签「启动」—— 原 dsh-pcl-launch 的 factory 体（闭包隔离，内部标识符不外泄）
      // 取自原文件第 39 行 (const { useState... }) 到第 879 行（PanelMain 收尾）。
      // 相对原文只有两处改动：① 删掉取 react / 取 createElement 的声明行；
      // ② 末尾 return 出面板组件（原图标组件名为 McIcon，这里以 PanelIcon 键暴露）。
      // 轮询 store、/mc 前缀、所有 helper 与样式函数均原样保留。
      // ══════════════════════════════════════════════════════════════════════
      const LaunchUI = (function () {

        const { useState, useEffect, useRef } = React

        const PANEL_ID = 'mc-launch'
        const API = '/mc'
        const POLL_RUNNING_MS = 1500
        const POLL_IDLE_MS = 5000

        // ========================================================== 纯函数小工具
        function errText(e) {
          try { return String((e && e.message) || e || '未知错误') } catch (_e) { return '未知错误' }
        }

        function firstOf(list) {
          for (let i = 0; i < list.length; i += 1) if (list[i]) return list[i]
          return ''
        }

        function midEllipsis(text, max) {
          const s = String(text === undefined || text === null ? '' : text)
          if (!s || s.length <= max) return s
          const keep = Math.max(4, max - 1)
          const head = Math.ceil(keep * 0.58)
          const tail = Math.max(1, keep - head)
          return s.slice(0, head) + '…' + s.slice(-tail)
        }

        function fmtUptime(startedAt, now) {
          if (!startedAt) return ''
          const s = Math.max(0, Math.round(((now || Date.now()) - startedAt) / 1000))
          if (s >= 3600) return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分'
          if (s >= 60) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
          return s + ' 秒'
        }

        function fmtStamp(ms) {
          const n = Number(ms)
          if (!n || !Number.isFinite(n)) return ''
          const d = new Date(n)
          if (!Number.isFinite(d.getTime())) return ''
          const p = (x) => (x < 10 ? '0' + x : String(x))
          return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
            ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
        }

        function clampMem(n) {
          const v = Number(n)
          if (!Number.isFinite(v)) return 4096
          return Math.max(256, Math.min(32768, Math.round(v)))
        }

        function planMissingCount(plan) {
          if (!plan) return 0
          const count = Number(plan.missingCount) || 0
          const len = Array.isArray(plan.missing) ? plan.missing.length : 0
          return Math.max(count, len)
        }

        function javaDesc(j) {
          if (!j) return '（自动）'
          if (typeof j === 'string') return j
          const base = j.exe || j.folder || ''
          const bits = []
          if (j.major) bits.push('Java ' + j.major)
          if (j.arch) bits.push(String(j.arch) + ' 位')
          if (j.version) bits.push(String(j.version))
          if (j.from) bits.push(String(j.from))
          const detail = bits.join(' · ')
          if (base && detail) return base + '  （' + detail + '）'
          return base || detail || '（自动）'
        }

        function javaLabel(j) {
          if (!j) return 'Java'
          const bits = []
          if (j.major) bits.push('Java ' + j.major)
          if (j.arch) bits.push(String(j.arch) + '位')
          if (j.version) bits.push(String(j.version))
          let text = bits.join(' · ')
          if (!text) text = j.folder || j.exe || 'Java'
          if (j.from) text += ' — ' + j.from
          if (j.ok === false) text += '（不可用）'
          return text
        }

        function versionOptionLabel(v) {
          let text = String((v && v.id) || '')
          text += ' · ' + (v && v.javaMajor ? 'Java ' + v.javaMajor : 'Java 未标注')
          const miss = Number(v && v.missingCount) || 0
          if (miss > 0) text += '  ⚠ 缺 ' + miss + ' 个文件'
          return text
        }

        function versionHint(v) {
          if (!v) return ''
          const bits = []
          if (v.type) bits.push(v.type === 'release' ? '正式版' : String(v.type))
          if (v.base && v.base !== v.id) bits.push('基于 ' + v.base)
          if (v.loader) bits.push('loader：' + v.loader)
          if (v.lastPlayed) bits.push('上次游玩 ' + fmtStamp(v.lastPlayed))
          return bits.join(' · ')
        }

        const LOADER_GROUPS = [
          { key: 'vanilla', label: '原版', test: (l) => l === '' || l === 'vanilla' || l === 'release' || l === 'none' || l === 'original' },
          { key: 'forge', label: 'Forge', test: (l) => l === 'forge' },
          { key: 'fabric', label: 'Fabric', test: (l) => l === 'fabric' },
          { key: 'neoforge', label: 'NeoForge', test: (l) => l === 'neoforge' || l === 'neo' },
          { key: 'optifine', label: 'OptiFine', test: (l) => l === 'optifine' || l === 'optifabric' },
        ]

        function groupVersions(versions) {
          const buckets = new Map()
          LOADER_GROUPS.forEach((g) => buckets.set(g.key, []))
          const other = []
          ;(versions || []).forEach((v) => {
            const loader = String((v && v.loader) || '').toLowerCase()
            const hit = LOADER_GROUPS.find((g) => g.test(loader))
            if (hit) buckets.get(hit.key).push(v)
            else other.push(v)
          })
          const out = []
          LOADER_GROUPS.forEach((g) => {
            const items = buckets.get(g.key)
            if (items.length) out.push({ key: g.key, label: g.label, items })
          })
          if (other.length) out.push({ key: 'other', label: '其它', items: other })
          return out
        }

        // ========================================================== HTTP 小门面
        async function api(path, method, body) {
          const init = { method: method || 'GET', headers: { 'content-type': 'application/json' } }
          if (body !== undefined) init.body = JSON.stringify(body)
          const res = await fetch(API + path, init)
          const text = await res.text()
          let json = null
          try { json = text ? JSON.parse(text) : null } catch (_e) { json = null }
          if (!res.ok) {
            const msg = (json && json.error) || String(text || '').slice(0, 300) || ('HTTP ' + res.status)
            throw new Error(msg)
          }
          if (json && json.ok === false) throw new Error(String(json.error || '宿主返回 ok=false'))
          return json
        }

        // ========================================================== 共享轮询 store
        // 侧栏图标与主面板共用一份数据 + 一个定时器（否则两处各轮一次、绿点还不同步）
        const store = {
          state: null,
          error: '',
          listeners: new Set(),
          timer: null,
          refs: 0,
          inflight: null,
        }

        function emit() {
          store.listeners.forEach((fn) => {
            try { fn() } catch (_e) { /* 单个订阅者坏了不影响别人 */ }
          })
        }

        function refresh() {
          if (store.inflight) return store.inflight
          store.inflight = (async () => {
            try {
              store.state = await api('/state')
              store.error = ''
            } catch (e) {
              store.error = errText(e)
            }
            store.inflight = null
            emit()
          })()
          return store.inflight
        }

        function pollDelay() {
          return (store.state && store.state.running) ? POLL_RUNNING_MS : POLL_IDLE_MS
        }

        function schedulePoll() {
          if (store.timer !== null) { clearTimeout(store.timer); store.timer = null }
          if (store.refs <= 0) return
          store.timer = setTimeout(() => {
            store.timer = null
            refresh().then(schedulePoll, schedulePoll)
          }, pollDelay())
        }

        function ensurePolling() {
          if (store.refs <= 0) return
          refresh().then(schedulePoll, schedulePoll)
        }

        function stopPolling() {
          if (store.timer !== null) { clearTimeout(store.timer); store.timer = null }
        }

        function useStore() {
          const [snap, setSnap] = useState(() => ({ state: store.state, error: store.error }))
          useEffect(() => {
            let alive = true
            const fn = () => { if (alive) setSnap({ state: store.state, error: store.error }) }
            store.listeners.add(fn)
            store.refs += 1
            ensurePolling()
            fn()
            return () => {
              alive = false
              store.listeners.delete(fn)
              store.refs -= 1
              if (store.refs <= 0) { store.refs = 0; stopPolling() }
            }
          }, [])
          return snap
        }

        // ========================================================== 主题
        function readDark() {
          try {
            return Boolean(typeof document !== 'undefined' && document.body &&
              document.body.hasAttribute('data-ds-dark-theme'))
          } catch (_e) { return false }
        }

        function useDark() {
          const [dark, setDark] = useState(readDark)
          useEffect(() => {
            if (typeof MutationObserver === 'undefined') return undefined
            let body = null
            try { body = document.body } catch (_e) { body = null }
            if (!body) return undefined
            const mo = new MutationObserver(() => setDark(readDark()))
            mo.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
            return () => mo.disconnect()
          }, [])
          return dark
        }

        function palette(dark) {
          return dark
            ? {
                dark: true,
                bg: '#17171b', card: '#212127', text: '#f4f4f5', sub: '#a1a1aa',
                line: 'rgba(255,255,255,.13)', log: '#0d0d10',
                input: '#1a1a1f', logText: '#d4d4d8', chip: 'rgba(255,255,255,.045)',
                errBg: 'rgba(127,29,29,.20)', errLine: 'rgba(239,68,68,.50)', errText: '#fca5a5',
                warnBg: 'rgba(120,53,15,.22)', warnLine: 'rgba(245,158,11,.42)', warnText: '#fcd34d',
                ok: '#22c55e', idle: '#9ca3af', bad: '#f87171', primary: '#2563eb', danger: '#ef4444',
              }
            : {
                dark: false,
                bg: '#f7f7f8', card: '#ffffff', text: '#18181b', sub: '#52525b',
                line: 'rgba(0,0,0,.12)', log: '#0f172a',
                input: '#ffffff', logText: '#d4d4d8', chip: 'rgba(0,0,0,.045)',
                errBg: 'rgba(254,226,226,.72)', errLine: 'rgba(239,68,68,.45)', errText: '#b91c1c',
                warnBg: 'rgba(254,243,199,.75)', warnLine: 'rgba(245,158,11,.42)', warnText: '#92400e',
                ok: '#16a34a', idle: '#9ca3af', bad: '#dc2626', primary: '#2563eb', danger: '#dc2626',
              }
        }

        // ========================================================== 通用视觉件
        function inputStyle(t) {
          return {
            padding: '7px 10px',
            borderRadius: 9,
            boxSizing: 'border-box',
            border: '1px solid ' + t.line,
            background: t.input,
            color: t.text,
            font: '13px/1.35 system-ui, "Microsoft YaHei", sans-serif',
            colorScheme: t.dark ? 'dark' : 'light',
          }
        }

        function selectStyle(t) {
          return Object.assign(inputStyle(t), { cursor: 'pointer', maxWidth: '100%' })
        }

        function Btn(props) {
          const t = props.t
          const disabled = Boolean(props.disabled)
          const primary = Boolean(props.primary)
          const danger = Boolean(props.danger)
          let bg = 'transparent'
          if (primary) bg = disabled ? (t.dark ? '#3f3f46' : '#9ca3af') : t.primary
          else if (danger && !disabled) bg = 'rgba(239,68,68,.10)'
          return h('button', {
            type: 'button',
            onClick: disabled ? undefined : props.onClick,
            disabled,
            style: {
              padding: '8px 16px',
              borderRadius: 10,
              cursor: disabled ? 'default' : 'pointer',
              font: '13px/1.3 system-ui, "Microsoft YaHei", sans-serif',
              border: '1px solid ' + (primary ? 'transparent' : (danger ? 'rgba(239,68,68,.55)' : t.line)),
              background: bg,
              color: primary ? '#ffffff' : (danger ? t.danger : t.text),
              opacity: disabled ? 0.6 : 1,
            },
          }, props.label)
        }

        function Chip(props) {
          const t = props.t
          const disabled = Boolean(props.disabled)
          return h('button', {
            type: 'button',
            disabled,
            onClick: disabled ? undefined : props.onClick,
            style: {
              padding: '5px 11px',
              borderRadius: 999,
              cursor: disabled ? 'default' : 'pointer',
              font: '12px/1.4 system-ui, "Microsoft YaHei", sans-serif',
              border: '1px solid ' + t.line,
              background: t.chip,
              color: disabled ? t.sub : t.text,
              opacity: disabled ? 0.6 : 1,
            },
          }, props.label)
        }

        function Field(props) {
          const t = props.t
          return h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: 6,
              flex: props.flex || '1 1 200px', minWidth: 150,
            },
          },
            h('span', { style: { color: t.sub, fontSize: 12 } }, props.label),
            props.children,
            props.hint ? h('span', { style: { color: t.sub, fontSize: 11, opacity: 0.85 } }, props.hint) : null)
        }

        function KV(props) {
          const t = props.t
          const mono = Boolean(props.mono)
          return h('div', {
            style: {
              display: 'flex', gap: 12, padding: '6px 0', alignItems: 'flex-start',
              borderBottom: '1px dashed ' + t.line,
            },
          },
            h('div', { style: { width: 84, flex: '0 0 auto', color: t.sub, fontSize: 12.5 } }, props.k),
            h('div', {
              style: {
                flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all',
                fontFamily: mono ? 'ui-monospace, Consolas, monospace' : 'inherit',
                fontSize: mono ? 12 : 13,
              },
            }, props.v))
        }

        function Card(props) {
          const t = props.t
          return h('div', {
            style: {
              marginTop: props.mt === undefined ? 16 : props.mt,
              background: t.card,
              border: '1px solid ' + t.line,
              borderRadius: 12,
              padding: '14px 16px',
            },
          },
            props.title
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, marginBottom: 10 } },
                  props.title, props.extra || null)
              : null,
            props.children)
        }

        // 运行中的 1 秒心跳（只在运行中开，卸载即清）
        function useNowTick(active) {
          const [now, setNow] = useState(() => Date.now())
          useEffect(() => {
            if (!active) return undefined
            setNow(Date.now())
            const id = setInterval(() => setNow(Date.now()), 1000)
            return () => clearInterval(id)
          }, [active])
          return now
        }

        // ========================================================== 侧栏图标
        function McIcon(props) {
          const size = (props && props.size) ? props.size : 18
          const active = Boolean(props && props.active)
          const snap = useStore()
          const running = Boolean(snap.state && snap.state.running)
          return h('span', {
            style: {
              position: 'relative', display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', lineHeight: 0,
            },
          },
            h('svg', {
              width: size,
              height: size,
              viewBox: '0 0 24 24',
              fill: 'none',
              'aria-hidden': 'true',
              focusable: 'false',
              style: { display: 'block', opacity: active ? 1 : 0.92 },
            },
              h('rect', {
                x: 3.1, y: 3.1, width: 17.8, height: 17.8, rx: 4.6,
                stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.7, strokeOpacity: active ? 1 : 0.9,
              }),
              h('path', { d: 'M10 8.5l6 3.5-6 3.5z', fill: running ? '#22c55e' : 'currentColor' })),
            running
              ? h('span', {
                  style: {
                    position: 'absolute', right: -1, bottom: -1, width: 7, height: 7,
                    borderRadius: '50%', background: '#22c55e',
                    boxShadow: '0 0 0 2px rgba(0,0,0,.35)',
                  },
                })
              : null)
        }

        // ========================================================== 账号卡
        // 正版登录的数据全部来自宿主已实现好的同源路由（/mc/ms/*）：
        //   · 展示用的账号态来自 GET /mc/state 的 msAccount（父面板已有轮询刷新，卡片自己不再拉数据）；
        //   · /mc/ms/start、/mc/ms/complete、/mc/ms/logout、/mc/ms/refresh 只在用户点按钮时才发
        //     —— 加载时绝不 start，否则会擅自弹浏览器。
        // 安全：token 不上屏、不落 localStorage，展示只用 name / uuid / owned。
        // 依赖：只用外层那一份 React（本闭包内的 useState）、api() 与 errText()（都在本闭包里）。
        function MsAccountCard(props) {
          const t = props.t
          const account = (props.account && typeof props.account === 'object') ? props.account : { loggedIn: false }
          const loggedIn = Boolean(account.loggedIn)
          const accountMode = props.accountMode === 'offline' ? 'offline' : 'online'
          const setAccountMode = (typeof props.setAccountMode === 'function') ? props.setAccountMode : (() => {})
          const onChanged = (typeof props.onChanged === 'function') ? props.onChanged : (() => Promise.resolve())

          const [flow, setFlow] = useState(null)   // /mc/ms/start 的响应；null = 登录区收起
          const [paste, setPaste] = useState('')   // 用户粘回来的整条回跳 URL
          const [busy, setBusy] = useState('')     // '' | start | complete | logout | refresh
          const [err, setErr] = useState('')

          // 只走 auth-code 这一条（零配置那条），不自动触发。
          const openFlow = async () => {
            if (busy) return
            setBusy('start')
            setErr('')
            try {
              const data = await api('/ms/start', 'POST', { flow: 'auth-code' })
              setFlow({
                url: String((data && data.url) || ''),
                hint: String((data && data.hint) || ''),
                flow: String((data && data.flow) || 'auth-code'),
                userCode: String((data && data.userCode) || ''),
              })
              setPaste('')
            } catch (e) {
              setErr(errText(e))
            } finally {
              setBusy('')
            }
          }

          const completeFlow = async () => {
            const input = String(paste || '').trim()
            if (!input || busy) return
            setBusy('complete')
            setErr('')
            try {
              await api('/ms/complete', 'POST', { input })
              setFlow(null)
              setPaste('')
              await onChanged()
            } catch (e) {
              setErr(errText(e))
            } finally {
              setBusy('')
            }
          }

          const doSwitch = async (uuid) => {
            if (busy || !uuid) return
            setBusy('switch')
            setErr('')
            try {
              await api('/ms/switch', 'POST', { uuid })
              setFlow(null)
              setPaste('')
              await onChanged()
            } catch (e) {
              setErr(String((e && e.message) || e))
            } finally {
              setBusy('')
            }
          }

          const doLogout = async () => {
            if (busy) return
            setBusy('logout')
            setErr('')
            try {
              await api('/ms/logout', 'POST', {})
              setFlow(null)
              setPaste('')
              await onChanged()
            } catch (e) {
              setErr(errText(e))
            } finally {
              setBusy('')
            }
          }

          const doRefreshToken = async () => {
            if (busy) return
            setBusy('refresh')
            setErr('')
            try {
              await api('/ms/refresh', 'POST', {})
              await onChanged()
            } catch (e) {
              setErr(errText(e))
            } finally {
              setBusy('')
            }
          }

          const openAuthUrl = (url) => {
            try {
              if (url && typeof window !== 'undefined' && typeof window.open === 'function') {
                window.open(url, '_blank', 'noopener')
              }
            } catch (_e) { /* 弹窗被拦就退化成手动复制下面那行地址 */ }
          }

          // 二选一的启动模式（正版 / 离线）——直接决定 /mc/launch 的 accountMode
          const modeBtn = (label, value) => {
            const on = accountMode === value
            return h('button', {
              type: 'button',
              onClick: () => setAccountMode(value),
              style: {
                padding: '5px 12px',
                borderRadius: 999,
                cursor: 'pointer',
                font: '12px/1.4 system-ui, "Microsoft YaHei", sans-serif',
                border: '1px solid ' + (on ? t.primary : t.line),
                background: on ? t.primary : t.chip,
                color: on ? '#ffffff' : t.text,
              },
            }, label)
          }

          const modeNode = h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
          },
            h('span', { style: { color: t.sub, fontSize: 12 } }, '启动模式'),
            modeBtn('正版', 'online'),
            modeBtn('离线', 'offline'),
            accountMode === 'offline'
              ? h('span', { style: { color: t.sub, fontSize: 11.5 } }, '离线：用「启动配置」里的玩家名')
              : null)

          const errNode = err
            ? h('div', {
                style: {
                  marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '8px 11px', borderRadius: 9, fontSize: 12.5, lineHeight: 1.6,
                  background: t.errBg, border: '1px solid ' + t.errLine, color: t.errText,
                },
              },
                h('div', { style: { flex: '1 1 auto', wordBreak: 'break-word' } }, err),
                h('button', {
                  type: 'button',
                  title: '关闭',
                  onClick: () => setErr(''),
                  style: {
                    flex: '0 0 auto', border: 'none', background: 'transparent',
                    color: t.errText, cursor: 'pointer', fontSize: 14, lineHeight: 1,
                    padding: '2px 4px', opacity: 0.85,
                  },
                }, '✕'))
            : null

          const flowNode = flow
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button',
                    onClick: () => openAuthUrl(flow.url),
                    style: {
                      padding: '8px 16px', borderRadius: 10, cursor: 'pointer',
                      font: '13px/1.3 system-ui, "Microsoft YaHei", sans-serif',
                      border: '1px solid transparent', background: t.primary, color: '#ffffff',
                    },
                  }, '打开微软登录页'),
                  flow.userCode
                    ? h('span', { style: { color: t.text, fontSize: 13 } }, '代码 ' + flow.userCode)
                    : null,
                  h('span', { style: { color: t.sub, fontSize: 11.5 } }, '弹窗被拦就手动复制下面的地址')),
                h('div', {
                  style: {
                    fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5,
                    color: t.sub, wordBreak: 'break-all', lineHeight: 1.55,
                    padding: '7px 10px', borderRadius: 8,
                    border: '1px dashed ' + t.line, background: t.chip,
                  },
                }, flow.url || '（宿主没有返回登录地址）'),
                h('textarea', {
                  rows: 2,
                  value: paste,
                  placeholder: '把登录后浏览器地址栏的整条 URL 粘到这里（含 code=）',
                  onChange: (e) => setPaste(e.target.value),
                  style: Object.assign(inputStyle(t), {
                    width: '100%', resize: 'vertical', minHeight: 54,
                  }),
                }),
                h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
                  h(Btn, {
                    t, primary: true,
                    label: busy === 'complete' ? '登录中…' : '完成登录',
                    disabled: busy !== '' || !String(paste || '').trim(),
                    onClick: completeFlow,
                  }),
                  h(Btn, {
                    t, label: '取消',
                    disabled: busy !== '',
                    onClick: () => { setFlow(null); setPaste(''); setErr('') },
                  })),
                flow.hint
                  ? h('div', { style: { color: t.sub, fontSize: 12.5, lineHeight: 1.7 } }, flow.hint)
                  : null)
            : null

          const headNode = loggedIn
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                h('div', { style: { fontSize: 13.5, fontWeight: 500 } }, '正版：' + String(account.name || '（未知）')),
                account.owned === false
                  ? h('div', { style: { color: t.bad, fontSize: 12.5 } },
                      '这个账号没有 Minecraft 权益（未购买或 XGP 到期）')
                  : null,
                h('span', { style: { color: t.sub, fontSize: 11.5 } },
                  'uuid ' + midEllipsis(String(account.uuid || '—'), 18)),
                (account.accounts && account.accounts.length > 1)
                  ? h('select', {
                      value: String(account.activeUuid || account.uuid || ''),
                      disabled: busy !== '',
                      title: '切换账号（' + account.accounts.length + ' 个已登录）',
                      onChange: (e) => doSwitch(e.target.value),
                      style: Object.assign({ width: 170 }, inputStyle(t)),
                    }, account.accounts.map((a) => h('option', { key: a.uuid, value: a.uuid },
                      String(a.name || a.uuid) + (a.owned === false ? '（无权益）' : ''))))
                  : null,
                account.needsRefresh
                  ? h('span', { style: { color: t.warnText, fontSize: 11.5 } }, '令牌即将过期')
                  : null)
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                h('div', { style: { fontSize: 13.5, fontWeight: 500 } }, '离线账号'),
                h('span', { style: { color: t.sub, fontSize: 11.5 } }, '玩家名用下面「启动配置」里的输入框'))

          const actionNode = loggedIn
            ? h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
                flow
                  ? null
                  : h(Btn, {
                      t, primary: true,
                      label: busy === 'start' ? '准备中…' : '微软登录',
                      disabled: busy !== '',
                      onClick: openFlow,
                    }),
                account.needsRefresh
                  ? h(Btn, {
                      t, label: busy === 'refresh' ? '刷新中…' : '刷新令牌',
                      disabled: busy !== '',
                      onClick: doRefreshToken,
                    })
                  : null,
                h(Btn, {
                  t, danger: true,
                  label: busy === 'logout' ? '退出中…' : '退出登录',
                  disabled: busy !== '',
                  onClick: doLogout,
                }))
            : h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
                flow
                  ? null
                  : h(Btn, {
                      t, primary: true,
                      label: busy === 'start' ? '准备中…' : '微软登录',
                      disabled: busy !== '',
                      onClick: openFlow,
                    }))

          return h(Card, { t, title: '账号' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              headNode,
              loggedIn ? modeNode : null,
              actionNode,
              flowNode),
            errNode)
        }

        // ========================================================== 主面板
        const DIR_TARGETS = [
          ['root', '根目录'],
          ['mods', 'mods'],
          ['config', 'config'],
          ['saves', '存档'],
          ['logs', '日志'],
          ['crashReports', '崩溃报告'],
          ['resourcepacks', '资源包'],
          ['screenshots', '截图'],
        ]

        /* ── 皮肤卡（正版）：读当前皮肤/披风，按 URL 换肤、恢复默认 ───────────────── */
        function SkinCard(props) {
          const t = props.t
          const account = (props.account && typeof props.account === 'object') ? props.account : { loggedIn: false }
          const loggedIn = Boolean(account.loggedIn)
          const [profile, setProfile] = useState(null)
          const [url, setUrl] = useState('')
          const [variant, setVariant] = useState('classic')
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [notice, setNotice] = useState('')
          const alive = useRef(true)

          async function call(pathname, method, body) {
            const init = { method: method || 'GET', headers: { 'content-type': 'application/json' } }
            if (body !== undefined) init.body = JSON.stringify(body)
            const res = await fetch(pathname, init)
            let json = null
            try { json = await res.json() } catch (_e) { json = null }
            if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status))
            if (json && json.ok === false) throw new Error(String(json.error || '宿主返回 ok=false'))
            return json || {}
          }

          async function load() {
            if (!loggedIn) { setProfile(null); return }
            try {
              const data = await call('/mc/skin/current', 'GET')
              if (alive.current) setProfile(data.profile || null)
            } catch (e) {
              if (alive.current) { setProfile(null); setError(String((e && e.message) || e)) }
            }
          }

          useEffect(function () {
            alive.current = true
            load()
            return function () { alive.current = false }
          }, [loggedIn])

          async function apply() {
            if (busy) return
            setBusy('set'); setError(''); setNotice('')
            try {
              const data = await call('/mc/skin/set', 'POST', { url: url.trim(), variant: variant })
              if (!alive.current) return
              setProfile(data.profile || null)
              setNotice('已换肤（' + (variant === 'slim' ? '细手臂' : '经典') + '），进游戏后重新登录可见')
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            } finally {
              if (alive.current) setBusy('')
            }
          }

          async function reset() {
            if (busy) return
            setBusy('reset'); setError(''); setNotice('')
            try {
              const data = await call('/mc/skin/reset', 'POST', {})
              if (!alive.current) return
              setProfile(data.profile || null)
              setNotice('已恢复默认皮肤')
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            } finally {
              if (alive.current) setBusy('')
            }
          }

          const skin = profile && profile.skins && profile.skins[0] ? profile.skins[0] : null
          const head = h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, [
            h('div', { key: 't', style: { fontWeight: 600, fontSize: 14 } }, '皮肤'),
            h('div', { key: 's', style: { color: t.sub, fontSize: 12 } }, loggedIn ? '正版账号：' + (account.name || '') : '需要登录正版账号'),
          ])

          const preview = skin && skin.url
            ? h('img', {
                key: 'img', src: skin.url, alt: '当前皮肤', width: 64, height: 64,
                style: { imageRendering: 'pixelated', background: t.chip, borderRadius: 8, border: '1px solid ' + t.line },
              })
            : null

          const children = [head]
          if (!loggedIn) {
            children.push(h('div', { key: 'off', style: { color: t.sub, fontSize: 12.5, marginTop: 8 } },
              '换肤是账号服务端行为，离线账号做不了。先在上面点「微软登录」。'))
          } else {
            children.push(h('div', { key: 'cur', style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' } }, [
              preview,
              h('div', { key: 'meta', style: { color: t.sub, fontSize: 12 } },
                skin
                  ? '当前皮肤：' + (skin.variant === 'slim' ? '细手臂' : '经典') + ' · ' + String(skin.state || '')
                  : (busy === 'load' ? '读取中…' : '（还没读到皮肤，可能令牌刚刷新）')),
            ]))
            children.push(h('div', { key: 'form', style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } }, [
              h('input', {
                key: 'u', value: url, placeholder: 'https://…/skin.png（64x64 或 64x32 PNG 的直链）',
                onChange: function (e) { setUrl(e.target.value) },
                style: Object.assign({ flex: '1 1 260px' }, inputStyle(t)),
              }),
              h('select', {
                key: 'v', value: variant, onChange: function (e) { setVariant(e.target.value) },
                style: Object.assign({ width: 120 }, inputStyle(t)),
              }, [
                h('option', { key: 'c', value: 'classic' }, '经典'),
                h('option', { key: 's', value: 'slim' }, '细手臂'),
              ]),
              h(Btn, { key: 'go', t, primary: true, disabled: Boolean(busy) || !url.trim(), label: busy === 'set' ? '应用中…' : '应用皮肤', onClick: apply }),
              h(Btn, { key: 'reset', t, disabled: Boolean(busy), label: busy === 'reset' ? '恢复中…' : '恢复默认', onClick: reset }),
            ]))
          }
          if (error) children.push(h('div', { key: 'e', style: { marginTop: 8, color: t.errText || '#f87171', fontSize: 12.5, wordBreak: 'break-word' } }, error))
          if (notice) children.push(h('div', { key: 'n', style: { marginTop: 8, color: t.sub, fontSize: 12.5 } }, notice))
          return h(Card, { t, title: '皮肤（正版）' }, children)
        }

        function PanelMain() {
          const dark = useDark()
          const t = palette(dark)
          const snap = useStore()
          const state = snap.state || null

          const [picked, setPicked] = useState('')
          const [memory, setMemory] = useState('4096')
          const [username, setUsername] = useState('Steve')
          // 账号卡里选的启动模式（'online' = 正版 / 'offline' = 离线），默认正版；
          // 没登录时下面 launchAccountMode 会强制退回 offline，避免宿主回 409。
          const [accountMode, setAccountMode] = useState('online')
          const [java, setJava] = useState('')
          const [plan, setPlan] = useState(null)
          const [planLoading, setPlanLoading] = useState(false)
          const [planErr, setPlanErr] = useState('')
          const [actErr, setActErr] = useState('')
          const [advice, setAdvice] = useState(null)
          const [busy, setBusy] = useState('')
          const [scanning, setScanning] = useState(false)
          const [dismissed, setDismissed] = useState('')
          const seeded = useRef(false)

          const running = Boolean(state && state.running)
          const now = useNowTick(running)

          const versions = (state && Array.isArray(state.versions)) ? state.versions : []
          const javaList = (state && Array.isArray(state.javaList)) ? state.javaList : []
          const mcDir = (state && state.minecraftDir) || ''
          const selectedId = picked || (state && state.selected) || (versions.length ? versions[0].id : '')
          const selVer = versions.find((v) => v && v.id === selectedId) || null
          const meta = (state && state.meta) ? state.meta : null
          const exitCode = (state && state.exitCode !== null && state.exitCode !== undefined)
            ? state.exitCode : null
          const logPath = (state && state.logPath) || ''
          const logTail = (state && state.logTail) || ''

          // 账号态：来自 /mc/state 的 msAccount（父面板轮询已有，不再额外请求）
          const msAccount = (state && state.msAccount && typeof state.msAccount === 'object')
            ? state.msAccount : { loggedIn: false }
          // 真正带给 /mc/launch 的模式：只有「已登录 + 选了正版」才走 online
          const launchAccountMode = (msAccount.loggedIn && accountMode === 'online') ? 'online' : 'offline'

          // ---- 默认值只落一次（之后用户改了什么就是什么）
          useEffect(() => {
            if (seeded.current || !state) return
            seeded.current = true
            const d = state.defaults || {}
            if (Number(d.memoryMb) > 0) setMemory(String(Number(d.memoryMb)))
            if (typeof d.username === 'string' && d.username) setUsername(d.username)
            if (typeof d.java === 'string' && d.java) setJava(d.java)
          }, [state])

          // ---- 选中版本变化即重新生成计划（卸载/切版时用 cancelled 兜住过期响应）
          useEffect(() => {
            if (!selectedId) {
              setPlan(null)
              setPlanErr('')
              setPlanLoading(false)
              return undefined
            }
            let cancelled = false
            setPlanLoading(true)
            setPlanErr('')
            const load = async () => {
              try {
                const data = await api('/plan', 'POST', { versionId: selectedId })
                if (cancelled) return
                setPlan((data && data.plan) || null)
              } catch (e) {
                if (cancelled) return
                setPlan(null)
                setPlanErr(errText(e))
              } finally {
                if (!cancelled) setPlanLoading(false)
              }
            }
            load()
            return () => { cancelled = true }
          }, [selectedId])

          const rescan = async () => {
            if (scanning) return
            setScanning(true)
            setActErr('')
            try {
              await api('/versions?refresh=1')
              await refresh()
            } catch (e) {
              setActErr(errText(e))
            } finally {
              setScanning(false)
            }
          }

          const act = async (kind, path, body) => {
            setBusy(kind)
            setActErr('')
            try {
              const out = await api(path, 'POST', body)
              // 启动响应里可能带正版/赞助劝导（PCL McLaunchPrecheck 等价）
              if (out && out.advice && Array.isArray(out.advice.hints) && out.advice.hints.length) setAdvice(out.advice)
              await refresh()
            } catch (e) {
              setActErr(errText(e))
            } finally {
              setBusy('')
            }
          }

          const onLaunch = () => act('launch', '/launch', {
            versionId: selectedId,
            memoryMb: clampMem(parseInt(memory, 10)),
            username: String(username || '').trim() || 'Steve',
            java: java || '',
            gameDirMode: 'isolated',
            // 账号卡里选的模式：online = 正版（宿主用已登录账号），offline = 用上面的玩家名
            accountMode: launchAccountMode,
          })

          const onStop = () => act('stop', '/stop', {})
          // 带上当前选中的版本：宿主 openDir(target, cfg, versionId) 优先用 body.versionId，
          // 否则会退回 cfg.selectedVersion —— 那个只在「启动过」时才更新，会开错版本的目录。
          const onOpen = (target) => act('open', '/open', { target, versionId: selectedId })

          const planMissing = planMissingCount(plan)
          const verMissing = selVer ? (Number(selVer.missingCount) || 0) : 0
          const missingCount = plan ? planMissing : verMissing
          const warnings = (plan && Array.isArray(plan.warnings)) ? plan.warnings.filter(Boolean) : []
          const busyAny = busy !== ''
          const canLaunch = Boolean(selectedId) && !running && !busyAny && !planLoading && missingCount === 0
          const bannerText = firstOf([
            actErr,
            snap.error,
            planErr,
            (state && state.error) ? String(state.error) : '',
          ])
          const showBanner = Boolean(bannerText) && bannerText !== dismissed

          let launchHint = ''
          if (running) launchHint = '游戏已在运行'
          else if (missingCount > 0) launchHint = '缺 ' + missingCount + ' 个文件，先下载再启动'
          else if (!selectedId) launchHint = '先选一个版本'
          else if (planLoading) launchHint = '正在生成计划…'

          const statusLine = running
            ? ('pid ' + (state.pid === undefined || state.pid === null ? '?' : state.pid) +
               (state.startedAt ? ' · 已运行 ' + fmtUptime(state.startedAt, now) : ''))
            : (exitCode !== null ? '上次退出码 ' + exitCode : '未运行')

          const statusRows = meta ? [
            ['版本', meta.versionId],
            ['Java', (meta.java || '') + (meta.javaFrom ? '  （' + meta.javaFrom + '）' : '')],
            ['账号', meta.account],
            ['内存', meta.memoryMb ? meta.memoryMb + ' MB' : ''],
            ['classpath', meta.classpathEntries !== undefined && meta.classpathEntries !== null
              ? meta.classpathEntries + ' 项' : ''],
            ['natives', (meta.nativesDir || '') + (meta.nativesNote ? ' · ' + meta.nativesNote : '')],
            ['游戏目录', meta.gameDir],
            ['缺失文件', meta.missingCount ? String(meta.missingCount) : ''],
          ].filter((row) => row[1]) : []

          // ---------------------------------------------------------- 头部
          const headerNode = h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
          },
            h('div', { style: { fontSize: 20, fontWeight: 600, letterSpacing: 0.2 } }, 'MC 启动器'),
            h('div', {
              title: mcDir || '（宿主还没报告 .minecraft 目录）',
              style: {
                display: 'inline-flex', alignItems: 'center', maxWidth: 380,
                padding: '4px 11px', borderRadius: 999,
                border: '1px solid ' + t.line, background: t.card, color: t.sub,
                fontSize: 11.5, fontFamily: 'ui-monospace, Consolas, monospace',
                whiteSpace: 'nowrap', overflow: 'hidden',
              },
            }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
                midEllipsis(mcDir || '未知 .minecraft 目录', 52))),
            h('div', {
              style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
            },
              h('div', {
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '5px 11px', borderRadius: 999,
                  border: '1px solid ' + t.line, background: t.card,
                  fontSize: 12, color: running ? t.ok : t.sub,
                },
              },
                h('span', {
                  style: {
                    width: 7, height: 7, borderRadius: '50%',
                    background: running ? t.ok : t.idle,
                  },
                }),
                running ? '运行中' : '未运行'),
              h(Btn, {
                t,
                label: scanning ? '刷新中…' : '刷新',
                disabled: scanning || busyAny,
                onClick: rescan,
              })))

          const bannerNode = showBanner
            ? h('div', {
                style: {
                  marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '9px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.6,
                  background: t.errBg, border: '1px solid ' + t.errLine, color: t.errText,
                },
              },
                h('div', { style: { flex: '1 1 auto', wordBreak: 'break-word' } }, bannerText),
                h('button', {
                  type: 'button',
                  title: '关闭',
                  onClick: () => setDismissed(bannerText),
                  style: {
                    flex: '0 0 auto', border: 'none', background: 'transparent',
                    color: t.errText, cursor: 'pointer', fontSize: 14, lineHeight: 1,
                    padding: '2px 4px', opacity: 0.85,
                  },
                }, '✕'))
            : null

          // ---------------------------------------------------------- 版本
          const versionCard = h(Card, { t, title: '版本' + (versions.length ? ' · ' + versions.length + ' 个' : '') },
            versions.length
              ? h('select', {
                  value: selectedId,
                  onChange: (e) => setPicked(e.target.value),
                  style: Object.assign(selectStyle(t), { width: '100%' }),
                }, groupVersions(versions).map((g) => h('optgroup', { key: g.key, label: g.label },
                    g.items.map((v) => h('option', { key: v.id, value: v.id }, versionOptionLabel(v))))))
              : h('div', { style: { color: t.sub, fontSize: 13 } },
                  state
                    ? '没有扫描到任何版本（.minecraft/versions 为空？点右上角「刷新」重扫）'
                    : '正在连接宿主…'),
            selVer ? h('div', { style: { color: t.sub, fontSize: 11.5, marginTop: 8 } }, versionHint(selVer)) : null)

          // ---------------------------------------------------------- 账号
          // 数据（account）由上面的 /mc/state 轮询喂，交互（登录/退出）由卡片自己发请求；
          // onChanged 只是让父面板立刻重拉一次 /mc/state，卡片本身不持有账号数据。
          const accountCard = h(MsAccountCard, {
            t,
            account: msAccount,
            accountMode,
            setAccountMode,
            onChanged: () => refresh(),
          })

          const skinCard = h(SkinCard, { t, account: msAccount })

          // ---------------------------------------------------------- 配置
          const configCard = h(Card, { t, title: '启动配置' },
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h(Field, { t, label: '内存（MB）', flex: '0 0 150px', hint: '256 – 32768，步进 512' },
                h('input', {
                  type: 'number', min: 256, max: 32768, step: 512,
                  value: memory,
                  onChange: (e) => setMemory(e.target.value),
                  onBlur: () => setMemory(String(clampMem(parseInt(memory, 10)))),
                  style: Object.assign(inputStyle(t), { width: '100%' }),
                })),
              h(Field, { t, label: '玩家名', flex: '1 1 180px', hint: '离线登录显示的名字' },
                h('input', {
                  type: 'text',
                  value: username,
                  placeholder: 'Steve',
                  onChange: (e) => setUsername(e.target.value),
                  style: Object.assign(inputStyle(t), { width: '100%' }),
                })),
              h(Field, {
                t,
                label: 'Java',
                flex: '1 1 290px',
                hint: javaList.length ? '共 ' + javaList.length + ' 个探测到的 Java' : '宿主没有探测到 Java',
              },
                h('select', {
                  value: java,
                  onChange: (e) => setJava(e.target.value),
                  style: Object.assign(selectStyle(t), { width: '100%' }),
                },
                  h('option', { value: '' }, '自动（按版本要求）'),
                  javaList.map((j, i) => h('option', {
                    key: (j && j.exe) ? j.exe : 'java-' + i,
                    value: (j && j.exe) || '',
                    disabled: Boolean(j && j.ok === false),
                  }, javaLabel(j)))))))

          // ---------------------------------------------------------- 计划
          const planRows = plan ? [
            ['主类', String(plan.mainClass || '（未知）'), true],
            ['Java', javaDesc(plan.java), true],
            ['classpath', (Number(plan.classpathEntries) || 0) + ' 项', false],
            ['natives', (plan.nativesDir || '（无）') + (plan.nativesNote ? ' · ' + plan.nativesNote : ''), true],
            ['游戏目录', plan.gameDir || '（未知）', true],
          ] : []

          const missingList = (plan && Array.isArray(plan.missing) && plan.missing.length)
            ? plan.missing.slice(0, 6).map((m) => (m && m.rel) ? m.rel : String(m)).join('、') +
              (plan.missing.length > 6 ? ' 等' : '')
            : ''

          const planCard = selectedId ? h(Card, {
            t,
            title: '启动计划',
            extra: h('span', {
              style: { marginLeft: 'auto', color: t.sub, fontSize: 11.5, fontWeight: 400 },
            }, planLoading ? '生成中…' : (plan ? String(plan.versionId || '') : '')),
          },
            planLoading && !plan
              ? h('div', { style: { color: t.sub, fontSize: 13 } }, '正在生成启动计划…')
              : null,
            plan ? planRows.map((row) => h(KV, {
              key: row[0], t, k: row[0], v: String(row[1]), mono: row[2],
            })) : null,
            missingCount > 0
              ? h('div', {
                  style: {
                    marginTop: 12, padding: '8px 11px', borderRadius: 9, fontSize: 12.5,
                    background: t.errBg, border: '1px solid ' + t.errLine, color: t.errText,
                    wordBreak: 'break-word',
                  },
                }, '缺 ' + missingCount + ' 个文件，先下载再启动' + (missingList ? '：' + missingList : ''))
              : null,
            warnings.length
              ? h('div', {
                  style: {
                    marginTop: 12, padding: '8px 11px', borderRadius: 9, fontSize: 12.5,
                    background: t.warnBg, border: '1px solid ' + t.warnLine, color: t.warnText,
                    lineHeight: 1.65,
                  },
                }, warnings.map((w, i) => h('div', { key: 'w' + i }, '⚠ ' + String(w))))
              : null,
            !plan && !planLoading
              ? h('div', { style: { color: t.sub, fontSize: 12.5 } },
                  '暂时拿不到这个版本的启动计划，先看上方红条里的原因。')
              : null)
            : null

          // ---------------------------------------------------------- 动作
          const adviceCard = advice && advice.hints && advice.hints.length
            ? h(Card, { t, title: '提示' },
                advice.hints.map(function (hint) {
                  const isBuy = hint.kind === 'buy'
                  return h('div', { key: hint.kind + hint.count, style: { padding: '6px 0' } }, [
                    h('div', { key: 't', style: { fontSize: 13.5, fontWeight: 500 } },
                      isBuy ? '考虑一下正版？' : '支持 PCL'),
                    h('div', { key: 'b', style: { color: t.sub, fontSize: 12.5, lineHeight: 1.7, marginTop: 4 } },
                      isBuy
                        ? '你已经用离线账号启动了 ' + hint.count + ' 次 Minecraft。如果觉得游戏还不错，可以购买正版支持一下（登录一次正版账号后就不会再提示）。'
                        : '本工具的功能移植自龙腾猫跃（LTCat）开发的 PCL，它免费、无广告地维护了很多年。如果它帮到了你，可以考虑赞助 PCL 的作者。'),
                    h('div', { key: 'a', style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } }, [
                      h(Btn, { key: 'go', t, primary: true, label: isBuy ? '购买正版' : '赞助 PCL（爱发电）', onClick: function () {
                        try { window.open(hint.url, '_blank', 'noopener') } catch (_e) { /* 弹窗被拦就算了 */ }
                        setAdvice(null)
                      } }),
                      h(Btn, { key: 'no', t, label: isBuy ? '下次一定' : '但是我拒绝', onClick: function () { setAdvice(null) } }),
                    ]),
                    !isBuy ? h('div', { key: 'c', style: { color: t.sub, fontSize: 12, marginTop: 6 } },
                      'PCL 作者：龙腾猫跃（LTCat）· ' + String(hint.url || '')) : null,
                  ])
                }))
            : null

          const actionsCard = h(Card, { t, title: '操作' },
            h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
              h(Btn, {
                t, primary: true,
                label: busy === 'launch' ? '正在启动…' : '▶ 启动游戏',
                disabled: !canLaunch,
                onClick: onLaunch,
              }),
              h(Btn, {
                t, danger: true,
                label: busy === 'stop' ? '正在停止…' : '■ 停止',
                disabled: !running || busyAny,
                onClick: onStop,
              }),
              launchHint ? h('span', { style: { color: t.sub, fontSize: 12 } }, launchHint) : null),
            h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px dashed ' + t.line } },
              h('div', { style: { color: t.sub, fontSize: 12, marginBottom: 8 } }, '打开目录'),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                DIR_TARGETS.map((pair) => h(Chip, {
                  key: pair[0], t, label: pair[1],
                  disabled: busyAny || !state,
                  onClick: () => onOpen(pair[0]),
                })))))

          // ---------------------------------------------------------- 状态
          const statusCard = h(Card, { t, title: '运行状态' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' } },
              h('span', {
                style: {
                  width: 9, height: 9, borderRadius: '50%',
                  background: running ? t.ok : (exitCode !== null ? t.bad : t.idle),
                },
              }),
              h('div', { style: { fontSize: 13.5, fontWeight: 500 } }, statusLine),
              running && logPath
                ? h('span', { style: { color: t.sub, fontSize: 11.5 } }, '日志实时跟随')
                : null),
            statusRows.length
              ? h('div', { style: { marginTop: 8 } }, statusRows.map((row) => h(KV, {
                  key: row[0], t, k: row[0], v: String(row[1]),
                  mono: ['版本', 'Java', 'classpath', 'natives', '游戏目录'].indexOf(row[0]) >= 0,
                })))
              : null)

          // ---------------------------------------------------------- 日志
          const logCard = logPath ? h(Card, { t, title: '日志' },
            h('div', {
              style: {
                color: t.sub, fontSize: 11.5, wordBreak: 'break-all', marginBottom: 8,
                fontFamily: 'ui-monospace, Consolas, monospace',
              },
            }, logPath),
            logTail
              ? h('pre', {
                  style: {
                    margin: 0, padding: '12px 14px', borderRadius: 10,
                    maxHeight: 320, overflow: 'auto',
                    background: t.log, color: t.logText,
                    fontFamily: 'ui-monospace, Consolas, monospace',
                    fontSize: 11.5, lineHeight: 1.55,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  },
                }, String(logTail).slice(-4000))
              : h('div', { style: { color: t.sub, fontSize: 12.5 } }, '（日志暂时为空）'))
            : null

          const footerNode = h('div', {
            style: { marginTop: 18, color: t.sub, fontSize: 11.5, lineHeight: 1.7 },
          }, '数据源 /mc/state：运行中每 1.5 秒、空闲每 5 秒刷新。版本扫描、Java 探测与下载都在宿主侧；启动失败先看上面日志尾巴。')

          return h('div', {
            style: {
              minHeight: '100%',
              background: t.bg,
              color: t.text,
              overflow: 'auto',
              font: '14px/1.65 system-ui, "Microsoft YaHei", sans-serif',
            },
          },
            h('div', { style: { maxWidth: 880, margin: '0 auto', padding: '28px 32px 48px' } },
              headerNode,
              bannerNode,
              versionCard,
              accountCard,
              skinCard,
              configCard,
              planCard,
              adviceCard,
              actionsCard,
              statusCard,
              logCard,
              footerNode))
        }
        return { PanelMain, PanelIcon: McIcon }
      })()


      // ══════════════════════════════════════════════════════════════════════
      // 页签「下载」—— 原 dsh-mc-downloader 的 factory 体（闭包隔离）
      // 取自原文件第 18 行到第 1259 行（PanelMain 收尾）：删掉取 react / 取
      // createElement 的声明行、以及 module/exports 那两行 shim（外层已有），
      // 末尾 return 出面板组件。轮询 store、/mc/dl 前缀、镜像常量全部原样保留。
      // ══════════════════════════════════════════════════════════════════════
      const DownloadUI = (function () {


        /** Sidebar entry id AND the `main` slot key — they must stay identical. */
        const PANEL_ID = 'mc-downloader'
        /** Same-origin host routes (mirror engine lives in the host half). */
        const API_BASE = '/mc/dl'
        /** Every byte of traffic goes through this mirror host. */
        const MIRROR_HOST = 'bmclapi2.bangbang93.com'

        /** Fixed display order for the per-kind progress rows. */
        const KINDS = [
          { key: 'client', label: '客户端' },
          { key: 'libraries', label: '库' },
          { key: 'assetIndex', label: '资源索引' },
          { key: 'assets', label: '资源' }
        ]

        const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

        /* ----------------------------- formatting ----------------------------- */

        /** 1234567 -> "1.2 MB"; KB/MB/GB carry with one decimal. */
        function humanBytes(value) {
          const n = typeof value === 'number' && isFinite(value) ? value : 0
          if (n < 0) return '0 B'
          if (n < 1024) return Math.round(n) + ' B'
          const units = ['KB', 'MB', 'GB', 'TB', 'PB']
          let scaled = n / 1024
          let index = 0
          while (scaled >= 1024 && index < units.length - 1) {
            scaled = scaled / 1024
            index += 1
          }
          return scaled.toFixed(1) + ' ' + units[index]
        }

        function pad2(n) {
          return n < 10 ? '0' + n : String(n)
        }

        /** 35 -> "剩 35 秒"; 65 -> "剩 1 分 05 秒"; 3700 -> "剩 1 时 01 分". */
        function humanEta(seconds) {
          if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return ''
          const total = Math.round(seconds)
          if (total < 60) return '剩 ' + total + ' 秒'
          const minutes = Math.floor(total / 60)
          const rest = total % 60
          if (minutes < 60) return '剩 ' + minutes + ' 分 ' + pad2(rest) + ' 秒'
          const hours = Math.floor(minutes / 60)
          return '剩 ' + hours + ' 时 ' + pad2(minutes % 60) + ' 分'
        }

        /**
         * Count of one kind bucket. `state.task.byKind` carries `{n,done}` but
         * `plan.byKind` only carries the planned count, so accept both shapes.
         */
        function bucketCount(bucket) {
          if (typeof bucket === 'number' && isFinite(bucket)) return bucket
          if (bucket && typeof bucket.n === 'number' && isFinite(bucket.n)) return bucket.n
          return 0
        }

        /** Share of a total as one-decimal percent ("" when the total is unknown). */
        function percentText(done, total) {
          if (!(typeof total === 'number') || !isFinite(total) || total <= 0) return ''
          const ratio = (typeof done === 'number' && isFinite(done) ? done : 0) / total
          const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio
          return (clamped * 100).toFixed(1) + '%'
        }

        function describeError(err) {
          if (err === null || err === undefined) return '未知错误'
          if (typeof err === 'string') return err
          if (typeof err.message === 'string' && err.message) return err.message
          try {
            return String(err)
          } catch (_err) {
            return '未知错误'
          }
        }

        /** Width of a fill bar in percent, clamped to 0..100. */
        function barWidth(done, total) {
          if (!(typeof total === 'number') || !isFinite(total) || total <= 0) return '0%'
          const ratio = (typeof done === 'number' && isFinite(done) ? done : 0) / total
          const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio
          return (clamped * 100).toFixed(2) + '%'
        }

        function phaseLabel(phase) {
          if (phase === 'planning') return '规划中'
          if (phase === 'downloading') return '下载中'
          if (phase === 'done') return '已完成'
          if (phase === 'error') return '出错'
          if (phase === 'cancelled') return '已取消'
          return String(phase === undefined || phase === null ? '未知' : phase)
        }

        function isRunningPhase(phase) {
          return phase === 'planning' || phase === 'downloading'
        }

        /* -------------------------------- HTTP -------------------------------- */

        /** Host-contract reply: `{ok:true,...}` or `{ok:false,error:"..."}`. */
        async function requestApi(path, init) {
          const options = init === undefined ? {} : init
          let response
          try {
            response = await fetch(API_BASE + path, options)
          } catch (err) {
            return { ok: false, error: '请求 ' + path + ' 失败：' + describeError(err) }
          }
          let data = null
          try {
            data = await response.json()
          } catch (_err) {
            data = null
          }
          if (data === null || typeof data !== 'object') {
            return { ok: false, error: '响应不是 JSON（HTTP ' + response.status + '）' }
          }
          if (data.ok === true) return data
          const message = typeof data.error === 'string' && data.error ? data.error : 'HTTP ' + response.status
          return { ok: false, error: message }
        }

        function postJson(path, body) {
          return requestApi(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body === undefined ? {} : body)
          })
        }

        /* -------------------------------- theme ------------------------------- */

        function readDark() {
          try {
            return !!(document && document.body && document.body.hasAttribute('data-ds-dark-theme'))
          } catch (_err) {
            return false
          }
        }

        /** Follow the host theme attribute live (observer cleaned up on unmount). */
        function useDark() {
          const [dark, setDark] = React.useState(readDark)
          React.useEffect(function () {
            const body = document.body
            if (!body) return undefined
            const sync = function () {
              setDark(function (prev) {
                const next = readDark()
                return prev === next ? prev : next
              })
            }
            sync()
            if (typeof MutationObserver !== 'function') return undefined
            const observer = new MutationObserver(sync)
            observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
            return function () {
              observer.disconnect()
            }
          }, [])
          return dark
        }

        const LIGHT = {
          bg: '#f7f7f8',
          card: '#ffffff',
          text: '#18181b',
          sub: '#52525b',
          line: 'rgba(0,0,0,.12)',
          log: '#0f172a',
          logText: '#e2e8f0',
          inputBg: '#ffffff',
          track: 'rgba(0,0,0,.08)',
          accent: '#2563eb',
          accentSoft: 'rgba(37,99,235,.12)',
          danger: '#dc2626',
          dangerSoft: 'rgba(220,38,38,.10)',
          ok: '#15803d',
          okSoft: 'rgba(21,128,61,.10)'
        }

        const DARK = {
          bg: '#17171b',
          card: '#212127',
          text: '#f4f4f5',
          sub: '#a1a1aa',
          line: 'rgba(255,255,255,.13)',
          log: '#0d0d10',
          logText: '#e4e4e7',
          inputBg: '#1b1b21',
          track: 'rgba(255,255,255,.10)',
          accent: '#3b82f6',
          accentSoft: 'rgba(59,130,246,.18)',
          danger: '#f87171',
          dangerSoft: 'rgba(248,113,113,.14)',
          ok: '#4ade80',
          okSoft: 'rgba(74,222,128,.14)'
        }

        /* ------------------------------- styles ------------------------------- */

        function makeStyles(P) {
          const input = {
            width: '100%',
            boxSizing: 'border-box',
            padding: '7px 10px',
            borderRadius: '8px',
            border: '1px solid ' + P.line,
            background: P.inputBg,
            color: P.text,
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
            outline: 'none'
          }
          const btn = {
            fontFamily: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
            padding: '7px 14px',
            borderRadius: '8px',
            cursor: 'pointer',
            border: '1px solid ' + P.line,
            background: 'transparent',
            color: P.text
          }
          return {
            root: {
              minHeight: '100%',
              boxSizing: 'border-box',
              background: P.bg,
              color: P.text,
              fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
              fontSize: '14px',
              lineHeight: 1.65,
              padding: '28px 32px 48px'
            },
            inner: {
              maxWidth: '880px',
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            },
            header: { display: 'flex', flexDirection: 'column', gap: '4px' },
            titleRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
            h1: { margin: 0, fontSize: '20px', fontWeight: 600, lineHeight: 1.4 },
            pill: {
              border: '1px solid ' + P.line,
              borderRadius: '999px',
              padding: '1px 10px',
              fontSize: '12px',
              color: P.sub,
              fontFamily: MONO,
              whiteSpace: 'nowrap'
            },
            lede: { margin: 0, color: P.sub, fontSize: '13px' },
            card: {
              border: '1px solid ' + P.line,
              borderRadius: '12px',
              background: P.card,
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            },
            cardHead: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
            h2: { margin: 0, fontSize: '14px', fontWeight: 600 },
            subtle: { color: P.sub, fontSize: '12px' },
            mono: { fontFamily: MONO },
            filterRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
            seg: {
              display: 'inline-flex',
              border: '1px solid ' + P.line,
              borderRadius: '999px',
              overflow: 'hidden',
              flex: 'none'
            },
            segBtn: {
              fontFamily: 'inherit',
              fontSize: '12px',
              lineHeight: 1.5,
              padding: '4px 12px',
              cursor: 'pointer',
              border: 'none',
              background: 'transparent',
              color: P.sub
            },
            segOn: { background: P.accentSoft, color: P.accent, fontWeight: 600 },
            searchInput: {
              width: '210px',
              boxSizing: 'border-box',
              padding: '5px 10px',
              borderRadius: '999px',
              border: '1px solid ' + P.line,
              background: P.inputBg,
              color: P.text,
              fontFamily: 'inherit',
              fontSize: '12px',
              lineHeight: 1.5,
              outline: 'none'
            },
            input: input,
            select: input,
            dirHint: { color: P.sub, fontSize: '12px' },
            actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
            btn: btn,
            btnPrimary: { border: '1px solid ' + P.accent, background: P.accent, color: '#ffffff', fontWeight: 600 },
            btnDanger: { border: '1px solid ' + P.danger, color: P.danger, background: 'transparent' },
            btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
            linkBtn: {
              fontFamily: 'inherit',
              fontSize: '12px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: P.accent,
              cursor: 'pointer'
            },
            banner: {
              borderRadius: '8px',
              padding: '8px 12px',
              fontSize: '13px',
              border: '1px solid ' + P.line
            },
            bannerError: { border: '1px solid ' + P.danger, background: P.dangerSoft, color: P.danger },
            bannerOk: { border: '1px solid ' + P.line, background: P.okSoft, color: P.ok },
            planLine: { color: P.text, fontSize: '13px' },
            barRow: { display: 'flex', alignItems: 'center', gap: '12px' },
            barTrack: {
              flex: 1,
              height: '8px',
              borderRadius: '999px',
              background: P.track,
              overflow: 'hidden'
            },
            barFill: {
              height: '100%',
              borderRadius: '999px',
              background: P.accent,
              transition: 'width .25s linear'
            },
            barFillDone: { background: P.ok },
            meta: {
              fontFamily: MONO,
              fontSize: '12px',
              color: P.sub,
              whiteSpace: 'nowrap',
              flex: 'none'
            },
            filesRow: { fontFamily: MONO, fontSize: '12px', color: P.sub },
            kindGrid: { display: 'flex', flexDirection: 'column', gap: '6px' },
            kindRow: { display: 'flex', alignItems: 'center', gap: '10px' },
            kindLabel: { width: '68px', flex: 'none', fontSize: '12px', color: P.sub },
            kindTrack: {
              flex: 1,
              height: '5px',
              borderRadius: '999px',
              background: P.track,
              overflow: 'hidden'
            },
            kindFill: {
              height: '100%',
              borderRadius: '999px',
              background: P.accent,
              transition: 'width .25s linear'
            },
            kindCount: {
              width: '96px',
              flex: 'none',
              textAlign: 'right',
              fontFamily: MONO,
              fontSize: '12px',
              color: P.sub
            },
            badge: {
              display: 'inline-block',
              borderRadius: '999px',
              padding: '1px 10px',
              fontSize: '12px',
              border: '1px solid ' + P.line,
              color: P.sub,
              whiteSpace: 'nowrap'
            },
            badgeActive: { border: '1px solid ' + P.accent, background: P.accentSoft, color: P.accent },
            badgeDone: { border: '1px solid ' + P.ok, background: P.okSoft, color: P.ok },
            badgeError: { border: '1px solid ' + P.danger, background: P.dangerSoft, color: P.danger },
            details: { display: 'flex', flexDirection: 'column', gap: '6px' },
            summary: { cursor: 'pointer', fontSize: '13px', color: P.danger },
            errList: {
              maxHeight: '180px',
              overflow: 'auto',
              margin: 0,
              fontFamily: MONO,
              fontSize: '12px',
              lineHeight: 1.55,
              color: P.sub
            },
            errRow: { padding: '2px 0', wordBreak: 'break-all' },
            logPre: {
              margin: 0,
              padding: '10px 12px',
              borderRadius: '8px',
              background: P.log,
              color: P.logText,
              fontFamily: MONO,
              fontSize: '12px',
              lineHeight: 1.55,
              maxHeight: '200px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            },
            idle: { margin: 0, color: P.sub, fontSize: '13px' }
          }
        }

        /* ---------------------------- polling store ---------------------------- *
         * The sidebar icon and the main panel share this one store, so the icon's
         * "in progress" dot costs no extra traffic and the two never disagree.
         * Poll interval: 800ms while a task is planning/downloading, else 3000ms.
         * Nothing is polled while no component is subscribed.
         * ------------------------------------------------------------------- */
        const store = (function createPollStore() {
          const listeners = new Set()
          let snapshot = { state: null, error: '', pending: true, at: 0 }
          let timer = null
          let fetching = false

          function notify() {
            listeners.forEach(function (listener) {
              try {
                listener()
              } catch (_err) {
                /* a broken subscriber must not stop the poll loop */
              }
            })
          }

          function nextDelay() {
            const state = snapshot.state
            const task = state && state.task ? state.task : null
            return task && isRunningPhase(task.phase) ? 800 : 3000
          }

          function clearTimer() {
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
          }

          function arm() {
            clearTimer()
            if (listeners.size === 0) return
            timer = setTimeout(function () {
              timer = null
              tick()
            }, nextDelay())
          }

          async function tick() {
            if (fetching) return
            fetching = true
            try {
              const result = await requestApi('/state')
              if (result && result.ok === true) {
                snapshot = { state: result, error: '', pending: false, at: Date.now() }
              } else {
                snapshot = {
                  state: snapshot.state,
                  error: (result && result.error) || '无法读取宿主动作状态',
                  pending: false,
                  at: Date.now()
                }
              }
            } catch (err) {
              snapshot = {
                state: snapshot.state,
                error: '状态轮询失败：' + describeError(err),
                pending: false,
                at: Date.now()
              }
            }
            fetching = false
            notify()
            arm()
          }

          return {
            getSnapshot: function () {
              return snapshot
            },
            subscribe: function (listener) {
              listeners.add(listener)
              if (listeners.size === 1) {
                if (fetching) arm()
                else tick()
              }
              return function () {
                listeners.delete(listener)
                if (listeners.size === 0) clearTimer()
              }
            },
            /** Refresh now (after a mutating action) and keep the loop alive. */
            refresh: function () {
              if (listeners.size === 0) return
              clearTimer()
              if (fetching) {
                arm()
                return
              }
              tick()
            }
          }
        })()

        function useStoreSnapshot() {
          const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
          React.useEffect(function () {
            const unsubscribe = store.subscribe(function () {
              setSnapshot(store.getSnapshot())
            })
            setSnapshot(store.getSnapshot())
            return unsubscribe
          }, [])
          return snapshot
        }

        /** Sidebar icon only cares about one boolean; keep its re-renders minimal. */
        function useRunning() {
          const read = function () {
            const snapshot = store.getSnapshot()
            const state = snapshot.state
            const task = state && state.task ? state.task : null
            return !!(task && isRunningPhase(task.phase))
          }
          const [running, setRunning] = React.useState(read)
          React.useEffect(function () {
            const sync = function () {
              const next = read()
              setRunning(function (prev) {
                return prev === next ? prev : next
              })
            }
            const unsubscribe = store.subscribe(sync)
            sync()
            return unsubscribe
          }, [])
          return running
        }

        /* ----------------------------- sidebar icon ---------------------------- */

        /** Props from the sidebar panel row: `{size: 16|18, active: boolean}`. */
        function PanelIcon(props) {
          const size = props && typeof props.size === 'number' ? props.size : 18
          const active = !!(props && props.active)
          const running = useRunning()
          const children = [
            h('rect', {
              key: 'block',
              x: 3.5,
              y: 3.5,
              width: 17,
              height: 17,
              rx: 3.5,
              strokeWidth: active ? 1.9 : 1.6
            }),
            h('path', {
              key: 'shaft',
              d: 'M12 7.8v6.3',
              strokeWidth: active ? 1.9 : 1.6,
              strokeLinecap: 'round'
            }),
            h('path', {
              key: 'head',
              d: 'M9.1 11.5 12 14.4l2.9-2.9',
              strokeWidth: active ? 1.9 : 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round'
            })
          ]
          if (running) {
            children.push(
              h('circle', {
                key: 'dot',
                cx: 19.2,
                cy: 19.2,
                r: 3.1,
                fill: '#22c55e',
                stroke: 'none'
              })
            )
          }
          return h(
            'svg',
            {
              viewBox: '0 0 24 24',
              width: size,
              height: size,
              fill: 'none',
              stroke: 'currentColor',
              'aria-hidden': 'true',
              focusable: 'false',
              style: { display: 'block' }
            },
            children
          )
        }

        /* ------------------------------ main panel ----------------------------- */

        /** Versions grouped for the native select: releases first, then snapshots. */
        function versionGroups(versions, typeFilter, search) {
          const query = search.trim().toLowerCase()
          const list = versions.filter(function (version) {
            if (!version || typeof version.id !== 'string') return false
            if (typeFilter !== 'all' && version.type !== typeFilter) return false
            if (query && version.id.toLowerCase().indexOf(query) === -1) return false
            return true
          })
          const groups = []
          const releases = list.filter(function (version) {
            return version.type === 'release'
          })
          const snapshots = list.filter(function (version) {
            return version.type === 'snapshot'
          })
          const others = list.filter(function (version) {
            return version.type !== 'release' && version.type !== 'snapshot'
          })
          if (releases.length > 0) groups.push({ label: '正式版', items: releases })
          if (snapshots.length > 0) groups.push({ label: '快照', items: snapshots })
          if (others.length > 0) groups.push({ label: '其他', items: others })
          return groups
        }

        function PanelMain() {
          const dark = useDark()
          const P = dark ? DARK : LIGHT
          const S = React.useMemo(function () {
            return makeStyles(P)
          }, [P])

          const snapshot = useStoreSnapshot()
          const state = snapshot.state
          const task = state && state.task ? state.task : null
          const running = !!(task && isRunningPhase(task.phase))

          const [manifest, setManifest] = React.useState({
            status: 'loading',
            versions: [],
            latest: null,
            total: 0,
            error: ''
          })
          const [reloadKey, setReloadKey] = React.useState(0)
          const [version, setVersion] = React.useState('')
          const [typeFilter, setTypeFilter] = React.useState('all')
          const [search, setSearch] = React.useState('')
          const [dir, setDir] = React.useState('')
          const [plan, setPlan] = React.useState(null)
          const [busy, setBusy] = React.useState('')
          const [banner, setBanner] = React.useState(null)
          const dirTouched = React.useRef(false)
          const alive = React.useRef(true)

          React.useEffect(function () {
            alive.current = true
            return function () {
              alive.current = false
            }
          }, [])

          /* Manifest: one fetch per reload key, cancelled on unmount. */
          React.useEffect(function () {
            let cancelled = false
            setManifest(function (prev) {
              return Object.assign({}, prev, { status: 'loading', error: '' })
            })
            requestApi('/manifest').then(function (result) {
              if (cancelled) return
              if (result && result.ok === true) {
                const versions = Array.isArray(result.versions) ? result.versions : []
                setManifest({
                  status: 'ok',
                  versions: versions,
                  latest: result.latest && typeof result.latest === 'object' ? result.latest : null,
                  total: typeof result.total === 'number' ? result.total : versions.length,
                  error: ''
                })
              } else {
                setManifest(function (prev) {
                  return Object.assign({}, prev, {
                    status: 'error',
                    error: (result && result.error) || '版本清单加载失败'
                  })
                })
              }
            })
            return function () {
              cancelled = true
            }
          }, [reloadKey])

          /* Default the version selection to latest.release once the manifest lands. */
          React.useEffect(function () {
            if (manifest.status !== 'ok') return
            setVersion(function (prev) {
              if (prev) return prev
              const latestRelease =
                manifest.latest && typeof manifest.latest.release === 'string' ? manifest.latest.release : ''
              if (latestRelease) return latestRelease
              const firstRelease = manifest.versions.filter(function (item) {
                return item && item.type === 'release' && typeof item.id === 'string'
              })[0]
              const fallback = firstRelease || manifest.versions[0]
              return fallback && typeof fallback.id === 'string' ? fallback.id : ''
            })
          }, [manifest])

          /* Seed the directory input from the host config until the user edits it. */
          React.useEffect(function () {
            const configDir = state && state.config && typeof state.config.dir === 'string' ? state.config.dir : ''
            if (!dirTouched.current && configDir && !dir) setDir(configDir)
          }, [state, dir])

          const concurrency = state && state.config && typeof state.config.concurrency === 'number' ? state.config.concurrency : 8

          const groups = React.useMemo(function () {
            return versionGroups(manifest.versions, typeFilter, search)
          }, [manifest.versions, typeFilter, search])

          const visibleIds = React.useMemo(function () {
            const ids = {}
            groups.forEach(function (group) {
              group.items.forEach(function (item) {
                ids[item.id] = true
              })
            })
            return ids
          }, [groups])

          function showError(result, fallback) {
            const text = (result && result.error) || fallback || '操作失败'
            setBanner({ tone: 'error', text: text })
          }

          async function runScan() {
            if (busy) return
            if (!version) {
              setBanner({ tone: 'error', text: '先选择要扫描的版本' })
              return
            }
            setBusy('plan')
            setBanner(null)
            const result = await postJson('/plan', { version: version, dir: dir })
            if (!alive.current) return
            if (result && result.ok === true && result.plan && typeof result.plan === 'object') {
              setPlan(result.plan)
              setBanner(null)
            } else {
              setPlan(null)
              showError(result, '扫描计划失败')
            }
            setBusy('')
          }

          async function runStart() {
            if (busy) return
            if (!version) {
              setBanner({ tone: 'error', text: '先选择要下载的版本' })
              return
            }
            setBusy('start')
            setBanner(null)
            const result = await postJson('/start', {
              version: version,
              dir: dir,
              concurrency: concurrency
            })
            if (!alive.current) return
            if (result && result.ok === true) {
              setBanner({ tone: 'ok', text: '已开始下载 ' + version + (result.taskId ? '（任务 ' + result.taskId + '）' : '') })
            } else {
              showError(result, '启动下载失败')
            }
            setBusy('')
            store.refresh()
          }

          async function runCancel() {
            if (busy) return
            setBusy('cancel')
            setBanner(null)
            const result = await postJson('/cancel', {})
            if (!alive.current) return
            if (result && result.ok === true) {
              setBanner({ tone: 'ok', text: result.cancelled === false ? '当前没有可取消的任务' : '已请求取消' })
            } else {
              showError(result, '取消失败')
            }
            setBusy('')
            store.refresh()
          }

          async function runOpen() {
            if (busy) return
            setBusy('open')
            setBanner(null)
            const result = await postJson('/open', { target: 'dir' })
            if (!alive.current) return
            if (result && result.ok === true) {
              setBanner({ tone: 'ok', text: '已打开：' + (typeof result.path === 'string' ? result.path : '下载目录') })
            } else {
              showError(result, '打开目录失败')
            }
            setBusy('')
          }

          /* ------------------------------ fragments ----------------------------- */

          const selectChildren = []
          if (version && !visibleIds[version]) {
            selectChildren.push(
              h('option', { key: 'pinned', value: version }, version + '（当前选择）')
            )
          }
          groups.forEach(function (group) {
            selectChildren.push(
              h(
                'optgroup',
                { key: group.label, label: group.label },
                group.items.map(function (item) {
                  return h(
                    'option',
                    { key: item.id, value: item.id, title: item.releaseTime || item.type || '' },
                    item.id
                  )
                })
              )
            )
          })

          const filterButtons = [
            { key: 'all', label: '全部' },
            { key: 'release', label: '正式版' },
            { key: 'snapshot', label: '快照' }
          ].map(function (item) {
            const on = typeFilter === item.key
            return h(
              'button',
              {
                key: item.key,
                type: 'button',
                onClick: function () {
                  setTypeFilter(item.key)
                },
                style: on ? Object.assign({}, S.segBtn, S.segOn) : S.segBtn
              },
              item.label
            )
          })

          const btnPrimary = function (disabled) {
            return disabled ? Object.assign({}, S.btn, S.btnPrimary, S.btnDisabled) : Object.assign({}, S.btn, S.btnPrimary)
          }
          const btnPlain = function (disabled) {
            return disabled ? Object.assign({}, S.btn, S.btnDisabled) : S.btn
          }
          const btnDanger = function (disabled) {
            return disabled ? Object.assign({}, S.btn, S.btnDanger, S.btnDisabled) : Object.assign({}, S.btn, S.btnDanger)
          }

          const planLine = plan
            ? h(
                'div',
                { style: S.planLine },
                h('span', { style: S.mono }, String(typeof plan.files === 'number' ? plan.files : 0)),
                ' 个文件 · ',
                h('span', { style: S.mono }, humanBytes(plan.bytes)),
                plan.byKind && typeof plan.byKind === 'object'
                  ? h(
                      'span',
                      { style: S.subtle },
                      '（客户端 ' +
                        String(bucketCount(plan.byKind.client)) +
                        ' · 库 ' +
                        String(bucketCount(plan.byKind.libraries)) +
                        ' · 资源索引 ' +
                        String(bucketCount(plan.byKind.assetIndex)) +
                        ' · 资源 ' +
                        String(bucketCount(plan.byKind.assets)) +
                        '）'
                    )
                  : null
              )
            : null

          /* ------------------------------- progress ----------------------------- */

          let progressCard = null
          if (task) {
            const bytesTotal = typeof task.bytesTotal === 'number' ? task.bytesTotal : 0
            const bytesDone = typeof task.bytesDone === 'number' ? task.bytesDone : 0
            const complete = task.phase === 'done'
            const fillStyle = complete
              ? Object.assign({}, S.barFill, S.barFillDone, {
                  width: barWidth(complete ? bytesTotal : bytesDone, bytesTotal)
                })
              : Object.assign({}, S.barFill, { width: barWidth(bytesDone, bytesTotal) })

            const metaBits = []
            const pct = percentText(complete ? bytesTotal : bytesDone, bytesTotal)
            if (pct) metaBits.push(pct)
            const speed = typeof task.speedBps === 'number' ? task.speedBps : 0
            if (running && speed > 0) metaBits.push(humanBytes(speed) + '/s')
            const eta = running ? humanEta(task.etaSec) : ''
            if (eta) metaBits.push(eta)
            if (complete) metaBits.push('已完成')

            const filesRow =
              '文件 ' +
              String(typeof task.filesDone === 'number' ? task.filesDone : 0) +
              '/' +
              String(typeof task.filesTotal === 'number' ? task.filesTotal : 0) +
              ' · 跳过 ' +
              String(typeof task.filesSkipped === 'number' ? task.filesSkipped : 0) +
              ' · 失败 ' +
              String(typeof task.filesFailed === 'number' ? task.filesFailed : 0)

            const kindRows = KINDS.map(function (kind) {
              const bucket = task.byKind && typeof task.byKind === 'object' ? task.byKind[kind.key] : null
              const n = bucket && typeof bucket.n === 'number' ? bucket.n : 0
              const done = bucket && typeof bucket.done === 'number' ? bucket.done : 0
              return h(
                'div',
                { key: kind.key, style: S.kindRow },
                h('span', { style: S.kindLabel }, kind.label),
                h('span', { style: S.kindTrack }, h('span', { style: Object.assign({}, S.kindFill, { display: 'block', width: barWidth(done, n) }) })),
                h('span', { style: S.kindCount }, done + '/' + n)
              )
            })

            const badgeStyle =
              task.phase === 'done'
                ? Object.assign({}, S.badge, S.badgeDone)
                : task.phase === 'error'
                  ? Object.assign({}, S.badge, S.badgeError)
                  : running
                    ? Object.assign({}, S.badge, S.badgeActive)
                    : S.badge

            progressCard = h(
              'section',
              { style: S.card },
              h(
                'div',
                { style: S.cardHead },
                h('h2', { style: S.h2 }, '进度'),
                h('span', { style: badgeStyle }, phaseLabel(task.phase)),
                h('span', { style: S.subtle }, '版本 ' + String(task.version || version || '—')),
                h('span', { style: S.subtle }, '目录 ' + String(task.dir || dir || '—'))
              ),
              h(
                'div',
                { style: S.barRow },
                h('div', { style: S.barTrack }, h('div', { style: fillStyle })),
                h('span', { style: S.meta }, metaBits.join(' · ') || '等待数据')
              ),
              h('div', { style: S.filesRow }, filesRow),
              h('div', { style: S.kindGrid }, kindRows)
            )
          }

          /* -------------------------------- errors ------------------------------ */

          let errorsCard = null
          const errors = task && Array.isArray(task.errors) ? task.errors : []
          if (errors.length > 0) {
            const shown = errors.slice(0, 20)
            errorsCard = h(
              'section',
              { style: S.card },
              h(
                'details',
                { style: S.details },
                h('summary', { style: S.summary }, '失败 ' + errors.length + ' 项（显示前 ' + shown.length + ' 项）'),
                h(
                  'div',
                  { style: S.errList },
                  shown.map(function (item, index) {
                    const rel = item && typeof item.rel === 'string' ? item.rel : '—'
                    const status = item && (typeof item.status === 'number' || typeof item.status === 'string') ? String(item.status) : ''
                    const message = item && typeof item.message === 'string' ? item.message : ''
                    const url = item && typeof item.url === 'string' ? item.url : ''
                    return h(
                      'div',
                      { key: 'err-' + index, style: S.errRow },
                      rel,
                      status ? ' · ' + status : '',
                      message ? ' · ' + message : '',
                      url ? ' · ' + url : ''
                    )
                  })
                )
              )
            )
          }

          /* --------------------------------- log -------------------------------- */

          let logCard = null
          const logLines = task && Array.isArray(task.log) ? task.log.slice(-20) : []
          if (logLines.length > 0) {
            logCard = h(
              'section',
              { style: S.card },
              h(
                'div',
                { style: S.cardHead },
                h('h2', { style: S.h2 }, '日志'),
                h('span', { style: S.subtle }, '最后 ' + logLines.length + ' 行')
              ),
              h('pre', { style: S.logPre }, logLines.join('\n'))
            )
          }

          /* --------------------------------- idle ------------------------------- */

          const idle = !task
            ? h(
                'section',
                { style: S.card },
                h(
                  'p',
                  { style: S.idle },
                  '空闲中：全部经 BMCLAPI 镜像（' +
                    MIRROR_HOST +
                    '）下载，下载后按官方目录布局落盘，文件逐个 SHA-1 校验。选好版本后点「扫描计划」看清单，再点「开始下载」。'
                )
              )
            : null

          const stateError = snapshot.error
            ? h('div', { style: Object.assign({}, S.banner, S.bannerError) }, '状态：' + snapshot.error)
            : null
          const bannerNode = banner
            ? h(
                'div',
                {
                  style:
                    banner.tone === 'error'
                      ? Object.assign({}, S.banner, S.bannerError)
                      : Object.assign({}, S.banner, S.bannerOk)
                },
                banner.text
              )
            : null

          const manifestNode =
            manifest.status === 'error'
              ? h('div', { style: Object.assign({}, S.banner, S.bannerError) }, '版本清单：' + manifest.error)
              : null

          return h(
            'div',
            { style: S.root },
            h(
              'div',
              { style: S.inner },
              h(
                'header',
                { style: S.header },
                h(
                  'div',
                  { style: S.titleRow },
                  h('h1', { style: S.h1 }, 'Minecraft 下载器'),
                  h('span', { style: S.pill, title: '全部流量走镜像' }, MIRROR_HOST)
                ),
                h(
                  'p',
                  { style: S.lede },
                  '全部流量走镜像 ' +
                    MIRROR_HOST +
                    '（BMCLAPI），版本清单、客户端 jar、库、资源索引与资源对象都从镜像取，不直连官方源。'
                )
              ),
              stateError,
              bannerNode,
              h(
                'section',
                { style: S.card },
                h(
                  'div',
                  { style: S.cardHead },
                  h('h2', { style: S.h2 }, '版本'),
                  h(
                    'span',
                    { style: S.subtle },
                    manifest.status === 'loading'
                      ? '加载镜像清单…'
                      : manifest.status === 'ok'
                        ? '镜像共 ' + manifest.total + ' 个版本' +
                          (manifest.latest && manifest.latest.release ? ' · 最新正式版 ' + manifest.latest.release : '')
                        : '清单不可用'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: function () {
                        setReloadKey(function (prev) {
                          return prev + 1
                        })
                      },
                      style: Object.assign({}, S.linkBtn, { marginLeft: 'auto' })
                    },
                    '刷新清单'
                  )
                ),
                manifestNode,
                h(
                  'div',
                  { style: S.filterRow },
                  h('span', { style: S.seg }, filterButtons),
                  h('input', {
                    type: 'search',
                    value: search,
                    placeholder: '搜索版本号，如 1.21',
                    spellCheck: false,
                    onChange: function (event) {
                      setSearch(event.target.value)
                    },
                    style: S.searchInput
                  })
                ),
                h(
                  'select',
                  {
                    value: version,
                    disabled: manifest.versions.length === 0,
                    onChange: function (event) {
                      setVersion(event.target.value)
                    },
                    style: S.select,
                    'aria-label': '选择 Minecraft 版本'
                  },
                  selectChildren
                )
              ),
              h(
                'section',
                { style: S.card },
                h('h2', { style: S.h2 }, '下载目录'),
                h('input', {
                  type: 'text',
                  value: dir,
                  spellCheck: false,
                  placeholder: '例如 C:\\Users\\<你>\\.mc-download',
                  onChange: function (event) {
                    dirTouched.current = true
                    setDir(event.target.value)
                  },
                  style: S.input,
                  'aria-label': '下载目录'
                }),
                h(
                  'div',
                  { style: S.dirHint },
                  '留空则使用宿主默认目录；并发 ' + String(concurrency) + ' 路。按官方目录布局落盘（versions / libraries / assets）。'
                )
              ),
              h(
                'section',
                { style: S.card },
                h('h2', { style: S.h2 }, '操作'),
                h(
                  'div',
                  { style: S.actions },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: runScan,
                      disabled: !!busy || !version,
                      style: btnPlain(!!busy || !version)
                    },
                    busy === 'plan' ? '扫描中…' : '扫描计划'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: runStart,
                      disabled: !!busy || !version || running,
                      title: running ? '已有任务在跑' : '开始下载',
                      style: btnPrimary(!!busy || !version || running)
                    },
                    busy === 'start' ? '启动中…' : '开始下载'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: runCancel,
                      disabled: !!busy || !running,
                      title: running ? '取消当前任务' : '当前没有进行中的任务',
                      style: btnDanger(!!busy || !running)
                    },
                    busy === 'cancel' ? '取消中…' : '取消'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: runOpen,
                      disabled: !!busy,
                      style: btnPlain(!!busy)
                    },
                    '打开目录'
                  )
                ),
                planLine
              ),
              idle,
              progressCard,
              errorsCard,
              logCard
            )
          )
        }
        return { PanelMain, PanelIcon }
      })()

      // ══════════════════════════════════════════════════════════════════════
      // 页签「版本」—— 实例内容管理（模组 / 资源包 / 光影 / 存档 / 配置 / 日志 / 崩溃）
      // 与上面两个面板同样的闭包隔离：LaunchUI / DownloadUI 里的 Btn / Card / palette
      // 在外壳作用域拿不到，所以这里自带一份最小样式 helper，视觉风格与它们对齐。
      //
      // 宿主契约（字段名原样照抄，不许自创）：
      //   GET  /mc/state                                    → versions[] / selected
      //   GET  /mc/inst/summary?versionId=…                  → counts / sizeBytes / lastPlayed / gameDir
      //   GET  /mc/inst/content?versionId=…&kind=…           → dir / entries[]
      //   GET  /mc/inst/log?versionId=…&kind=…&name=…&tail=400 → text
      //   POST /mc/inst/toggle | delete | open | analyze
      //
      // 不做自动轮询：只在挂载 / 切版本 / 切分类 / 操作成功后各拉一次。
      // ══════════════════════════════════════════════════════════════════════
      const InstanceUI = (function () {

        const { useState, useEffect, useRef } = React

        const API_STATE = '/mc/state'
        const API_INST = '/mc/inst'
        const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

        /** 分类顺序即界面上 chip 的顺序。 */
        const KINDS = [
          { key: 'mods', label: '模组' },
          { key: 'resourcepacks', label: '资源包' },
          { key: 'shaderpacks', label: '光影' },
          { key: 'saves', label: '存档' },
          { key: 'config', label: '配置' },
          { key: 'logs', label: '日志' },
          { key: 'crashReports', label: '崩溃' },
        ]

        /** 这两类点文件名要读内容并显示在 <pre> 里。 */
        const TEXT_KINDS = { logs: true, crashReports: true }

        /* ================================================================ 纯函数 */

        function errText(e) {
          try { return String((e && e.message) || e || '未知错误') } catch (_e) { return '未知错误' }
        }

        function pad2(n) {
          return n < 10 ? '0' + n : String(n)
        }

        /** 1234567 → "1.2 MB"（与下载面板同一套进位规则）。 */
        function humanBytes(value) {
          const n = typeof value === 'number' && isFinite(value) ? value : 0
          if (!(n > 0)) return '0 B'
          const units = ['KB', 'MB', 'GB', 'TB']
          let scaled = n / 1024
          let index = 0
          while (scaled >= 1024 && index < units.length - 1) {
            scaled = scaled / 1024
            index += 1
          }
          return scaled.toFixed(1) + ' ' + units[index]
        }

        /** 行内大小文案：目录显示「文件夹」，大小未知显示「—」。 */
        function fmtSize(value, isDir) {
          if (isDir) return '文件夹'
          if (typeof value !== 'number' || !isFinite(value)) return '—'
          return humanBytes(value)
        }

        /** 时间戳 → "2026-10-25 12:00"（本地时区；空值给空串）。 */
        function fmtStamp(ms) {
          const n = Number(ms)
          if (!n || !isFinite(n)) return ''
          const d = new Date(n)
          if (!isFinite(d.getTime())) return ''
          return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
            ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        }

        /** counts 里的项可能是数字 / 数组 / {n,done}：一律降成数字。 */
        function countOf(value) {
          if (Array.isArray(value)) return value.length
          if (value && typeof value === 'object') {
            const n = countOf(value.n)
            return n || countOf(value.done)
          }
          const n = Number(value)
          return isFinite(n) ? n : 0
        }

        /** 模组计数：契约是 {enabled, disabled}，宽松兼容纯数字。 */
        function modsOf(counts) {
          const m = counts && counts.mods
          if (m && typeof m === 'object' && !Array.isArray(m)) {
            const on = countOf(m.enabled)
            const off = countOf(m.disabled)
            return { on: on, off: off, total: on + off }
          }
          const total = countOf(m)
          return { on: total, off: 0, total: total }
        }

        function clip(text, max) {
          const s = String(text === undefined || text === null ? '' : text)
          if (!s || s.length <= max) return s
          return s.slice(0, max) + '…'
        }

        function kindLabel(key) {
          for (let i = 0; i < KINDS.length; i += 1) if (KINDS[i].key === key) return KINDS[i].label
          return String(key || '')
        }

        function versionOptionLabel(v) {
          if (!v) return '（未知版本）'
          let text = String(v.id || '')
          const bits = []
          if (v.loader) bits.push(String(v.loader))
          if (v.javaMajor) bits.push('Java ' + v.javaMajor)
          const miss = Number(v.missingCount) || 0
          if (miss > 0) bits.push('缺 ' + miss + ' 个文件')
          if (v.hasJar === false) bits.push('缺客户端 jar')
          if (bits.length) text += ' · ' + bits.join(' · ')
          return text
        }

        function hasId(list, id) {
          if (!id) return false
          for (let i = 0; i < list.length; i += 1) if (list[i] && list[i].id === id) return true
          return false
        }

        /** 挑当前版本：优先保持原选择，其次宿主 selected，最后第一个。 */
        function pickVersion(list, selected, prev) {
          if (hasId(list, prev)) return prev
          if (hasId(list, selected)) return selected
          return (list && list[0] && list[0].id) || ''
        }

        /* ================================================================== HTTP */

        async function request(url, method, body) {
          if (typeof fetch !== 'function') throw new Error('当前环境没有 fetch')
          const init = { method: method || 'GET', headers: { 'content-type': 'application/json' } }
          if (body !== undefined) init.body = JSON.stringify(body)
          let res
          try {
            res = await fetch(url, init)
          } catch (e) {
            throw new Error('请求 ' + url + ' 失败：' + errText(e))
          }
          let text = ''
          try { text = await res.text() } catch (_e) { text = '' }
          let json = null
          try { json = text ? JSON.parse(text) : null } catch (_e) { json = null }
          if (!res.ok) {
            const fallback = String(text || '').slice(0, 300) || ('HTTP ' + (res && res.status ? res.status : '?'))
            throw new Error((json && json.error) || fallback)
          }
          if (json && json.ok === false) throw new Error(String(json.error || '宿主返回 ok=false'))
          return json || {}
        }

        function qs(pairs) {
          const parts = []
          for (let i = 0; i < pairs.length; i += 1) {
            const k = pairs[i][0]
            const v = pairs[i][1]
            if (v === undefined || v === null || v === '') continue
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
          }
          return parts.length ? '?' + parts.join('&') : ''
        }

        function getSummary(versionId) {
          return request(API_INST + '/summary' + qs([['versionId', versionId]]), 'GET')
        }

        function getContent(versionId, kind) {
          return request(API_INST + '/content' + qs([['versionId', versionId], ['kind', kind]]), 'GET')
        }

        function getLog(versionId, kind, name) {
          return request(API_INST + '/log' + qs([['versionId', versionId], ['kind', kind], ['name', name], ['tail', 400]]), 'GET')
        }

        function postJson(path, body) {
          return request(API_INST + path, 'POST', body)
        }

        /** content 回复归一成 {kind, dir, entries[]}，缺字段不炸。 */
        function normalizeContent(data, kind) {
          const d = data || {}
          return {
            kind: kind,
            dir: typeof d.dir === 'string' ? d.dir : '',
            entries: Array.isArray(d.entries) ? d.entries : [],
          }
        }

        /* ================================================================= 主题 */

        function readDark() {
          try {
            return Boolean(typeof document !== 'undefined' && document.body &&
              document.body.hasAttribute('data-ds-dark-theme'))
          } catch (_e) { return false }
        }

        /** 跟随宿主 body[data-ds-dark-theme]，observer 在卸载时断开。 */
        function useDark() {
          const [dark, setDark] = useState(readDark)
          useEffect(function () {
            let BodyObserver = null
            try {
              if (typeof window !== 'undefined' && window && typeof window.MutationObserver === 'function') {
                BodyObserver = window.MutationObserver
              } else if (typeof MutationObserver !== 'undefined') {
                BodyObserver = MutationObserver
              }
            } catch (_e) { BodyObserver = null }
            let body = null
            try { body = typeof document !== 'undefined' ? document.body : null } catch (_e) { body = null }
            if (!body || !BodyObserver) return undefined
            const sync = function () {
              setDark(function (prev) {
                const next = readDark()
                return prev === next ? prev : next
              })
            }
            sync()
            const observer = new BodyObserver(sync)
            try {
              observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
            } catch (_e) { return undefined }
            return function () { observer.disconnect() }
          }, [])
          return dark
        }

        const LIGHT = {
          bg: '#f7f7f8', card: '#ffffff', text: '#18181b', sub: '#52525b',
          line: 'rgba(0,0,0,.12)', log: '#0f172a', logText: '#e2e8f0', inputBg: '#ffffff',
          track: 'rgba(0,0,0,.06)', accent: '#2563eb', accentSoft: 'rgba(37,99,235,.12)',
          danger: '#dc2626', dangerSoft: 'rgba(220,38,38,.10)',
          warn: '#b45309', warnSoft: 'rgba(180,83,9,.10)',
          ok: '#15803d', okSoft: 'rgba(21,128,61,.10)',
        }

        const DARK = {
          bg: '#17171b', card: '#212127', text: '#f4f4f5', sub: '#a1a1aa',
          line: 'rgba(255,255,255,.13)', log: '#0d0d10', logText: '#e4e4e7', inputBg: '#1b1b21',
          track: 'rgba(255,255,255,.10)', accent: '#3b82f6', accentSoft: 'rgba(59,130,246,.18)',
          danger: '#f87171', dangerSoft: 'rgba(248,113,113,.14)',
          warn: '#fbbf24', warnSoft: 'rgba(251,191,36,.14)',
          ok: '#4ade80', okSoft: 'rgba(74,222,128,.14)',
        }

        /* ================================================================= 样式 */

        function makeStyles(P) {
          const input = {
            boxSizing: 'border-box',
            padding: '6px 10px',
            borderRadius: 8,
            border: '1px solid ' + P.line,
            background: P.inputBg,
            color: P.text,
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: 1.5,
            outline: 'none',
          }
          return {
            root: {
              minHeight: '100%',
              boxSizing: 'border-box',
              background: P.bg,
              color: P.text,
              fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
              fontSize: 14,
              lineHeight: 1.65,
              padding: '28px 32px 48px',
            },
            inner: {
              maxWidth: 880,
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            },
            titleRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
            h1: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.4 },
            pill: {
              border: '1px solid ' + P.line,
              borderRadius: 999,
              padding: '1px 10px',
              fontSize: 12,
              color: P.sub,
              fontFamily: MONO,
              whiteSpace: 'nowrap',
            },
            lede: { margin: 0, color: P.sub, fontSize: 13 },
            card: {
              border: '1px solid ' + P.line,
              borderRadius: 12,
              background: P.card,
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            },
            cardHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
            h2: { margin: 0, fontSize: 14, fontWeight: 600 },
            subtle: { color: P.sub, fontSize: 12 },
            mono: { fontFamily: MONO, fontSize: 12, color: P.sub, wordBreak: 'break-all' },
            controlRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
            select: Object.assign({}, input, { maxWidth: '100%', minWidth: 240 }),
            statLine: { fontSize: 13.5, color: P.text, wordBreak: 'break-word' },
            chipsRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
            chip: {
              fontFamily: 'inherit',
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: '4px 12px',
              borderRadius: 999,
              cursor: 'pointer',
              border: '1px solid ' + P.line,
              background: 'transparent',
              color: P.sub,
            },
            chipOn: { background: P.accentSoft, color: P.accent, fontWeight: 600, border: '1px solid ' + P.accent },
            row: {
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '9px 2px',
              borderTop: '1px solid ' + P.line,
            },
            rowOn: { background: P.accentSoft, borderRadius: 8 },
            rowMain: { flex: '1 1 auto', minWidth: 0 },
            nameText: {
              fontSize: 13,
              fontFamily: MONO,
              wordBreak: 'break-all',
            },
            nameLink: {
              fontFamily: MONO,
              fontSize: 13,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: P.accent,
              cursor: 'pointer',
              textDecoration: 'underline',
              wordBreak: 'break-all',
              textAlign: 'left',
            },
            meta: { color: P.sub, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
            dot: { opacity: 0.6 },
            note: { color: P.sub, fontSize: 12, fontStyle: 'italic' },
            badge: {
              fontSize: 11,
              lineHeight: 1.5,
              padding: '0 7px',
              borderRadius: 999,
              border: '1px solid ' + P.warn,
              color: P.warn,
              background: P.warnSoft,
              whiteSpace: 'nowrap',
            },
            actions: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', flexWrap: 'wrap' },
            btn: {
              fontFamily: 'inherit',
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: '4px 11px',
              borderRadius: 8,
              cursor: 'pointer',
              border: '1px solid ' + P.line,
              background: 'transparent',
              color: P.text,
              whiteSpace: 'nowrap',
            },
            btnPrimary: { border: '1px solid ' + P.accent, background: P.accent, color: '#ffffff', fontWeight: 600 },
            btnDanger: { border: '1px solid ' + P.danger, color: P.danger, background: 'transparent' },
            btnOff: { opacity: 0.45, cursor: 'not-allowed' },
            banner: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 13,
            },
            bannerError: { border: '1px solid ' + P.danger, background: P.dangerSoft, color: P.danger },
            bannerOk: { border: '1px solid ' + P.line, background: P.okSoft, color: P.ok },
            bannerText: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' },
            bannerClose: {
              flex: '0 0 auto',
              fontFamily: 'inherit',
              fontSize: 15,
              lineHeight: 1,
              padding: '2px 4px',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              opacity: 0.75,
            },
            hint: { color: P.sub, fontSize: 12.5, padding: '6px 0' },
            pre: {
              margin: 0,
              maxHeight: 320,
              overflow: 'auto',
              background: P.log,
              color: P.logText,
              border: '1px solid ' + P.line,
              borderRadius: 8,
              padding: '10px 12px',
              fontFamily: MONO,
              fontSize: 11.5,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
            findings: { display: 'flex', flexDirection: 'column', gap: 8 },
            analysisSummary: { fontSize: 13, color: P.text, fontWeight: 600, wordBreak: 'break-word' },
          }
        }

        /* ═══════════════════════════════════════════════════════════════════
         * 「Java 运行时」卡 —— 版本页签里的独立组件（自带状态 / 轮询 / 错误条）
         *
         * 宿主契约（lib/java-routes.js，字段名原样照抄，不许自创）：
         *   GET  /mc/java/runtimes → { ok, platform, installed, runtimes[] }
         *   GET  /mc/java/state    → { ok, task } | { ok, task: null }
         *   POST /mc/java/install  body {component} → { ok, taskId }（忙时 409）
         *   POST /mc/java/cancel   body {}          → { ok, cancelled }
         *
         * 轮询：只有 task.phase ∈ planning/downloading/verifying 时才开 1200ms 定时器；
         * 任务结束 / 出错 / 组件卸载都会把它清掉。挂载时只「读一次」当前状态（用于
         * 恢复上次没跑完的进度显示），绝不自动发起安装 —— 只有用户点「安装 / 更新」
         * 才会 POST /mc/java/install。
         * ═══════════════════════════════════════════════════════════════════ */
        const JAVA_API = '/mc/java'
        const JAVA_POLL_MS = 1200
        const JAVA_RUNNING_PHASE = { planning: true, downloading: true, verifying: true }

        function javaRunning(phase) {
          return Boolean(JAVA_RUNNING_PHASE[String(phase || '')])
        }

        /** 24200000 / 99100000 → "23.1/94.5 MB"（同一单位；总量未知时退化成「已完成 / —」）。 */
        function javaBytesPair(done, total) {
          const d = Number(done) || 0
          const t = Number(total) || 0
          if (!(t > 0)) return humanBytes(d) + ' / —'
          const gb = 1024 * 1024 * 1024
          const unit = t >= gb ? gb : 1024 * 1024
          return (d / unit).toFixed(1) + '/' + (t / unit).toFixed(1) + ' ' + (unit === gb ? 'GB' : 'MB')
        }

        /** 进度百分比（0–100）：优先按字节，没字节就退化成按文件数。 */
        function javaProgressPct(task) {
          if (!task) return 0
          const bt = Number(task.bytesTotal) || 0
          const bd = Number(task.bytesDone) || 0
          let pct = 0
          if (bt > 0) {
            pct = (bd / bt) * 100
          } else {
            const ft = Number(task.filesTotal) || 0
            const fd = Number(task.filesDone) || 0
            if (ft > 0) pct = (fd / ft) * 100
          }
          if (!isFinite(pct) || pct < 0) pct = 0
          if (pct > 100) pct = 100
          return pct
        }

        /** 「135/402 文件 · 23.1/94.5 MB · 6.5 MB/s · 剩 11 秒」 */
        function javaProgressLine(task) {
          if (!task) return ''
          const bits = []
          const ft = Number(task.filesTotal) || 0
          const fd = Number(task.filesDone) || 0
          if (ft > 0) bits.push(String(fd) + '/' + String(ft) + ' 文件')
          bits.push(javaBytesPair(task.bytesDone, task.bytesTotal))
          const speed = Number(task.speedBps) || 0
          if (speed > 0) bits.push(humanBytes(speed) + '/s')
          const eta = Number(task.etaSec)
          if (isFinite(eta) && eta > 0) bits.push('剩 ' + Math.round(eta) + ' 秒')
          return bits.join(' · ')
        }

        function javaPhaseLabel(phase) {
          if (phase === 'planning') return '准备中…'
          if (phase === 'downloading') return '下载中'
          if (phase === 'verifying') return '校验中…'
          if (phase === 'done') return '已完成'
          if (phase === 'cancelled') return '已取消'
          if (phase === 'error') return '失败'
          return String(phase || '')
        }

        /** 行的状态文案 + 语义色标（渲染时再映射成 P.ok / P.warn / P.sub）。 */
        function javaRowStatus(rt) {
          if (rt && rt.installed) {
            const iv = rt.installedVersion ? String(rt.installedVersion) : '未知'
            if (rt.upToDate) return { text: '已装 ' + iv + ' ✓', tone: 'ok' }
            return { text: '已装 ' + iv + '（索引 ' + String(rt.version || '—') + '）', tone: 'warn' }
          }
          return { text: '未安装', tone: 'sub' }
        }

        function JavaRuntimeCard() {
          const dark = useDark()
          const P = dark ? DARK : LIGHT
          const s = makeStyles(P)

          const alive = useRef(true)
          const timerRef = useRef(null)
          const pollRef = useRef(null)
          const doneRef = useRef({})

          const [snap, setSnap] = useState(null)
          const [loading, setLoading] = useState(false)
          const [loadError, setLoadError] = useState('')
          const [error, setError] = useState('')
          const [task, setTask] = useState(null)
          const [busyRow, setBusyRow] = useState('')
          const [cancelling, setCancelling] = useState(false)

          /* 降序展示（后端已经排好，这里再兜一次，防契约漂移） */
          const list = snap && Array.isArray(snap.runtimes) ? snap.runtimes.slice() : []
          list.sort(function (a, b) {
            const am = a && typeof a.major === 'number' ? a.major : -1
            const bm = b && typeof b.major === 'number' ? b.major : -1
            if (am !== bm) return bm - am
            return String((a && a.component) || '').localeCompare(String((b && b.component) || ''))
          })
          const installedCount = snap && typeof snap.installed === 'number'
            ? snap.installed
            : list.filter(function (it) { return Boolean(it && it.installed) }).length
          const running = Boolean(task && javaRunning(task.phase))
          const taskPhase = task ? String(task.phase || '') : ''
          const taskComponent = task ? String(task.component || '') : ''
          const redText = error || loadError

          function stopTimer() {
            if (timerRef.current !== null) {
              try { clearInterval(timerRef.current) } catch (_e) { /* 定时器已经没了 */ }
              timerRef.current = null
            }
          }

          function startTimer() {
            stopTimer()
            timerRef.current = setInterval(function () {
              const fn = pollRef.current
              if (typeof fn === 'function') fn()
            }, JAVA_POLL_MS)
          }

          async function loadRuntimes() {
            setLoading(true)
            setLoadError('')
            try {
              const data = await request(JAVA_API + '/runtimes', 'GET')
              if (!alive.current) return
              setSnap(data || null)
            } catch (e) {
              if (alive.current) setLoadError(errText(e))
            } finally {
              if (alive.current) setLoading(false)
            }
          }

          /** 把 /mc/java/state 快照落到界面；任务结束就停表、刷新列表（一次）。 */
          function applyTask(next) {
            const t = next || null
            setTask(t)
            if (t && javaRunning(t.phase)) {
              if (timerRef.current === null) startTimer()
              return
            }
            stopTimer()
            setBusyRow('')
            setCancelling(false)
            if (!t) return
            if (t.phase === 'error') {
              const msg = t.error
                ? String(t.error)
                : (t.verify && t.verify.message ? String(t.verify.message) : '安装失败')
              setError(msg)
            }
            if (t.phase === 'done' || t.phase === 'error' || t.phase === 'cancelled') {
              const key = String(t.id || t.phase)
              if (!doneRef.current[key]) {
                doneRef.current[key] = true
                loadRuntimes()
              }
            }
          }

          async function pollState() {
            try {
              const data = await request(JAVA_API + '/state', 'GET')
              if (!alive.current) return
              applyTask(data && data.task)
            } catch (e) {
              if (!alive.current) return
              stopTimer()
              setError(errText(e))
            }
          }

          /* 挂载：只读一次状态 + 拉一次清单；卸载时把定时器清干净。 */
          useEffect(function () {
            alive.current = true
            pollRef.current = pollState
            pollState()
            loadRuntimes()
            return function () {
              alive.current = false
              stopTimer()
            }
          }, [])

          async function onInstall(rt) {
            const component = rt && rt.component ? String(rt.component) : ''
            if (!component || running || busyRow) return
            setError('')
            setLoadError('')
            setBusyRow(component)
            try {
              const res = await request(JAVA_API + '/install', 'POST', { component: component })
              if (!alive.current) return
              setTask({
                id: (res && res.taskId) || '',
                component: component,
                phase: 'planning',
                filesTotal: 0,
                filesDone: 0,
                bytesTotal: 0,
                bytesDone: 0,
                speedBps: 0,
                etaSec: null,
                verify: null,
                error: null,
              })
              startTimer()
              pollState()
            } catch (e) {
              if (!alive.current) return
              setBusyRow('')
              setError(errText(e))
            }
          }

          async function onCancel() {
            if (cancelling) return
            setCancelling(true)
            setError('')
            try {
              await request(JAVA_API + '/cancel', 'POST', {})
              if (!alive.current) return
              pollState()
            } catch (e) {
              if (!alive.current) return
              setError(errText(e))
            } finally {
              if (alive.current) setCancelling(false)
            }
          }

          /* ------------------------------------------------------------ 渲染 */

          const headerNode = h('div', { style: s.cardHead },
            h('h2', { style: s.h2 }, 'Java 运行时'),
            h('button', {
              type: 'button',
              style: Object.assign({}, s.btn, { marginLeft: 'auto' }),
              disabled: loading,
              onClick: function () { loadRuntimes() },
            }, loading ? '刷新中…' : '刷新')
          )

          const noteNode = h('div', { style: s.subtle },
            (snap && snap.platform ? String(snap.platform) + ' · ' : '') +
            '已装 ' + installedCount + ' 个'
          )

          const errorNode = redText
            ? h('div', { style: Object.assign({}, s.banner, s.bannerError), role: 'alert' },
                h('span', { style: s.bannerText }, String(redText)),
                h('button', {
                  type: 'button',
                  title: '关闭',
                  'aria-label': '关闭错误提示',
                  style: s.bannerClose,
                  onClick: function () { setError(''); setLoadError('') },
                }, '×'))
            : null

          /* 任务区：进行中 → 进度条 + 文案 + 取消；结束 → verify.message（成功绿 / 失败红）。 */
          let statusNode = null
          if (task && running) {
            const pct = javaProgressPct(task)
            statusNode = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontFamily: MONO, fontSize: 12.5, color: P.text } }, taskComponent),
                h('span', { style: s.subtle }, javaPhaseLabel(taskPhase)),
                h('button', {
                  type: 'button',
                  style: Object.assign({}, s.btn, s.btnDanger, { marginLeft: 'auto' }, cancelling ? s.btnOff : null),
                  disabled: cancelling,
                  onClick: function () { onCancel() },
                }, cancelling ? '取消中…' : '取消')
              ),
              h('div', {
                role: 'progressbar',
                'aria-valuenow': Math.round(pct),
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                style: {
                  position: 'relative',
                  height: 6,
                  borderRadius: 999,
                  background: P.track,
                  overflow: 'hidden',
                },
              }, h('div', {
                style: {
                  height: '100%',
                  width: pct.toFixed(1) + '%',
                  borderRadius: 999,
                  background: P.accent,
                  transition: 'width .25s linear',
                },
              })),
              h('div', { style: s.subtle }, javaProgressLine(task))
            )
          } else if (task && taskPhase === 'done') {
            const vr = task.verify || null
            const ok = !vr || vr.ok !== false
            const msg = vr && vr.message ? String(vr.message) : '安装完成'
            statusNode = h('div', { style: Object.assign({}, s.banner, ok ? s.bannerOk : s.bannerError) },
              h('span', { style: s.bannerText }, msg),
              h('button', {
                type: 'button',
                title: '关闭',
                'aria-label': '关闭安装结果',
                style: s.bannerClose,
                onClick: function () { setTask(null) },
              }, '×'))
          } else if (task && taskPhase === 'cancelled') {
            statusNode = h('div', {
              style: Object.assign({}, s.banner, { border: '1px solid ' + P.line, background: P.track, color: P.sub }),
            },
              h('span', { style: s.bannerText }, '安装已取消'),
              h('button', {
                type: 'button',
                title: '关闭',
                'aria-label': '关闭取消提示',
                style: s.bannerClose,
                onClick: function () { setTask(null) },
              }, '×'))
          }

          function renderRow(rt) {
            const item = rt || {}
            const component = String(item.component || '')
            const major = typeof item.major === 'number' ? item.major : null
            const st = javaRowStatus(item)
            const installed = Boolean(item.installed)
            const upToDate = Boolean(item.upToDate)
            const mine = running && taskComponent === component
            let label = '安装'
            let tone = 'primary'
            let disabled = running || Boolean(busyRow)
            if (installed && upToDate) {
              label = '已是最新'
              tone = 'plain'
              disabled = true
            } else if (installed) {
              label = '更新'
              tone = 'plain'
            }
            if (mine) label = '安装中…'
            const btnStyle = Object.assign({}, s.btn)
            if (tone === 'primary') Object.assign(btnStyle, s.btnPrimary)
            if (disabled && !mine) Object.assign(btnStyle, s.btnOff)
            const statusColor = st.tone === 'ok' ? P.ok : (st.tone === 'warn' ? P.warn : P.sub)
            return h('div', { key: component || String(item.path || ''), style: s.row },
              h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: s.nameText, title: component }, component),
                  major !== null
                    ? h('span', {
                        style: {
                          fontSize: 11.5,
                          lineHeight: 1.5,
                          padding: '0 7px',
                          borderRadius: 999,
                          border: '1px solid ' + P.accent,
                          color: P.accent,
                          background: P.accentSoft,
                          whiteSpace: 'nowrap',
                          fontFamily: MONO,
                        },
                      }, 'Java ' + String(major))
                    : null,
                  h('span', { style: s.subtle }, '索引 ' + String(item.version || '—'))
                )
              ),
              h('div', {
                style: { flex: '0 0 auto', fontSize: 13, color: statusColor, whiteSpace: 'nowrap' },
              }, st.text),
              h('div', { style: s.actions },
                h('button', {
                  type: 'button',
                  style: btnStyle,
                  disabled: disabled,
                  onClick: function () { onInstall(item) },
                }, label)
              )
            )
          }

          const listNode = list.length
            ? list.map(renderRow)
            : h('div', { style: s.hint }, loading ? '加载中…' : '没有读到运行时清单')

          return h('div', { style: s.card },
            headerNode,
            noteNode,
            errorNode,
            statusNode,
            listNode
          )
        }

        /* =============================================================== 组件 */

        /* ═══════════════════════════════════════════════════════════════════
         * 「安装加载器」卡 —— Fabric / Quilt / Forge / NeoForge
         *
         * 宿主契约（lib/loader-routes.js）：
         *   GET  /mc/loader/list?type=&mc=   → { ok, type, mcVersion, loaders:[{version,stable}] }
         *   POST /mc/loader/install          → { ok, taskId }（忙时 409）
         *   GET  /mc/loader/state            → { ok, task } | { ok, task: null }
         *   GET  /mc/loader/instances?type=  → { ok, instances:[{id,json,inheritsFrom}] }
         *
         * 注意：Fabric/Quilt 要原版已存在才能装（profile 只提供加载器层），所以「原版版本」
         * 下拉只列 loader==='vanilla' 的实例，缺文件的会标注并禁用安装。
         * ═══════════════════════════════════════════════════════════════════ */
        const LOADER_API = '/mc/loader'
        const LOADER_POLL_MS = 1200
        const LOADER_TYPES = [
          { key: 'fabric', label: 'Fabric' },
          { key: 'quilt', label: 'Quilt' },
          { key: 'forge', label: 'Forge' },
          { key: 'neoforge', label: 'NeoForge' },
        ]
        const LOADER_RUNNING_PHASE = { planning: true, installing: true, downloading: true }

        function loaderRunning(phase) {
          return Boolean(LOADER_RUNNING_PHASE[String(phase || '')])
        }

        function loaderPhaseLabel(phase) {
          const map = { planning: '准备中', installing: '安装中', downloading: '下载库', done: '完成', error: '失败', cancelled: '已取消' }
          return map[String(phase || '')] || String(phase || '-')
        }

        function LoaderCard(props) {
          const onChanged = props && props.onChanged
          const dark = useDark()
          const P = dark ? DARK : LIGHT
          const [bases, setBases] = useState([])
          const [type, setType] = useState('fabric')
          const [mcVersion, setMcVersion] = useState('')
          const [loaders, setLoaders] = useState([])
          const [loaderVersion, setLoaderVersion] = useState('')
          const [task, setTask] = useState(null)
          const [instances, setInstances] = useState([])
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState('')
          const timerRef = useRef(null)
          const alive = useRef(true)

          const st = {
            card: { background: P.card, border: '1px solid ' + P.line, borderRadius: 12, padding: '14px 16px' },
            title: { fontWeight: 600, fontSize: 14 },
            hint: { color: P.sub, fontSize: 12.5, marginTop: 4, lineHeight: 1.6 },
            row: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 },
            field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150, flex: '1 1 150px' },
            label: { color: P.sub, fontSize: 12 },
            select: {
              padding: '7px 10px', borderRadius: 9, border: '1px solid ' + P.line,
              background: P.inputBg, color: P.text, fontSize: 13,
              font: '13px/1.4 system-ui, "Microsoft YaHei", sans-serif',
            },
            btn: {
              padding: '8px 16px', borderRadius: 10, border: '1px solid transparent',
              background: P.accent, color: '#ffffff', fontSize: 13, cursor: 'pointer',
            },
            btnDisabled: { opacity: 0.55, cursor: 'default' },
            err: {
              marginTop: 10, padding: '8px 10px', borderRadius: 9, fontSize: 12.5,
              background: P.dangerSoft, border: '1px solid ' + P.danger, color: P.danger,
              display: 'flex', justifyContent: 'space-between', gap: 8,
            },
            bar: { height: 6, borderRadius: 999, background: P.track, overflow: 'hidden', marginTop: 8 },
            ok: { color: P.ok, fontSize: 12.5, marginTop: 8 },
            bad: { color: P.danger, fontSize: 12.5, marginTop: 8 },
            logLine: { color: P.sub, fontSize: 11.5, fontFamily: MONO, marginTop: 2, wordBreak: 'break-all' },
          }

          function stopTimer() {
            if (timerRef.current !== null) {
              try { clearInterval(timerRef.current) } catch (_e) { /* 已经没了 */ }
              timerRef.current = null
            }
          }

          function startTimer() {
            stopTimer()
            timerRef.current = setInterval(function () {
              const fn = pollRef.current
              if (typeof fn === 'function') fn()
            }, LOADER_POLL_MS)
          }

          const pollRef = useRef(null)

          function applyTask(next) {
            const t = next || null
            setTask(t)
            if (t && loaderRunning(t.phase)) {
              if (timerRef.current === null) startTimer()
              return
            }
            stopTimer()
            setBusy(false)
            if (!t) return
            if (t.phase === 'error') setError(String(t.error || '安装失败'))
            if (t.phase === 'done') {
              const r = t.result || {}
              const created = Array.isArray(r.created) ? r.created : []
              if (created.length) setError('')
              loadInstances()
              if (typeof onChanged === 'function') { try { onChanged() } catch (_e) { /* 不影响本体 */ } }
            }
          }

          pollRef.current = async function () {
            try {
              const data = await request(LOADER_API + '/state', 'GET')
              if (alive.current) applyTask(data ? data.task : null)
            } catch (e) {
              if (alive.current) { setError(errText(e)); stopTimer() }
            }
          }

          async function loadBases() {
            try {
              const data = await request(API_STATE, 'GET')
              if (!alive.current) return
              const list = (data && data.versions ? data.versions : []).filter(function (v) { return v && v.loader === 'vanilla' })
              list.sort(function (a, b) { return String(b.id).localeCompare(String(a.id), undefined, { numeric: true }) })
              setBases(list)
              setMcVersion(function (prev) {
                if (prev && list.some(function (v) { return v.id === prev })) return prev
                const sel = data && data.selected
                if (sel && list.some(function (v) { return v.id === sel })) return sel
                return list.length ? list[0].id : ''
              })
            } catch (e) {
              if (alive.current) setError(errText(e))
            }
          }

          async function loadLoaders(nextType, nextMc) {
            if (!nextMc) { setLoaders([]); setLoaderVersion(''); return }
            try {
              const data = await request(LOADER_API + '/list' + qs([['type', nextType], ['mc', nextMc]]), 'GET')
              if (!alive.current) return
              const list = (data && data.loaders ? data.loaders : []).filter(function (l) { return l && l.version })
              setLoaders(list)
              const stable = list.filter(function (l) { return l.stable })[0] || list[0]
              setLoaderVersion(stable ? stable.version : '')
            } catch (e) {
              if (alive.current) { setLoaders([]); setLoaderVersion(''); setError(errText(e)) }
            }
          }

          async function loadInstances() {
            try {
              const data = await request(LOADER_API + '/instances' + qs([['type', type]]), 'GET')
              if (alive.current) setInstances(data && data.instances ? data.instances : [])
            } catch (_e) { /* 实例列表失败不影响安装 */ }
          }

          useEffect(function () {
            alive.current = true
            loadBases()
            pollRef.current()
            return function () {
              alive.current = false
              stopTimer()
            }
          }, [])

          useEffect(function () {
            loadLoaders(type, mcVersion)
            loadInstances()
          }, [type, mcVersion])

          const selectedBase = bases.filter(function (v) { return v.id === mcVersion })[0] || null
          const baseMissing = selectedBase && typeof selectedBase.missingCount === 'number' ? selectedBase.missingCount : 0
          const running = Boolean(task && loaderRunning(task.phase))
          const canInstall = Boolean(type && mcVersion && loaderVersion) && !busy && !running && baseMissing === 0

          async function doInstall() {
            setBusy(true)
            setError('')
            try {
              await request(LOADER_API + '/install', 'POST', { type: type, mcVersion: mcVersion, loaderVersion: loaderVersion })
              await (pollRef.current ? pollRef.current() : Promise.resolve())
            } catch (e) {
              if (alive.current) { setError(errText(e)); setBusy(false) }
            }
          }

          const phase = task ? String(task.phase || '') : ''
          const total = task ? Number(task.bytesTotal) || 0 : 0
          const done = task ? Number(task.bytesDone) || 0 : 0
          const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0
          const logLines = task && Array.isArray(task.log) ? task.log.slice(-2) : []
          const result = task ? task.result || null : null
          const labelOfType = function (k) { const hit = LOADER_TYPES.filter(function (t) { return t.key === k })[0]; return hit ? hit.label : k }

          const children = []
          children.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
            h('div', { key: 't', style: st.title }, '安装加载器'),
            h('div', { key: 'h', style: { color: P.sub, fontSize: 12.5 } },
              'Fabric/Quilt 只写元数据+下库；Forge/NeoForge 会跑官方 installer（失败会自动用镜像预置依赖后重试）'),
          ]))

          children.push(h('div', { key: 'fields', style: st.row }, [
            h('div', { key: 'type', style: st.field }, [
              h('div', { key: 'l', style: st.label }, '加载器'),
              h('select', {
                key: 's', value: type, style: st.select,
                onChange: function (e) { setType(e.target.value) },
              }, LOADER_TYPES.map(function (t) { return h('option', { key: t.key, value: t.key }, t.label) })),
            ]),
            h('div', { key: 'mc', style: st.field }, [
              h('div', { key: 'l', style: st.label }, '原版版本'),
              h('select', {
                key: 's', value: mcVersion, style: st.select,
                onChange: function (e) { setMcVersion(e.target.value) },
              }, bases.length
                ? bases.map(function (v) {
                    const miss = typeof v.missingCount === 'number' ? v.missingCount : 0
                    return h('option', { key: v.id, value: v.id }, v.id + (miss ? '（⚠ 缺 ' + miss + ' 个文件）' : ''))
                  })
                : [h('option', { key: 'none', value: '' }, '（没有原版版本，先去「下载」页签下）')]),
            ]),
            h('div', { key: 'lv', style: st.field }, [
              h('div', { key: 'l', style: st.label }, '加载器版本'),
              h('select', {
                key: 's', value: loaderVersion, style: st.select,
                onChange: function (e) { setLoaderVersion(e.target.value) },
              }, loaders.length
                ? loaders.slice(0, 200).map(function (l) { return h('option', { key: l.version, value: l.version }, l.version + (l.stable ? '' : '（beta）')) })
                : [h('option', { key: 'none', value: '' }, '（没有可用版本）')]),
            ]),
            h('div', { key: 'go', style: { display: 'flex', alignItems: 'flex-end' } },
              h('button', {
                onClick: canInstall ? doInstall : undefined,
                disabled: !canInstall,
                style: Object.assign({}, st.btn, canInstall ? null : st.btnDisabled),
              }, running ? '安装中…' : '安装 ' + labelOfType(type) + (loaderVersion ? ' ' + loaderVersion : ''))),
          ]))

          if (baseMissing > 0) {
            children.push(h('div', { key: 'basemiss', style: st.bad },
              '这个原版版本还缺 ' + baseMissing + ' 个文件，装加载器也起不来 —— 先去「下载」页签补齐。'))
          }

          if (task) {
            const prog = [h('div', { key: 'phase', style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, fontSize: 12.5 } }, [
              h('span', { key: 'p', style: { color: running ? P.accent : (phase === 'done' ? P.ok : P.danger), fontWeight: 600 } }, loaderPhaseLabel(phase)),
              h('span', { key: 'f', style: { color: P.sub } },
                (task.filesDone || 0) + '/' + (task.filesTotal || 0) + ' 个文件' + (total ? ' · ' + humanBytes(done) + '/' + humanBytes(total) : '')),
              (task.speedBps ? h('span', { key: 'sp', style: { color: P.sub } }, (Math.round(task.speedBps / 104857.6) / 10) + ' MB/s') : null),
            ])]
            if (total > 0) {
              prog.push(h('div', { key: 'bar', style: st.bar, role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 },
                h('div', { style: { width: pct.toFixed(1) + '%', height: '100%', background: P.accent, transition: 'width .25s linear' } })))
            }
            for (let i = 0; i < logLines.length; i += 1) prog.push(h('div', { key: 'lg' + i, style: st.logLine }, String(logLines[i]).slice(0, 200)))
            children.push(h('div', { key: 'prog' }, prog))

            if (phase === 'done') {
              const createdList = result && Array.isArray(result.created) ? result.created : []
              if (result && result.id) {
                const miss = Number(result.missing) || 0
                children.push(h('div', { key: 'done', style: miss ? st.bad : st.ok },
                  '已创建实例 ' + result.id + '（库 ' + (result.libraries || 0) + ' 个，' + (miss ? '还缺 ' + miss + ' 个' : '无缺失') + '）' + (miss ? '，可以点 /mc/loader/repair 补' : '，去「启动」页签就能启动')))
              } else if (createdList.length) {
                children.push(h('div', { key: 'done', style: st.ok }, 'installer 完成，新版本：' + createdList.join(', ')))
              } else {
                children.push(h('div', { key: 'done', style: st.ok }, 'installer 完成（没有新增版本，可能已经装过）'))
              }
              if (result && result.note) children.push(h('div', { key: 'note', style: st.logLine }, String(result.note)))
            }
          }

          if (error) {
            children.push(h('div', { key: 'err', style: st.err }, [
              h('span', { key: 'm', style: { wordBreak: 'break-word' } }, error),
              h('span', { key: 'x', style: { cursor: 'pointer', opacity: 0.8 }, onClick: function () { setError('') } }, '✕'),
            ]))
          }

          if (instances.length) {
            const ids = instances.slice(0, 5).map(function (x) { return x.id })
            children.push(h('div', { key: 'inst', style: { color: P.sub, fontSize: 12, marginTop: 10 } },
              '已装 ' + labelOfType(type) + ' 实例：' + ids.join('、') + (instances.length > ids.length ? ' 等 ' + instances.length + ' 个' : '')))
          }

          return h('div', { style: st.card }, children)
        }

        function InstancePanel() {
          const dark = useDark()
          const P = dark ? DARK : LIGHT
          const s = makeStyles(P)

          const alive = useRef(true)
          const contentSeq = useRef(0)

          const [versions, setVersions] = useState([])
          const [versionId, setVersionId] = useState('')
          const [summary, setSummary] = useState(null)
          const [kind, setKind] = useState('mods')
          const [content, setContent] = useState(null)
          const [backups, setBackups] = useState(null)
          const [updates, setUpdates] = useState(null)
          const [logView, setLogView] = useState(null)
          const [analysis, setAnalysis] = useState(null)
          const [error, setError] = useState('')
          const [notice, setNotice] = useState('')
          const [busy, setBusy] = useState('')

          useEffect(function () {
            alive.current = true
            return function () { alive.current = false }
          }, [])

          function busyStart(key) { setBusy(key) }
          function busyEnd(key) {
            setBusy(function (cur) { return cur === key ? '' : cur })
          }
          function fail(e) {
            if (alive.current) setError(errText(e))
          }
          function buttonStyle(tone, disabled) {
            const base = Object.assign({}, s.btn)
            if (tone === 'primary') Object.assign(base, s.btnPrimary)
            if (tone === 'danger') Object.assign(base, s.btnDanger)
            if (disabled) Object.assign(base, s.btnOff)
            return base
          }

          /* -------------------------------------------------------- 数据加载 */

          async function refreshAll() {
            busyStart('refresh')
            setError('')
            setNotice('')
            try {
              const state = await request(API_STATE, 'GET')
              if (!alive.current) return
              const list = Array.isArray(state.versions) ? state.versions : []
              setVersions(list)
              const next = pickVersion(list, state.selected, versionId)
              if (!next) {
                setVersionId('')
                return
              }
              if (next !== versionId) {
                // 交给 versionId 的 effect 去拉概览与列表，避免重复请求
                setVersionId(next)
                return
              }
              const pair = await Promise.all([getSummary(next), getContent(next, kind)])
              if (!alive.current) return
              setSummary(pair[0])
              setContent(normalizeContent(pair[1], kind))
            } catch (e) {
              fail(e)
            } finally {
              busyEnd('refresh')
            }
          }

          async function loadSummary(vid) {
            if (!vid) return
            busyStart('summary')
            try {
              const data = await getSummary(vid)
              if (alive.current) setSummary(data)
            } catch (e) {
              fail(e)
            } finally {
              busyEnd('summary')
            }
          }

          async function loadContent(vid, k) {
            if (!vid) return
            const seq = contentSeq.current + 1
            contentSeq.current = seq
            busyStart('content')
            try {
              const data = await getContent(vid, k)
              if (!alive.current || seq !== contentSeq.current) return
              setContent(normalizeContent(data, k))
            } catch (e) {
              if (alive.current && seq === contentSeq.current) {
                setContent({ kind: k, dir: '', entries: [] })
                setError(errText(e))
              }
            } finally {
              busyEnd('content')
            }
          }

          // 挂载即拉一次（版本清单 + 概览 + 当前分类列表）
          useEffect(function () { refreshAll() }, [])

          // 切版本：重拉概览，清掉上一篇日志/分析
          useEffect(function () {
            if (!versionId) return
            setSummary(null)
            setLogView(null)
            setAnalysis(null)
            loadSummary(versionId)
          }, [versionId])

          // 切版本 / 切分类：重拉列表（不轮询，只在依赖变化时拉）
          useEffect(function () {
            if (!versionId) return
            setContent(null)
            setUpdates(null)
            loadContent(versionId, kind)
            if (kind === 'saves') loadBackups(versionId)
          }, [versionId, kind])

          /* -------------------------------------------------------- 交互动作 */

          function onSelectVersion(e) {
            const next = e && e.target ? String(e.target.value || '') : ''
            if (!next || next === versionId) return
            setError('')
            setNotice('')
            setVersionId(next)
          }

          async function loadBackups(vid) {
            if (!vid) return
            try {
              const data = await request(API_INST + '/backups' + qs([['instance', vid]]), 'GET')
              if (alive.current) setBackups(data && data.backups ? data.backups : [])
            } catch (_e) {
              if (alive.current) setBackups([])
            }
          }

          async function onBackupAll() {
            if (!versionId || busy) return
            busyStart('backup')
            setError('')
            setNotice('')
            try {
              const data = await postJson('/backup', { instance: versionId })
              if (!alive.current) return
              setNotice('已备份 ' + (data.saves || []).join('、') + ' → ' + data.name + '（' + ((data.compressed || 0) / 1048576).toFixed(1) + ' MB）')
              loadBackups(versionId)
            } catch (e) {
              if (alive.current) setError(errText(e))
            } finally {
              if (alive.current) busyEnd('backup')
            }
          }

          async function onRestoreBackup(backup) {
            if (!versionId || busy || !backup) return
            busyStart('restore')
            setError('')
            setNotice('')
            try {
              const data = await postJson('/restore', { instance: versionId, backup: backup })
              if (!alive.current) return
              setNotice('已从 ' + backup + ' 还原 ' + (data.restored || 0) + ' 个文件' + (data.trashed && data.trashed.length ? '（原存档已移到回收站）' : ''))
              loadContent(versionId, kind)
              loadBackups(versionId)
            } catch (e) {
              if (alive.current) setError(errText(e))
            } finally {
              if (alive.current) busyEnd('restore')
            }
          }

          async function onDeleteBackup(backup) {
            if (!versionId || busy || !backup) return
            busyStart('backupDel')
            setError('')
            setNotice('')
            try {
              await postJson('/backupDelete', { instance: versionId, backup: backup })
              if (!alive.current) return
              setNotice('已删除备份 ' + backup)
              loadBackups(versionId)
            } catch (e) {
              if (alive.current) setError(errText(e))
            } finally {
              if (alive.current) busyEnd('backupDel')
            }
          }

          async function onShareCrash() {
            if (!versionId || busy) return
            busyStart('share')
            setError('')
            setNotice('')
            try {
              const body = { instance: versionId, kind: kind }
              if (logView && logView.name && TEXT_KINDS[kind]) body.name = logView.name
              const data = await postJson('/shareCrash', body)
              if (!alive.current) return
              let copied = false
              try {
                if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(String(data.markdown || ''))
                  copied = true
                }
              } catch (_e) {
                copied = false
              }
              setNotice('脱敏报告已生成：' + String(data.file || '') + (copied ? '（内容已复制到剪贴板）' : ''))
            } catch (e) {
              if (alive.current) setError(errText(e))
            } finally {
              if (alive.current) busyEnd('share')
            }
          }

          async function onCheckUpdates() {
            if (!versionId || busy) return
            busyStart('updates')
            setError('')
            setNotice('')
            try {
              // 注意：postJson 会自动加 /mc/inst 前缀，这条路由在 /mc/mod 下，必须用 request 直接调
              const data = await request('/mc/mod/updates', 'POST', { instance: versionId })
              if (!alive.current) return
              const list = Array.isArray(data.updates) ? data.updates : []
              setUpdates(list)
              const sum = data.summary || {}
              setNotice('检查了 ' + (sum.checked || 0) + ' 个模组：可更新 ' + (sum.updatable || 0) + ' · 已最新 ' + (sum.upToDate || 0) + ' · 非 Modrinth 来源 ' + (sum.unknown || 0))
            } catch (e) {
              if (alive.current) setError(errText(e))
            } finally {
              if (alive.current) busyEnd('updates')
            }
          }

          function onSelectKind(key) {
            if (!key || key === kind) return
            setError('')
            setNotice('')
            setKind(key)
          }

          async function onToggle(entry) {
            const name = entry && entry.name
            if (!name || !versionId || busy) return
            const key = 'toggle:' + name
            busyStart(key)
            setError('')
            setNotice('')
            try {
              const data = await postJson('/toggle', { versionId: versionId, kind: kind, name: name })
              if (!alive.current) return
              const updated = data && data.entry ? data.entry : null
              setContent(function (cur) {
                if (!cur) return cur
                const entries = cur.entries.map(function (it) {
                  return it && it.name === name && updated ? updated : it
                })
                return { kind: cur.kind, dir: cur.dir, entries: entries }
              })
              loadSummary(versionId)
            } catch (e) {
              fail(e)
            } finally {
              busyEnd(key)
            }
          }

          function askDelete(name) {
            const text = '确定删除「' + name + '」吗？\n\n文件会被移到回收站目录（不是永久删除），之后可以从那里手动恢复。'
            try {
              if (typeof window !== 'undefined' && window && typeof window.confirm === 'function') {
                return Boolean(window.confirm(text))
              }
            } catch (_e) { return false }
            return false
          }

          async function onDelete(entry) {
            const name = entry && entry.name
            if (!name || !versionId || busy) return
            if (!askDelete(name)) return
            const key = 'delete:' + name
            busyStart(key)
            setError('')
            setNotice('')
            try {
              const data = await postJson('/delete', { versionId: versionId, kind: kind, name: name })
              if (!alive.current) return
              setContent(function (cur) {
                if (!cur) return cur
                return {
                  kind: cur.kind,
                  dir: cur.dir,
                  entries: cur.entries.filter(function (it) { return !it || it.name !== name }),
                }
              })
              setLogView(function (cur) { return cur && cur.name === name ? null : cur })
              setAnalysis(null)
              const to = data && data.trashedTo ? '：' + String(data.trashedTo) : ''
              setNotice('已把「' + name + '」移到回收站' + to)
              loadSummary(versionId)
            } catch (e) {
              fail(e)
            } finally {
              busyEnd(key)
            }
          }

          async function postOpen(kindName, name) {
            if (!versionId || busy) return
            const key = 'open:' + (name || kindName)
            busyStart(key)
            setError('')
            setNotice('')
            const body = { versionId: versionId, kind: kindName }
            if (name) body.name = name
            try {
              const data = await postJson('/open', body)
              if (!alive.current) return
              const where = (data && data.path) || name || kindName
              setNotice('已在系统中打开：' + String(where))
            } catch (e) {
              fail(e)
            } finally {
              busyEnd(key)
            }
          }

          async function onOpenLog(entry) {
            const name = entry && entry.name
            if (!name || !versionId || busy) return
            const key = 'log:' + name
            busyStart(key)
            setError('')
            setNotice('')
            try {
              const data = await getLog(versionId, kind, name)
              if (!alive.current) return
              const text = data && data.text !== undefined && data.text !== null ? String(data.text) : ''
              setLogView({
                name: (data && data.name) || name,
                size: data && data.size,
                mtime: data && data.mtime,
                text: text,
              })
              setAnalysis(null)
            } catch (e) {
              fail(e)
            } finally {
              busyEnd(key)
            }
          }

          async function onExport() {
            if (!versionId || busy) return
            const key = 'export'
            busyStart(key)
            setError('')
            setNotice('')
            try {
              const data = await postJson('/export', { instance: versionId })
              if (!alive.current) return
              const mb = (Number(data && data.compressed) || 0) / 1048576
              setNotice('已导出 ' + (data && data.entries ? data.entries : 0) + ' 个条目（' + mb.toFixed(1) + ' MB）→ ' + String((data && data.outPath) || ''))
            } catch (e) {
              if (alive.current) setError(errText(e))
            } finally {
              if (alive.current) busyEnd(key)
            }
          }

          async function onAnalyze() {
            if (!versionId || busy) return
            const key = 'analyze'
            busyStart(key)
            setError('')
            setNotice('')
            const body = { versionId: versionId, kind: kind }
            if (logView && logView.name && TEXT_KINDS[kind]) body.name = logView.name
            try {
              const data = await postJson('/analyze', body)
              if (!alive.current) return
              setAnalysis({
                source: data && data.source ? data.source : null,
                findings: data && Array.isArray(data.findings) ? data.findings : [],
                summary: data && typeof data.summary === 'string' ? data.summary : '',
              })
            } catch (e) {
              fail(e)
            } finally {
              busyEnd(key)
            }
          }

          /* ------------------------------------------------------------ 渲染 */

          const body = build(s, P, {
            versions: versions,
            versionId: versionId,
            summary: summary,
            kind: kind,
            content: content,
            logView: logView,
            analysis: analysis,
            error: error,
            notice: notice,
            busy: busy,
            onSelectVersion: onSelectVersion,
            onSelectKind: onSelectKind,
            onRefresh: refreshAll,
            onToggle: onToggle,
            onDelete: onDelete,
            onOpenLog: onOpenLog,
            onAnalyze: onAnalyze,
            onExport: onExport,
            backups: backups,
            updates: updates,
            onBackupAll: onBackupAll,
            onRestoreBackup: onRestoreBackup,
            onDeleteBackup: onDeleteBackup,
            onCheckUpdates: onCheckUpdates,
            onShareCrash: onShareCrash,
            postOpen: postOpen,
            setError: setError,
            setNotice: setNotice,
            setLogView: setLogView,
            buttonStyle: buttonStyle,
          })
          return h('div', { style: s.root }, h('div', { style: s.inner }, body))
        }

        /** 纯渲染层：把 state 拼成节点树（不碰任何副作用）。 */
        function build(s, P, v) {
          const busy = v.busy || ''
          const entries = v.content && Array.isArray(v.content.entries) ? v.content.entries : []
          const dir = (v.content && v.content.dir) || ''
          const counts = (v.summary && v.summary.counts) || {}
          const mods = modsOf(counts)
          const loadingContent = busy === 'content'
          const textKind = Boolean(TEXT_KINDS[v.kind])

          /* 顶部错误 / 提示条（都可关闭） */
          const errorBar = v.error
            ? h('div', { key: 'error', style: Object.assign({}, s.banner, s.bannerError), role: 'alert' },
                h('span', { style: s.bannerText }, v.error),
                h('button', {
                  type: 'button',
                  title: '关闭',
                  'aria-label': '关闭错误提示',
                  style: s.bannerClose,
                  onClick: function () { v.setError('') },
                }, '×'))
            : null

          const noticeBar = v.notice
            ? h('div', { key: 'notice', style: Object.assign({}, s.banner, s.bannerOk) },
                h('span', { style: s.bannerText }, v.notice),
                h('button', {
                  type: 'button',
                  title: '关闭',
                  'aria-label': '关闭提示',
                  style: s.bannerClose,
                  onClick: function () { v.setNotice('') },
                }, '×'))
            : null

          /* 标题 */
          const title = h('div', { style: s.titleRow },
            h('h1', { style: s.h1 }, '版本内容'),
            v.versionId ? h('span', { style: s.pill }, String(v.versionId)) : null
          )

          /* 版本选择 + 刷新 */
          const controls = h('div', { style: s.card },
            h('div', { style: s.controlRow },
              h('span', { style: s.subtle }, '版本'),
              h('select', {
                style: s.select,
                'aria-label': '选择版本',
                value: v.versionId,
                onChange: v.onSelectVersion,
              }, v.versions.length
                ? v.versions.map(function (item, index) {
                    const id = item && item.id ? String(item.id) : ''
                    return h('option', { key: id || ('v' + index), value: id }, versionOptionLabel(item))
                  })
                : [h('option', { key: 'none', value: '' }, '（没有可用版本）')]),
              h('button', {
                type: 'button',
                style: v.buttonStyle('plain', busy === 'refresh'),
                disabled: busy === 'refresh',
                onClick: function () { if (!busy) v.onRefresh() },
              }, busy === 'refresh' ? '处理中…' : '刷新')
            )
          )

          /* 概览 */
          const statLine1 = '模组 ' + mods.on + '/' + mods.total + '（启用/总数）' +
            ' · 资源包 ' + countOf(counts.resourcepacks) +
            ' · 光影 ' + countOf(counts.shaderpacks) +
            ' · 存档 ' + countOf(counts.saves) +
            ' · 日志 ' + countOf(counts.logs) +
            ' · 崩溃 ' + countOf(counts.crashReports)
          const second = []
          if (v.summary && typeof v.summary.sizeBytes === 'number' && isFinite(v.summary.sizeBytes)) {
            second.push('占用 ' + humanBytes(v.summary.sizeBytes))
          }
          if (v.summary && v.summary.lastPlayed) second.push('最后游玩 ' + fmtStamp(v.summary.lastPlayed))
          const statLine2 = second.length ? second.join(' · ') : '还没有游玩记录'

          const overview = h('div', { style: s.card },
            h('div', { style: s.cardHead },
              h('h2', { style: s.h2 }, '概览'),
              h('span', { style: s.subtle }, busy === 'summary' ? '读取中…' : (v.summary ? '实例信息' : '还没读到实例信息')),
              h('button', {
                type: 'button',
                style: Object.assign(v.buttonStyle('plain', false), { marginLeft: 'auto' }),
                disabled: busy === ('open:mods'),
                onClick: function () { if (!busy) v.postOpen('mods') },
              }, busy === 'open:mods' ? '处理中…' : '打开实例目录')
            ),
            h('div', { style: s.statLine }, statLine1),
            h('div', { style: s.statLine }, statLine2),
            (v.summary && v.summary.gameDir)
              ? h('div', { style: s.mono, title: String(v.summary.gameDir) }, String(v.summary.gameDir))
              : null
          )

          /* 分类 chips */
          const chips = h('div', { style: s.chipsRow, role: 'group', 'aria-label': '内容分类' },
            KINDS.map(function (item) {
              const on = item.key === v.kind
              return h('button', {
                key: item.key,
                type: 'button',
                'aria-pressed': on ? 'true' : 'false',
                style: Object.assign({}, s.chip, on ? s.chipOn : null),
                onClick: function () { v.onSelectKind(item.key) },
              }, item.label)
            })
          )

          /* 列表行 */
          function renderRow(entry, index) {
            const item = entry || {}
            const name = String(item.name || '')
            const enabled = item.enabled !== false
            const selected = Boolean(v.logView && v.logView.name === name)
            const toggleKey = 'toggle:' + name
            const deleteKey = 'delete:' + name
            const openKey = 'open:' + name
            const logKey = 'log:' + name
            const buttons = []
            if (v.kind === 'mods') {
              buttons.push(h('button', {
                key: 'toggle',
                type: 'button',
                style: v.buttonStyle('plain', Boolean(busy)),
                disabled: Boolean(busy),
                onClick: function () { v.onToggle(item) },
              }, busy === toggleKey ? '处理中…' : (enabled ? '禁用' : '启用')))
            }
            buttons.push(h('button', {
              key: 'open',
              type: 'button',
              style: v.buttonStyle('plain', Boolean(busy)),
              disabled: Boolean(busy),
              onClick: function () { v.postOpen(v.kind, name) },
            }, busy === openKey ? '处理中…' : '打开位置'))
            buttons.push(h('button', {
              key: 'delete',
              type: 'button',
              style: v.buttonStyle('danger', Boolean(busy)),
              disabled: Boolean(busy),
              onClick: function () { v.onDelete(item) },
            }, busy === deleteKey ? '处理中…' : '删除'))

            return h('div', {
              key: String(item.path || name || index),
              style: Object.assign({}, s.row, selected ? s.rowOn : null),
            },
              h('div', { style: s.rowMain },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  (textKind && name)
                    ? h('button', {
                        type: 'button',
                        style: s.nameLink,
                        title: '查看内容',
                        onClick: function () { v.onOpenLog(item) },
                      }, busy === logKey ? '读取中…' : name)
                    : h('span', { style: s.nameText, title: name }, name || '（未命名）'),
                  v.kind === 'mods' && !enabled ? h('span', { style: s.badge }, '已禁用') : null
                ),
                h('div', { style: s.meta },
                  h('span', null, fmtSize(item.size, item.isDir)),
                  h('span', { style: s.dot }, '·'),
                  h('span', null, fmtStamp(item.mtime) || '—'),
                  item.note ? h('span', { style: s.dot }, '·') : null,
                  item.note ? h('span', { style: s.note, title: String(item.note) }, clip(item.note, 60)) : null
                )
              ),
              h('div', { style: s.actions }, buttons)
            )
          }

          const listBody = loadingContent
            ? h('div', { style: s.hint }, '加载中…')
            : entries.length
              ? entries.map(renderRow)
              : h('div', { style: s.hint }, '这个目录还是空的')

          const listCard = h('div', { style: s.card },
            h('div', { style: s.cardHead },
              h('h2', { style: s.h2 }, kindLabel(v.kind)),
              h('span', { style: s.subtle }, entries.length + ' 项'),
              v.kind === 'saves'
                ? h('button', {
                    type: 'button',
                    style: Object.assign(v.buttonStyle('plain', Boolean(busy)), { marginLeft: 'auto' }),
                    disabled: Boolean(busy) || !v.versionId,
                    title: '把 saves/ 里所有存档打包进实例的 .dsh-backups/',
                    onClick: function () { if (typeof v.onBackupAll === 'function') v.onBackupAll() },
                  }, busy === 'backup' ? '备份中…' : '备份全部存档')
                : null,
              v.kind === 'mods'
                ? h('button', {
                    type: 'button',
                    style: Object.assign(v.buttonStyle('plain', Boolean(busy)), { marginLeft: 'auto' }),
                    disabled: Boolean(busy) || !v.versionId,
                    title: '用 sha1 反查 Modrinth，列出可更新的模组',
                    onClick: function () { if (typeof v.onCheckUpdates === 'function') v.onCheckUpdates() },
                  }, busy === 'updates' ? '检查中…' : '检查更新')
                : null,
              h('button', {
                type: 'button',
                style: Object.assign(v.buttonStyle('plain', Boolean(busy)), { marginLeft: (v.kind === 'saves' || v.kind === 'mods') ? 0 : 'auto' }),
                disabled: Boolean(busy) || !v.versionId,
                title: '把 mods/config/options.txt 打包成 zip（默认落在实例目录里）',
                onClick: function () { if (typeof v.onExport === 'function') v.onExport() },
              }, busy === 'export' ? '导出中…' : '导出 zip'),
              h('button', {
                type: 'button',
                style: v.buttonStyle('plain', Boolean(busy)),
                disabled: Boolean(busy),
                onClick: function () { v.postOpen(v.kind) },
              }, busy === ('open:' + v.kind) ? '处理中…' : '打开目录')
            ),
            dir ? h('div', { style: s.mono, title: dir }, dir) : null,
            listBody
          )

          /* 存档备份卡（仅「存档」分类） */
          const backupCard = (v.kind === 'saves' && Array.isArray(v.backups))
            ? h('div', { style: Object.assign({}, s.card, { marginTop: 12 }) },
                h('div', { style: s.cardHead },
                  h('h2', { style: s.h2 }, '存档备份'),
                  h('span', { style: s.subtle }, v.backups.length + ' 个')),
                v.backups.length
                  ? v.backups.slice(0, 12).map(function (bk) {
                      const mb = ((bk.size || 0) / 1048576).toFixed(1)
                      const saves = (bk.manifest && Array.isArray(bk.manifest.saves)) ? bk.manifest.saves.join('、') : '（无清单）'
                      return h('div', { key: bk.name, style: { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px dashed ' + (v.P ? v.P.line : 'rgba(0,0,0,.1)'), flexWrap: 'wrap' } }, [
                        h('div', { key: 'n', style: { flex: '1 1 260px', wordBreak: 'break-all' } }, [
                          h('div', { key: 'a', style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 } }, bk.name),
                          h('div', { key: 'b', style: s.meta }, saves + ' · ' + mb + ' MB'),
                        ]),
                        h('button', {
                          key: 'r', type: 'button', style: v.buttonStyle('plain', Boolean(busy)), disabled: Boolean(busy),
                          onClick: function () {
                            if (typeof window !== 'undefined' && window.confirm && !window.confirm('还原备份会让当前存档先被移到回收站，继续？\n' + bk.name)) return
                            if (typeof v.onRestoreBackup === 'function') v.onRestoreBackup(bk.name)
                          },
                        }, busy === 'restore' ? '还原中…' : '还原备份'),
                        h('button', {
                          key: 'd', type: 'button', style: v.buttonStyle('plain', Boolean(busy)), disabled: Boolean(busy),
                          onClick: function () {
                            if (typeof window !== 'undefined' && window.confirm && !window.confirm('删除备份文件 ' + bk.name + '？')) return
                            if (typeof v.onDeleteBackup === 'function') v.onDeleteBackup(bk.name)
                          },
                        }, '删除备份'),
                      ])
                    })
                  : h('div', { style: s.hint }, '还没有备份。点上面的「备份全部存档」创建一个。'))
            : null

          /* 模组更新卡（仅「模组」分类） */
          const updatesCard = (v.kind === 'mods' && Array.isArray(v.updates))
            ? h('div', { style: Object.assign({}, s.card, { marginTop: 12 }) },
                h('div', { style: s.cardHead },
                  h('h2', { style: s.h2 }, '模组更新'),
                  h('span', { style: s.subtle }, v.updates.filter(function (u) { return u.status === 'update-available' }).length + ' 个可更新')),
                v.updates.length
                  ? v.updates.map(function (u) {
                      const tag = u.status === 'update-available' ? '可更新' : u.status === 'up-to-date' ? '已最新' : u.status
                      const color = u.status === 'update-available' ? 'inherit' : 'inherit'
                      return h('div', { key: u.file, style: { display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px dashed rgba(0,0,0,.08)', flexWrap: 'wrap', fontSize: 12.5 } }, [
                        h('span', { key: 't', style: { width: 66, flex: '0 0 66px', fontWeight: 600 } }, tag),
                        h('span', { key: 'f', style: { flex: '1 1 240px', wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, monospace' } }, u.file),
                        h('span', { key: 'v', style: Object.assign({}, s.meta, { color }) }, String(u.currentVersionNumber || '?') + (u.latestVersionNumber ? ' → ' + u.latestVersionNumber : '')),
                      ])
                    })
                  : h('div', { style: s.hint }, '点上面的「检查更新」开始（用 sha1 反查 Modrinth，只查启用中的 jar）'))
            : null

          /* 日志 / 崩溃内容 + 分析结果 */
          let textCard = null
          if (textKind) {
            const findings = (v.analysis && v.analysis.findings) || []
            const analysisNode = v.analysis
              ? h('div', { style: s.findings },
                  v.analysis.summary ? h('div', { style: s.analysisSummary }, v.analysis.summary) : null,
                  findings.length
                    ? findings.map(function (f, index) {
                        const item = f || {}
                        const severity = String(item.severity || 'info')
                        const tone = severity === 'error'
                          ? { color: P.danger, bg: P.dangerSoft, label: '错误' }
                          : severity === 'warn'
                            ? { color: P.warn, bg: P.warnSoft, label: '警告' }
                            : { color: P.sub, bg: P.track, label: '提示' }
                        return h('div', {
                          key: 'finding' + index,
                          style: {
                            borderLeft: '3px solid ' + tone.color,
                            background: tone.bg,
                            borderRadius: 8,
                            padding: '7px 12px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          },
                        },
                          h('div', { style: { fontSize: 13, fontWeight: 600, color: tone.color } },
                            tone.label + ' · ' + String(item.title || '未命名问题')),
                          item.detail
                            ? h('div', {
                                style: { fontFamily: MONO, fontSize: 11.5, color: P.text, opacity: 0.85, wordBreak: 'break-word' },
                              }, clip(item.detail, 240))
                            : null,
                          item.suggestion
                            ? h('div', { style: { fontSize: 12.5, color: P.sub, wordBreak: 'break-word' } },
                                '建议：' + String(item.suggestion))
                            : null
                        )
                      })
                    : h('div', { style: s.hint }, '没有发现明显的问题条目，可结合下方日志人工判断。')
                )
              : null

            textCard = h('div', { style: s.card },
              h('div', { style: s.cardHead },
                h('h2', { style: s.h2 }, v.kind === 'crashReports' ? '崩溃内容' : '日志内容'),
                h('span', { style: s.subtle },
                  v.logView
                    ? v.logView.name + ' · ' + fmtSize(v.logView.size)
                    : '点上面的文件名查看内容'),
                h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button',
                    style: v.buttonStyle('primary', Boolean(busy)),
                    disabled: Boolean(busy),
                    onClick: function () { v.onAnalyze() },
                  }, busy === 'analyze' ? '处理中…' : '分析崩溃'),
                  h('button', {
                    type: 'button',
                    style: v.buttonStyle('plain', Boolean(busy)),
                    disabled: Boolean(busy),
                    title: '把这份崩溃整理成脱敏 Markdown（用户目录/玩家名/UUID/令牌/IP 会被替换），并复制到剪贴板',
                    onClick: function () { v.onShareCrash() },
                  }, busy === 'share' ? '生成中…' : '生成脱敏报告'),
                  v.logView
                    ? h('button', {
                        type: 'button',
                        style: v.buttonStyle('plain', Boolean(busy)),
                        disabled: Boolean(busy),
                        onClick: function () { v.setLogView(null) },
                      }, '收起')
                    : null
                )
              ),
              analysisNode,
              v.logView ? h('pre', { style: s.pre }, v.logView.text || '（文件是空的）') : null
            )
          }

          return [
            errorBar,
            noticeBar,
            h('div', { key: 'header', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              title,
              h('p', { style: s.lede }, '管理这个实例的模组、资源包、光影、存档与日志，并分析崩溃原因。')
            ),
            h('div', { key: 'controls', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, controls),
            h('div', { key: 'overview', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, overview),
            h('div', { key: 'java', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, h(JavaRuntimeCard, null)),
            h('div', { key: 'loader', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, h(LoaderCard, { onChanged: v.onRefresh })),
            h('div', { key: 'kinds', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, chips, listCard, backupCard, updatesCard),
            textCard ? h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, textCard) : null,
          ]
        }

        return { PanelMain: InstancePanel }
      })()


      // ══════════════════════════════════════════════════════════════════════
      // 外壳 —— 单个侧栏入口 + 页签容器
      // 只负责布局与页签，不含任何子面板的数据逻辑：三个子面板各自 minHeight:100%
      // + maxWidth:880 居中，所以正文容器给 flex:1 1 auto / minHeight:0 / overflow:auto
      // 就够，不重复它们的 padding 体系。
      // ══════════════════════════════════════════════════════════════════════

      /** 侧栏条目 id 与 main slot 的 key 必须同名（宿主点图标即切到本面板）。 */
      const PANEL_ID = 'mc-toolbox'


      /* ══════════════════════════════════════════════════════════════════
       * ModUI —— 模组市场（Modrinth）。独立页签，自带主题与状态。
       *
       * 宿主契约（lib/mod-routes.js）：
       *   GET  /mc/mod/search?q=&mc=&loader=&offset=&limit=&sort= → { ok, total, hits[] }
       *   GET  /mc/mod/installed?instance=                       → { ok, dir, entries[] }
       *   POST /mc/mod/install  { instance, projectId, modVersionId? } → { ok, files[], downloaded, ... }
       *
       * 「游戏版本 + 加载器」不用用户选：直接从实例信息里推断（实例的 base 与 loader），
       * 这样搜出来的模组一定是能装的。
       * ══════════════════════════════════════════════════════════════════ */
      const ModUI = (function () {
        const { useState, useEffect, useRef } = React
        const API_MOD = '/mc/mod'
        const API_STATE = '/mc/state'

        function useDarkMod() {
          const read = function () {
            try { return Boolean(document.body && document.body.hasAttribute('data-ds-dark-theme')) } catch (_e) { return false }
          }
          const [dark, setDark] = useState(read)
          useEffect(function () {
            if (typeof MutationObserver !== 'function') return undefined
            const mo = new MutationObserver(function () { setDark(read()) })
            try { mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }) } catch (_e) { /* 观察不到就算了 */ }
            return function () { try { mo.disconnect() } catch (_e) { /* 已经断开 */ } }
          }, [])
          return dark
        }

        const P_LIGHT = {
          bg: '#f7f7f8', card: '#ffffff', text: '#18181b', sub: '#52525b',
          line: 'rgba(0,0,0,.12)', inputBg: '#ffffff', track: 'rgba(0,0,0,.06)',
          accent: '#2563eb', accentSoft: 'rgba(37,99,235,.12)',
          danger: '#dc2626', dangerSoft: 'rgba(220,38,38,.10)',
          ok: '#15803d', okSoft: 'rgba(21,128,61,.10)',
          warn: '#b45309', warnSoft: 'rgba(180,83,9,.10)',
        }
        const P_DARK = {
          bg: '#17171b', card: '#212127', text: '#f4f4f5', sub: '#a1a1aa',
          line: 'rgba(255,255,255,.13)', inputBg: '#1b1b21', track: 'rgba(255,255,255,.10)',
          accent: '#3b82f6', accentSoft: 'rgba(59,130,246,.18)',
          danger: '#f87171', dangerSoft: 'rgba(248,113,113,.14)',
          ok: '#4ade80', okSoft: 'rgba(74,222,128,.14)',
          warn: '#fbbf24', warnSoft: 'rgba(251,191,36,.14)',
        }

        function human(n) {
          const v = Number(n) || 0
          if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
          if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
          return String(v)
        }

        async function req(url, method, body) {
          const init = { method: method || 'GET', headers: { 'content-type': 'application/json' } }
          if (body !== undefined) init.body = JSON.stringify(body)
          const res = await fetch(url, init)
          let json = null
          try { json = await res.json() } catch (_e) { json = null }
          if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status))
          if (json && json.ok === false) throw new Error(String(json.error || '宿主返回 ok=false'))
          return json || {}
        }

        function ModPanel() {
          const dark = useDarkMod()
          const P = dark ? P_DARK : P_LIGHT
          const [instances, setInstances] = useState([])
          const [instance, setInstance] = useState('')
          const [query, setQuery] = useState('')
          const [sort, setSort] = useState('relevance')
          const [mode, setMode] = useState('mod')
          const [packTask, setPackTask] = useState(null)
          const [hits, setHits] = useState([])
          const [total, setTotal] = useState(0)
          const [searched, setSearched] = useState(false)
          const [busy, setBusy] = useState('')
          const [notice, setNotice] = useState('')
          const [error, setError] = useState('')
          const [installed, setInstalled] = useState(null)
          const alive = useRef(true)

          const st = {
            bg: { background: P.bg, color: P.text, minHeight: '100%', overflow: 'auto', font: '14px/1.65 system-ui, "Microsoft YaHei", sans-serif' },
            wrap: { maxWidth: 880, margin: '0 auto', padding: '28px 32px 48px' },
            card: { background: P.card, border: '1px solid ' + P.line, borderRadius: 12, padding: '14px 16px' },
            title: { fontSize: 20, fontWeight: 600 },
            sub: { color: P.sub, fontSize: 12.5 },
            input: {
              padding: '8px 10px', borderRadius: 9, border: '1px solid ' + P.line,
              background: P.inputBg, color: P.text, fontSize: 13, width: '100%',
              font: '13px/1.4 system-ui, "Microsoft YaHei", sans-serif',
            },
            select: {
              padding: '8px 10px', borderRadius: 9, border: '1px solid ' + P.line,
              background: P.inputBg, color: P.text, fontSize: 13,
              font: '13px/1.4 system-ui, "Microsoft YaHei", sans-serif',
            },
            btn: { padding: '8px 16px', borderRadius: 10, border: '1px solid transparent', background: P.accent, color: '#fff', fontSize: 13, cursor: 'pointer' },
            btnGhost: { padding: '8px 14px', borderRadius: 10, border: '1px solid ' + P.line, background: 'transparent', color: P.text, fontSize: 13, cursor: 'pointer' },
            row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
            hit: { display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px dashed ' + P.line, alignItems: 'flex-start' },
            hitTitle: { fontWeight: 600, fontSize: 14 },
            desc: { color: P.sub, fontSize: 12.5, marginTop: 2, lineHeight: 1.55 },
            pill: { fontSize: 11.5, padding: '2px 8px', borderRadius: 999, background: P.accentSoft, color: P.accent },
            err: { marginTop: 12, padding: '8px 10px', borderRadius: 9, fontSize: 12.5, background: P.dangerSoft, border: '1px solid ' + P.danger, color: P.danger },
            ok: { marginTop: 12, padding: '8px 10px', borderRadius: 9, fontSize: 12.5, background: P.okSoft, border: '1px solid ' + P.ok, color: P.ok },
          }

          const current = instances.filter(function (v) { return v.id === instance })[0] || null
          const gameVersion = current ? current.base || null : null
          const loader = current && current.loader !== 'vanilla' ? current.loader : ''

          useEffect(function () {
            alive.current = true
            ;(async function () {
              try {
                const data = await req(API_STATE, 'GET')
                if (!alive.current) return
                const list = Array.isArray(data.versions) ? data.versions : []
                setInstances(list)
                setInstance(function (prev) {
                  if (prev && list.some(function (v) { return v.id === prev })) return prev
                  return data.selected || (list[0] ? list[0].id : '')
                })
              } catch (e) {
                if (alive.current) setError(String((e && e.message) || e))
              }
            })()
            return function () { alive.current = false }
          }, [])

          useEffect(function () {
            if (!instance) { setInstalled(null); return }
            ;(async function () {
              try {
                const data = await req(API_MOD + '/installed?instance=' + encodeURIComponent(instance), 'GET')
                if (alive.current) setInstalled(data)
              } catch (_e) { if (alive.current) setInstalled(null) }
            })()
          }, [instance])

          async function doSearch() {
            if (!gameVersion) { setError('先选一个实例（要能读出它的游戏版本）'); return }
            setBusy('search')
            setError('')
            setNotice('')
            try {
              const q = new URLSearchParams({ q: query, mc: gameVersion })
              if (loader) q.set('loader', loader)
              if (sort) q.set('sort', sort)
              q.set('limit', '20')
              // 整合包走 /mc/pack/list（同一套返回形状：projectId/title/description/downloads）
              const base = mode === 'pack' ? '/mc/pack/list' : (API_MOD + '/search')
              const data = await req(base + '?' + q.toString(), 'GET')
              if (!alive.current) return
              setHits(data.hits || [])
              setTotal(data.total || 0)
              setSearched(true)
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            } finally {
              if (alive.current) setBusy('')
            }
          }

          async function doInstall(hit) {
            setBusy(hit.projectId)
            setError('')
            setNotice('')
            try {
              if (mode === 'pack') {
                await req('/mc/pack/install', 'POST', { source: 'modrinth', projectId: hit.projectId, mcVersion: gameVersion })
                // 轮询安装进度（整合包要装加载器 + 下几十个文件，可能要一两分钟）
                let last = null
                for (let i = 0; i < 300; i += 1) {
                  await new Promise(function (r) { setTimeout(r, 1500) })
                  if (!alive.current) return
                  const snap = await req('/mc/pack/state', 'GET')
                  last = snap && snap.task ? snap.task : null
                  if (!last) break
                  setPackTask(last)
                  if (!(last.phase === 'downloading' || last.phase === 'loader' || last.phase === 'files' || last.phase === 'overrides' || last.phase === 'planning')) break
                }
                setPackTask(null)
                if (last && last.phase === 'done' && last.summary) {
                  const sm = last.summary
                  setNotice('整合包已装为实例 ' + sm.instanceId + '：' + (sm.downloaded || 0) + ' 个文件 / ' +
                    ((sm.bytes || 0) / 1048576).toFixed(1) + ' MB，overrides ' + (sm.overridesExtracted || 0) + ' 个文件' +
                    (sm.libraryMissing ? '（库还缺 ' + sm.libraryMissing + ' 个）' : '') + ' —— 去「启动」页签就能启动')
                } else if (last && last.error) {
                  setError(String(last.error))
                } else {
                  setNotice('整合包安装已提交，可以在「版本」页签看结果')
                }
                return
              }
              const data = await req(API_MOD + '/install', 'POST', { instance: instance, projectId: hit.projectId })
              if (!alive.current) return
              const names = (data.files || []).map(function (f) { return f.filename })
              setNotice('已装到 ' + (data.dir || '') + '：' + (names.join('、') || '（无文件）') +
                (data.skipped ? '（跳过 ' + data.skipped + ' 个已存在）' : '') +
                ((data.unresolved && data.unresolved.length) ? '；有 ' + data.unresolved.length + ' 个依赖没解析到' : ''))
              if (data.failed) setError('有 ' + data.failed + ' 个文件下载失败')
              const fresh = await req(API_MOD + '/installed?instance=' + encodeURIComponent(instance), 'GET')
              if (alive.current) setInstalled(fresh)
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            } finally {
              if (alive.current) setBusy('')
            }
          }

          const header = h('div', { key: 'head' }, [
            h('div', { key: 't', style: st.title }, mode === 'pack' ? '整合包市场' : '模组市场'),
            h('div', { key: 's', style: st.sub }, mode === 'pack'
              ? '数据来自 Modrinth · 整合包会按当前实例的游戏版本挑一个 .mrpack 版本，自动装加载器 + 模组 + overrides'
              : '数据来自 Modrinth · 搜索会自动按当前实例的 游戏版本' + (loader ? ' 与加载器 ' + loader : '') + ' 过滤'),
          ])

          const picker = h('div', { key: 'picker', style: Object.assign({ marginTop: 16 }, st.row) }, [
            h('select', {
              key: 'inst', value: instance, style: Object.assign({ minWidth: 220 }, st.select),
              onChange: function (e) { setInstance(e.target.value); setHits([]); setSearched(false); setNotice('') },
            }, instances.length
              ? instances.map(function (v) { return h('option', { key: v.id, value: v.id }, v.id + '（' + (v.loader || 'vanilla') + ' / ' + (v.base || '?') + '）') })
              : [h('option', { key: 'none', value: '' }, '（没有实例）')]),
            h('input', {
              key: 'q', value: query, style: Object.assign({ flex: '1 1 220px' }, st.input),
              placeholder: '搜索模组，例如 jei / sodium / create',
              onChange: function (e) { setQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && busy !== 'search') doSearch() },
            }),
            h('button', {
              key: 'mode',
              onClick: function () { setMode(mode === 'pack' ? 'mod' : 'pack'); setHits([]); setSearched(false); setNotice('') },
              style: Object.assign({}, st.btnGhost, mode === 'pack' ? { background: P.accentSoft, color: P.accent, borderColor: P.accent } : null),
              title: '在「模组」和「整合包」之间切换',
            }, mode === 'pack' ? '整合包' : '模组'),
            h('select', {
              key: 'sort', value: sort, style: st.select,
              onChange: function (e) { setSort(e.target.value) },
            }, [
              h('option', { key: 'relevance', value: 'relevance' }, '相关度'),
              h('option', { key: 'downloads', value: 'downloads' }, '下载量'),
              h('option', { key: 'newest', value: 'newest' }, '最新'),
            ]),
            h('button', {
              key: 'go', onClick: busy === 'search' ? undefined : doSearch, disabled: busy === 'search',
              style: Object.assign({}, st.btn, busy === 'search' ? { opacity: 0.6 } : null),
            }, busy === 'search' ? '搜索中…' : '搜索'),
          ])

          const list = []
          if (busy === 'search') list.push(h('div', { key: 'load', style: Object.assign({ marginTop: 14 }, st.sub) }, '正在查询 Modrinth…'))
          else if (searched && !hits.length) list.push(h('div', { key: 'empty', style: Object.assign({ marginTop: 14 }, st.sub) }, '没有匹配的模组（换个关键词，或确认这个实例的版本/加载器有支持）'))
          else if (hits.length) {
            list.push(h('div', { key: 'total', style: Object.assign({ marginTop: 14 }, st.sub) }, '共 ' + total + ' 个结果，显示前 ' + hits.length + ' 个'))
            hits.forEach(function (hit) {
              list.push(h('div', { key: hit.projectId, style: st.hit }, [
                h('div', { key: 'body', style: { flex: '1 1 auto', minWidth: 0 } }, [
                  h('div', { key: 't', style: st.hitTitle }, hit.title + ' '),
                  h('span', { key: 'slug', style: { color: P.sub, fontSize: 12 } }, hit.slug),
                  h('div', { key: 'd', style: st.desc }, String(hit.description || '').slice(0, 220)),
                  h('div', { key: 'm', style: Object.assign({ marginTop: 4 }, st.sub) }, '下载 ' + human(hit.downloads) + ' · 关注 ' + human(hit.follows) + (hit.categories && hit.categories.length ? ' · ' + hit.categories.slice(0, 4).join(' / ') : '')),
                ]),
                h('button', {
                  key: 'install',
                  onClick: busy === hit.projectId ? undefined : function () { doInstall(hit) },
                  disabled: busy === hit.projectId || !current,
                  style: Object.assign({}, st.btnGhost, (busy === hit.projectId || !current) ? { opacity: 0.6 } : null),
                }, busy === hit.projectId ? '安装中…' : '安装'),
              ]))
            })
          }

          const installedLine = installed && installed.entries
            ? h('div', { key: 'inst', style: Object.assign({ marginTop: 12 }, st.sub) },
                '这个实例的 mods/ 现有 ' + installed.entries.length + ' 个文件' +
                (installed.dir ? '（' + installed.dir + '）' : '') +
                (installed.entries.length ? '：' + installed.entries.slice(0, 4).map(function (e) { return e.name }).join('、') + (installed.entries.length > 4 ? ' 等' : '') : '，还是空的'))
            : null

          return h('div', { style: st.bg }, h('div', { style: st.wrap }, [
            header,
            picker,
            error ? h('div', { key: 'err', style: st.err }, error) : null,
            notice ? h('div', { key: 'ok', style: st.ok }, notice) : null,
            packTask ? h('div', { key: 'pk', style: Object.assign({ marginTop: 12 }, st.sub) },
              '整合包安装中：' + String(packTask.phase || '') +
              (packTask.filesTotal ? ' · ' + (packTask.filesDone || 0) + '/' + packTask.filesTotal + ' 个文件' : '') +
              (packTask.bytesTotal ? ' · ' + human(packTask.bytesDone) + '/' + human(packTask.bytesTotal) : '')) : null,
            h('div', { key: 'list', style: Object.assign({ marginTop: 16 }, st.card) }, list.length ? list : h('div', { style: st.sub }, '输入关键词搜一下（例：jei、sodium、create、appleskin）')),
            installedLine,
          ]))
        }

        return { PanelMain: ModPanel }
      })()


      /* ══════════════════════════════════════════════════════════════════
       * SettingsUI —— 「设置」页签：配置表单 + 下载源测速。
       *   GET  /mc/settings        → { ok, values, fields[], secrets, files }
       *   POST /mc/settings        → 校验后保存（越界夹住、非法枚举忽略）
       *   POST /mc/net/speedtest   → { ok, rows[], recommendation, note }
       * 服务端已经做了校验，这里只负责把「字段元数据」渲染成控件。
       * ══════════════════════════════════════════════════════════════════ */
      const SettingsUI = (function () {
        const { useState, useEffect, useRef } = React

        function useDarkSet() {
          const read = function () {
            try { return Boolean(document.body && document.body.hasAttribute('data-ds-dark-theme')) } catch (_e) { return false }
          }
          const [dark, setDark] = useState(read)
          useEffect(function () {
            if (typeof MutationObserver !== 'function') return undefined
            const mo = new MutationObserver(function () { setDark(read()) })
            try { mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }) } catch (_e) { /* 忽略 */ }
            return function () { try { mo.disconnect() } catch (_e) { /* 忽略 */ } }
          }, [])
          return dark
        }

        const L = {
          bg: '#f7f7f8', card: '#ffffff', text: '#18181b', sub: '#52525b', line: 'rgba(0,0,0,.12)',
          inputBg: '#ffffff', track: 'rgba(0,0,0,.06)', accent: '#2563eb', accentSoft: 'rgba(37,99,235,.12)',
          danger: '#dc2626', dangerSoft: 'rgba(220,38,38,.10)', ok: '#15803d', okSoft: 'rgba(21,128,61,.10)',
          warn: '#b45309', warnSoft: 'rgba(180,83,9,.10)',
        }
        const D = {
          bg: '#17171b', card: '#212127', text: '#f4f4f5', sub: '#a1a1aa', line: 'rgba(255,255,255,.13)',
          inputBg: '#1b1b21', track: 'rgba(255,255,255,.10)', accent: '#3b82f6', accentSoft: 'rgba(59,130,246,.18)',
          danger: '#f87171', dangerSoft: 'rgba(248,113,113,.14)', ok: '#4ade80', okSoft: 'rgba(74,222,128,.14)',
          warn: '#fbbf24', warnSoft: 'rgba(251,191,36,.14)',
        }

        async function req(url, method, body) {
          const init = { method: method || 'GET', headers: { 'content-type': 'application/json' } }
          if (body !== undefined) init.body = JSON.stringify(body)
          const res = await fetch(url, init)
          let json = null
          try { json = await res.json() } catch (_e) { json = null }
          if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status))
          if (json && json.ok === false) throw new Error(String(json.error || '宿主返回 ok=false'))
          return json || {}
        }

        function SettingsPanel() {
          const dark = useDarkSet()
          const P = dark ? D : L
          const [snap, setSnap] = useState(null)
          const [draft, setDraft] = useState({})
          const [busy, setBusy] = useState('')
          const [notice, setNotice] = useState('')
          const [error, setError] = useState('')
          const [net, setNet] = useState(null)
          const alive = useRef(true)

          const st = {
            bg: { background: P.bg, color: P.text, minHeight: '100%', overflow: 'auto', font: '14px/1.65 system-ui, "Microsoft YaHei", sans-serif' },
            wrap: { maxWidth: 880, margin: '0 auto', padding: '28px 32px 48px' },
            card: { background: P.card, border: '1px solid ' + P.line, borderRadius: 12, padding: '14px 16px' },
            title: { fontSize: 20, fontWeight: 600 },
            sub: { color: P.sub, fontSize: 12.5 },
            row: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px dashed ' + P.line, flexWrap: 'wrap' },
            label: { width: 180, flex: '0 0 180px', fontSize: 13, color: P.text },
            hint: { color: P.sub, fontSize: 11.5, marginTop: 2 },
            input: {
              flex: '1 1 260px', padding: '7px 10px', borderRadius: 9, border: '1px solid ' + P.line,
              background: P.inputBg, color: P.text, fontSize: 13, font: '13px/1.4 system-ui, "Microsoft YaHei", sans-serif',
            },
            btn: { padding: '8px 16px', borderRadius: 10, border: '1px solid transparent', background: P.accent, color: '#fff', fontSize: 13, cursor: 'pointer' },
            ghost: { padding: '8px 14px', borderRadius: 10, border: '1px solid ' + P.line, background: 'transparent', color: P.text, fontSize: 13, cursor: 'pointer' },
            err: { marginTop: 12, padding: '8px 10px', borderRadius: 9, fontSize: 12.5, background: P.dangerSoft, border: '1px solid ' + P.danger, color: P.danger },
            ok: { marginTop: 12, padding: '8px 10px', borderRadius: 9, fontSize: 12.5, background: P.okSoft, border: '1px solid ' + P.ok, color: P.ok },
            mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, color: P.sub, wordBreak: 'break-all' },
          }

          async function load() {
            try {
              const data = await req('/mc/settings', 'GET')
              if (!alive.current) return
              setSnap(data)
              setDraft(Object.assign({}, data.values || {}))
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            }
          }

          useEffect(function () {
            alive.current = true
            load()
            return function () { alive.current = false }
          }, [])

          function setVal(key, value) {
            setDraft(function (prev) { const next = Object.assign({}, prev); next[key] = value; return next })
          }

          async function save() {
            setBusy('save'); setError(''); setNotice('')
            try {
              const data = await req('/mc/settings', 'POST', draft)
              if (!alive.current) return
              setSnap({ fields: (snap && snap.fields) || [], values: (data.settings && data.settings.values) || {}, files: (data.settings && data.settings.files) || (snap && snap.files) })
              setDraft(Object.assign({}, (data.settings && data.settings.values) || {}))
              setNotice('已保存' + (data.changed && data.changed.length ? '（改动：' + data.changed.join('、') + '）' : '（没有变化）'))
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            } finally {
              if (alive.current) setBusy('')
            }
          }

          async function doSpeedtest() {
            setBusy('net'); setError(''); setNotice('')
            try {
              const data = await req('/mc/net/speedtest', 'POST', {})
              if (alive.current) setNet(data)
            } catch (e) {
              if (alive.current) setError(String((e && e.message) || e))
            } finally {
              if (alive.current) setBusy('')
            }
          }

          function adopt() {
            if (!net || !net.recommendation) return
            setVal('downloadSourcePreference', net.recommendation)
            setNotice('已把「下载源偏好」改成 ' + net.recommendation + '，点保存生效')
          }

          const fields = (snap && snap.fields) || []
          const rows = fields.map(function (f) {
            const val = draft[f.key]
            let control = null
            if (f.type === 'enum') {
              control = h('select', {
                style: st.input, value: String(val || ''), onChange: function (e) { setVal(f.key, e.target.value) },
              }, f.options.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }))
            } else if (f.type === 'number') {
              control = h('input', {
                type: 'number', min: f.min, max: f.max, step: f.step || 1, style: st.input,
                value: val === undefined || val === null ? '' : String(val),
                onChange: function (e) { setVal(f.key, e.target.value === '' ? '' : Number(e.target.value)) },
              })
            } else if (f.type === 'string[]') {
              control = h('textarea', {
                rows: 2, style: Object.assign({}, st.input, { fontFamily: 'ui-monospace, Consolas, monospace' }),
                value: Array.isArray(val) ? val.join('\n') : String(val || ''),
                onChange: function (e) { setVal(f.key, e.target.value.split(/\r?\n/).map(function (x) { return x.trim() }).filter(Boolean)) },
              })
            } else {
              control = h('input', {
                style: st.input, value: val === undefined || val === null ? '' : String(val),
                placeholder: f.type === 'path' ? '留空 = 默认' : '',
                onChange: function (e) { setVal(f.key, e.target.value) },
              })
            }
            return h('div', { key: f.key, style: st.row }, [
              h('div', { key: 'l', style: st.label }, [
                h('div', { key: 'n' }, f.label),
                f.hint ? h('div', { key: 'h', style: st.hint }, f.hint) : null,
              ]),
              h('div', { key: 'c', style: { flex: '1 1 260px', display: 'flex' } }, control),
            ])
          })

          const netCard = net
            ? h('div', { key: 'net', style: Object.assign({ marginTop: 16 }, st.card) }, [
                h('div', { key: 't', style: { fontWeight: 600 } }, '下载源测速'),
                h('div', { key: 'v', style: Object.assign({ marginTop: 4 }, st.sub) }, '用版本 ' + (net.version || '?') + ' 实测；推荐：' + net.recommendation),
                h('div', { key: 'rows', style: { marginTop: 10 } },
                  (net.rows || []).map(function (r) {
                    const okMark = function (x) { return x && x.ok ? (x.ms + ' ms') : '✘' }
                    return h('div', { key: r.key, style: { display: 'flex', gap: 12, flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px dashed ' + P.line, fontSize: 12.5 } }, [
                      h('span', { key: 'l', style: { width: 130, fontWeight: r.key === net.best ? 600 : 400 } }, r.label),
                      h('span', { key: 'm', style: { color: P.sub } }, 'manifest ' + okMark(r.manifest)),
                      h('span', { key: 'c', style: { color: P.sub } }, 'client ' + okMark(r.client)),
                      h('span', { key: 'v', style: { color: P.sub } }, 'maven ' + okMark(r.maven)),
                      h('span', { key: 't', style: { color: P.sub } }, '吞吐 ' + (Math.round((r.throughputBps || 0) / 104857.6) / 10) + ' MB/s'),
                    ])
                  })),
                h('div', { key: 'n', style: Object.assign({ marginTop: 8 }, st.sub) }, net.note || ''),
                h('button', { key: 'adopt', style: Object.assign({ marginTop: 10 }, st.ghost), onClick: adopt }, '采用建议（' + net.recommendation + '）'),
              ])
            : null

          return h('div', { style: st.bg }, h('div', { style: st.wrap }, [
            h('div', { key: 'h' }, [
              h('div', { key: 't', style: st.title }, '设置'),
              h('div', { key: 's', style: st.sub }, '保存后立即生效；部分项（如 .minecraft 目录）会触发版本重扫。'),
            ]),
            error ? h('div', { key: 'e', style: st.err }, error) : null,
            notice ? h('div', { key: 'n', style: st.ok }, notice) : null,
            h('div', { key: 'form', style: Object.assign({ marginTop: 16 }, st.card) }, rows.length ? rows : h('div', { style: st.sub }, '加载中…')),
            h('div', { key: 'actions', style: { display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' } }, [
              h('button', { key: 'save', style: Object.assign({}, st.btn, busy ? { opacity: 0.6 } : null), disabled: Boolean(busy), onClick: save }, busy === 'save' ? '保存中…' : '保存'),
              h('button', { key: 'net', style: Object.assign({}, st.ghost, busy ? { opacity: 0.6 } : null), disabled: Boolean(busy), onClick: doSpeedtest }, busy === 'net' ? '测速中…' : '下载源测速'),
              h('button', { key: 'reload', style: st.ghost, disabled: Boolean(busy), onClick: load }, '重新读取'),
            ]),
            netCard,
            snap && snap.files ? h('div', { key: 'f', style: Object.assign({ marginTop: 14 }, st.mono) }, '配置文件：' + (snap.files.config || '')) : null,
          ]))
        }

        return { PanelMain: SettingsPanel }
      })()


      /* ══════════════════════════════════════════════════════════════════
       * AboutUI —— 「关于」页。
       *
       * 顺序是**有要求的**：《PCL 存储库合理使用指南》二·重度使用 第 3 条要求
       * 「在关于页面的首位给出龙腾猫跃的署名及对应的赞助链接」，所以署名与赞助链接放最上面，
       * 之后才是第三方声明、许可证、致谢。
       * ══════════════════════════════════════════════════════════════════ */
      const AboutUI = (function () {
        const { useState, useEffect } = React
        const AUTHOR = '龙腾猫跃（LTCat）'
        const PCL_SITE = 'https://meloong.com/pcl'
        const DONATE = 'https://meloong.com/afd/a/LTCat'
        const BMCLAPI = 'https://bmclapi.bangbang93.com/'

        function useDarkAbout() {
          const read = function () {
            try { return Boolean(document.body && document.body.hasAttribute('data-ds-dark-theme')) } catch (_e) { return false }
          }
          const [dark, setDark] = useState(read)
          useEffect(function () {
            if (typeof MutationObserver !== 'function') return undefined
            const mo = new MutationObserver(function () { setDark(read()) })
            try { mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }) } catch (_e) { /* 忽略 */ }
            return function () { try { mo.disconnect() } catch (_e) { /* 忽略 */ } }
          }, [])
          return dark
        }

        const L = { bg: '#f7f7f8', card: '#ffffff', text: '#18181b', sub: '#52525b', line: 'rgba(0,0,0,.12)', accent: '#2563eb', accentSoft: 'rgba(37,99,235,.12)' }
        const D = { bg: '#17171b', card: '#212127', text: '#f4f4f5', sub: '#a1a1aa', line: 'rgba(255,255,255,.13)', accent: '#3b82f6', accentSoft: 'rgba(59,130,246,.18)' }

        function open_(url) {
          try { window.open(url, '_blank', 'noopener') } catch (_e) { /* 弹窗被拦 */ }
        }

        function AboutPanel() {
          const P = useDarkAbout() ? D : L
          const st = {
            bg: { background: P.bg, color: P.text, minHeight: '100%', overflow: 'auto', font: '14px/1.7 system-ui, "Microsoft YaHei", sans-serif' },
            wrap: { maxWidth: 860, margin: '0 auto', padding: '28px 32px 48px' },
            card: { background: P.card, border: '1px solid ' + P.line, borderRadius: 12, padding: '16px 18px', marginTop: 14 },
            h: { fontSize: 20, fontWeight: 600 },
            sub: { color: P.sub, fontSize: 12.5 },
            p: { fontSize: 13, marginTop: 8, lineHeight: 1.8 },
            first: { fontSize: 15, fontWeight: 600 },
            link: { color: P.accent, cursor: 'pointer', textDecoration: 'underline' },
            btn: { padding: '7px 14px', borderRadius: 10, border: '1px solid ' + P.line, background: 'transparent', color: P.text, fontSize: 13, cursor: 'pointer' },
            mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, color: P.sub },
          }
          return h('div', { style: st.bg }, h('div', { style: st.wrap }, [
            h('div', { key: 'h', style: st.h }, '关于'),
            h('div', { key: 's', style: st.sub }, 'PCL 工具箱（第三方修改版）· DSH 插件'),

            // ① 首位：署名 + 赞助链接（指南要求）
            h('div', { key: 'author', style: st.card }, [
              h('div', { key: 'a', style: st.first }, '作者署名：' + AUTHOR),
              h('div', { key: 'b', style: st.p },
                '本工具的功能设计与行为，参考/移植自 ' + AUTHOR + ' 开发的 Plain Craft Launcher（PCL）。'
                + 'PCL 免费、无广告地维护多年 —— 如果你觉得它有价值，请考虑赞助作者。'),
              h('div', { key: 'c', style: { display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' } }, [
                h('button', { key: 'd', style: st.btn, onClick: function () { open_(DONATE) } }, '赞助 PCL（爱发电）'),
                h('button', { key: 'p', style: st.btn, onClick: function () { open_(PCL_SITE) } }, 'PCL 官网 / 下载'),
              ]),
              h('div', { key: 'u', style: Object.assign({ marginTop: 8 }, st.mono) }, DONATE),
            ]),

            // ② 第三方二创声明（指南要求第 1 条）
            h('div', { key: 'tp', style: st.card }, [
              h('div', { key: 't', style: { fontWeight: 600 } }, '第三方声明'),
              h('div', { key: 'b', style: st.p },
                '本工具是**第三方基于 PCL 独立进行的二次创作**，与 PCL 官方无任何隶属或授权关系，也不代表 PCL 官方。'
                + '名称按《PCL 存储库合理使用指南》命名，以「PCL」开头并附「（第三方修改版）」后缀，避免与官方混淆。'),
              h('div', { key: 'c', style: st.p },
                '本工具**不包含 PCL 的任何源代码、二进制或美术资源**：实现语言与结构完全不同（PCL 为 VB.NET，本工具为 TypeScript/JavaScript），'
                + '仅参考其功能行为与公开协议（Mojang 版本 JSON、BMCLAPI 镜像路径等）。'),
            ]),

            // ③ 许可证
            h('div', { key: 'lic', style: st.card }, [
              h('div', { key: 't', style: { fontWeight: 600 } }, '许可证'),
              h('div', { key: 'a', style: st.p },
                '本工具源码以 MIT 协议发布（仓库公开）；同时**继续附带 PCL 的《LICENCE》**'
                + '（《PCL 分发有限许可》+《PCL 存储库合理使用指南》）作为本工具的使用约束说明，见仓库根目录 PCL-LICENCE.md。'),
              h('div', { key: 'b', style: st.p },
                '若你不认可上述约束，请停止使用本工具；PCL 本身的许可与条款以作者发布为准。'),
            ]),

            // ④ 致谢
            h('div', { key: 'thanks', style: st.card }, [
              h('div', { key: 't', style: { fontWeight: 600 } }, '致谢'),
              h('div', { key: 'b', style: st.p }, [
                h('span', { key: '1' }, '· BMCLAPI（bangbang93）提供公益镜像'),
                h('br', { key: 'br1' }),
                h('span', { key: '2' }, '· Modrinth 提供模组/整合包 API'),
                h('br', { key: 'br2' }),
                h('span', { key: '3' }, '· Mojang / Microsoft 提供版本与账号服务'),
                h('br', { key: 'br3' }),
                h('span', { key: '4' }, '· ' + AUTHOR + ' 的 PCL 是这一切功能设计的来源'),
              ]),
            ]),

            h('div', { key: 'ver', style: Object.assign({ marginTop: 14 }, st.mono) },
              '版本 0.4.0 · 插件 @dsh-external/pcl-toolbox · 运行于 DeepSeek Harness'),
          ]))
        }

        return { PanelMain: AboutPanel }
      })()

      const MC_TABS = [
        { key: 'launch', label: '启动' },
        { key: 'instance', label: '版本' },
        { key: 'mods', label: '资源' },
        { key: 'download', label: '下载' },
        { key: 'settings', label: '设置' },
        { key: 'about', label: '关于' },
      ]

      // 外壳自带一份主题读取，不依赖任一子面板内部的同名函数。
      function readShellDark() {
        try {
          return Boolean(typeof document !== 'undefined' && document.body &&
            document.body.hasAttribute('data-ds-dark-theme'))
        } catch (_e) { return false }
      }

      function useShellDark() {
        const [dark, setDark] = React.useState(readShellDark)
        React.useEffect(() => {
          if (typeof MutationObserver === 'undefined') return undefined
          let body = null
          try { body = document.body } catch (_e) { body = null }
          if (!body) return undefined
          const mo = new MutationObserver(() => setDark(readShellDark()))
          mo.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
          return () => mo.disconnect()
        }, [])
        return dark
      }

      function shellPalette(dark) {
        return dark
          ? {
              dark: true, bg: '#17171b', card: '#212127', text: '#f4f4f5', sub: '#a1a1aa',
              line: 'rgba(255,255,255,.13)', chip: 'rgba(255,255,255,.06)',
            }
          : {
              dark: false, bg: '#f7f7f8', card: '#ffffff', text: '#18181b', sub: '#52525b',
              line: 'rgba(0,0,0,.12)', chip: 'rgba(0,0,0,.05)',
            }
      }

      /**
       * 单侧栏图标：方块 + 播放三角（启动为主），右下角一个小下载箭头。
       * 纯 SVG / currentColor 描边，只读 props.size 与 props.active，
       * 不依赖两个子面板的内部 state（否则切页签时图标会跟着抖动）。
       */
      function PanelIcon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 18
        const active = Boolean(props && props.active)
        const stroke = active ? 1.9 : 1.6
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block' },
          'aria-hidden': 'true',
        },
          // 方块（MC 的方块感）
          h('rect', { key: 'block', x: 2.6, y: 2.6, width: 13.4, height: 13.4, rx: 2.8 }),
          // 播放三角（启动）
          h('path', {
            key: 'play',
            d: 'M7.9 6.4l5.2 3-5.2 3z',
            fill: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          }),
          // 下载箭头（右下角）
          h('path', { key: 'dl-shaft', d: 'M18.4 13.1v3.9' }),
          h('path', { key: 'dl-head', d: 'M16.4 15.2l2 2 2-2' }),
          h('path', { key: 'dl-base', d: 'M15.9 19.4h5' }))
      }

      function TabButton(props) {
        const t = props.t
        const on = Boolean(props.on)
        return h('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          onClick: props.onClick,
          style: {
            appearance: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '5px 16px',
            borderRadius: 6,
            font: 'inherit',
            fontSize: 13,
            fontWeight: on ? 600 : 500,
            color: on ? t.text : t.sub,
            background: on ? t.card : 'transparent',
            boxShadow: on ? '0 1px 2px rgba(0,0,0,.18)' : 'none',
          },
        }, props.label)
      }

      function PanelMain() {
        const dark = useShellDark()
        const t = shellPalette(dark)
        const [tab, setTab] = React.useState(MC_TABS[0].key)
        const firstRender = React.useRef(true)

        // 从「下载」切回「启动」时刷一次版本清单：用户很可能刚下完版本，
        // 启动面板的列表需要重读。失败静默（面板自己的 store 还会再兜一次）。
        React.useEffect(() => {
          if (firstRender.current) { firstRender.current = false; return undefined }
          if (tab !== 'launch') return undefined
          try {
            if (typeof fetch !== 'function') return undefined
            const pending = fetch('/mc/versions?refresh=1')
            if (pending && typeof pending.catch === 'function') pending.catch(() => {})
          } catch (_e) { /* 刷新只是锦上添花，失败不影响切换 */ }
          return undefined
        }, [tab])

        // 整宽粘性 tab 条（不横跨子面板的 880 卡片）。
        const tabBar = h('div', {
          style: {
            position: 'sticky',
            top: 0,
            zIndex: 3,
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px',
            background: t.bg,
            borderBottom: '1px solid ' + t.line,
            font: '13px/1.5 system-ui, "Microsoft YaHei", sans-serif',
          },
        },
          h('div', {
            role: 'tablist',
            'aria-label': 'PCL 工具箱',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: 2,
              borderRadius: 8,
              background: t.chip,
              border: '1px solid ' + t.line,
            },
          },
            MC_TABS.map((item) => h(TabButton, {
              key: item.key,
              t: t,
              label: item.label,
              on: tab === item.key,
              onClick: () => setTab(item.key),
            }))),
          h('span', {
            style: { marginLeft: 'auto', color: t.sub, fontSize: 11.5, letterSpacing: 0.3 },
          }, 'PCL 工具箱'))

        const bodyNode = tab === 'download'
          ? h(DownloadUI.PanelMain, null)
          : tab === 'instance'
            ? h(InstanceUI.PanelMain, null)
            : tab === 'mods'
              ? h(ModUI.PanelMain, null)
              : tab === 'settings'
                ? h(SettingsUI.PanelMain, null)
                : tab === 'about'
                  ? h(AboutUI.PanelMain, null)
                  : h(LaunchUI.PanelMain, null)

        return h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            background: t.bg,
            color: t.text,
          },
        },
          tabBar,
          h('div', {
            style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
          }, bodyNode))
      }

      // ══════════════════════════════════════════════════════════════════════
      // 注册：一个侧栏入口 + 一个 main 面板
      // ══════════════════════════════════════════════════════════════════════
      const inject = ['slots']

      /**
       * 注册侧栏入口与主面板。
       *
       * 为什么要退避重试：宿主给的 ctx 在极端时序下可能还拿不到 slots 服务（或者
       * `sidebar.panellist` 这个 slot 还没被 ui-sidebar 声明），此时**不能**静默放弃——
       * 外层幂等护栏（window.__dshMcToolboxRegistered）只能在本次页面生命周期里执行一次，
       * 一旦这次放弃，之后再启用插件也不会重新注册，表现为「侧栏入口凭空消失」。
       * 所以：拿不到就短退避重试，最多约 3 秒；每次 effect 单独记状态，避免重复注册。
       */
      function apply(ctx) {
        var tries = 0
        var sideDone = false
        var mainDone = false
        var MAX_TRIES = 20

        function go() {
          var slots
          try {
            slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
          } catch (_e) {
            slots = undefined
          }
          if (!slots) {
            tries += 1
            if (tries <= MAX_TRIES) { setTimeout(go, 150); return }
            try { console.error('[mc-toolbox] 拿不到 slots 服务，放弃注册侧栏入口') } catch (_e) {}
            return
          }
          try {
            if (!sideDone) {
              ctx.effect(function () {
                return slots.inject('sidebar.panellist', function () {
                  return slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: 'PCL 工具箱' }, PanelIcon)
                })
              }, 'mc-toolbox: sidebar entry')
              sideDone = true
            }
            if (!mainDone) {
              ctx.effect(function () {
                return slots.inject('main', function () {
                  return slots.register({ name: 'main', key: PANEL_ID }, PanelMain)
                })
              }, 'mc-toolbox: main panel')
              mainDone = true
            }
          } catch (err) {
            tries += 1
            if (tries <= MAX_TRIES) { setTimeout(go, 200); return }
            // 软着陆：最坏退化成「没有侧栏入口」，绝不让整个 web boot 失败
            try { console.error('[mc-toolbox] client apply failed (降级为无入口):', err) } catch (_e) {}
          }
        }
        go()
      }

      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
})()
