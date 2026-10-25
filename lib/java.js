/**
 * java.js —— Java 运行时发现与选择。
 *
 * 目标：在「什么都不配」的前提下也能挑到一个能跑目标版本的 Java。
 * 探测顺序（先本地已知、后系统全局）：
 *   1. PCL 给这个实例强制的 Java（versions/<id>/PCL/config.json）
 *   2. .minecraft/runtime/* —— PCL / 官方启动器下载的 Mojang runtime（有 release 文件，最准）
 *   3. %APPDATA%/PCL/config.json 的 JavaList（PCL 自己扫过的结果）
 *   4. 系统常见安装目录（Program Files 下各家 JDK）+ JAVA_HOME + PATH
 *
 * 两个坑：
 *   · 探测版本必须用 java.exe，**javaw.exe 没有控制台输出**，跑 -version 什么都拿不到。
 *   · 版本要求是 major（如 25）。拿 17 去跑 25 的 class 会 UnsupportedClassVersionError，
 *     所以选择规则是「先找 major 相等的；没有就找 major 更大里最小的；都没有就报错」。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PROBE_CACHE = new Map() // exe → { major, version, arch, ok, error }
const PROBE_TTL_MS = 10 * 60 * 1000

function readReleaseFile(dir) {
  const p = path.join(dir, 'release')
  if (!existsSync(p)) return null
  try {
    const text = readFileSync(p, 'utf8')
    const get = (k) => {
      const m = new RegExp('^' + k + '="?([^"\\n]+)"?', 'm').exec(text)
      return m ? m[1].trim() : null
    }
    const version = get('JAVA_VERSION')
    if (!version) return null
    const major = Number(String(version).split('.')[0]) === 1
      ? Number(String(version).split('.')[1]) // 1.8.0_xxx → 8
      : Number(String(version).split('.')[0])
    const archRaw = get('OS_ARCH') || ''
    const arch = archRaw ? (/64/.test(archRaw) || /x86_64|amd64/i.test(archRaw) ? '64' : '32') : null
    return { version, major, arch }
  } catch {
    return null
  }
}

function majorFromPath(p) {
  // jdk-17 / jdk8u372 / jre1.8.0_381 / java-runtime-gamma …
  const m = /(?:jdk|jre|java)[-_]?(\d+)(?:[._](\d+))?/i.exec(p)
  if (!m) return null
  const a = Number(m[1])
  if (a === 1 && m[2]) return Number(m[2])
  return a >= 8 ? a : null
}

/** 跑一次 `java -version` 拿准确版本（只对 java.exe 有效，javaw 无输出）。 */
export function probeJava(exe, { timeoutMs = 6000, force = false } = {}) {
  const hit = PROBE_CACHE.get(exe)
  if (!force && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.info
  const info = { exe, ok: false, major: null, version: null, arch: null, error: null }
  if (!existsSync(exe)) {
    info.error = '文件不存在'
    PROBE_CACHE.set(exe, { at: Date.now(), info })
    return info
  }
  try {
    // Java 8 把版本写到 stderr，9+ 也是 stderr；两路都收
    const out = execFileSync(exe, ['-version'], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const text = String(out || '')
    applyVersionText(info, text.stderr || text.stdout || text)
  } catch (err) {
    const text = String((err && (err.stderr || err.stdout)) || err?.message || '')
    applyVersionText(info, text)
    if (!info.ok) info.error = text.trim().split('\n')[0] || String(err?.message || err)
  }
  PROBE_CACHE.set(exe, { at: Date.now(), info })
  return info
}

function applyVersionText(info, text) {
  const s = String(text || '')
  const m = /version\s+"([^"]+)"/i.exec(s) || /openjdk\s+([\d._]+)/i.exec(s)
  if (!m) return
  const version = m[1]
  const parts = version.split(/[._+-]/)
  const major = Number(parts[0]) === 1 ? Number(parts[1]) : Number(parts[0])
  info.ok = true
  info.version = version
  info.major = Number.isFinite(major) ? major : null
  if (/64-bit|amd64|x86_64/i.test(s)) info.arch = '64'
  else if (/32-bit|x86\b/i.test(s) && !/x86_64/i.test(s)) info.arch = '32'
  else info.arch = null
}

