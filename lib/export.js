/**
 * export.js —— 把实例导出成 zip（PCL 的「版本设置 → 导出整合包」）。
 *
 * 默认导出「能复刻这个实例所需的最小集合」：mods / config / defaultconfigs / options.txt / servers.dat。
 * resourcepacks / shaderpacks / saves 默认不导出（体积大且是个人数据），可按需打开。
 *
 * 不导出：logs、crash-reports、natives、.dsh-trash、libraries、assets（都由加载器/原版提供）。
 * 额外写一个 dsh-export.json 清单，记录来源实例、MC 版本、加载器、包含哪些分类，便于以后重装/对比。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { writeZip } from './zip.js'
import { resolveVersionJson, listVersions } from './versions.js'

const DEFAULT_INCLUDE = {
  mods: true,
  config: true,
  defaultconfigs: true,
  resourcepacks: false,
  shaderpacks: false,
  saves: false,
}
const SINGLE_FILES = ['options.txt', 'servers.dat', 'servers.dat_old']
const SKIP_DIRS = new Set(['logs', 'crash-reports', '.dsh-trash', 'natives', 'libraries', 'assets', 'downloads', 'codex-backups'])
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024

export function instanceBase(minecraftDir, gameDirMode, instanceId) {
  return gameDirMode === 'shared' ? path.resolve(minecraftDir) : path.resolve(path.join(minecraftDir, 'versions', instanceId))
}

function walk(root, rel, out, budget) {
  let names = []
  try {
    names = readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of names) {
    const relPath = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(root, relPath, out, budget)
      continue
    }
    if (!e.isFile()) continue
    let st
    try {
      st = statSync(path.join(root, relPath))
    } catch {
      continue
    }
    if (st.size > MAX_FILE_BYTES) {
      budget.skipped.push({ path: relPath, reason: 'too-large', size: st.size })
      continue
    }
    if (budget.bytes + st.size > MAX_TOTAL_BYTES) {
      budget.skipped.push({ path: relPath, reason: 'total-cap', size: st.size })
      continue
    }
    budget.bytes += st.size
    out.push({ name: relPath, path: path.join(root, relPath), size: st.size })
  }
}

/** 预览：这个实例导出会包含多少文件、多大（不写盘）。 */
export function previewExport({ minecraftDir, gameDirMode, instanceId, include }) {
  const root = instanceBase(minecraftDir, gameDirMode, instanceId)
  if (!existsSync(root)) throw new Error('实例目录不存在: ' + root)
  const inc = Object.assign({}, DEFAULT_INCLUDE, include || {})
  const budget = { bytes: 0, skipped: [] }
  const files = []
  const counts = {}
  for (const key of Object.keys(inc)) {
    if (!inc[key]) continue
    const dir = path.join(root, key)
    if (!existsSync(dir)) {
      counts[key] = 0
      continue
    }
    const before = files.length
    walk(root, key, files, budget)
    counts[key] = files.length - before
  }
  for (const name of SINGLE_FILES) {
    const p = path.join(root, name)
    if (!existsSync(p)) continue
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    budget.bytes += st.size
    files.push({ name, path: p, size: st.size })
  }
  return { instanceId, root, include: inc, files: files.length, bytes: budget.bytes, counts, skipped: budget.skipped.length }
}

/**
 * 导出成 zip。
 * @param {object} o
 * @param {string} o.minecraftDir
 * @param {'isolated'|'shared'} o.gameDirMode
 * @param {string} o.instanceId
 * @param {string} [o.outPath]   默认放到实例目录里
 * @param {object} [o.include]   覆盖 DEFAULT_INCLUDE
 * @param {(l:string)=>void} [o.onLog]
 */
export function exportInstance(o) {
  const log = o.onLog || (() => {})
  const root = instanceBase(o.minecraftDir, o.gameDirMode, o.instanceId)
  if (!existsSync(root)) throw new Error('实例目录不存在: ' + root)
  const inc = Object.assign({}, DEFAULT_INCLUDE, o.include || {})

  let minecraft = null
  let loader = null
  try {
    const meta = listVersions(o.minecraftDir).find((v) => v.id === o.instanceId)
    minecraft = meta?.base || null
    loader = meta?.loader || null
    if (!minecraft) {
      const resolved = resolveVersionJson(o.minecraftDir, o.instanceId)
      minecraft = resolved.chain.length > 1 ? resolved.chain[resolved.chain.length - 1] : null
    }
  } catch {
    /* 元数据读不到不影响导出 */
  }

  const budget = { bytes: 0, skipped: [] }
  const files = []
  const counts = {}
  for (const key of Object.keys(inc)) {
    if (!inc[key]) continue
    if (!existsSync(path.join(root, key))) {
      counts[key] = 0
      continue
    }
    const before = files.length
    walk(root, key, files, budget)
    counts[key] = files.length - before
    log(`${key}: ${counts[key]} 个文件`)
  }
  for (const name of SINGLE_FILES) {
    const p = path.join(root, name)
    if (!existsSync(p)) continue
    try {
      const st = statSync(p)
      budget.bytes += st.size
      files.push({ name, path: p, size: st.size })
    } catch {
      /* 跳过 */
    }
  }
  if (!files.length) throw new Error('没有可导出的内容（mods/config 都是空的？）')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = o.outPath
    ? path.resolve(o.outPath)
    : path.join(root, `${o.instanceId}-export-${stamp}.zip`)
  mkdirSync(path.dirname(outPath), { recursive: true })

  const manifest = {
    format: 'dsh-mc-toolbox-export/v1',
    instance: o.instanceId,
    minecraft,
    loader,
    include: inc,
    counts,
    files: files.length,
    bytes: budget.bytes,
    exportedAt: Date.now(),
    note: '解压后按同名目录覆盖即可还原 mods/config/options；libraries 与 assets 由启动器负责。',
  }
  const entries = files.map((f) => ({ name: f.name, data: readFileSync(f.path) }))
  entries.push({ name: 'dsh-export.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  log(`写入 ${entries.length} 个条目 → ${outPath}`)
  const out = writeZip(outPath, entries)
  log(`完成：${entries.length} 个条目 / ${(budget.bytes / 1048576).toFixed(1)} MB → ${(out.compressed / 1048576).toFixed(1)} MB zip`)
  return { ...out, outPath, manifest, skipped: budget.skipped.slice(0, 20), skippedCount: budget.skipped.length }
}

/** 把实例里的 mods 清单写成文本（便于贴到别处/对比）。 */
export function modsListText(minecraftDir, gameDirMode, instanceId) {
  const root = instanceBase(minecraftDir, gameDirMode, instanceId)
  const modsDir = path.join(root, 'mods')
  if (!existsSync(modsDir)) return ''
  const lines = []
  for (const name of readdirSync(modsDir).sort()) {
    if (!/\.jar(\.disabled)?$/i.test(name)) continue
    let size = 0
    try {
      size = statSync(path.join(modsDir, name)).size
    } catch {
      /* 跳过 */
    }
    lines.push(`${name}\t${size}`)
  }
  return lines.join('\n')
}

export { DEFAULT_INCLUDE }
