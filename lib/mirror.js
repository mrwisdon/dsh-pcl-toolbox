/**
 * mirror.js —— 纯函数：BMCLAPI 路径改写 + 下载计划构建。无 IO、无依赖，方便单测。
 *
 * 实测映射（2026-10 在本机实测，逐条见 README「实测证据」）：
 *
 *   版本清单   {M}/mc/game/version_manifest_v2.json
 *   版本 JSON  {M}/version/{v}/json
 *   client jar {M}/version/{v}/client          ← 实测 28,335,587B，sha1 与官方一致
 *   server jar {M}/version/{v}/server
 *   库(maven)  {M}/maven/{downloads.artifact.path}
 *   资源索引   {M}/v1/packages/{assetIndex.sha1}/{assetIndex.id}.json
 *   资源对象   {M}/assets/{hash[0:2]}/{hash}   ← ⚠ 必须直连；走本地 HTTP 代理会 000
 *
 * 两个必须记住的坑：
 *   1. 清单与版本 JSON 里的下载 URL 仍然是 piston-meta / piston-data 官方域名，
 *      BMCLAPI **不会**替你改写。所以这里一律忽略原 url 字段，按上表重建。
 *   2. `/version/{v}/{任意文件名}` 是 catch-all：`.json` 给版本 JSON，其余给 client.jar。
 *      因此**不能**用它取资源索引或 log4j 的 client-*.xml（实测都不存在）。
 */

export const DEFAULT_MIRROR = 'https://bmclapi2.bangbang93.com'

/**
 * 统一 User-Agent。BMCLAPI 是公益镜像，规范使用应带可识别 UA（我们之前用 Node 默认 UA 还吃过 429）。
 * 发布到 GitHub 后把 URL 换成真实仓库地址即可。
 */
export const DEFAULT_USER_AGENT = 'PCL-Toolbox/0.4 (+https://github.com/; third-party reimplementation) '

function joinUrl(base, suffix) {
  return String(base || DEFAULT_MIRROR).replace(/\/+$/, '') + suffix
}

export const urls = {
  manifest: (m) => joinUrl(m, '/mc/game/version_manifest_v2.json'),
  versionJson: (m, v) => joinUrl(m, `/version/${encodeURIComponent(v)}/json`),
  clientJar: (m, v) => joinUrl(m, `/version/${encodeURIComponent(v)}/client`),
  serverJar: (m, v) => joinUrl(m, `/version/${encodeURIComponent(v)}/server`),
  maven: (m, artifactPath) => joinUrl(m, `/maven/${artifactPath}`),
  assetIndex: (m, ai) => joinUrl(m, `/v1/packages/${ai.sha1}/${encodeURIComponent(ai.id)}.json`),
  assetObject: (m, hash) => joinUrl(m, `/assets/${String(hash).slice(0, 2)}/${hash}`),
  /**
   * 官方资源 CDN。BMCLAPI 的 /assets/ 实测是「302 到临时签名 URL + 429 限流」的
   * 结构（Retry-After-short ≈ 19s），4000+ 资源硬打必然被限流。
   * 这个 URL 是同一个内容寻址文件的官方直取地址，用于限流时的兜底。
   */
  assetObjectOfficial: (hash) => `https://resources.download.minecraft.net/${String(hash).slice(0, 2)}/${hash}`,
  /** 官方库源（PCL 的 DlSourceLibraryGet 会同时给出 maven 与 libraries 两个镜像路径 + 官方源）。 */
  libraryOfficial: (artifactPath) => `https://libraries.minecraft.net/${artifactPath}`,
  libraryAltMirror: (m, artifactPath) => joinUrl(m, `/libraries/${artifactPath}`),
  clientJarOfficial: (sha1) => `https://piston-data.mojang.com/v1/objects/${sha1}/client.jar`,
  versionJsonOfficial: (sha1, id) => `https://piston-meta.mojang.com/v1/packages/${sha1}/${id}.json`,
}

/**
 * 按「下载源偏好」把官方源与镜像源排成有序候选列表。
 * 对应 PCL 的 ToolDownloadSource 三档：尽量镜像 / 优先官方 / 尽量官方。
 */
export function orderSources(official, mirror, preference = 'mirror-first') {
  const o = (official || []).filter(Boolean)
  const m = (mirror || []).filter(Boolean)
  const list = preference === 'official-first' ? [...o, ...m] : preference === 'mirror-only' ? [...m] : [...m, ...o]
  return [...new Set(list)]
}

