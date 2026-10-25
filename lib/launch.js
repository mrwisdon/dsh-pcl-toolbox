/**
 * launch.js —— 配置 + 启动计划 + 进程/状态/日志 + 目录操作。
 *
 * 与 DSH / Cordis 解耦（只依赖 node 内置模块），可以单独跑：
 *     node scripts/selftest.mjs          # 只算不跑（含 4 个真实实例）
 *     node scripts/selftest.mjs --run    # 真跑一次
 *
 * 进程管理沿用上一版验证过的做法（这里都是血泪）：
 *   · spawn 用 detached + stdio 直连文件描述符 → 宿主重启不会掐断游戏输出
 *   · isAlive 里 EPERM 必须当成「活着」：Windows 上对无权访问的进程 kill(0) 抛 EPERM
 *   · 停进程用 taskkill /T /F：Java 会派生子进程，只杀父进程会留孤儿
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildAccount, buildLaunchPlan } from './args.js'
import { discoverJavas, selectJava } from './java.js'
import { listVersions } from './versions.js'
import { LEGACY_CLIENT_ID, describeAccount, ensureFreshAccount } from './msa.js'
import { checkGamePath, noteLaunch } from './precheck.js'

export const STATE_DIR = '.mc-launch'
const CONFIG_FILE = 'mc-launch.config.json'
const LEGACY_CONFIG_FILE = 'pcl-launch.config.json'

const DEFAULTS = {
  minecraftDir: '%APPDATA%\\.minecraft',
  memoryMb: 4096,
  username: '',
  uuid: '',
  accessToken: '', // 非空 = 正版令牌模式
  java: '', // 空 = 自动按版本要求挑
  gameDirMode: 'isolated', // isolated=版本隔离（PCL 默认） / shared=.minecraft 根
  extraJvmArgs: [],
  selectedVersion: '',
  // ── 下载页签（原「MC 下载」插件合并进来）
  downloadDir: '', // 空 = 跟 minecraftDir 走（下完就能直接启动）
  downloadConcurrency: 16,
  downloadMirror: '', // 空 = 默认 BMCLAPI
  downloadSourcePreference: 'mirror-first', // mirror-first | official-first | mirror-only
  // ── 正版登录（Microsoft Account）
  msClientId: '', // 空 = 用公共 Live Connect id 走授权码流程；填自己的 Entra client id 才能用设备码
  msFlow: 'auth-code', // auth-code | device-code
}

export function pluginRootFromLib() {
  let dir = path.dirname(new URL(import.meta.url).pathname)
  if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1) // /C:/... → C:/...
  return path.resolve(decodeURIComponent(dir), '..')
}

export function expandEnv(s) {
  return String(s).replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '')
}

export function defaultConfig() {
  return { ...DEFAULTS, minecraftDir: expandEnv(DEFAULTS.minecraftDir) || fallbackMinecraftDir() }
}

/** %APPDATA% 不存在时（例如在 WSL 里跑）给一个能用的默认值。 */
function fallbackMinecraftDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, '.minecraft')
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return home ? path.join(home, '.minecraft') : '.minecraft'
}

export function loadConfig(root) {
  const cfg = defaultConfig()
  const readInto = (file, legacy) => {
    const p = path.join(root, file)
    if (!existsSync(p)) return
    let user
    try {
      user = JSON.parse(readFileSync(p, 'utf8'))
    } catch (err) {
      throw new Error(file + ' 解析失败: ' + err.message)
    }
    if (!user || typeof user !== 'object') return
    for (const [k, v] of Object.entries(user)) {
      if (k in DEFAULTS) cfg[k] = v
    }
    // 旧版配置迁移：versionId → selectedVersion
    if (legacy && typeof user.versionId === 'string' && !cfg.selectedVersion) cfg.selectedVersion = user.versionId
  }
  readInto(LEGACY_CONFIG_FILE, true) // 先套旧配置
  readInto(CONFIG_FILE, false) // 新配置覆盖
  const expanded = expandEnv(String(cfg.minecraftDir || ''))
  cfg.minecraftDir = path.isAbsolute(expanded) ? expanded : path.resolve(fallbackMinecraftDir())
  cfg.memoryMb = Math.max(256, Math.min(32768, Number(cfg.memoryMb) || 4096))
  if (!['isolated', 'shared'].includes(cfg.gameDirMode)) cfg.gameDirMode = 'isolated'
  if (!Array.isArray(cfg.extraJvmArgs)) cfg.extraJvmArgs = []
  cfg.downloadConcurrency = Math.max(1, Math.min(32, Number(cfg.downloadConcurrency) || 16))
  if (!['mirror-first', 'official-first', 'mirror-only'].includes(cfg.downloadSourcePreference)) {
    cfg.downloadSourcePreference = 'mirror-first'
  }
  cfg.msFlow = cfg.msFlow === 'device-code' ? 'device-code' : 'auth-code'
  return cfg
}