/** 给一个已确定的可执行文件路径，配出同目录的 console 版用于探测。 */
function candidateFromExe(exe, from, extra = {}) {
  const bin = path.dirname(exe)
  const javaExe = path.join(bin, 'java.exe')
  return {
    folder: path.dirname(bin),
    exe,
    probeExe: existsSync(javaExe) ? javaExe : exe,
    major: null,
    version: null,
    arch: null,
    from,
    ...extra,
  }
}

function candidate(folder, from) {
  const java = path.join(folder, 'bin', 'java.exe')
  const javaw = path.join(folder, 'bin', 'javaw.exe')
  if (!existsSync(java) && !existsSync(javaw)) return null
  const rel = readReleaseFile(folder)
  return {
    folder,
    exe: existsSync(javaw) ? javaw : java,
    probeExe: existsSync(java) ? java : javaw,
    major: rel?.major ?? majorFromPath(folder),
    version: rel?.version ?? null,
    arch: rel?.arch ?? null,
    from,
  }
}

function pushCandidate(out, seen, c) {
  if (!c) return
  const key = c.folder.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  out.push(c)
}

/** 扫一遍能找到的所有 Java（不做 -version 探测，靠 release/路径名猜 major）。 */
export function discoverJavas(minecraftDir, { pclConfigDirs = [] } = {}) {
  const out = []
  const seen = new Set()

  // 1) Mojang runtime（PCL / 官方启动器下载的）
  const runtimeRoot = path.join(minecraftDir, 'runtime')
  if (existsSync(runtimeRoot)) {
    for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const c = candidate(path.join(runtimeRoot, entry.name), 'Mojang runtime')
      if (c) pushCandidate(out, seen, { ...c, from: 'Mojang runtime (' + entry.name + ')' })
      // 新版 runtime 是 <name>/<platform>/ 结构
      const nested = path.join(runtimeRoot, entry.name, 'windows-x64')
      if (existsSync(nested)) {
        const c2 = candidate(nested, 'Mojang runtime')
        if (c2) pushCandidate(out, seen, { ...c2, from: 'Mojang runtime (' + entry.name + ')' })
      }
    }
  }

  // 2) PCL 自己的 Java 列表
  for (const dir of pclConfigDirs) {
    const p = path.join(dir, 'config.json')
    if (!existsSync(p)) continue
    try {
      const list = JSON.parse(readFileSync(p, 'utf8'))?.JavaList || []
      for (const j of list) {
        if (!j?.Folder) continue
        const c = candidate(j.Folder.replace(/[\\/]+$/, ''), 'PCL Java 列表')
        if (c) pushCandidate(out, seen, { ...c, from: 'PCL Java 列表', major: j.Version?.Major ?? c.major })
      }
    } catch {
      /* 坏配置跳过 */
    }
  }

  // 3) 系统常见安装目录
  const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean)
  const vendorDirs = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft', 'Semeru']
  for (const pf of programFiles) {
    for (const vendor of vendorDirs) {
      const base = path.join(pf, vendor)
      if (!existsSync(base)) continue
      pushCandidate(out, seen, candidate(base, '系统安装'))
      try {
        for (const sub of readdirSync(base, { withFileTypes: true })) {
          if (sub.isDirectory()) pushCandidate(out, seen, candidate(path.join(base, sub.name), '系统安装'))
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  // Oracle javapath（只是一个转发目录）
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const pf = process.env[key]
    if (!pf) continue
    const jp = path.join(pf, 'Common Files', 'Oracle', 'Java', 'javapath')
    if (existsSync(jp)) {
      const javaw = path.join(jp, 'javaw.exe')
      const java = path.join(jp, 'java.exe')
      if (existsSync(javaw) || existsSync(java)) {
        pushCandidate(out, seen, {
          folder: jp,
          exe: existsSync(javaw) ? javaw : java,
          probeExe: existsSync(java) ? java : javaw,
          major: majorFromPath(jp),
          version: null,
          arch: null,
          from: 'Java 自动更新路径',
        })
      }
    }
  }

  // 4) JAVA_HOME + PATH
  if (process.env.JAVA_HOME) {
    const c = candidate(process.env.JAVA_HOME, 'JAVA_HOME')
    if (c) {
      // JAVA_HOME 可能直接就是 jre 根
      pushCandidate(out, seen, c)
    }
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const javaw = path.join(dir, 'javaw.exe')
    if (existsSync(javaw)) {
      pushCandidate(out, seen, {
        folder: path.dirname(dir),
        exe: javaw,
        probeExe: existsSync(path.join(dir, 'java.exe')) ? path.join(dir, 'java.exe') : javaw,
        major: majorFromPath(dir),
        version: null,
        arch: null,
        from: 'PATH',
      })
    }
  }

  for (const c of out) {
    c.dedupeKey = c.folder.toLowerCase()
    c.arch = c.arch || (c.folder.includes('x86') && !c.folder.includes('x86_64') ? '32' : '64')
  }
  return out
}

/** 探测一个候选的准确版本（结果进缓存）。 */
export function describeJava(c) {
  const p = probeJava(c.probeExe)
  return {
    exe: c.exe,
    folder: c.folder,
    major: p.major ?? c.major,
    version: p.version ?? c.version,
    arch: p.arch ?? c.arch,
    from: c.from,
    ok: p.ok || c.major != null,
    error: p.ok ? null : p.error,
  }
}

/**
 * 选一个 Java。
 * @param {object} opts
 * @param {string} [opts.explicit]      配置文件里写死的 java 路径
 * @param {object} [opts.forced]        PCL 实例强制 Java（{exe,major}）
 * @param {number|null} opts.requiredMajor 版本 JSON 的 javaVersion.majorVersion
 * @param {Array} opts.candidates       discoverJavas() 的结果
 */
export function selectJava({ explicit, forced, requiredMajor, candidates }) {
  const notes = []
  const need = Number.isFinite(requiredMajor) ? requiredMajor : null

  const accept = (c, from) => {
    const d = describeJava(c)
    const majorText = d.major != null ? 'Java ' + d.major : 'Java 版本未知'
    if (need != null && d.major != null && d.major < need) {
      notes.push(`${from}：${majorText} 低于该版本要求的 ${need}，跳过`)
      return null
    }
    if (need != null && d.major != null && d.major > need) {
      notes.push(`${from}：${majorText} 高于要求的 ${need}（能用，但模组可能有兼容问题）`)
    }
    return { java: d, from }
  }

  if (explicit) {
    const e = candidateFromExe(explicit, '配置指定')
    const r = accept(e, '配置指定')
    if (r) return { ...r, notes }
    throw new Error('配置指定的 Java 不满足版本要求（需要 Java ' + need + '）: ' + explicit + '\n' + notes.join('\n'))
  }

  if (forced) {
    // PCL 给的是 javaw.exe（无控制台输出），探测要换成同目录的 java.exe
    const e = candidateFromExe(forced.exe, forced.from, { major: forced.major ?? null })
    const r = accept(e, '实例强制 Java')
    if (r) return { ...r, notes }
  }

  // 先找 major 正好相等的，再找更大里最小的
  const described = candidates.map((c) => ({ c, d: describeJava(c) }))
  const usable = described.filter((x) => x.d.ok || x.d.major != null)
  if (need != null) {
    const exact = usable.filter((x) => x.d.major === need)
    if (exact.length) {
      exact.sort((a, b) => (b.d.arch === '64') - (a.d.arch === '64'))
      return { java: exact[0].d, from: exact[0].d.from, notes }
    }
    const higher = usable.filter((x) => x.d.major > need).sort((a, b) => a.d.major - b.d.major)
    if (higher.length) {
      notes.push(`没有正好 Java ${need} 的，退化用 Java ${higher[0].d.major}`)
      return { java: higher[0].d, from: higher[0].d.from, notes }
    }
    const available = usable.map((x) => x.d.major).filter((m) => m != null)
    throw new Error(
      `这个版本要求 Java ${need}，本机找不到（已发现: ${available.length ? [...new Set(available)].sort((a, b) => a - b).map((m) => 'Java ' + m).join(', ') : '无'}）。` +
        '可以在「版本」页签的「Java 运行时」卡里一键安装（会从 Mojang 下到 .minecraft/runtime/），或手动指定 Java 路径。',
    )
  }

  const fallback = usable.find((x) => x.d.arch === '64') || usable[0]
  if (fallback) return { java: fallback.d, from: fallback.d.from, notes }
  throw new Error('找不到任何可用的 Java（本机没装 JDK / JRE？）')
}
