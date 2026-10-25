/**
 * args.js —— 把版本 JSON 翻译成一条可执行的 javaw 命令行。
 *
 * 规则来源：Mojang 版本 JSON 语义 + PCL 2.14 的启动实现（ModLaunch.vb），要点：
 *   · classpath 顺序：库按 JSON 顺序在前，客户端 jar 在最后（Forge 的 BootstrapLauncher 依赖这个顺序）
 *   · 现代版本（1.13+）的 jvm 参数**含 `-cp ${classpath}`**，我们只做替换，不自己再拼一个 -cp
 *   · natives：现代版本是带 `natives-<os>` classifier 的普通 artifact；老版本在 `natives` 映射 +
 *     `downloads.classifiers` 里。两种情况都要「解压到 -Djava.library.path 指向的目录」
 *   · `-Djava.library.path` 的写法各版本不同（本机 26.2 是 `${natives_directory}/java`），
 *     所以解压目标**按实际参数解析**，不写死目录名
 *   · 老版本没有 arguments 时退回 minecraftArguments（按空格切）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveVersionJson, libraryRelPath } from './versions.js'
import { extractZip } from './zip.js'

export const LAUNCHER_NAME = 'dsh-mc-launch'
export const LAUNCHER_VERSION = '0.2.0'

const CLASS_PATH_SEP = process.platform === 'win32' ? ';' : ':'

export function currentPlatform() {
  return {
    osName: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux',
    arch: process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : process.arch,
  }
}

// ---------------------------------------------------------------- rules
function ruleMatches(rule, platform, features) {
  const os = rule.os
  if (os) {
    if (os.name && os.name !== platform.osName) return false
    if (os.arch && os.arch !== platform.arch) return false
  }
  if (rule.features && typeof rule.features === 'object') {
    for (const [k, v] of Object.entries(rule.features)) {
      if (Boolean(features?.[k]) !== Boolean(v)) return false
    }
  }
  return true
}

/** 原版语义：没有 rules = 允许；有 rules 则从 false 起，最后一条命中的 action 说了算。 */
export function rulesAllow(rules, platform = currentPlatform(), features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true
  let ok = false
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue
    if (ruleMatches(r, platform, features)) ok = r.action === 'allow'
  }
  return ok
}

// ---------------------------------------------------------------- 账号
export function offlineUuid(name) {
  const h = createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  const s = h.toString('hex')
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-')
}

export function buildAccount({ username, uuid, accessToken } = {}) {
  const name = String(username || '').trim() || 'Steve'
  const online = Boolean(accessToken)
  return {
    username: name,
    uuid: uuid || (online ? '' : offlineUuid(name)),
    accessToken: accessToken || '0',
    // 离线账号官方的口径就是 legacy + token "0"；填 msa 会让客户端走在线校验
    userType: online ? 'msa' : 'legacy',
    mode: online ? '正版令牌' : '离线',
  }
}

// ---------------------------------------------------------------- natives
function nativeClassifierKey(lib, platform) {
  const natives = lib.natives
  if (!natives || typeof natives !== 'object') return null
  const raw = natives[platform.osName]
  if (!raw) return null
  return String(raw).replace('${arch}', platform.arch === 'x86' ? '32' : '64')
}

/** 现代版本：坐标里带 `:natives-windows` 这种 classifier 的普通 artifact。 */
function isModernNatives(lib, rel) {
  const name = String(lib?.name || '')
  if (/:natives-/.test(name)) return true
  return /(?:^|[-_/])natives-(windows|linux|macos|osx)/i.test(rel || '')
}

// ---------------------------------------------------------------- 主流程
/**
 * @param {object} o
 * @param {string} o.minecraftDir
 * @param {string} o.versionId
 * @param {object} o.java             selectJava() 的结果里的 java 字段（{exe, major, ...}）
 * @param {number} o.memoryMb
 * @param {object} o.account          buildAccount() 的结果
 * @param {'isolated'|'shared'} [o.gameDirMode]
 * @param {string[]} [o.extraJvmArgs]
 * @param {boolean} [o.extractNatives]  默认 true；自检时可关掉
 * @param {string[]} [o.javaNotes]
 */
