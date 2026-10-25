/**
 * crashshare.js —— 把崩溃报告整理成「可安全贴到别处」的脱敏摘要（PCL 的崩溃分析 + 分享）。
 *
 * 脱敏原则（宁多勿少）：
 *   · Windows / Unix 用户目录 → <USER_PATH>
 *   · 玩家名（`Setting user: xxx`）→ <PLAYER>
 *   · UUID（含无连字符的 32 位）→ <UUID>
 *   · 令牌（Bearer / accessToken= / 长 base64）→ <TOKEN>
 *   · IPv4 / IPv6 → <IP>
 *   · 服务器地址（servers.dat 里的）不会进报告，这里只处理文本
 * 保留：异常类型、堆栈里的类名/模组 jar 名、Java/OS/显卡信息、崩溃摘要与建议 —— 这些是排障必需的。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { analyzeText, extractMissingClass, extractSuspectJar, instanceDir, latestOf, readLog } from './instance.js'

const RULES = [
  { re: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/g, to: '<USER_PATH>' },
  { re: /[A-Za-z]:[\\/]+Documents and Settings[\\/]+[^\\/\s"']+/g, to: '<USER_PATH>' },
  { re: /\/(?:home|Users)\/[^\s/"']+/g, to: '<USER_PATH>' },
  { re: /(Setting user:\s*)([^\r\n]+)/g, to: '$1<PLAYER>' },
  { re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, to: '<UUID>' },
  // 无连字符的 UUID（32 位 hex）
  { re: /\b[0-9a-fA-F]{32}\b/g, to: '<UUID>' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, to: 'Bearer <TOKEN>' },
  { re: /(--accessToken\s+)("?)[^\s"']+/g, to: '$1$2<TOKEN>' },
  { re: /\b[A-Za-z0-9._~+/=-]{80,}={0,2}\b/g, to: '<TOKEN>' },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, to: '<IP>' },
  // IPv6：必须含 hex 字母或 '::'，否则会把 `23:27:38` 这种时间当地址误伤
  { re: /\b(?=[0-9a-fA-F:]*[a-fA-F])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, to: '<IP>' },
  { re: /\b(?:[0-9a-fA-F]{1,4}:)+:(?:[0-9a-fA-F]{1,4})?\b/g, to: '<IP>' },
]

/** 对一段文本做脱敏，返回 {text, counts}。 */
export function redact(text) {
  const counts = {}
  let out = String(text || '')
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      const label = String(rule.to).replace(/\$\d/g, '')
      counts[label] = (counts[label] || 0) + 1
      const suffix = typeof args[args.length - 2] === 'string' ? '' : ''
      void suffix
      // 支持 $1 形式（保留前缀，比如 "Setting user: "）
      if (rule.to.includes('$1')) {
        const m = args
        return String(rule.to).replace('$1', m[1] || '').replace('$2', m[2] || '')
      }
      return rule.to
    })
  }
  return { text: out, counts }
}

/** 从崩溃报告里抠几条「环境」信息（不依赖完整解析）。 */
function environmentOf(text) {
  const s = String(text || '')
  const g = (re) => {
    const m = re.exec(s)
    return m ? m[1].trim() : null
  }
  return {
    os: g(/(?:OS|Operating System):\s*([^\r\n]+)/i),
    javaVersion: g(/(?:Java Version|java\.version)[:=]\s*([^\r\n,]+)/i),
    javaVm: g(/(?:Java VM Version|java\.vm\.name)[:=]\s*([^\r\n]+)/i),
    memory: g(/(?:Memory|jvm\.args)[:=]\s*([^\r\n]+)/i),
    gpu: g(/(?:Graphics|GL info)[:=]\s*([^\r\n]+)/i),
    crashTime: g(/(?:Time|Date):\s*([^\r\n]+)/i),
    description: g(/Description:\s*([^\r\n]+)/i),
  }
}

