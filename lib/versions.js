/**
 * versions.js —— 版本发现 + inheritsFrom 继承链合并。
 *
 * 与 DSH / Cordis 解耦（只依赖 node 内置模块），可以单独跑：
 *     node scripts/selftest.mjs
 *
 * 两个现实情况决定了这里的写法：
 *  1. PCL 写盘时**已经把版本 JSON 合并好了**（inheritsFrom 为空、库已内联），所以大多数实例
 *     根本走不到继承逻辑；但官方启动器 / HMCL 装的实例会带 inheritsFrom，必须支持。
 *  2. 版本目录名可以是任何字符串，含空格（本机就有 `1.20.1-Fabric 0.19.5`），
 *     所以只能用 readdir + 目录名，不能按 id 拼路径猜。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * 猜加载器种类（只用于 UI 分组和展示，不影响启动）。
 * 注意：Forge 1.17+ 的主类叫 `cpw.mods.bootstraplauncher.BootstrapLauncher`，
 * **不含 "forge" 字样**，只按名字匹配会把它误判成原版。
 */
const MAIN_CLASS_HINTS = [
  ['neoforge', /neoforged|neoforge/i],
  ['fabric', /fabricmc|quiltmc|knotclient/i],
  ['forge', /bootstraplauncher|modlauncher|net\.minecraftforge/i],
  ['optifine', /optifine/i],
  ['liteloader', /liteloader/i],
]

export function detectLoader(id, mainClass) {
  const name = String(id || '')
  const main = String(mainClass || '')
  if (/neoforge/i.test(name)) return 'neoforge'
  if (/fabric|quilt/i.test(name)) return 'fabric'
  if (/optifine/i.test(name)) return 'optifine'
  if (/liteloader/i.test(name)) return 'liteloader'
  if (/forge/i.test(name)) return 'forge'
  for (const [kind, re] of MAIN_CLASS_HINTS) if (re.test(main)) return kind
  return 'vanilla'
}

/** 从实例名里抽出原版版本号：`1.20.1-Fabric 0.19.5` → `1.20.1`；`26.3-Fabric 0.19.5` → `26.3`。 */
export function detectBaseVersion(id) {
  const m = /^(\d+\.\d+(?:\.\d+)?)/.exec(String(id || ''))
  if (m) return m[1]
  // 快照形如 25w46a
  const snap = /^(\d{2}w\d{2}[a-z])/.exec(String(id || ''))
  return snap ? snap[1] : null
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 版本目录里找版本 JSON：优先 `<目录名>.json`，否则取目录里唯一的 .json。 */
export function findVersionJson(versionDir) {
  const own = path.join(versionDir, path.basename(versionDir) + '.json')
  if (existsSync(own)) return own
  let names = []
  try {
    names = readdirSync(versionDir).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch {
    return null
  }
  if (names.length === 1) return path.join(versionDir, names[0])
  // 多个 json：挑那个真的能解析出 id 的
  for (const n of names) {
    try {
      const j = readJson(path.join(versionDir, n))
      if (j && j.id) return path.join(versionDir, n)
    } catch {
      /* 坏 json 跳过 */
    }
  }
  return null
}

/** 读 PCL 给这个实例强制的 Java（versions/<id>/PCL/config.json）。没有就 null。 */
export function readForcedJava(versionDir) {
  const p = path.join(versionDir, 'PCL', 'config.json')
  if (!existsSync(p)) return null
  try {
    const j = readJson(p)
    const f = j?.InstanceForcedJava
    if (!f || !f.Folder) return null
    for (const exe of ['javaw.exe', 'java.exe']) {
      const abs = path.join(f.Folder, exe)
      if (existsSync(abs)) return { exe: abs, folder: f.Folder, major: f.Version?.Major ?? null, from: 'PCL 实例强制 Java' }
    }
  } catch {
    /* 坏配置当没有 */
  }
  return null
}

/** 扫描 versions/ 下所有实例。**不解析继承链**（列表要快），只给概要。 */
export function listVersions(minecraftDir) {
  const root = path.join(minecraftDir, 'versions')
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const versionDir = path.join(root, entry.name)
    const jsonPath = findVersionJson(versionDir)
    if (!jsonPath) continue
    let vj = null
    try {
      vj = readJson(jsonPath)
    } catch {
      continue // 坏 JSON 不进列表，避免面板里出现点不动的项
    }
    const id = vj.id || entry.name
    // 加载器实例（Fabric/Quilt profile）常常没有 javaVersion，得从 inheritsFrom 的父版本继承，
    // 否则 java.js 会当成"无要求"随便挑一个（实测挑成了 Java 21，而 26.2 要 25）。
    let javaMajor = vj.javaVersion?.majorVersion ?? null
    if (javaMajor == null && vj.inheritsFrom) {
      try {
        const parentDir = path.join(root, String(vj.inheritsFrom))
        const pj = findVersionJson(parentDir)
        if (pj) javaMajor = readJson(pj)?.javaVersion?.majorVersion ?? null
      } catch {
        /* 父版本读不到就算了 */
      }
    }
    const jarName = vj.jar || id
    const jarPath = path.join(versionDir, jarName + '.jar')
    let lastPlayed = null
    try {
      lastPlayed = statSync(jsonPath).mtimeMs
    } catch {
      /* 忽略 */
    }
    out.push({
      id,
      dirName: entry.name,
      dir: versionDir,
      jsonPath,
      type: vj.type || 'release',
      loader: detectLoader(id + ' ' + entry.name, vj.mainClass),
      base: detectBaseVersion(id) || detectBaseVersion(entry.name),
      javaMajor,
      mainClass: vj.mainClass ?? null,
      hasJar: existsSync(jarPath),
      jarPath,
      inheritsFrom: vj.inheritsFrom || null,
      lastPlayed,
      forcedJava: readForcedJava(versionDir),
    })
  }
  // 最常玩的排前面：有 lastPlayed 的按时间倒序，剩下的按名字
  out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.id.localeCompare(b.id))
  return out
}

