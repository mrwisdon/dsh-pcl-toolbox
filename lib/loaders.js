/**
 * loaders.js —— 加载器安装（PCL 的「安装 Forge/Fabric/NeoForge」那块）。
 *
 * 两条完全不同的路径：
 *
 *   A. Fabric / Quilt —— **纯元数据**：meta 给一个 profile JSON（`inheritsFrom` = 原版版本），
 *      我们把它写成 `versions/<自定义id>/<自定义id>.json`，再把它引用的那几个 maven 库下下来。
 *      原版 jar / 资源复用已有实例，所以装完立刻能启动。
 *
 *   B. Forge / NeoForge —— **跑官方 installer**：下载 `*-installer.jar`，用选好的 Java 执行
 *      `java -jar installer.jar --installClient <minecraftDir>`，installer 自己会写 versions/<id>/ 和库。
 *      这一步必须有 Java，所以依赖 javaruntime / java.js。
 *
 * 镜像实测（2026-10）：
 *   · Fabric meta 镜像可用（`/fabric-meta/...`，profile 58ms）
 *   · Quilt meta 镜像 **404**，只能走官方 `meta.quiltmc.org`
 *   · Forge installer / NeoForge installer 镜像都 200（`/maven/...`）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRun } from './download.js'
import { fetchJson } from './http.js'
import { mavenPathFromName, resolveVersionJson } from './versions.js'
import { rulesAllow } from './args.js'

const FABRIC_MIRROR = (m) => `${String(m || 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')}/fabric-meta`
const FABRIC_OFFICIAL = 'https://meta.fabricmc.net'
const QUILT_OFFICIAL = 'https://meta.quiltmc.org'
const FORGE_MIRROR = (m) => `${String(m || 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')}/forge`
const NEOFORGE_META = (m) => `${String(m || 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')}/neoforge/meta`
const MAVEN_MIRROR = (m) => `${String(m || 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')}/maven`

const TYPES = { fabric: true, quilt: true, forge: true, neoforge: true }

export function isValidLoaderType(type) {
  return Boolean(TYPES[String(type)])
}

async function fetchFirst(urls, opts) {
  let lastErr = null
  for (const url of urls) {
    try {
      return await fetchJson(url, opts)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('全部地址都失败')
}

// ---------------------------------------------------------------- 列表
function normalizeLoaderList(arr) {
  const seen = new Map()
  for (const e of Array.isArray(arr) ? arr : []) {
    const l = e?.loader || e
    const version = l?.version || l?.name || (typeof e === 'string' ? e : null)
    if (!version) continue
    if (!seen.has(version)) seen.set(version, { version, stable: l?.stable !== false })
  }
  return [...seen.values()]
}

export async function listLoaderVersions({ type, mcVersion, mirror }) {
  if (!isValidLoaderType(type)) throw new Error('未知加载器类型: ' + type)
  if (!mcVersion) throw new Error('缺少 mcVersion')
  if (type === 'fabric') {
    const { json } = await fetchFirst(
      [`${FABRIC_MIRROR(mirror)}/v2/versions/loader/${encodeURIComponent(mcVersion)}`, `${FABRIC_OFFICIAL}/v2/versions/loader/${encodeURIComponent(mcVersion)}`],
      { timeoutMs: 20000 },
    )
    return { type, mcVersion, loaders: normalizeLoaderList(json) }
  }
  if (type === 'quilt') {
    // 镜像没有 quilt-meta（实测 404），只能官方
    const { json } = await fetchFirst([`${QUILT_OFFICIAL}/v3/versions/loader/${encodeURIComponent(mcVersion)}`], { timeoutMs: 25000 })
    return { type, mcVersion, loaders: normalizeLoaderList(json) }
  }
  if (type === 'forge') {
    const { json } = await fetchFirst(
      [`${FORGE_MIRROR(mirror)}/minecraft/${encodeURIComponent(mcVersion)}`, `https://files.minecraftforge.net/maven/net/minecraftforge/forge/maven-metadata.xml`],
      { timeoutMs: 20000 },
    ).catch(async () => {
      // 兜底：直接用 promos 拿 latest/recommended
      const p = await fetchFirst([`${FORGE_MIRROR(mirror)}/promos`], { timeoutMs: 20000 })
      return { json: p.json }
    })
    if (Array.isArray(json)) {
      const loaders = normalizeLoaderList(json.map((e) => (typeof e === 'string' ? e : e?.version)))
      // meta 给的是升序，面板要"最新在前"
      loaders.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
      return { type, mcVersion, loaders }
    }
    return { type, mcVersion, loaders: [], note: 'Forge 版本列表格式不是数组，改用 promos 取推荐版本' }
  }
  // neoforge：maven 目录列表
  const { json } = await fetchFirst([`${NEOFORGE_META(mirror)}/api/maven/details/releases/net/neoforged/neoforge`], { timeoutMs: 30000 })
  const dirs = (json?.files || []).filter((f) => f.type === 'DIRECTORY').map((f) => f.name)
  // NeoForge 版本号形如 21.1.77；MC 1.21.1 → 21.1.*；MC 26.2 → 26.2.*
  const prefix = String(mcVersion).replace(/^1\./, '') + '.'
  const loaders = dirs
    .filter((n) => n.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => ({ version, stable: !/-beta|-alpha/i.test(version) }))
  return { type, mcVersion, loaders, allVersions: dirs.length }
}

// ---------------------------------------------------------------- A. Fabric / Quilt
function profileUrls(type, mcVersion, loaderVersion, mirror) {
  if (type === 'fabric') {
    return [
      `${FABRIC_MIRROR(mirror)}/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
      `${FABRIC_OFFICIAL}/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
    ]
  }
  return [`${QUILT_OFFICIAL}/v3/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`]
}

/** 默认实例名：`26.2-fabric-0.20.1`（不带空格，省掉一堆引号麻烦；仍兼容带空格的旧实例）。 */
export function defaultInstanceName(type, mcVersion, loaderVersion) {
  return `${mcVersion}-${type}-${loaderVersion}`
}

