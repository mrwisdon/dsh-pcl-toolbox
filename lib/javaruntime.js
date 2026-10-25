/**
 * javaruntime.js —— 从 Mojang 下载 Java 运行时（PCL 的 ModJava.vb 那块）。
 *
 * 数据源三级：
 *   1. `/v1/products/java-runtime/<productId>/all.json`   —— 组件索引（含每个平台的组件列表）
 *   2. 组件条目里的 `manifest.url`（piston-meta）        —— 该组件的**文件树**（400+ 个文件）
 *   3. 文件树里每个文件的 `downloads.raw.url`（piston-data）—— 真正的文件
 *
 * 关键点（都是实测出来的）：
 *   · `all.json` 里 `windows-x64` 下的每个组件是**数组**，取 `[0]`
 *   · manifest 走 BMCLAPI 时是**域替换 + 路径保持**：`piston-meta.mojang.com/v1/packages/...`
 *     → `bmclapi2.bangbang93.com/v1/packages/...`（实测 200）
 *   · 文件树里 `type` 有 `directory` / `file` / `link` 三种，只有 `file` 要下载
 *   · 装完读 `<runtime>/<component>/release` 的 `JAVA_VERSION` 就知道版本
 *   · 装到 `<minecraftDir>/runtime/<component>/` 之后，`java.js` 的扫描会自动发现它
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fetchJson } from './http.js'

export const RUNTIME_PRODUCT_ID = '2ec0cc96c44e5a76b9c8b7c39df7210883d12871'

/** 当前平台在 all.json 里的键。 */
export function platformKey() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'ia32' ? 'x86' : process.arch
  if (process.platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'x86' ? 'windows-x86' : 'windows-x64'
  if (process.platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  return arch === 'ia32' ? 'linux-i386' : 'linux'
}

/** major → 默认组件名（版本 JSON 没给 component 时的兜底）。 */
export const MAJOR_TO_COMPONENT = {
  25: 'java-runtime-epsilon',
  21: 'java-runtime-delta',
  17: 'java-runtime-gamma',
  16: 'java-runtime-alpha',
  8: 'jre-legacy',
}

const INDEX_URLS = (mirror) => [
  `${String(mirror || 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')}/v1/products/java-runtime/${RUNTIME_PRODUCT_ID}/all.json`,
  `https://launchermeta.mojang.com/v1/products/java-runtime/${RUNTIME_PRODUCT_ID}/all.json`,
]

let INDEX_CACHE = { at: 0, platform: null, data: null }
const INDEX_TTL_MS = 30 * 60 * 1000

/** 取组件索引（按平台裁剪），带 30 分钟缓存。 */
export async function fetchRuntimeIndex(mirror) {
  const platform = platformKey()
  if (INDEX_CACHE.data && INDEX_CACHE.platform === platform && Date.now() - INDEX_CACHE.at < INDEX_TTL_MS) {
    return INDEX_CACHE.data
  }
  let lastErr = null
  let raw = null
  for (const url of INDEX_URLS(mirror)) {
    try {
      const { json } = await fetchJson(url, { timeoutMs: 30000 })
      raw = json
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!raw) throw new Error('取 Java 运行时索引失败：' + String(lastErr?.message || lastErr))
  const bucket = raw[platform] || {}
  const components = {}
  for (const [name, value] of Object.entries(bucket)) {
    const entry = Array.isArray(value) ? value[0] : value
    if (!entry || !entry.manifest?.url) continue
    components[name] = {
      component: name,
      version: entry.version?.name || null,
      released: entry.version?.released || null,
      manifestUrl: entry.manifest.url,
      manifestSha1: entry.manifest.sha1 || null,
      manifestSize: entry.manifest.size || null,
    }
  }
  const data = { platform, components, fetchedAt: Date.now() }
  INDEX_CACHE = { at: Date.now(), platform, data }
  return data
}

/** 已安装的 runtime（读 release 文件）。 */
export function listInstalled(minecraftDir) {
  const root = path.join(minecraftDir, 'runtime')
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const exe = path.join(dir, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
    const javaExe = path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    let version = null
    let arch = null
    try {
      const release = readFileSync(path.join(dir, 'release'), 'utf8')
      version = /JAVA_VERSION="([^"]+)"/.exec(release)?.[1] || null
      const osArch = /OS_ARCH="([^"]+)"/.exec(release)?.[1] || null
      arch = osArch ? (/64/.test(osArch) || /x86_64|amd64/i.test(osArch) ? '64' : '32') : null
    } catch {
      /* 没有 release 文件就当未知 */
    }
    out.push({
      component: entry.name,
      dir,
      version,
      arch,
      installed: existsSync(javaExe) || existsSync(exe),
      exe: existsSync(exe) ? exe : javaExe,
      major: version ? (/^1\./.test(version) ? Number(version.split('.')[1]) : Number(version.split('.')[0])) : null,
    })
  }
  out.sort((a, b) => (b.major ?? -1) - (a.major ?? -1))
  return out
}

/** 列出「索引里的组件 × 是否已安装」。 */
export async function listRuntimes({ minecraftDir, mirror }) {
  const index = await fetchRuntimeIndex(mirror)
  const installed = listInstalled(minecraftDir)
  const byName = new Map(installed.map((r) => [r.component, r]))
  const rows = []
  for (const c of Object.values(index.components)) {
    const inst = byName.get(c.component)
    const major = c.version ? (/^1\./.test(c.version) ? Number(c.version.split('.')[1]) : Number(c.version.split('.')[0])) : null
    rows.push({
      component: c.component,
      version: c.version,
      major,
      installed: Boolean(inst?.installed),
      installedVersion: inst?.version || null,
      installedMajor: inst?.major ?? null,
      upToDate: Boolean(inst?.version && c.version && inst.version === c.version),
      path: inst?.dir || path.join(minecraftDir, 'runtime', c.component),
      exe: inst?.exe || null,
    })
  }
  rows.sort((a, b) => (b.major ?? -1) - (a.major ?? -1) || a.component.localeCompare(b.component))
  return { platform: index.platform, runtimes: rows, installed: installed.length }
}