export function saveConfig(root, patch) {
  const cur = loadConfig(root)
  const next = { ...cur, ...(patch || {}) }
  const out = {}
  for (const k of Object.keys(DEFAULTS)) out[k] = next[k]
  writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(out, null, 2), 'utf8')
  return out
}

export function javaCandidates(cfg) {
  const pclDirs = [path.join(process.env.APPDATA || '', 'PCL')]
  return discoverJavas(cfg.minecraftDir, { pclConfigDirs: pclDirs })
}

/** 版本的摘要列表（带缺失统计）。plan 结果按 JSON mtime 缓存 45 秒。 */
const SUMMARY_CACHE = new Map()

export function describeVersions(cfg, { force = false } = {}) {
  const cands = javaCandidates(cfg)
  const list = listVersions(cfg.minecraftDir)
  return list.map((v) => {
    const key = v.id + '|' + v.jsonPath
    const hit = SUMMARY_CACHE.get(key)
    if (!force && hit && Date.now() - hit.at < 45000) return hit.summary
    let summary = {
      id: v.id,
      type: v.type,
      loader: v.loader,
      base: v.base,
      javaMajor: v.javaMajor,
      hasJar: v.hasJar,
      jsonPath: v.jsonPath,
      gameDir: cfg.gameDirMode === 'shared' ? cfg.minecraftDir : v.dir,
      lastPlayed: v.lastPlayed,
      missingCount: null,
      error: null,
    }
    try {
      const sel = selectJava({
        explicit: cfg.java || undefined,
        forced: v.forcedJava,
        requiredMajor: v.javaMajor,
        candidates: cands,
      })
      const plan = buildLaunchPlan({
        minecraftDir: cfg.minecraftDir,
        versionId: v.id,
        java: sel.java,
        memoryMb: cfg.memoryMb,
        account: buildAccount(cfg),
        gameDirMode: cfg.gameDirMode,
        extraJvmArgs: cfg.extraJvmArgs,
        extractNatives: false, // 列表只统计，不动磁盘
      })
      summary = { ...summary, missingCount: plan.missing.length, java: plan.java, error: null }
    } catch (err) {
      summary = { ...summary, missingCount: null, error: String(err?.message || err) }
    }
    SUMMARY_CACHE.set(key, { at: Date.now(), summary })
    return summary
  })
}

export function invalidateVersions() {
  SUMMARY_CACHE.clear()
}

/** 生成启动计划（不改磁盘，除非 extractNatives）。 */
export function resolvePlan(cfg, opts = {}) {
  const versionId = opts.versionId || cfg.selectedVersion || listVersions(cfg.minecraftDir)[0]?.id
  if (!versionId) throw new Error('没有可启动的版本（versions/ 目录里没东西？）')
  const list = listVersions(cfg.minecraftDir)
  const meta = list.find((v) => v.id === versionId) || list.find((v) => v.dirName === versionId)
  if (!meta) throw new Error('找不到版本: ' + versionId)

  const cands = javaCandidates(cfg)
  const sel = selectJava({
    explicit: opts.java || cfg.java || undefined,
    forced: meta.forcedJava,
    requiredMajor: meta.javaVersion ?? meta.javaMajor ?? null,
    candidates: cands,
  })
  const memoryMb = Math.max(256, Math.min(32768, Number(opts.memoryMb) || cfg.memoryMb))
  // 正版登录时由调用方传进来一个已构造好的 account（含真实 uuid/name）
  const account = opts.account || buildAccount({ ...cfg, ...opts })

  const plan = buildLaunchPlan({
    minecraftDir: cfg.minecraftDir,
    versionId: meta.id,
    java: sel.java,
    memoryMb,
    account,
    gameDirMode: opts.gameDirMode || cfg.gameDirMode,
    extraJvmArgs: cfg.extraJvmArgs,
    extractNatives: opts.extractNatives !== false,
    javaNotes: sel.notes,
  })
  plan.javaRequired = meta.javaMajor ?? null
  plan.versionMeta = { loader: meta.loader, base: meta.base, type: meta.type, chain: plan.chain }
  return plan
}

// ---------------------------------------------------------------- 进程
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // 存活但无权限 = EPERM，也是活着；只有 ESRCH 才是真死了
    return Boolean(err && err.code === 'EPERM')
  }
}