/**
 * 装 Fabric / Quilt。
 * @param {object} o
 * @param {'fabric'|'quilt'} o.type
 * @param {string} o.minecraftDir
 * @param {string} o.mcVersion
 * @param {string} o.loaderVersion
 * @param {string} [o.name]      自定义实例名
 * @param {string} [o.mirror]
 * @param {number} [o.concurrency]
 * @param {(line:string)=>void} [o.onLog]
 * @returns {Promise<{id:string, dir:string, libraries:number, run:object|null, missing:number, plan:object}>}
 */
export async function installFabricLike(o) {
  const { type, minecraftDir, mcVersion } = o
  if (type !== 'fabric' && type !== 'quilt') throw new Error('不是 fabric/quilt: ' + type)
  if (!mcVersion) throw new Error('缺少 mcVersion')
  const log = o.onLog || (() => {})

  // 原版必须已经装好（profile 只提供加载器层，客户端 jar / 资源要复用原版）
  const baseJson = path.join(minecraftDir, 'versions', mcVersion, mcVersion + '.json')
  if (!existsSync(baseJson)) {
    throw new Error(`原版 ${mcVersion} 还没装（找不到 ${baseJson}）。先用「下载」页签把它下下来。`)
  }

  let loaderVersion = o.loaderVersion
  if (!loaderVersion) {
    const list = await listLoaderVersions({ type, mcVersion, mirror: o.mirror })
    loaderVersion = list.loaders.find((l) => l.stable)?.version || list.loaders[0]?.version
    if (!loaderVersion) throw new Error(`没有找到 ${type} 对 ${mcVersion} 的可用版本`)
  }

  const id = String(o.name || defaultInstanceName(type, mcVersion, loaderVersion))
  const versionDir = path.join(minecraftDir, 'versions', id)
  log(`取 ${type} ${loaderVersion} 的 profile（MC ${mcVersion}）`)
  const { json: profile } = await fetchFirst(profileUrls(type, mcVersion, loaderVersion, o.mirror), { timeoutMs: 25000 })
  if (!profile || !profile.mainClass) throw new Error('profile 里没有 mainClass，meta 返回异常')

  // 写版本 JSON：id / inheritsFrom 必须和我们的目录名对齐
  const vj = { ...profile, id, inheritsFrom: profile.inheritsFrom || mcVersion }
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(path.join(versionDir, id + '.json'), JSON.stringify(vj, null, 2), 'utf8')
  log(`已写入 versions/${id}/${id}.json（mainClass=${vj.mainClass}）`)

  // 下载 profile 引用的 maven 库
  const files = []
  for (const lib of vj.libraries || []) {
    const rel = lib.downloads?.artifact?.path || mavenPathFromName(lib.name)
    if (!rel) continue
    const art = lib.downloads?.artifact
    const base = String(lib.url || 'https://maven.fabricmc.net/').replace(/\/+$/, '')
    const official = `${base}/${rel}`
    const mirrorUrl = `${MAVEN_MIRROR(o.mirror)}/${rel}`
    files.push({
      rel: 'libraries/' + rel,
      url: mirrorUrl,
      sources: [mirrorUrl, official],
      size: Number(art?.size ?? lib.size) || 0,
      sha1: art?.sha1 || lib.sha1 || null,
      kind: 'libraries',
    })
  }
  let run = null
  if (files.length) {
    log(`下载 ${files.length} 个加载器库`)
    run = createRun({ dir: minecraftDir, files, concurrency: Number(o.concurrency) || 6, onLog: log })
    await run.start()
  }

  // 校验：能把继承链解开、且没有缺文件
  const resolved = resolveVersionJson(minecraftDir, id)
  const libDir = path.join(minecraftDir, 'libraries')
  let missing = 0
  let considered = 0
  for (const lib of resolved.json.libraries || []) {
    // 必须按 rules 过滤：否则会把 macOS/Linux 的库也算成"缺失"（第一次就栽在这，报了 42 个假缺失）
    if (!rulesAllow(lib.rules)) continue
    const rel = lib.downloads?.artifact?.path || mavenPathFromName(lib.name)
    if (!rel) continue
    considered += 1
    if (!existsSync(path.join(libDir, ...rel.split('/')))) missing += 1
  }
  const plan = {
    id,
    dir: versionDir,
    mainClass: resolved.json.mainClass,
    mainClassSources: resolved.chain,
    libraries: files.length,
    considered,
    missing,
    downloaded: run ? run.stats.filesDone : 0,
    skipped: run ? run.stats.filesSkipped : 0,
    failed: run ? run.stats.filesFailed : 0,
  }
  log(missing === 0 ? `完成：实例 ${id} 已就绪（加载器库 ${files.length} 个，无缺失）` : `完成，但还缺 ${missing} 个库`)
  return { id, dir: versionDir, libraries: files.length, run, missing, plan }
}

