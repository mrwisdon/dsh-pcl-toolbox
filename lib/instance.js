/**
 * instance.js —— 实例内容管理 + 崩溃/日志分析（PCL 的「版本设置 / 模组管理 / 崩溃分析」那块的移植）。
 *
 * 只做本地文件操作，不联网，方便单测。四个能力：
 *   1. 内容清点 listContent：mods / resourcepacks / shaderpacks / saves / config / logs / crash-reports
 *   2. 模组启停 toggleMod：`X.jar` ↔ `X.jar.disabled`（PCL 也是这个约定，所以两边互相认）
 *   3. 删除 → 移到实例内的 `.dsh-trash/<时间戳>/`（不硬删，给后悔药）
 *   4. 崩溃分析 analyzeCrash：按已知特征把 crash-report / latest.log 归纳成人能看懂的原因 + 建议
 *
 * 存档信息读的是 level.dat（gzip 包着的 NBT），所以这里带一个**最小 NBT 解析器**，
 * 只为了拿 LevelName / Version.Name / LastPlayed / GameType —— 不值得为它引依赖。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { listZipEntries } from './zip.js'

export const KINDS = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  saves: 'saves',
  config: 'config',
  logs: 'logs',
  crashReports: 'crash-reports',
}

const VALID_KINDS = Object.keys(KINDS)

export function isValidKind(kind) {
  return VALID_KINDS.includes(String(kind))
}

/** 实例根目录：版本隔离 → versions/<id>，否则 .minecraft 根。与 launch.js 的规则保持一致。 */
export function instanceDir(cfg, versionId) {
  if (!versionId) throw new Error('缺少 versionId')
  return cfg.gameDirMode === 'shared'
    ? path.resolve(cfg.minecraftDir)
    : path.resolve(path.join(cfg.minecraftDir, 'versions', versionId))
}

export function kindDir(cfg, versionId, kind) {
  if (!isValidKind(kind)) throw new Error('未知分类 "' + kind + '"（可用: ' + VALID_KINDS.join(', ') + '）')
  return path.join(instanceDir(cfg, versionId), KINDS[kind])
}

// ---------------------------------------------------------------- 最小 NBT 解析（只读 level.dat）
const TAG = {
  end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6,
  byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12,
}
const MAX_DEPTH = 64
const MAX_NODES = 200000

class NbtCursor {
  constructor(buf) {
    this.buf = buf
    this.off = 0
    this.nodes = 0
  }
  need(n) {
    if (this.off + n > this.buf.length) throw new Error('NBT 越界')
  }
  u8() {
    this.need(1)
    return this.buf.readUInt8(this.off++)
  }
  i8() {
    this.need(1)
    return this.buf.readInt8(this.off++)
  }
  i16() {
    this.need(2)
    const v = this.buf.readInt16BE(this.off)
    this.off += 2
    return v
  }
  i32() {
    this.need(4)
    const v = this.buf.readInt32BE(this.off)
    this.off += 4
    return v
  }
  i64() {
    this.need(8)
    const v = this.buf.readBigInt64BE(this.off)
    this.off += 8
    return v
  }
  f32() {
    this.need(4)
    const v = this.buf.readFloatBE(this.off)
    this.off += 4
    return v
  }
  f64() {
    this.need(8)
    const v = this.buf.readDoubleBE(this.off)
    this.off += 8
    return v
  }
  str() {
    const len = this.u16()
    this.need(len)
    const s = this.buf.toString('utf8', this.off, this.off + len)
    this.off += len
    return s
  }
  u16() {
    this.need(2)
    const v = this.buf.readUInt16BE(this.off)
    this.off += 2
    return v
  }
  payload(type, depth) {
    if (depth > MAX_DEPTH) throw new Error('NBT 嵌套过深')
    if (++this.nodes > MAX_NODES) throw new Error('NBT 节点过多')
    switch (type) {
      case TAG.byte: return this.i8()
      case TAG.short: return this.i16()
      case TAG.int: return this.i32()
      case TAG.long: return this.i64()
      case TAG.float: return this.f32()
      case TAG.double: return this.f64()
      case TAG.string: return this.str()
      case TAG.byteArray: {
        const n = this.i32()
        this.need(n)
        this.off += n
        return null
      }
      case TAG.intArray: {
        const n = this.i32()
        this.need(n * 4)
        this.off += n * 4
        return null
      }
      case TAG.longArray: {
        const n = this.i32()
        this.need(n * 8)
        this.off += n * 8
        return null
      }
      case TAG.list: {
        const itemType = this.u8()
        const n = this.i32()
        if (n < 0 || n > MAX_NODES) throw new Error('NBT list 长度异常')
        const out = []
        for (let i = 0; i < n; i += 1) out.push(this.payload(itemType, depth + 1))
        return out
      }
      case TAG.compound: {
        const out = {}
        for (;;) {
          const t = this.u8()
          if (t === TAG.end) return out
          const name = this.str()
          out[name] = this.payload(t, depth + 1)
        }
      }
      default:
        throw new Error('未知 NBT 类型 ' + type)
    }
  }
}