/** 取前 N 行「有信息量」的堆栈（异常行 + at 行），跳过 log4j XML 噪音。 */
function keyStack(text, maxLines = 24) {
  const lines = String(text || '').split(/\r?\n/)
  const picked = []
  let started = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^(---- Minecraft Crash Report|Description:|java\.|Caused by:|Exception|Error|\s*at )/i.test(raw) || /---- Minecraft Crash Report ----/.test(raw)) {
      started = true
    }
    if (!started) continue
    if (/^<log4j:Event|^\s*<log4j:Message|^\s*<\/log4j:/.test(line)) continue
    picked.push(line.slice(0, 400))
    if (picked.length >= maxLines) break
  }
  return picked.join('\n')
}

/**
 * 生成脱敏报告。
 * @param {object} o
 * @param {string} o.minecraftDir
 * @param {'isolated'|'shared'} o.gameDirMode
 * @param {string} o.instanceId
 * @param {string} [o.name]  读哪个崩溃/日志文件；不传走最新
 * @returns {{file:string, markdown:string, counts:object, findings:Array, source:object}}
 */
export function buildShareReport(o) {
  const cfg = { minecraftDir: o.minecraftDir, gameDirMode: o.gameDirMode }
  const kind = 'crashReports'
  const latest = o.name ? { name: o.name } : latestOf(cfg, o.instanceId, kind)
  const src = latest && latest.name ? latest.name : null
  if (!src) throw new Error('这个实例还没有崩溃报告（crash-reports/ 是空的）')
  const raw = readLog(cfg, o.instanceId, kind, src, 4000)

  const analysis = analyzeText(raw.text)
  const suspects = {
    jar: extractSuspectJar(raw.text),
    missingClass: extractMissingClass(raw.text)?.replace(/\//g, '.') || null,
  }
  const env = environmentOf(raw.text)
  const { text: safeStack, counts } = redact(keyStack(raw.text))

  const lines = []
  lines.push('# 崩溃报告（已脱敏）')
  lines.push('')
  lines.push('> 由 DSH「MC 工具箱」自动整理：用户目录/玩家名/UUID/令牌/IP 已替换；类名与模组名保留以便排障。')
  lines.push('')
  lines.push('## 概要')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 实例 | ${o.instanceId} |`)
  if (env.crashTime) lines.push(`| 崩溃时间 | ${redact(env.crashTime).text} |`)
  if (env.description) lines.push(`| 崩溃类型 | ${redact(env.description).text} |`)
  lines.push(`| 崩溃文件 | ${src} |`)
  if (env.os) lines.push(`| 系统 | ${redact(env.os).text} |`)
  if (env.javaVersion) lines.push(`| Java | ${redact(env.javaVersion).text} |`)
  if (env.javaVm) lines.push(`| JVM | ${redact(env.javaVm).text} |`)
  if (env.gpu) lines.push(`| 显卡 | ${redact(env.gpu).text} |`)
  lines.push('')
  lines.push('## 诊断')
  lines.push('')
  lines.push(analysis.summary || '（没有识别出已知特征）')
  lines.push('')
  for (const f of analysis.findings || []) {
    lines.push(`- **${f.severity === 'error' ? '错误' : f.severity === 'warn' ? '警告' : '线索'}**：${f.title}`)
    if (f.detail) lines.push(`  - 依据：\`${redact(f.detail).text.slice(0, 240)}\``)
    if (f.suggestion) lines.push(`  - 建议：${f.suggestion.replace(/\n+/g, ' ')}`)
  }
  if (suspects.jar) lines.push(`- 疑似模组：\`${suspects.jar}\``)
  if (suspects.missingClass) lines.push(`- 缺失类：\`${suspects.missingClass}\``)
  lines.push('')
  lines.push('## 关键堆栈（脱敏后）')
  lines.push('')
  lines.push('```')
  lines.push(safeStack || '（没有提取到堆栈）')
  lines.push('```')
  lines.push('')
  lines.push(`<!-- redacted: ${Object.entries(counts).map(([k, v]) => k + '×' + v).join(', ') || 'nothing'} -->`)

  const markdown = lines.join('\n')
  const dir = path.join(instanceDir(cfg, o.instanceId), '.dsh-crash-share')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(dir, `crash-share-${stamp}.md`)
  writeFileSync(file, markdown, 'utf8')
  return { file, markdown, counts, findings: analysis.findings || [], summary: analysis.summary, source: { name: src, size: raw.size, mtime: raw.mtime }, suspects }
}