// ---------------------------------------------------------------- B. Forge / NeoForge
function forgeInstallerUrls({ type, mcVersion, build, mirror }) {
  if (type === 'forge') {
    const full = `${mcVersion}-${build}`
    return [
      `${MAVEN_MIRROR(mirror)}/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
      `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
    ]
  }
  return [
    `${MAVEN_MIRROR(mirror)}/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`,
    `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`,
  ]
}

/** 下载 installer jar 到临时目录。 */
export async function fetchInstaller({ type, mcVersion, build, mirror, onLog }) {
  const log = onLog || (() => {})
  const urls = forgeInstallerUrls({ type, mcVersion, build, mirror })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mc-installer-'))
  const file = path.join(tmp, 'installer.jar')
  log(`下载 installer：${urls[0]}`)
  const run = createRun({
    dir: tmp,
    files: [{ rel: 'installer.jar', url: urls[0], sources: urls, size: 0, sha1: null, kind: 'installer' }],
    concurrency: 1,
    onLog: log,
  })
  await run.start()
  if (run.stats.filesFailed || !existsSync(file)) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error('installer 下载失败')
  }
  return { tmp, file, bytes: run.stats.bytesDone }
}

/**
 * 从 installer 输出里抠出「下载失败的 maven 坐标」。
 * 形如 `net.neoforged:neoforge:26.2.0.93:universal` / `org.jline:jline:3.20.0`。
 */