/** 读 level.dat（gzip NBT）→ 存档摘要。坏文件返回 null，绝不抛。 */
export function readLevelDat(file) {
  try {
    const raw = readFileSync(file)
    const buf = zlib.gunzipSync(raw)
    const c = new NbtCursor(buf)
    const rootType = c.u8()
    if (rootType !== TAG.compound) return null
    c.str() // 根名，一般是空串
    const root = c.payload(TAG.compound, 0)
    const data = root?.Data || root?.data || null
    if (!data) return null
    const gameTypes = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' }
    const lastPlayed = Number(data.LastPlayed ?? 0)
    return {
      levelName: typeof data.LevelName === 'string' ? data.LevelName : null,
      versionName: data.Version?.Name ?? null,
      lastPlayed: Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : null,
      gameType: gameTypes[Number(data.GameType ?? -1)] ?? null,
      hardcore: Boolean(data.hardcore),
      // 旧版存档没有 Version.Name，用 StorageVersion 提一下也好
      storageVersion: data.Version?.Snapshot ?? null,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 内容清点
function statOf(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

function dirSize(dir, budget = 40) {
  // 只统计有限深度与条目数，避免 mods 里有超大解压目录时卡住
  let total = 0
  let visited = 0
  const walk = (d, depth) => {
    if (depth > 4 || visited > 20000) return
    let ents = []
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      visited += 1
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else {
        const st = statOf(p)
        if (st) total += st.size
      }
    }
  }
  walk(dir, 0)
  return total
}
void dirSize

function entryOf(fullPath, name, { mods = false, saves = false } = {}) {
  const st = statOf(fullPath)
  if (!st) return null
  const entry = {
    name,
    path: fullPath,
    isDir: st.isDirectory(),
    size: st.isDirectory() ? dirSize(fullPath) : st.size,
    mtime: st.mtimeMs,
    enabled: true,
  }
  if (mods) entry.enabled = !/\.disabled$/i.test(name)
  if (saves && st.isDirectory()) {
    const lv = readLevelDat(path.join(fullPath, 'level.dat'))
    if (lv) {
      const bits = [lv.versionName, lv.gameType].filter(Boolean)
      entry.note = bits.join(' · ') || null
      if (lv.lastPlayed) entry.mtime = lv.lastPlayed
      entry.levelName = lv.levelName
      entry.lastPlayed = lv.lastPlayed
      entry.hardcore = lv.hardcore
    }
  }
  return entry
}

export function listContent(cfg, versionId, kind) {
  const dir = kindDir(cfg, versionId, kind)
  if (!existsSync(dir)) {
    // crash-reports 目录可能还没建，但 JVM 崩溃日志（hs_err_pid*.log）就在实例根目录
    if (kind === 'crashReports') {
      const rootEntries = jvmCrashLogs(cfg, versionId)
      return { dir, entries: rootEntries, exists: rootEntries.length > 0 }
    }
    return { dir, entries: [], exists: false }
  }
  let names = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    throw new Error('读取目录失败 ' + dir + ': ' + err.message)
  }
  const entries = []
  for (const name of names) {
    // 隐藏文件（含我们的 trash 目录）不进列表
    if (name.startsWith('.')) continue
    if (kind === 'logs' && !/\.(log|log\.gz|txt)$/i.test(name)) continue
    if (kind === 'crashReports' && !/\.(txt|log)$/i.test(name)) continue
    const e = entryOf(path.join(dir, name), name, { mods: kind === 'mods', saves: kind === 'saves' })
    if (e) entries.push(e)
  }
  if (kind === 'crashReports') {
    for (const e of jvmCrashLogs(cfg, versionId)) entries.push(e)
  }
  entries.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  return { dir, entries, exists: true }
}

/** 实例根目录里的 hs_err_pid*.log / replay_pid*.log（JVM 自己写的崩溃日志）。 */
function jvmCrashLogs(cfg, versionId) {
  const root = instanceDir(cfg, versionId)
  let names = []
  try {
    names = readdirSync(root).filter((n) => /^(hs_err|replay)_pid\d+\.log$/i.test(n))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const st = statOf(path.join(root, name))
    if (!st) continue
    out.push({ name, path: path.join(root, name), isDir: false, size: st.size, mtime: st.mtimeMs, enabled: true, note: 'JVM 崩溃日志' })
  }
  return out
}

/** 模组启停：`X.jar` ↔ `X.jar.disabled`。返回启用后的条目。 */
export function toggleMod(cfg, versionId, name) {
  const dir = kindDir(cfg, versionId, 'mods')
  const target = path.join(dir, name)
  const st = statOf(target)
  if (!st) throw new Error('文件不存在: ' + name)
  if (st.isDirectory()) throw new Error('目录不能启停: ' + name)
  const disabled = /\.disabled$/i.test(name)
  const nextName = disabled ? name.replace(/\.disabled$/i, '') : name + '.disabled'
  const nextPath = path.join(dir, nextName)
  if (existsSync(nextPath)) throw new Error('目标已存在，无法重命名: ' + nextName)
  renameSync(target, nextPath)
  return entryOf(nextPath, nextName, { mods: true })
}

/** 删除 → 移到 `.dsh-trash/<时间戳>/<kind>/`（可恢复）。 */
export function trashContent(cfg, versionId, kind, name) {
  const dir = kindDir(cfg, versionId, kind)
  const target = path.join(dir, name)
  if (!existsSync(target)) throw new Error('不存在: ' + name)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trashDir = path.join(instanceDir(cfg, versionId), '.dsh-trash', stamp, KINDS[kind])
  mkdirSync(trashDir, { recursive: true })
  const dest = path.join(trashDir, name)
  renameSync(target, dest)
  return { trashedTo: dest }
}

// ---------------------------------------------------------------- 日志 / 崩溃
const LOG_MAX_BYTES = 2 * 1024 * 1024

function readMaybeGz(file) {
  const st = statOf(file)
  if (!st) throw new Error('文件不存在: ' + path.basename(file))
  const raw = readFileSync(file)
  const buf = /\.gz$/i.test(file) ? zlib.gunzipSync(raw) : raw
  const slice = buf.length > LOG_MAX_BYTES ? buf.subarray(buf.length - LOG_MAX_BYTES) : buf
  return { text: slice.toString('utf8'), size: st.size, mtime: st.mtimeMs }
}

export function readLog(cfg, versionId, kind, name, tailLines = 400) {
  const isCrash = kind === 'crashReports'
  const dir = kindDir(cfg, versionId, isCrash ? 'crashReports' : 'logs')
  let file = null
  if (name) {
    file = path.join(dir, name)
    if (!existsSync(file) && isCrash) {
      // hs_err_pid*.log 在实例根目录
      const rootFile = path.join(instanceDir(cfg, versionId), name)
      if (existsSync(rootFile)) file = rootFile
    }
  } else {
    const latest = latestOf(cfg, versionId, kind)
    if (latest) file = latest.path || path.join(dir, latest.name)
  }
  if (!file || !existsSync(file)) throw new Error('没有可读的日志文件')
  const { text, size, mtime } = readMaybeGz(file)
  const lines = text.split(/\r?\n/)
  const max = Math.max(20, Math.min(5000, Number(tailLines) || 400))
  const tail = lines.length > max ? lines.slice(-max).join('\n') : text
  return { name: path.basename(file), size, mtime, text: tail, lines: lines.length }
}

export function latestOf(cfg, versionId, kind) {
  try {
    const { entries } = listContent(cfg, versionId, kind === 'crashReports' ? 'crashReports' : 'logs')
    if (!entries.length) return null
    const top = entries[0]
    return { name: top.name, size: top.size, mtime: top.mtime, path: top.path }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 崩溃分析
/**
 * 特征规则。每条：命中任一正则 → 给一条人话结论 + 建议。
 * 这些模式是从真实 crash-report / latest.log 里最常见的几类来的（与 PCL 的 ModCrash 思路一致：
 * 先归类，再给「改什么」而不是丢一堆堆栈）。
 */
const RULES = [
  {
    re: /java\.lang\.OutOfMemoryError|Failed to allocate a \d+ byte allocation|Direct buffer memory/i,
    severity: 'error',
    title: '内存不足（OOM）',
    suggestion: '把启动内存调大（建议 4096–8192MB），或减少同时启用的模组；32 位 Java 最多只能给到 1.5GB 左右。',
  },
  {
    re: /UnsupportedClassVersionError|class file version (\d+)/i,
    severity: 'error',
    title: 'Java 版本不匹配',
    suggestion: '当前 Java 版本与该 Minecraft/模组版本要求不符：1.18+ 需要 Java 17，1.20.5+ 需要 Java 21，26.x 需要 Java 25。到「启动」页签换一个 Java。',
  },
  {
    re: /java\.lang\.(NoClassDefFoundError|ClassNotFoundException)(?!.*net\.minecraft)/,
    severity: 'error',
    title: '模组缺少类（jar 不完整或前置没装）',
    suggestion:
      '异常类名属于某个模组。三种常见原因：① 这个模组 jar 构建不完整/版本不对；② 它依赖的另一个模组没装；③ 模组与 MC 版本不匹配。' +
      '下方「疑似模组」会告诉你这个类在哪些 jar 里存在——如果哪都不在，就是缺前置；如果在一个 jar 里，多半是那个 jar 坏了。',
  },
  {
    re: /Description: Ticking (?:entity|block entity|block|player)|Exception ticking (?:entity|block entity)/i,
    severity: 'error',
    title: '实体/方块更新时崩溃',
    suggestion: '某个生物或方块模组在自己的 tick 逻辑里出错。看堆栈里第一个非 net.minecraft 的类，属于哪个模组就换/停用哪个。',
  },
  {
    re: /Exception in server tick loop/i,
    severity: 'error',
    title: '服务端 tick 崩溃',
    suggestion: '多人/局域网存档里某个实体或维度模组出错。单人游戏如果也崩，用「新建世界」隔离测试来定位。',
  },
  {
    re: /java\.util\.ConcurrentModificationException/i,
    severity: 'warn',
    title: '集合并发修改（模组 bug）',
    suggestion: '有模组在遍历列表时又改它，通常只在特定时机触发。属于模组自身 bug，更新到最新版或停用它。',
  },
  {
    re: /java\.lang\.(NullPointerException|ArrayIndexOutOfBoundsException|IllegalStateException)/i,
    severity: 'warn',
    title: '模组空指针/越界（模组 bug）',
    suggestion: '看堆栈里第一个非 net.minecraft 的类，定位到模组后更新或停用；这类多是模组 bug，不是配置问题。',
  },
  {
    re: /Duplicate mods|DuplicateModsFoundException|Found a duplicate mod/i,
    severity: 'error',
    title: '模组重复',
    suggestion: 'mods 目录里有同一个模组的多个版本，删掉多余的（列表里按模组名找同名的两个 jar）。',
  },
  {
    re: /NoSuchMethodError|NoSuchFieldError|AbstractMethodError/i,
    severity: 'error',
    title: '模组 API 不匹配',
    suggestion: '某个模组和当前 Minecraft / 加载器版本不兼容，或缺少它依赖的其它模组版本。按堆栈里出现的类名去定位那个模组并换版本。',
  },
  {
    re: /Mixin (apply|transformer)|MixinTransformerError|mixin\.json.*failed|InvalidInjectionException/i,
    severity: 'error',
    title: 'Mixin 注入失败（模组冲突）',
    suggestion: '两个模组改同一个类，或模组版本与 MC 版本不匹配。看堆栈里的 target 类名，停用其中一个模组再试。',
  },
  {
    re: /ModResolutionException|Missing or unsupported mandatory dependencies|requires .* which is missing|fabric-loader.*dependency/i,
    severity: 'error',
    title: '缺少前置模组',
    suggestion: '日志里会写明缺哪个模组/版本区间，按名字把前置模组装进 mods。',
  },
  {
    re: /Pixel format not accelerated|Failed to create (window|GL context)|GLFW error|No OpenGL context|org\.lwjgl\.opengl\.OpenGLException/i,
    severity: 'error',
    title: '显卡/OpenGL 问题',
    suggestion: '更新显卡驱动；双显卡笔记本请在系统里指定用独显跑 javaw；远程桌面/虚拟机里通常没有可用的 OpenGL。',
  },
  {
    re: /EXCEPTION_ACCESS_VIOLATION|EXCEPTION_STACK_OVERFLOW|SIGSEGV|A fatal error has been detected by the Java Runtime/i,
    severity: 'error',
    title: 'JVM 崩溃（本地代码层）',
    suggestion: '多半是显卡驱动、模组的本地库（如光影/优化模组）或内存不足导致。先试关光影、换 Java，再看 hs_err_pid*.log。',
  },
  {
    re: /java\.io\.FileNotFoundException|java\.nio\.file\.NoSuchFileException|The system cannot find the path/i,
    severity: 'warn',
    title: '文件缺失/路径错误',
    suggestion: '有文件被删或路径里有特殊字符（`!`、`;` 这类）。核对日志里提到的具体路径，必要时重装该版本。',
  },
  {
    re: /Could not find or load main class|ClassNotFoundException: net\.minecraft|Unable to access jarfile/i,
    severity: 'error',
    title: '启动文件不完整',
    suggestion: '版本 JSON/客户端 jar 缺失或损坏。到「下载」页签重新下载该版本（会按 sha1 补齐）。',
  },
  {
    re: /The game crashed whilst|Crash report saved to|---- Minecraft Crash Report ----/i,
    severity: 'info',
    title: '检测到崩溃报告',
    suggestion: '这是一份官方崩溃报告，重点看下面 `Caused by` 之后的第一行。',
  },
  {
    re: /failed to load (texture|pack)|Invalid pack format|Resource pack .* failed/i,
    severity: 'warn',
    title: '资源包/光影加载失败',
    suggestion: '该资源包与当前版本不兼容（pack_format 不对），禁用它或换成对应版本的包。',
  },
  {
    re: /Watchdog|Timed out|Server thread stuck|took too long to tick/i,
    severity: 'warn',
    title: '卡顿超时',
    suggestion: '单次 tick 太慢：降低渲染距离/模拟距离，或减少实体类模组。',
  },
]

/**
 * 从 Forge/Fabric 的堆栈标注里抠出 classpath 上的 jar 文件名：
 * 形如 `~[battlefield-0.1.0.jar%23164!/:0.1.0]` → battlefield-0.1.0.jar
 * 取**前 60 行里最早出现的那个**（最靠近异常抛出点的那个模组）。
 */
export function extractSuspectJar(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 80).join('\n')
  const re = /~\[([^\]%!/]+\.jar)(?:%\d+)?!?/g
  let m
  while ((m = re.exec(head))) {
    const name = m[1]
    if (/^(client|server|forge|fabric-loader|minecraft)/i.test(name)) continue
    return name
  }
  return null
}

/** 从 NoClassDefFoundError / ClassNotFoundException 里抠出类名（转成路径形式，便于在 jar 里查）。 */
export function extractMissingClass(text) {
  const m = /(?:NoClassDefFoundError|ClassNotFoundException):\s*([a-zA-Z0-9_.$/]+)/.exec(String(text || ''))
  if (!m) return null
  return m[1].replace(/\./g, '/')
}

function firstCausedBy(text) {
  const m = /Caused by:\s*([^\n\r]{0,220})/.exec(text)
  return m ? m[1].trim() : null
}

function firstErrorLine(text) {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (/Exception|Error|FATAL|crash/i.test(line) && line.trim().length > 12) return line.trim().slice(0, 240)
  }
  return null
}

/** 分析一段崩溃报告/日志文本 → findings。 */
export function analyzeText(text, { maxFindings = 8 } = {}) {
  const findings = []
  const body = String(text || '')
  for (const rule of RULES) {
    const m = rule.re.exec(body)
    if (!m) continue
    // 把命中的那行截出来当 detail，便于用户核对
    let detail = ''
    const idx = body.indexOf(m[0])
    if (idx >= 0) {
      const start = Math.max(0, body.lastIndexOf('\n', idx) + 1)
      const end = body.indexOf('\n', idx)
      detail = body.slice(start, end === -1 ? idx + 160 : end).trim().slice(0, 260)
    }
    findings.push({ severity: rule.severity, title: rule.title, detail: detail || m[0], suggestion: rule.suggestion })
    if (findings.length >= maxFindings) break
  }
  if (!findings.length) {
    const caused = firstCausedBy(body)
    const errLine = firstErrorLine(body)
    findings.push({
      severity: caused || errLine ? 'warn' : 'info',
      title: caused ? '未归类的异常' : '没有识别出已知崩溃特征',
      detail: caused || errLine || '文件里没有明显的 Exception / Error 行。',
      suggestion: caused
        ? '这条 `Caused by` 是根因线索：用它的类名去搜对应的模组或功能。'
        : '如果游戏确实起不来，把最新一份 crash-report 的内容贴出来，或者看 logs/latest.log 最后 100 行。',
    })
  }
  const errors = findings.filter((f) => f.severity === 'error').length
  const warns = findings.filter((f) => f.severity === 'warn').length
  const summary =
    errors > 0
      ? `崩溃原因：${findings.find((f) => f.severity === 'error').title}（${errors} 条错误${warns ? ` / ${warns} 条警告` : ''}）`
      : warns > 0
        ? `发现 ${warns} 条可疑线索`
        : findings.length
          ? '这是一份崩溃报告，但没命中已知特征：重点看 `Caused by` 之后的第一行。'
          : '没有识别出已知崩溃特征'
  return { findings, summary }
}

/**
 * 扫 mods 目录里每个 jar 的条目表，看 classPath 存在哪些 jar 里。
 * 这是「缺前置」和「jar 坏了」的判据：哪都不在 → 缺前置/版本不对；在某个 jar 里 → 那个 jar 没被加载。
 * 只读中央目录，不动文件，几百个 jar 也就几十毫秒。
 */
export function findClassInMods(cfg, versionId, classPath, { maxJars = 400 } = {}) {
  const dir = kindDir(cfg, versionId, 'mods')
  let names = []
  try {
    names = readdirSync(dir)
      .filter((n) => /\.jar(\.disabled)?$/i.test(n))
      .slice(0, maxJars)
  } catch {
    return { scanned: 0, found: [] }
  }
  const want = classPath.endsWith('.class') ? classPath : classPath + '.class'
  const found = []
  let scanned = 0
  for (const name of names) {
    try {
      const entries = listZipEntries(path.join(dir, name))
      scanned += 1
      if (entries.includes(want)) found.push(name)
    } catch {
      /* 坏 jar 跳过，不影响结论 */
    }
  }
  return { scanned, found }
}

/** 分析实例的最新崩溃报告（没有就退回 latest.log）。 */
export function analyzeInstance(cfg, versionId, kind, name) {
  const k = kind === 'crashReports' || kind === 'logs' ? kind : 'crashReports'
  let src = null
  let text = ''
  if (name) {
    const r = readLog(cfg, versionId, k, name, 5000)
    src = { kind: k, name: r.name, size: r.size, mtime: r.mtime }
    text = r.text
  } else {
    const latest = latestOf(cfg, versionId, k)
    if (latest) {
      const r = readLog(cfg, versionId, k, latest.name, 5000)
      src = { kind: k, name: r.name, size: r.size, mtime: r.mtime }
      text = r.text
    } else {
      // 没有崩溃报告就分析 latest.log
      const fallback = latestOf(cfg, versionId, 'logs')
      if (fallback) {
        const r = readLog(cfg, versionId, 'logs', fallback.name, 5000)
        src = { kind: 'logs', name: r.name, size: r.size, mtime: r.mtime }
        text = r.text
      }
    }
  }
  if (!src) return { source: null, findings: [], suspects: null, summary: '这个实例还没有日志或崩溃报告（启动过一次之后才会有）。' }

  const result = analyzeText(text)
  const suspects = enrichSuspects(cfg, versionId, text, result)
  return { source: src, ...result, suspects }
}

/**
 * 把「疑似模组」这一层做出来：
 *   · 从堆栈标注里找最早的第三方 jar（最靠近抛出点）
 *   · 从 NoClassDefFound/ClassNotFound 里取类名，扫 mods 目录看它在哪些 jar 里
 * 然后把结论写进对应 finding 的 suggestion（面板不用改就能看到）。
 */
export function enrichSuspects(cfg, versionId, text, result) {
  const jar = extractSuspectJar(text)
  const missingClass = extractMissingClass(text)
  const suspects = { jar, missingClass: missingClass ? missingClass.replace(/\//g, '.') : null, scannedJars: 0, foundIn: [] }
  let extra = ''
  if (missingClass) {
    const r = findClassInMods(cfg, versionId, missingClass)
    suspects.scannedJars = r.scanned
    suspects.foundIn = r.found
    const cls = suspects.missingClass
    if (r.scanned === 0) {
      extra = `（mods 目录里没有可扫的 jar，无法判断 ${cls} 来自哪里）`
    } else if (r.found.length === 0) {
      extra = `在 ${r.scanned} 个模组 jar 里都没找到 ${cls} —— 说明这个类来自一个**没装的模组**（缺前置），或者版本对不上。`
    } else {
      extra = `${cls} 其实存在于 ${r.found.join('、')} 里 —— 那个 jar 没被正常加载（多半是版本冲突或它自己缺依赖）。`
    }
  }
  if (jar) {
    extra = (extra ? extra + ' ' : '') + `堆栈里最早出现的第三方 jar 是 ${jar}，重点查它。`
  }
  if (extra) {
    for (const f of result.findings) {
      if (f.severity === 'error' && /模组|加载|类/.test(f.title)) {
        f.suggestion = f.suggestion + '\n\n本次诊断：' + extra
        break
      }
    }
    // 没匹配到具体 finding 也要让用户看到
    if (!result.findings.some((f) => f.suggestion.includes('本次诊断'))) {
      result.findings.unshift({ severity: 'info', title: '疑似来源', detail: jar || suspects.missingClass || '', suggestion: extra })
    }
  }
  return { ...suspects, extra }
}

// ---------------------------------------------------------------- 概览
export function summary(cfg, versionId) {
  const counts = {}
  let sizeBytes = 0
  for (const kind of VALID_KINDS) {
    try {
      const { entries } = listContent(cfg, versionId, kind)
      if (kind === 'mods') {
        counts.mods = {
          enabled: entries.filter((e) => e.enabled).length,
          disabled: entries.filter((e) => !e.enabled).length,
        }
      } else {
        counts[kind] = entries.length
      }
      // 只统计体积较大的几个目录，避免把 logs 里的大文件重复算进"实例占用"的直觉里
      if (['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config'].includes(kind)) {
        for (const e of entries) sizeBytes += e.size || 0
      }
    } catch {
      if (kind === 'mods') counts.mods = { enabled: 0, disabled: 0 }
      else counts[kind] = 0
    }
  }
  // 最后游玩：优先看存档里的 LastPlayed，其次 options.txt / 版本 json 的 mtime
  let lastPlayed = null
  try {
    const { entries } = listContent(cfg, versionId, 'saves')
    for (const e of entries) if (e.lastPlayed && (!lastPlayed || e.lastPlayed > lastPlayed)) lastPlayed = e.lastPlayed
  } catch {
    /* 忽略 */
  }
  if (!lastPlayed) {
    const opts = statOf(path.join(instanceDir(cfg, versionId), 'options.txt'))
    if (opts) lastPlayed = opts.mtimeMs
  }
  return {
    versionId,
    gameDir: instanceDir(cfg, versionId),
    counts,
    sizeBytes,
    lastPlayed,
    latestLog: latestOf(cfg, versionId, 'logs'),
    latestCrash: latestOf(cfg, versionId, 'crashReports'),
  }
}