export function stateFile(root) {
  return path.join(root, STATE_DIR, 'state.json')
}
export function readState(root) {
  try {
    return JSON.parse(readFileSync(stateFile(root), 'utf8'))
  } catch {
    return {}
  }
}
function writeState(root, s) {
  const f = stateFile(root)
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(s, null, 2))
}

/** 从日志尾巴里判断「是不是真的起来了」——用来区分「进程活着」和「游戏起来了」。 */
const BOOT_MARKERS = [
  { re: /Backend library: LWJGL/i, label: 'LWJGL' },
  { re: /Setting user:/i, label: '账号注入' },
  { re: /OpenAL initialized|Sound engine started/i, label: '声音' },
  { re: /Narrator library for x64 successfully loaded/i, label: 'Narrator' },
]
export function detectBoot(logTail) {
  const text = String(logTail || '')
  const hit = BOOT_MARKERS.filter((m) => m.re.test(text)).map((m) => m.label)
  const failed = /---- Minecraft Crash Report ----|A fatal error has been detected by the Java Runtime|Exception in thread "main"|NoClassDefFoundError|UnsupportedClassVersionError/.test(text)
  return { booted: hit.length >= 2, markers: hit, crashed: failed }
}

export async function launch(cfg, opts, root) {
  const mode = opts?.accountMode === 'online' ? 'online' : 'offline'
  let resolvedOpts = { ...opts }
  if (mode === 'online') {
    let online = null
    try {
      online = await ensureFreshAccount(root, String(cfg.msClientId || '').trim() || LEGACY_CLIENT_ID)
    } catch (err) {
      throw new Error('正版账号刷新失败：' + String(err?.human || err?.message || err))
    }
    if (!online) throw new Error('还没有登录正版账号（面板里点「微软登录」）。')
    resolvedOpts = { ...resolvedOpts, accessToken: online.accessToken, uuid: online.uuid, username: online.name }
  }
  const plan = resolvePlan(cfg, resolvedOpts)
  // PCL 的 McLaunchPrecheck 等价：路径里带 ! 或 ; 直接拒绝（会让 classpath 解析炸掉）
  checkGamePath(plan.gameDir)
  checkGamePath(plan.command.exe)
  const prev = readState(root)
  if (prev.running && isAlive(prev.pid)) throw new Error('已经在跑（pid ' + prev.pid + '），先停止')

  if (plan.missing.length) {
    const list = plan.missing.slice(0, 8).map((m) => '  · [' + m.kind + '] ' + m.rel).join('\n')
    throw new Error('这个版本还缺 ' + plan.missing.length + ' 个文件，启动必定崩：\n' + list + '\n先用「MC 下载」把版本补齐。')
  }

  const stateDir = path.join(root, STATE_DIR)
  const logDir = path.join(stateDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logDir, 'launch-' + stamp + '.log')
  const fd = openSync(logPath, 'a')
  writeFileSync(
    logPath,
    '### version: ' + plan.versionId + '\n### cwd: ' + plan.command.cwd + '\n### exe: ' + plan.command.exe + '\n### args:\n' +
      plan.command.args.map((a) => '  ' + a).join('\n') + '\n\n',
  )

  const child = spawn(plan.command.exe, plan.command.args, {
    cwd: plan.command.cwd,
    detached: true,
    windowsHide: false,
    stdio: ['ignore', fd, fd],
  })
  child.unref()

  const st = {
    running: true,
    pid: child.pid,
    startedAt: Date.now(),
    versionId: plan.versionId,
    logPath,
    exitCode: null,
    stoppedByUser: false,
    lastError: null,
    meta: {
      versionId: plan.versionId,
      accountMode: mode,
      mainClass: plan.mainClass,
      java: plan.java.exe,
      javaFrom: plan.java.from,
      javaMajor: plan.java.major,
      account: plan.account.mode + ' / ' + plan.account.username,
      memoryMb: plan.memoryMb,
      classpathEntries: plan.classpathEntries,
      nativesDir: plan.nativesDir,
      nativesNote: plan.nativesNote,
      gameDir: plan.gameDir,
      missingCount: plan.missing.length,
    },
  }
  writeState(root, st)

  // 结束时要和**磁盘上的**状态合并：stop() 会在另一个对象上写 stoppedByUser，
  // 直接用内存里的 st 覆盖会把「用户手动停止」这个事实丢掉（第一版就是这么错的）。
  const finish = (patch) => {
    let cur = {}
    try {
      cur = readState(root)
    } catch {
      cur = {}
    }
    const next = { ...st, ...cur, ...patch, running: false }
    next.exitCode = cur.stoppedByUser ? null : (patch.exitCode ?? cur.exitCode ?? null)
    next.stoppedAt = Date.now()
    writeState(root, next)
  }
  child.on('error', (err) => {
    finish({ lastError: String((err && err.message) || err) })
  })
  child.on('exit', (code) => {
    finish({ exitCode: code })
  })
  // 启动计数 + 正版/赞助劝导（正版登录后不再劝买）
  let advice = { launches: 0, hints: [] }
  try {
    advice = noteLaunch(root, { onlineLegit: mode === 'online' })
  } catch {
    /* 统计写不进去不影响启动 */
  }
  return {
    ok: true,
    ...st,
    meta: st.meta,
    plan: { commandPreview: plan.commandPreview, nativesNote: plan.nativesNote },
    advice,
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
    if (r.status !== 0 && isAlive(pid)) return { ok: false, reason: String(r.stderr || r.stdout || 'taskkill 失败').trim() }
    return { ok: true }
  }
  try {
    process.kill(pid, 'SIGTERM')
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  }
}