export function buildLaunchPlan(o) {
  const platform = currentPlatform()
  const features = {} // 全部关闭：不加 --demo / 不自定义分辨率 / 不用 quickPlay
  const warnings = []

  const { json: vj, chain } = resolveVersionJson(o.minecraftDir, o.versionId)
  const versionDir = path.join(o.minecraftDir, 'versions', o.versionId)
  const libDir = path.join(o.minecraftDir, 'libraries')
  const assetsDir = path.join(o.minecraftDir, 'assets')
  const gameDir = o.gameDirMode === 'shared' ? o.minecraftDir : versionDir
  const versionId = vj.id || o.versionId

  // ---- 库：分「上班 classpath 的」和「要解压的 natives」
  const cp = []
  const missing = []
  const nativesJars = []
  let skippedByRule = 0

  for (const lib of vj.libraries || []) {
    if (!rulesAllow(lib.rules, platform, features)) {
      skippedByRule += 1
      continue
    }
    const rel = libraryRelPath(lib)
    if (!rel) continue
    const abs = path.join(libDir, ...rel.split('/'))

    if (isModernNatives(lib, rel)) {
      // 现代 natives：进 classpath（无害，里面只有 dll）+ 解压
      if (existsSync(abs)) {
        cp.push(abs)
        nativesJars.push(abs)
      } else {
        missing.push({ rel: 'libraries/' + rel, kind: 'native' })
      }
      continue
    }

    const legacyKey = nativeClassifierKey(lib, platform)
    if (legacyKey) {
      // 老格式 natives：只解压，不进 classpath（它的 artifact 可能根本不存在）
      const cls = lib.downloads?.classifiers?.[legacyKey]
      const clsRel = cls?.path || null
      if (clsRel) {
        const clsAbs = path.join(libDir, ...clsRel.split('/'))
        if (existsSync(clsAbs)) nativesJars.push(clsAbs)
        else missing.push({ rel: 'libraries/' + clsRel, kind: 'native' })
      }
      continue
    }

    if (existsSync(abs)) cp.push(abs)
    else missing.push({ rel: 'libraries/' + rel, kind: 'library' })
  }

  // ---- 客户端 jar
  // 三档：显式 `jar` 字段（老 Forge/LiteLoader）→ 继承链最底层的原版 → 自己。
  // Fabric/Quilt 的 profile 没有 jar 字段，必须走中间那档，否则会去找 `<自定义实例名>.jar`（不存在）。
  const rootId = chain.length > 1 ? chain[chain.length - 1] : versionId
  const jarId = vj.jar || rootId
  let jarPath = path.join(o.minecraftDir, 'versions', jarId, jarId + '.jar')
  if (!existsSync(jarPath)) {
    const own = path.join(versionDir, versionId + '.jar')
    if (existsSync(own)) jarPath = own
    else {
      jarPath = null
      missing.push({ rel: 'versions/' + jarId + '/' + jarId + '.jar', kind: 'client' })
    }
  }
  if (jarPath) cp.push(jarPath)

  // ---- 资源索引 / 日志配置
  const assetIndexId = vj.assetIndex?.id ?? vj.assets ?? 'legacy'
  const indexFile = path.join(assetsDir, 'indexes', assetIndexId + '.json')
  if (!existsSync(indexFile)) missing.push({ rel: 'assets/indexes/' + assetIndexId + '.json', kind: 'assetsIndex' })

  let loggingLine = null
  const logClient = vj.logging?.client
  if (logClient?.file?.id && logClient.argument) {
    const logFile = path.join(assetsDir, 'log_configs', logClient.file.id)
    if (existsSync(logFile)) loggingLine = String(logClient.argument).replace('${path}', logFile)
    else warnings.push('缺少日志配置 assets/log_configs/' + logClient.file.id + '（不影响启动，只是日志格式退化）')
  }

  // ---- 占位符
  const sub = {
    auth_player_name: o.account.username,
    auth_uuid: o.account.uuid,
    auth_access_token: o.account.accessToken,
    auth_xuid: '',
    clientid: '',
    user_type: o.account.userType,
    user_properties: '{}',
    // PCL 的 `${version_name}` 是「实例夹名」而不是 JSON 里的 id（两者通常相同）
    version_name: path.basename(versionDir),
    version_type: vj.type || 'release',
    game_directory: gameDir,
    assets_root: assetsDir,
    game_assets: path.join(assetsDir, 'virtual', 'legacy'),
    assets_index_name: assetIndexId,
    natives_directory: path.join(versionDir, versionId + '-natives'),
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: cp.join(CLASS_PATH_SEP),
    classpath_separator: CLASS_PATH_SEP,
    library_directory: libDir,
    resolution_width: '854',
    resolution_height: '480',
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
  }
  const subst = (s) => String(s).replace(/\$\{([^}]+)\}/g, (_, k) => (k in sub ? sub[k] : ''))

  const flatten = (list) => {
    const out = []
    for (const a of list || []) {
      if (typeof a === 'string') out.push(subst(a))
      else if (a && Array.isArray(a.value)) {
        if (rulesAllow(a.rules, platform, features)) for (const v of a.value) out.push(subst(v))
      } else if (a && typeof a.value === 'string') {
        if (rulesAllow(a.rules, platform, features)) out.push(subst(a.value))
      }
    }
    return out
  }

  // ---- JVM 参数
  const memoryMb = Number(o.memoryMb) > 0 ? Math.round(Number(o.memoryMb)) : 4096
  const jvm = [`-Xmx${memoryMb}M`, `-Xms${Math.min(1024, memoryMb)}M`]
  // PCL 每次都加这一条（ModLaunch.vb:11）：老版本 log4j 的 lookup 注入开关，无害且更安全
  jvm.push('-Dlog4j2.formatMsgNoLookups=true')
  if (Array.isArray(o.extraJvmArgs)) jvm.push(...o.extraJvmArgs)

  let modern = Boolean(vj.arguments)
  if (modern) {
    jvm.push(...flatten(vj.arguments.jvm))
  } else {
    // 1.13 以前：jvm 参数得自己拼
    jvm.push('-Djava.library.path=' + sub.natives_directory)
    jvm.push('-cp', sub.classpath)
  }
  if (loggingLine) jvm.push(loggingLine)

  // ---- natives 解压目标：按实际生效的 -Djava.library.path 决定
  let libPathArg = null
  for (const a of jvm) {
    const m = /^-Djava\.library\.path=(.*)$/.exec(a)
    if (m) libPathArg = m[1]
  }
  const nativesTarget = libPathArg || sub.natives_directory
  let nativesNote = 'none'
  let nativesResult = null
  if (!nativesJars.length) {
    nativesNote = 'no-natives-required'
  } else if (o.extractNatives === false) {
    nativesNote = 'skipped-by-option'
  } else {
    try {
      nativesResult = ensureNatives(nativesJars, nativesTarget)
      nativesNote = nativesResult.extracted ? 'extracted' : 'cached'
    } catch (err) {
      nativesNote = 'failed'
      warnings.push('natives 解压失败（游戏很可能起不来）: ' + String(err?.message || err))
    }
  }
  if (missing.filter((m) => m.kind === 'native').length) {
    nativesNote = nativesNote === 'no-natives-required' ? 'missing' : nativesNote + '+missing'
  }

  // ---- 游戏参数
  let gameArgs
  if (modern) gameArgs = flatten(vj.arguments.game)
  else gameArgs = String(vj.minecraftArguments || '').split(/\s+/).filter(Boolean).map(subst)

  if (!vj.mainClass) throw new Error('版本 JSON 缺少 mainClass，无法启动: ' + versionId)

  const args = [...jvm, vj.mainClass, ...gameArgs]
  const java = o.java || {}
  if (!java.exe) throw new Error('没有可用的 Java（内部错误：调用方应先用 selectJava）')

  return {
    versionId,
    chain,
    mainClass: vj.mainClass,
    gameDir,
    assetsDir,
    assetIndexId,
    java: { exe: java.exe, major: java.major ?? null, from: java.from || null, version: java.version ?? null },
    memoryMb,
    account: o.account,
    classpathEntries: cp.length,
    classpath: cp,
    nativesDir: nativesTarget,
    nativesNote,
    nativesResult,
    nativesJars: nativesJars.length,
    missing,
    warnings: [...warnings, ...(o.javaNotes || [])],
    command: { exe: java.exe, args, cwd: gameDir },
    commandPreview: buildPreview(java.exe, args),
    stats: { libraries: (vj.libraries || []).length, skippedByRule },
  }
}