/** 按 id 或目录名找实例（两者可能不同，且 id 里可能有空格）。 */
export function findVersion(minecraftDir, versionId) {
  const list = listVersions(minecraftDir)
  return list.find((v) => v.id === versionId) || list.find((v) => v.dirName === versionId) || null
}

/**
 * 合并库。顺序按 PCL 的规则（ModMinecraft.vb:457-483）：**子版本的库在前、父的在后**，
 * 同名 maven 坐标的父库直接丢弃（子覆盖父）。Forge/NeoForge 的 BootstrapLauncher 对
 * 这个顺序敏感，别改成「父在前」。
 */
function mergeLibraries(parent, child) {
  const out = []
  const seen = new Set()
  for (const lib of child || []) {
    if (!lib) continue
    if (lib.name) seen.add(lib.name)
    out.push(lib)
  }
  for (const lib of parent || []) {
    if (lib && lib.name && seen.has(lib.name)) continue
    out.push(lib)
  }
  return out
}

function concatArgLists(parent, child) {
  if (!parent && !child) return null
  const a = Array.isArray(parent) ? parent : []
  const b = Array.isArray(child) ? child : []
  return [...a, ...b]
}

/**
 * 递归解析版本 JSON 并合并 inheritsFrom 链。
 * @returns {{ json: object, chain: string[], warnings: string[] }}
 */
export function resolveVersionJson(minecraftDir, versionId, seen = new Set()) {
  const found = findVersion(minecraftDir, versionId)
  if (!found) throw new Error('找不到版本实例: ' + versionId)
  if (seen.has(found.id)) throw new Error('版本继承链出现环: ' + [...seen, found.id].join(' → '))
  seen.add(found.id)

  let vj
  try {
    vj = readJson(found.jsonPath)
  } catch (err) {
    throw new Error('版本 JSON 解析失败 ' + found.jsonPath + ': ' + err.message)
  }

  if (!vj.inheritsFrom) return { json: vj, chain: [found.id], warnings: [] }

  const parent = resolveVersionJson(minecraftDir, vj.inheritsFrom, seen)
  const p = parent.json

  const merged = {
    ...p,
    ...vj,
    // 这几个必须子优先（就算子没写也要继承父）
    id: vj.id || p.id,
    mainClass: vj.mainClass || p.mainClass,
    assetIndex: vj.assetIndex || p.assetIndex,
    assets: vj.assets || p.assets,
    javaVersion: vj.javaVersion || p.javaVersion,
    logging: vj.logging || p.logging,
    type: vj.type || p.type,
    releaseTime: vj.releaseTime || p.releaseTime,
    downloads: { ...(p.downloads || {}), ...(vj.downloads || {}) },
    libraries: mergeLibraries(p.libraries, vj.libraries),
  }
  // 老格式：子没写 arguments 就继承 minecraftArguments
  if (!vj.arguments && vj.minecraftArguments === undefined && p.arguments) merged.arguments = p.arguments
  if (vj.arguments) {
    merged.arguments = {
      game: concatArgLists(p.arguments?.game, vj.arguments.game),
      jvm: concatArgLists(p.arguments?.jvm, vj.arguments.jvm),
    }
  }

  const warnings = [...parent.warnings]
  if (!merged.mainClass) warnings.push('合并后仍没有 mainClass，无法启动')
  return { json: merged, chain: [found.id, ...parent.chain], warnings }
}

/** classpath/库路径用：把 maven 坐标转成 libraries/ 下的相对路径。 */
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

/** 库对象 → libraries/ 下的相对路径（优先 downloads.artifact.path）。 */
export function libraryRelPath(lib) {
  const art = lib?.downloads?.artifact
  if (art?.path) return art.path
  return mavenPathFromName(lib?.name)
}
