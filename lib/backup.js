/**
 * backup.js —— 存档备份 / 还原（PCL 的「存档管理」）。
 *
 * 备份落在实例目录的 `.dsh-backups/`（一份一个 zip），包里带 `.dsh-backup.json` 清单。
 * 还原时目标存档已存在就先整目录挪进 `.dsh-trash/<时间戳>/saves/`，再解压 —— 不硬删用户数据。
 * 解压/打包都用自己实现的 zip（lib/zip.js），不依赖系统命令。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { extractZip, readZipEntry, writeZip } from './zip.js'
import { instanceBase } from './export.js'
import { readLevelDat } from './instance.js'

const BACKUP_DIR = '.dsh-backups'
const MANIFEST = '.dsh-backup.json'

function savesRoot(minecraftDir, gameDirMode, instanceId) {
  return path.join(instanceBase(minecraftDir, gameDirMode, instanceId), 'saves')
}
function backupRoot(minecraftDir, gameDirMode, instanceId) {
  return path.join(instanceBase(minecraftDir, gameDirMode, instanceId), BACKUP_DIR)
}

function walkFiles(root, rel, out, budget) {
  let entries = []
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const relPath = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) {
      walkFiles(root, relPath, out, budget)
      continue
    }
    if (!e.isFile()) continue
    let st
    try {
      st = statSync(path.join(root, relPath))
    } catch {
      continue
    }
    if (budget.bytes + st.size > 2 * 1024 * 1024 * 1024) continue
    budget.bytes += st.size
    out.push({ name: relPath, path: path.join(root, relPath), size: st.size })
  }
}

/** 某实例下的存档列表（带 level.dat 摘要：版本 / 模式 / 最后游玩 / 体积）。 */
export function listSaves({ minecraftDir, gameDirMode, instanceId }) {
  const dir = savesRoot(minecraftDir, gameDirMode, instanceId)
  if (!existsSync(dir)) return { dir, saves: [] }
  const saves = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    const lv = readLevelDat(path.join(p, 'level.dat'))
    const files = []
    const budget = { bytes: 0 }
    walkFiles(p, '', files, budget)
    saves.push({
      name: e.name,
      path: p,
      lastPlayed: lv?.lastPlayed || null,
      version: lv?.versionName || null,
      gameType: lv?.gameType || null,
      files: files.length,
      bytes: budget.bytes,
    })
  }
  saves.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name))
  return { dir, saves }
}

