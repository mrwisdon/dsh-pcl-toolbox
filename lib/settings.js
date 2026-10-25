/**
 * settings.js —— 设置的读写 + 校验（给「设置」页签用）。
 *
 * 配置本身还是那一个 `mc-launch.config.json`；这里只做三件事：
 *   1. 给 UI 一份「字段描述 + 当前值」（含每项的范围/选项/说明）
 *   2. 把 UI 提交的对象**逐项校验**后再落盘（不能让它把 memoryMb 写成 -1）
 *   3. 明确哪些字段改了要做什么后续动作（比如换 minecraftDir 要清版本缓存）
 */

import { loadConfig, saveConfig } from './launch.js'

/** 字段元数据：ui 照这个渲染，save 照这个校验。 */
export const FIELDS = [
  {
    key: 'minecraftDir',
    label: '.minecraft 目录',
    type: 'path',
    hint: '版本、库、资源、runtime 都在这下面；改完要重新扫版本。',
  },
  { key: 'gameDirMode', label: '实例隔离', type: 'enum', options: [['isolated', '按版本隔离（PCL 默认）'], ['shared', '所有实例共用 .minecraft 根']] },
  { key: 'memoryMb', label: '默认内存 (MB)', type: 'number', min: 256, max: 32768, step: 256, hint: '启动页签里还能临时改。' },
  { key: 'username', label: '默认离线玩家名', type: 'string', hint: '留空则每次启动时用面板里填的。' },
  { key: 'java', label: '强制 Java 路径', type: 'path', hint: '留空 = 按版本要求自动挑（推荐）。填 ...\\bin\\javaw.exe 可强制。' },
  { key: 'extraJvmArgs', label: '附加 JVM 参数', type: 'string[]', hint: '每行一个，例如 -XX:+UseG1GC。' },
  { key: 'downloadSourcePreference', label: '下载源偏好', type: 'enum', options: [['mirror-first', '镜像优先（BMCLAPI）'], ['official-first', '官方优先（更快）'], ['mirror-only', '仅镜像（不碰官方域名）']] },
  { key: 'downloadConcurrency', label: '下载并发', type: 'number', min: 1, max: 32, step: 1 },
  { key: 'downloadMirror', label: '镜像地址', type: 'string', hint: '留空 = https://bmclapi2.bangbang93.com' },
  { key: 'downloadDir', label: '下载目录', type: 'path', hint: '留空 = 跟 .minecraft 走（下完即可启动）。' },
  { key: 'msFlow', label: '正版登录流程', type: 'enum', options: [['auth-code', '授权码（零配置）'], ['device-code', '设备码（需自备 client id）']] },
  { key: 'msClientId', label: 'Entra client id', type: 'string', hint: '只有设备码流程需要；授权码流程留空即可。' },
]

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 当前配置 + 字段描述（不暴露 accessToken 值，只给"是否已设置"）。 */
export function readSettings(pluginRoot) {
  const cfg = loadConfig(pluginRoot)
  const values = {}
  for (const f of FIELDS) values[f.key] = cfg[f.key] ?? (f.type === 'number' ? 0 : f.type === 'string[]' ? [] : '')
  return {
    values,
    fields: FIELDS,
    secrets: {
      accessTokenSet: Boolean(cfg.accessToken),
      msLoggedIn: null, // 由 /mc/ms/state 单独查，避免这里耦合账号模块
    },
    files: {
      config: pluginRoot + (process.platform === 'win32' ? '\\mc-launch.config.json' : '/mc-launch.config.json'),
    },
  }
}

/**
 * 校验并保存。只接受 FIELDS 里声明的键；返回 {saved, changed, needs}.
 * @returns {{saved:object, changed:string[], needs:{rescan:boolean}}}
 */
export function writeSettings(pluginRoot, patch) {
  const before = loadConfig(pluginRoot)
  const next = {}
  const changed = []
  for (const f of FIELDS) {
    if (!patch || !(f.key in patch)) continue
    const raw = patch[f.key]
    let value
    if (f.type === 'number') value = clampNumber(raw, f.min, f.max, before[f.key])
    else if (f.type === 'enum') {
      const allowed = f.options.map((o) => o[0])
      value = allowed.includes(String(raw)) ? String(raw) : before[f.key]
    } else if (f.type === 'string[]') {
      value = Array.isArray(raw) ? raw.map((x) => String(x)).filter(Boolean).slice(0, 40) : String(raw || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    } else {
      value = String(raw ?? '').trim()
    }
    if (JSON.stringify(value) !== JSON.stringify(before[f.key])) changed.push(f.key)
    next[f.key] = value
  }
  const saved = saveConfig(pluginRoot, next)
  return {
    saved,
    changed,
    needs: { rescan: changed.includes('minecraftDir') || changed.includes('gameDirMode') },
  }
}