/** 某个版本需要哪个组件（优先 javaVersion.component，其次按 major 兜底）。 */
export async function runtimeForVersion({ minecraftDir, mirror, javaVersion }) {
  const index = await fetchRuntimeIndex(mirror)
  const want = javaVersion?.component || MAJOR_TO_COMPONENT[javaVersion?.majorVersion] || null
  const entry = want ? index.components[want] : null
  const installed = listInstalled(minecraftDir).find((r) => r.component === want)
  return {
    needed: want,
    majorVersion: javaVersion?.majorVersion ?? null,
    available: entry ? { component: entry.component, version: entry.version, major: entry.version ? Number(entry.version.split('.')[0]) : null } : null,
    installed: Boolean(installed?.installed),
    installedVersion: installed?.version || null,
    exe: installed?.exe || null,
  }
}

/** manifest 的 URL 走镜像（域替换；路径保持）。 */
export function mirrorize(url, mirror) {
  const base = String(mirror || 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')
  return String(url)
    .replace('https://piston-meta.mojang.com', base)
    .replace('https://piston-data.mojang.com', base)
    .replace('https://launchermeta.mojang.com', base)
    .replace('https://launcher.mojang.com', base)
}

/**
 * 生成安装计划：{ files:[{rel,url,sources,size,sha1,executable}], bytes, ... }
 * rel 相对 `<minecraftDir>/runtime`，所以是 `<component>/bin/javaw.exe` 这种。
 */
export async function planInstall({ minecraftDir, mirror, component }) {
  const index = await fetchRuntimeIndex(mirror)
  const entry = index.components[component]
  if (!entry) throw new Error(`索引里没有组件 ${component}（平台 ${index.platform}）`)
  const manifestCandidates = [mirrorize(entry.manifestUrl, mirror), entry.manifestUrl]
  let manifest = null
  let lastErr = null
  for (const url of manifestCandidates) {
    try {
      const { json } = await fetchJson(url, { timeoutMs: 45000 })
      manifest = json
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!manifest || !manifest.files) throw new Error('取运行时文件树失败：' + String(lastErr?.message || lastErr || '没有 files'))

  const files = []
  const skipped = { directory: 0, link: 0, noRaw: 0 }
  for (const [name, f] of Object.entries(manifest.files)) {
    if (!f || f.type === 'directory') {
      skipped.directory += 1
      continue
    }
    if (f.type === 'link') {
      skipped.link += 1
      continue
    }
    const raw = f.downloads?.raw
    if (!raw?.url) {
      skipped.noRaw += 1
      continue
    }
    const rel = path.posix.join(component, String(f.target || name).replace(/\\/g, '/'))
    files.push({
      rel,
      // 实测（2026-10）：BMCLAPI **不镜像** piston-data 的 `/v1/objects/<sha>/<name>` ——
      // 要么 404 要么 429，拿它当首选会让 400 个文件每个都白等一次退避（实测整轮从几十秒变 7 分钟）。
      // 所以 raw 文件**官方优先、镜像兜底**；manifest 本身仍走镜像（那个是 /v1/packages/，镜像有）。
      url: raw.url,
      sources: [raw.url, mirrorize(raw.url, mirror)],
      size: Number(raw.size) || 0,
      sha1: raw.sha1 || null,
      executable: Boolean(f.executable),
    })
  }
  const bytes = files.reduce((s, f) => s + f.size, 0)
  return {
    component,
    version: entry.version,
    platform: index.platform,
    dir: path.join(minecraftDir, 'runtime'),
    files,
    bytes,
    skipped,
  }
}

/**
 * 装完之后校验：`<runtime>/<component>/release` 里的 JAVA_VERSION 是否等于索引里的版本。
 * @returns {{ok:boolean, javaVersion:string|null, expected:string|null, exe:string|null, message:string}}
 */
export function verifyInstall({ minecraftDir, component, expectedVersion }) {
  const dir = path.join(minecraftDir, 'runtime', component)
  const releaseFile = path.join(dir, 'release')
  const exe = path.join(dir, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
  if (!existsSync(dir)) return { ok: false, javaVersion: null, expected: expectedVersion || null, exe: null, message: '目录不存在：' + dir }
  if (!existsSync(exe)) return { ok: false, javaVersion: null, expected: expectedVersion || null, exe: null, message: '缺少启动器可执行文件：' + exe }
  let javaVersion = null
  try {
    const release = readFileSync(releaseFile, 'utf8')
    javaVersion = /JAVA_VERSION="([^"]+)"/.exec(release)?.[1] || null
  } catch {
    return { ok: true, javaVersion: null, expected: expectedVersion || null, exe, message: '已装好，但没有 release 文件（版本未知）' }
  }
  const ok = !expectedVersion || javaVersion === expectedVersion
  return {
    ok,
    javaVersion,
    expected: expectedVersion || null,
    exe,
    message: ok ? `已安装 Java ${javaVersion}` : `版本不符：期望 ${expectedVersion}，实际 ${javaVersion}`,
  }
}