/** 已有备份列表（读包里的清单，读不到就给 null）。 */
export function listBackups({ minecraftDir, gameDirMode, instanceId }) {
  const dir = backupRoot(minecraftDir, gameDirMode, instanceId)
  if (!existsSync(dir)) return { dir, backups: [] }
  const backups = []
  for (const name of readdirSync(dir)) {
    if (!/\.zip$/i.test(name)) continue
    const full = path.join(dir, name)
    const st = statSync(full)
    let manifest = null
    try {
      const raw = readZipEntry(full, MANIFEST)
      if (raw) manifest = JSON.parse(raw.toString('utf8'))
    } catch {
      manifest = null
    }
    backups.push({ name, path: full, size: st.size, mtime: st.mtimeMs, manifest })
  }
  backups.sort((a, b) => b.mtime - a.mtime)
  return { dir, backups }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

/**
 * 备份存档。
 * @param {object} o
 * @param {string} [o.save] 只备份这个存档；不传 = 备份全部
 * @returns {{name:string, path:string, entries:number, bytes:number, compressed:number, saves:string[]}}
 */
export function createBackup(o) {
  const savesDir = savesRoot(o.minecraftDir, o.gameDirMode, o.instanceId)
  if (!existsSync(savesDir)) throw new Error('这个实例没有 saves 目录')
  const names = o.save ? [String(o.save)] : readdirSync(savesDir).filter((n) => {
    try {
      return statSync(path.join(savesDir, n)).isDirectory()
    } catch {
      return false
    }
  })
  const picked = names.filter((n) => existsSync(path.join(savesDir, n)))
  if (!picked.length) throw new Error('没有可备份的存档')

  const files = []
  const budget = { bytes: 0 }
  for (const name of picked) walkFiles(savesDir, name, files, budget)
  if (!files.length) throw new Error('存档是空的，没什么可备份')

  const dir = backupRoot(o.minecraftDir, o.gameDirMode, o.instanceId)
  mkdirSync(dir, { recursive: true })
  const base = picked.length === 1 ? safeName(picked[0]) : 'all-saves'
  const name = `${base}-${stamp()}.zip`
  const outPath = path.join(dir, name)
  const manifest = {
    format: 'dsh-mc-toolbox-save-backup/v1',
    instance: o.instanceId,
    saves: picked,
    files: files.length,
    bytes: budget.bytes,
    createdAt: Date.now(),
  }
  const entries = files.map((f) => ({ name: f.name, data: readFileSync(f.path) }))
  entries.push({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  const out = writeZip(outPath, entries)
  return { name, path: outPath, entries: entries.length, bytes: budget.bytes, compressed: out.compressed, saves: picked }
}

/**
 * 从备份还原。目标已存在 → 先挪进 `.dsh-trash/<时间戳>/saves/`（可恢复）。
 * @param {object} o
 * @param {string} o.backup  备份文件名
 * @param {string} [o.save]  只还原包里某个存档（默认全部）
 */
export function restoreBackup(o) {
  const dir = backupRoot(o.minecraftDir, o.gameDirMode, o.instanceId)
  const zipPath = path.join(dir, path.basename(String(o.backup || '')))
  if (!existsSync(zipPath)) throw new Error('备份不存在: ' + o.backup)
  let manifest = null
  try {
    const raw = readZipEntry(zipPath, MANIFEST)
    if (raw) manifest = JSON.parse(raw.toString('utf8'))
  } catch {
    manifest = null
  }
  const savesDir = savesRoot(o.minecraftDir, o.gameDirMode, o.instanceId)
  mkdirSync(savesDir, { recursive: true })

  const saves = (manifest && Array.isArray(manifest.saves) ? manifest.saves : []).filter(Boolean)
  const picked = o.save ? saves.filter((s) => s === String(o.save)) : saves.length ? saves : null
  // 先把要覆盖的存档挪走（trash），保证可恢复
  const trashed = []
  const toMove = picked && picked.length ? picked : saves.length ? [] : []
  for (const name of toMove) {
    const target = path.join(savesDir, name)
    if (!existsSync(target)) continue
    const trashDir = path.join(instanceBase(o.minecraftDir, o.gameDirMode, o.instanceId), '.dsh-trash', stamp(), 'saves')
    mkdirSync(trashDir, { recursive: true })
    renameSync(target, path.join(trashDir, name))
    trashed.push({ name, movedTo: path.join(trashDir, name) })
  }

  // 解压目标：还原单个存档时，剥掉 `<存档名>/` 前缀后要落回 `saves/<存档名>/` 里，
  // 不能直接铺到 saves/ 根上（第一版就栽在这：文件全散在 saves/level.dat）。
  const stripPrefix = picked && picked.length === 1 ? picked[0] + '/' : ''
  const extractTo = stripPrefix ? path.join(savesDir, picked[0]) : savesDir
  mkdirSync(extractTo, { recursive: true })
  const r = extractZip(zipPath, extractTo, {
    stripPrefix,
    skipPrefixes: ['META-INF/', MANIFEST, 'modrinth.index.json'],
  })
  return {
    backup: path.basename(zipPath),
    restored: r.extracted,
    trashed,
    saves: saves.length ? saves : null,
    note: stripPrefix ? '已还原到 ' + extractTo : '已还原全部存档（原目录已移到回收站）',
  }
}

export function deleteBackup({ minecraftDir, gameDirMode, instanceId, backup }) {
  const dir = backupRoot(minecraftDir, gameDirMode, instanceId)
  const p = path.join(dir, path.basename(String(backup || '')))
  if (!existsSync(p)) throw new Error('备份不存在: ' + backup)
  unlinkSync(p)
  return { deleted: path.basename(p) }
}
