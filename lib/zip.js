/**
 * zip.js —— 最小 ZIP/JAR 读取器（只做「把 natives jar 里的文件解出来」这一件事）。
 *
 * 为什么不用依赖：这是个要装进用户 profile 的插件，装机时不该因为多一个包而变脆。
 * natives jar 只用 stored(0) 和 deflate(8) 两种压缩方式，ZIP 的中央目录结构也足够简单。
 *
 * 为什么不调 PowerShell Expand-Archive：它要求 .zip 后缀（得先复制改名），
 * 行为还受系统区域/安全策略影响。自己解 100 行，完全可控。
 */

import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

function readAt(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length)
  readSync(fd, buf, 0, length, offset)
  return buf
}

function findEocd(fd, fileSize) {
  const maxBack = Math.min(fileSize, 0xffff + 22)
  if (maxBack < 22) return null
  const buf = readAt(fd, fileSize - maxBack, maxBack)
  for (let i = maxBack - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return { entryCount: buf.readUInt16LE(i + 10), centralOffset: buf.readUInt32LE(i + 16) }
    }
  }
  return null
}

function* walkEntries(zipPath) {
  const fd = openSync(zipPath, 'r')
  try {
    const fileSize = fstatSync(fd).size
    const eocd = findEocd(fd, fileSize)
    if (!eocd) throw new Error('不是有效的 ZIP（找不到 EOCD）: ' + zipPath)
    let offset = eocd.centralOffset
    for (let i = 0; i < eocd.entryCount; i += 1) {
      const head = readAt(fd, offset, 46)
      if (head.readUInt32LE(0) !== CENTRAL_SIG) return
      const method = head.readUInt16LE(10)
      const compSize = head.readUInt32LE(20)
      const nameLen = head.readUInt16LE(28)
      const extraLen = head.readUInt16LE(30)
      const commentLen = head.readUInt16LE(32)
      const localOffset = head.readUInt32LE(42)
      const name = readAt(fd, offset + 46, nameLen).toString('utf8')
      offset += 46 + nameLen + extraLen + commentLen
      yield { fd, name, method, compSize, localOffset }
    }
  } finally {
    closeSync(fd)
  }
}

/** 列出 zip 里的条目名（不解压）。 */
export function listZipEntries(zipPath) {
  const names = []
  for (const e of walkEntries(zipPath)) names.push(e.name)
  return names
}

/**
 * 解压 zip 到目录（跳过目录项与 META-INF）。
 * @returns {{extracted:number, skipped:number, bytes:number}}
 */
/** 读 zip 里单个条目的内容（用于 modrinth.index.json / pack.mcmeta 这种小文件）。 */
export function readZipEntry(zipPath, entryName) {
  const want = String(entryName)
  for (const e of walkEntries(zipPath)) {
    if (e.name !== want) continue
    const local = readAt(e.fd, e.localOffset, 30)
    if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Error('ZIP 条目头损坏: ' + want)
    const dataOffset = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    const raw = e.compSize > 0 ? readAt(e.fd, dataOffset, e.compSize) : Buffer.alloc(0)
    if (e.method === 0) return raw
    if (e.method === 8) return inflateRawSync(raw)
    throw new Error('不支持的压缩方式 ' + e.method + ': ' + want)
  }
  return null
}

/**
 * 解压 zip 到目录。
 * @param {object} [opts]
 * @param {string[]} [opts.skipPrefixes]  跳过这些前缀（默认 META-INF/）
 * @param {string} [opts.stripPrefix]     解压时剥掉的路径前缀（如 'overrides/'）
 */
export function extractZip(zipPath, targetDir, { skipPrefixes = ['META-INF/'], stripPrefix = '' } = {}) {
  const root = path.resolve(targetDir)
  mkdirSync(root, { recursive: true })
  let extracted = 0
  let skipped = 0
  let bytes = 0

  for (const e of walkEntries(zipPath)) {
    if (e.name.endsWith('/') || skipPrefixes.some((p) => e.name.startsWith(p))) {
      skipped += 1
      continue
    }
    let name = e.name
    if (stripPrefix) {
      // 只要这个前缀下的内容：别的条目按原名解开会在实例目录里制造出游离的 overrides/ 目录
      if (!name.startsWith(stripPrefix)) {
        skipped += 1
        continue
      }
      name = name.slice(stripPrefix.length)
    }
    if (!name) {
      skipped += 1 // 就是 stripPrefix 那个目录项本身
      continue
    }
    const outPath = path.resolve(root, name)
    const rel = path.relative(root, outPath)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      skipped += 1 // 目录穿越，拒绝
      continue
    }
    const local = readAt(e.fd, e.localOffset, 30)
    if (local.readUInt32LE(0) !== LOCAL_SIG) {
      skipped += 1
      continue
    }
    const dataOffset = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    const raw = e.compSize > 0 ? readAt(e.fd, dataOffset, e.compSize) : Buffer.alloc(0)
    let out
    if (e.method === 0) out = raw
    else if (e.method === 8) out = inflateRawSync(raw)
    else {
      skipped += 1
      continue
    }
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, out)
    extracted += 1
    bytes += out.length
  }
  return { extracted, skipped, bytes }
}


// ---------------------------------------------------------------- 写侧（导出用）
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 标准 CRC32（自己实现，避免依赖 node 版本是否提供 zlib.crc32）。 */
export function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function dosDateTime(d) {
  const date = d || new Date()
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time: time & 0xffff, date: day & 0xffff }
}

/**
 * 把一组文件写成 ZIP（deflate；压不小就 stored）。
 * @param {string} zipPath
 * @param {Array<{name:string, data:Buffer}>} entries
 * @returns {{path:string, entries:number, bytes:number, compressed:number}}
 */
export function writeZip(zipPath, entries) {
  const chunks = []
  const central = []
  let offset = 0
  let rawBytes = 0
  const { time, date } = dosDateTime(new Date())

  for (const entry of entries || []) {
    const name = String(entry.name).replace(/\\/g, '/')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '')
    rawBytes += data.length
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    let body = data
    let method = 0
    if (data.length > 64) {
      const deflated = deflateRawSync(data, { level: 6 })
      if (deflated.length < data.length) {
        body = deflated
        method = 8
      }
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 flag
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, body)

    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(method, 10)
    head.writeUInt16LE(time, 12)
    head.writeUInt16LE(date, 14)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(body.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(nameBuf.length, 28)
    head.writeUInt16LE(0, 30)
    head.writeUInt16LE(0, 32)
    head.writeUInt16LE(0, 34)
    head.writeUInt16LE(0, 36)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(offset, 42)
    central.push(head, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralStart = offset
  let centralSize = 0
  for (const c of central) centralSize += c.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)

  const buf = Buffer.concat([...chunks, ...central, eocd])
  writeFileSync(zipPath, buf)
  let size = buf.length
  try {
    size = statSync(zipPath).size
  } catch {
    /* 忽略 */
  }
  return { path: zipPath, entries: entries.length, bytes: rawBytes, compressed: size }
}