/** 当前平台语义（与 Minecraft 清单里的 os.name / os.arch 对齐）。 */
export function currentPlatform() {
  const osName =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const arch =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : process.arch
  return { osName, arch }
}

function ruleMatches(rule, platform, features) {
  const os = rule.os
  if (os) {
    if (os.name && os.name !== platform.osName) return false
    if (os.arch && os.arch !== platform.arch) return false
    // os.version（正则）：只在显式给了才校验，给了就按正则跑，跑不动当匹配
    if (os.version) {
      try {
        if (!new RegExp(os.version).test(process.getSystemVersion?.() || '')) return false
      } catch {
        /* 正则坏了当匹配，别把整条库丢掉 */
      }
    }
  }
  if (rule.features && typeof rule.features === 'object') {
    for (const [key, want] of Object.entries(rule.features)) {
      if (Boolean(features && features[key]) !== Boolean(want)) return false
    }
  }
  return true
}

/**
 * Minecraft 的 rules 求值：没有 rules = 允许；有 rules 则从 false 起，按顺序命中的最后一条 action 生效。
 */
export function rulesAllow(rules, platform = currentPlatform(), features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (ruleMatches(rule, platform, features)) allowed = rule.action === 'allow'
  }
  return allowed
}

/** 没有 downloads.artifact.path 的老版本库，从 maven 坐标 name 反推路径。 */
export function mavenPathFromName(name) {
  if (typeof name !== 'string' || !name) return null
  let body = name
  let ext = 'jar'
  const at = body.indexOf('@')
  if (at >= 0) {
    ext = body.slice(at + 1)
    body = body.slice(0, at)
  }
  const parts = body.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version, classifier] = parts
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`
  return `${group.split('.').join('/')}/${artifact}/${version}/${file}`
}

function nativeClassifierKey(lib, platform) {
  const natives = lib.natives
  if (!natives || typeof natives !== 'object') return null
  const raw = natives[platform.osName]
  if (!raw) return null
  // 老版本里可能是 natives-windows-${arch} 这种占位
  return String(raw).replace('${arch}', platform.arch === 'x86' ? '32' : '64')
}

/**
 * 给定版本 JSON（+ 资源索引 JSON）构建完整下载计划。
 *
 * @param {object} input
 * @param {string} input.version
 * @param {object} input.versionJson        版本 JSON（来自 {M}/version/{v}/json）
 * @param {string} input.versionJsonSha1    版本 JSON 自身的 sha1（落盘后要一致）
 * @param {number} input.versionJsonSize
 * @param {object} input.assetIndex         资源索引 JSON（objects 表）
 * @param {string} [input.mirror]
 * @param {{osName:string,arch:string}} [input.platform]
 * @param {object} [input.features]
 * @returns {{version:string, mirror:string, platform:object, files:Array, byKind:object, warnings:string[]}}
 */
export function buildPlan(input) {
  const {
    version,
    versionJson,
    versionJsonSha1,
    versionJsonSize,
    assetIndex,
    mirror = DEFAULT_MIRROR,
    platform = currentPlatform(),
    features = {},
    sourcePreference = 'mirror-first',
    versionJsonOfficialUrl = null,
  } = input || {}

  if (!version || !versionJson) throw new Error('buildPlan: 缺少 version 或 versionJson')
  if (!assetIndex || !assetIndex.objects) throw new Error('buildPlan: 缺少 assetIndex.objects')

  const warnings = []
  /** rel -> file，天然按 rel 去重（不同库可能映射到同一路径） */
  const files = new Map()

  const add = (file) => {
    if (!file || !file.rel || !file.url) return
    if (!files.has(file.rel)) files.set(file.rel, file)
  }

  // 1) 版本 JSON 本体
  const vjSources = orderSources(
    [versionJsonOfficialUrl || (versionJsonSha1 ? urls.versionJsonOfficial(versionJsonSha1, version) : null)],
    [urls.versionJson(mirror, version)],
    sourcePreference,
  )
  add({
    kind: 'versionJson',
    rel: `versions/${version}/${version}.json`,
    url: vjSources[0],
    sources: vjSources,
    size: Number(versionJsonSize) || 0,
    sha1: versionJsonSha1 || null,
  })

  // 2) client jar（官方目录布局：versions/<v>/<v>.jar）
  const client = versionJson.downloads && versionJson.downloads.client
  if (client && client.sha1) {
    const clientSources = orderSources(
      [urls.clientJarOfficial(client.sha1)],
      [urls.clientJar(mirror, version)],
      sourcePreference,
    )
    add({
      kind: 'client',
      rel: `versions/${version}/${version}.jar`,
      url: clientSources[0],
      sources: clientSources,
      size: Number(client.size) || 0,
      sha1: client.sha1,
    })
  } else {
    warnings.push('该版本没有 downloads.client（多半是 1.6 以前的旧格式），客户端 jar 未纳入计划。')
  }

  // 3) 库：按 rules 过滤 + artifact + 平台相关 natives
  let libCount = 0
  let libSkippedByRule = 0
  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules, platform, features)) {
      libSkippedByRule += 1
      continue
    }
    const downloads = lib.downloads || {}
    const artifact = downloads.artifact
    if (artifact && artifact.path && artifact.sha1) {
      const libSources = orderSources(
        [urls.libraryOfficial(artifact.path)],
        [urls.maven(mirror, artifact.path), urls.libraryAltMirror(mirror, artifact.path)],
        sourcePreference,
      )
      add({
        kind: 'libraries',
        rel: `libraries/${artifact.path}`,
        url: libSources[0],
        sources: libSources,
        size: Number(artifact.size) || 0,
        sha1: artifact.sha1,
      })
      libCount += 1
      continue
    }
    // 老格式：artifact 缺 path 时从 name 反推
    const derived = mavenPathFromName(lib.name)
    if (derived) {
      const sources = orderSources(
        [urls.libraryOfficial(derived)],
        [urls.maven(mirror, derived), urls.libraryAltMirror(mirror, derived)],
        sourcePreference,
      )
      add({ kind: 'libraries', rel: `libraries/${derived}`, url: sources[0], sources, size: 0, sha1: null })
      libCount += 1
      continue
    }
    // 老格式 natives 走 classifiers
    const nativeKey = nativeClassifierKey(lib, platform)
    const classifiers = downloads.classifiers
    if (nativeKey && classifiers && classifiers[nativeKey] && classifiers[nativeKey].sha1) {
      const cls = classifiers[nativeKey]
      const p = cls.path || mavenPathFromName(lib.name)
      if (p) {
        const sources = orderSources(
          [urls.libraryOfficial(p)],
          [urls.maven(mirror, p), urls.libraryAltMirror(mirror, p)],
          sourcePreference,
        )
        add({
          kind: 'libraries',
          rel: `libraries/${p}`,
          url: sources[0],
          sources,
          size: Number(cls.size) || 0,
          sha1: cls.sha1,
        })
        libCount += 1
      }
    }
  }

  // 4) 资源索引
  const ai = versionJson.assetIndex
  if (ai && ai.sha1 && ai.id) {
    const aiSources = orderSources(
      [ai.url || urls.versionJsonOfficial(ai.sha1, ai.id)],
      [urls.assetIndex(mirror, ai)],
      sourcePreference,
    )
    add({
      kind: 'assetIndex',
      rel: `assets/indexes/${ai.id}.json`,
      url: aiSources[0],
      sources: aiSources,
      size: Number(ai.size) || 0,
      sha1: ai.sha1,
    })
  } else {
    warnings.push('版本 JSON 没有 assetIndex，资源未纳入计划。')
  }

  // 5) 资源对象（镜像优先；auto 模式下带官方兜底 URL）
  let assetCount = 0
  for (const obj of Object.values(assetIndex.objects)) {
    if (!obj || !obj.hash) continue
    const hash = String(obj.hash)
    const assetSources = orderSources([urls.assetObjectOfficial(hash)], [urls.assetObject(mirror, hash)], sourcePreference)
    add({
      kind: 'assets',
      rel: `assets/objects/${hash.slice(0, 2)}/${hash}`,
      url: assetSources[0],
      sources: assetSources,
      size: Number(obj.size) || 0,
      sha1: hash, // 资源对象本身就是「内容寻址」，sha1 == 文件名里的 hash
    })
    assetCount += 1
  }

  const list = [...files.values()]
  const byKind = {
    versionJson: { n: 0, bytes: 0 },
    client: { n: 0, bytes: 0 },
    libraries: { n: 0, bytes: 0 },
    assetIndex: { n: 0, bytes: 0 },
    assets: { n: 0, bytes: 0 },
  }
  for (const f of list) {
    const slot = (byKind[f.kind] ||= { n: 0, bytes: 0 })
    slot.n += 1
    slot.bytes += Number(f.size) || 0
  }

  return {
    version,
    mirror,
    platform,
    files: list,
    byKind,
    stats: { libCount, libSkippedByRule, assetCount },
    warnings,
  }
}