export function parseFailedArtifacts(output) {
  const text = String(output || '')
  const idx = text.indexOf('These libraries failed to download')
  const block = idx >= 0 ? text.slice(idx, idx + 8000) : text.slice(-8000)
  const coords = []
  const seen = new Set()
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim()
    if (!/^[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-]+(:[A-Za-z0-9_.\-]+)?$/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    coords.push(t)
    if (coords.length >= 60) break
  }
  return coords
}

/** 把坐标对应的 jar 用「镜像优先、官方兜底」预置到 libraries/。 */
export async function seedArtifacts({ minecraftDir, coords, mirror, onLog }) {
  const log = onLog || (() => {})
  const files = []
  for (const coord of coords) {
    const rel = mavenPathFromName(coord)
    if (!rel) continue
    if (existsSync(path.join(minecraftDir, 'libraries', ...rel.split('/')))) continue
    const official = [
      `https://maven.neoforged.net/releases/${rel}`,
      `https://maven.minecraftforge.net/${rel}`,
      `https://libraries.minecraft.net/${rel}`,
      `https://repo1.maven.org/maven2/${rel}`,
    ]
    files.push({
      rel: 'libraries/' + rel,
      url: `${MAVEN_MIRROR(mirror)}/${rel}`,
      sources: [`${MAVEN_MIRROR(mirror)}/${rel}`, ...official],
      size: 0,
      sha1: null,
      kind: 'libraries',
    })
  }
  if (!files.length) return { needed: 0, downloaded: 0 }
  log(`用镜像预置 ${files.length} 个 installer 依赖`)
  const run = createRun({ dir: minecraftDir, files, concurrency: 4, onLog: log })
  await run.start()
  return { needed: files.length, downloaded: run.stats.filesDone, failed: run.stats.filesFailed }
}

/**
 * 跑 Forge/NeoForge 官方 installer。
 * installer 会自己往 `<minecraftDir>/versions/` 写版本 JSON 和库，所以这里只负责「跑完 + 找出新版本」。
 */
export async function installForgeLike(o) {
  const { type, minecraftDir, mcVersion, build, javaExe } = o
  if (type !== 'forge' && type !== 'neoforge') throw new Error('不是 forge/neoforge: ' + type)
  if (!javaExe) throw new Error('缺少 Java 可执行文件（Forge/NeoForge 需要跑 installer）')
  const log = o.onLog || (() => {})
  const versionsDir = path.join(minecraftDir, 'versions')
  const before = new Set(readdirSync(versionsDir).map(String))

  const got = await fetchInstaller({ ...o, onLog: log })
  log(`installer 已下载（${(got.bytes / 1048576).toFixed(1)} MB）`)

  let result = { code: -1, out: '' }
  let created = []
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    log(`第 ${attempt}/${MAX_ATTEMPTS} 次执行 installer`)
    result = await new Promise((resolve) => {
      const child = spawn(javaExe, ['-jar', got.file, '--installClient', minecraftDir], { cwd: got.tmp, windowsHide: true })
      let out = ''
      const push = (b) => {
        const s = String(b)
        out += s
        for (const line of s.split(/\r?\n/)) if (line.trim()) log(line.trim().slice(0, 300))
        if (out.length > 300000) out = out.slice(-150000)
      }
      child.stdout.on('data', push)
      child.stderr.on('data', push)
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
      }, Number(o.timeoutMs) || 300000)
      child.on('error', (err) => resolve({ code: -1, out: out + '\n' + String(err?.message || err) }))
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, out })
      })
    })

    created = readdirSync(versionsDir).map(String).filter((n) => !before.has(n))
    if (result.code === 0) break

    // 失败原因多半是「官方 maven 拉不动」：把失败坐标用镜像预置好再重试一轮
    const failed = parseFailedArtifacts(result.out)
    if (!failed.length) {
      log('installer 失败，但输出里没有可识别的失败坐标，不再重试')
      break
    }
    if (attempt === MAX_ATTEMPTS) break
    const seeded = await seedArtifacts({ minecraftDir, coords: failed, mirror: o.mirror, onLog: log })
    log(`预置结果：需要 ${seeded.needed} 个，成功 ${seeded.downloaded} 个`)
    if (!seeded.downloaded) break
  }
  rmSync(got.tmp, { recursive: true, force: true })

  const okExit = result.code === 0
  log(okExit ? `installer 执行成功，新版本：${created.join(', ') || '（没有新增，可能已安装）'}` : `installer 退出码 ${result.code}`)
  return {
    ok: okExit,
    exitCode: result.code,
    created,
    logTail: result.out.slice(-4000),
    note: okExit ? null : created.length ? '版本 JSON 已生成但 installer 未跑完（库可能不全，可点「修复库」）' : 'installer 失败，没有生成版本',
  }
}