export function stop(root) {
  const st = readState(root)
  if (!st.pid || !isAlive(st.pid)) return { ok: false, reason: '没有在跑的进程' }
  const r = killTree(st.pid)
  if (r.ok) {
    st.running = false
    st.stoppedByUser = true
    st.stoppedAt = Date.now()
    writeState(root, st)
  }
  return { ...r, pid: st.pid }
}

/**
 * 取日志的头部 + 尾部各最多 256KB 用于启动判定。
 * 为什么不能只看尾巴：启动标记（`Setting user` / `Backend library: LWJGL`）出现在日志很靠前的位置，
 * 模组包一开就是几十万行，4000 字符的尾巴早就把它们冲掉了 —— 实测就是这样把「已经起来了」误判成没起来。
 */
function readHeadTail(file, headBytes = 262144, tailBytes = 262144) {
  try {
    if (!file || !existsSync(file)) return ''
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      if (size <= headBytes + tailBytes) return readFileSync(file, 'utf8')
      const head = Buffer.allocUnsafe(headBytes)
      readSync(fd, head, 0, headBytes, 0)
      const tail = Buffer.allocUnsafe(tailBytes)
      readSync(fd, tail, 0, tailBytes, size - tailBytes)
      return head.toString('utf8') + '\n...[中间省略]...\n' + tail.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function tailFile(file, max = 4000) {
  try {
    if (!file || !existsSync(file)) return ''
    const size = statSync(file).size
    const raw = readFileSync(file, 'utf8')
    return raw.length > max ? raw.slice(-max) : raw
  } catch {
    return ''
  }
}

export function status(root) {
  const st = readState(root)
  const alive = Boolean(st.pid) && isAlive(st.pid)
  const logTail = tailFile(st.logPath)
  const boot = detectBoot(readHeadTail(st.logPath))
  return {
    ...st,
    running: Boolean(st.running) && alive,
    alive,
    logTail,
    boot,
  }
}

// ---------------------------------------------------------------- 目录
const SUBDIRS = {
  root: '.',
  mods: 'mods',
  config: 'config',
  defaultconfigs: 'defaultconfigs',
  saves: 'saves',
  logs: 'logs',
  crashReports: 'crash-reports',
  resourcepacks: 'resourcepacks',
  screenshots: 'screenshots',
}

export function instancePaths(cfg, versionId) {
  const id = versionId || cfg.selectedVersion
  const base = cfg.gameDirMode === 'shared' ? cfg.minecraftDir : path.join(cfg.minecraftDir, 'versions', id || '')
  const out = {}
  for (const key of Object.keys(SUBDIRS)) {
    const rel = SUBDIRS[key]
    const abs = rel === '.' ? base : path.join(base, rel)
    out[key] = { path: abs, exists: existsSync(abs) }
  }
  return out
}

export function resolveDirTarget(target, cfg, versionId) {
  const key = String(target || 'root')
  const rel = SUBDIRS[key]
  if (rel === undefined) throw new Error('未知目录 "' + key + '"（可用: ' + Object.keys(SUBDIRS).join(', ') + '）')
  const id = versionId || cfg.selectedVersion
  const base = path.resolve(cfg.gameDirMode === 'shared' ? cfg.minecraftDir : path.join(cfg.minecraftDir, 'versions', id || ''))
  const abs = rel === '.' ? base : path.resolve(path.join(base, rel))
  const inside = path.relative(base, abs)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('拒绝越界路径: ' + abs)
  if (!existsSync(abs)) throw new Error('目录不存在: ' + abs)
  return abs
}

export function openDir(target, cfg, versionId) {
  const abs = resolveDirTarget(target, cfg, versionId)
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [abs], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return { ok: true, target: String(target || 'root'), path: abs }
}