/** 把参数拼成一句给人看的命令（accessToken 已打码）。 */
function buildPreview(exe, args) {
  const redacted = args.map((a) => {
    if (/^--accessToken$/i.test(a)) return a
    return a
  })
  const text = [exe, ...redacted].map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ')
  return text.length > 600 ? text.slice(0, 600) + ' …' : text
}

/** 解压 natives jars 到目标目录；内容没变就跳过（用 marker 文件判断）。 */
export function ensureNatives(jars, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const marker = path.join(targetDir, '.dsh-natives.json')
  const sig = jars.map((j) => {
    let size = 0
    try {
      size = statSync(j).size
    } catch {
      /* 忽略 */
    }
    return path.basename(j) + ':' + size
  })
  if (existsSync(marker)) {
    try {
      const prev = JSON.parse(readFileSync(marker, 'utf8'))
      if (Array.isArray(prev.jars) && JSON.stringify(prev.jars) === JSON.stringify(sig)) {
        const files = readdirSync(targetDir).filter((f) => f !== path.basename(marker))
        if (files.length > 0) return { extracted: 0, skipped: 0, bytes: 0, cached: true }
      }
    } catch {
      /* marker 坏了就重解 */
    }
  }
  let extracted = 0
  let skipped = 0
  let bytes = 0
  for (const jar of jars) {
    const r = extractZip(jar, targetDir)
    extracted += r.extracted
    skipped += r.skipped
    bytes += r.bytes
  }
  try {
    writeFileSync(marker, JSON.stringify({ jars: sig, at: Date.now() }, null, 2))
  } catch {
    /* marker 写不进去不影响游戏 */
  }
  return { extracted, skipped, bytes, cached: false }
}