/**
 * 修复/补齐某个实例缺的库（Forge/NeoForge installer 跑完后经常留下「库没下全」的实例）。
 *
 * 为什么需要：官方 installer 从 `maven.neoforged.net` 等官方源拉库，国内经常失败
 * （现象：installer 退出码 1 + "These libraries failed to download"，但版本 JSON 已经写好了）。
 * 这里把版本 JSON 里引用的库按 **BMCLAPI maven 优先、官方兜底** 补齐，补完往往直接可启动。
 */
export async function repairLibraries({ minecraftDir, versionId, mirror, onLog, concurrency = 8 }) {
  const log = onLog || (() => {})
  const resolved = resolveVersionJson(minecraftDir, versionId)
  const libDir = path.join(minecraftDir, 'libraries')
  const files = []
  let checked = 0
  for (const lib of resolved.json.libraries || []) {
    if (!rulesAllow(lib.rules)) continue
    const rel = lib.downloads?.artifact?.path || mavenPathFromName(lib.name)
    if (!rel) continue
    checked += 1
    if (existsSync(path.join(libDir, ...rel.split('/')))) continue
    const art = lib.downloads?.artifact
    const official = art?.url || `https://libraries.minecraft.net/${rel}`
    const mirrorUrl = `${MAVEN_MIRROR(mirror)}/${rel}`
    files.push({
      rel: 'libraries/' + rel,
      url: mirrorUrl,
      sources: [mirrorUrl, official],
      size: Number(art?.size) || 0,
      sha1: art?.sha1 || null,
      kind: 'libraries',
    })
  }
  log(`检查 ${checked} 个库，缺 ${files.length} 个`)
  let run = null
  if (files.length) {
    run = createRun({ dir: minecraftDir, files, concurrency, onLog: log })
    await run.start()
  }
  // 复核
  let stillMissing = 0
  for (const lib of resolved.json.libraries || []) {
    if (!rulesAllow(lib.rules)) continue
    const rel = lib.downloads?.artifact?.path || mavenPathFromName(lib.name)
    if (!rel) continue
    if (!existsSync(path.join(libDir, ...rel.split('/')))) stillMissing += 1
  }
  log(stillMissing === 0 ? '库已补齐' : `仍缺 ${stillMissing} 个库`)
  return {
    versionId,
    checked,
    needed: files.length,
    downloaded: run ? run.stats.filesDone : 0,
    skipped: run ? run.stats.filesSkipped : 0,
    failed: run ? run.stats.filesFailed : 0,
    stillMissing,
  }
}

/** 从版本目录里找「某个原版版本的 Forge/NeoForge 实例」。 */
export function findLoaderInstances(minecraftDir, type) {
  const root = path.join(minecraftDir, 'versions')
  if (!existsSync(root)) return []
  const re = type === 'forge' ? /forge/i : type === 'neoforge' ? /neo-?forge/i : type === 'fabric' ? /fabric/i : /quilt/i
  const out = []
  for (const name of readdirSync(root)) {
    if (!re.test(name)) continue
    const json = path.join(root, name, name + '.json')
    if (!existsSync(json)) continue
    try {
      out.push({ id: name, json, inheritsFrom: JSON.parse(readFileSync(json, 'utf8'))?.inheritsFrom ?? null })
    } catch {
      out.push({ id: name, json, inheritsFrom: null })
    }
  }
  return out
}
