/**
 * updates.js —— 模组更新检查（用 Modrinth 的 sha1 反查 + 版本对比）。
 *
 * 思路：
 *   1. 把实例 mods/ 里每个 jar 的 sha1 打包 POST 到 Modrinth `/version_files`
 *      → 得到「这个文件是哪个项目、哪个版本」
 *   2. 对命中的项目查一次「当前 MC 版本 + 加载器」下的最新版本
 *   3. 版本号不同（且日期更新）就标记可更新，并给出新文件信息
 * 非 Modrinth 来源的模组（国内站点/自建）不会被匹配到 —— 如实回报 unmatched。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { lookupHashes, versions as modrinthVersions } from './modrinth.js'
import { modsDir } from './modrinth.js'

function sha1File(p) {
  return createHash('sha1').update(readFileSync(p)).digest('hex')
}

/**
 * @param {object} o
 * @param {string} o.minecraftDir
 * @param {'isolated'|'shared'} o.gameDirMode
 * @param {string} o.instanceId
 * @param {string} o.gameVersion
 * @param {string} [o.loader]
 * @param {number} [o.maxFiles] 安全上限（默认 200）
 */
export async function checkModUpdates(o) {
  const dir = modsDir(o.minecraftDir, o.gameDirMode, o.instanceId)
  if (!existsSync(dir)) return { dir, checked: 0, matched: 0, updates: [], unmatched: [], errors: [] }
  const names = readdirSync(dir).filter((n) => /\.jar$/i.test(n)).slice(0, Number(o.maxFiles) || 200)
  const hashes = []
  const byHash = new Map()
  const errors = []
  for (const name of names) {
    try {
      const h = sha1File(path.join(dir, name))
      hashes.push(h)
      byHash.set(h, name)
    } catch (err) {
      errors.push({ file: name, error: String(err?.message || err).slice(0, 120) })
    }
  }
  if (!hashes.length) return { dir, checked: 0, matched: 0, updates: [], unmatched: [], errors }

  const lookup = await lookupHashes(hashes)
  const rows = []
  const unmatched = []
  for (const h of hashes) {
    const file = byHash.get(h)
    const hit = lookup && lookup[h]
    if (!hit || !hit.project_id) {
      unmatched.push({ file })
      continue
    }
    rows.push({
      file,
      sha1: h,
      projectId: hit.project_id,
      currentVersionId: hit.id,
      currentVersionNumber: hit.version_number,
      currentDate: hit.date_published || null,
    })
  }

  const updates = []
  for (const row of rows) {
    try {
      const list = await modrinthVersions(row.projectId, { gameVersion: o.gameVersion, loader: o.loader })
      const latest = list[0] // 接口按日期倒序
      if (!latest) {
        updates.push({ ...row, status: 'no-compatible-version', latestVersionNumber: null })
        continue
      }
      const isNewer = latest.versionId !== row.currentVersionId
      updates.push({
        ...row,
        status: isNewer ? 'update-available' : 'up-to-date',
        latestVersionId: latest.versionId,
        latestVersionNumber: latest.versionNumber,
        latestDate: latest.datePublished,
        latestFile: (latest.files || []).find((f) => f.primary) || (latest.files || [])[0] || null,
        downloadCount: latest.downloads || 0,
      })
    } catch (err) {
      updates.push({ ...row, status: 'error', error: String(err?.message || err).slice(0, 160) })
    }
  }
  updates.sort((a, b) => (a.status === b.status ? 0 : a.status === 'update-available' ? -1 : 1))
  return {
    dir,
    checked: names.length,
    matched: rows.length,
    updates,
    unmatched,
    errors,
    summary: {
      checked: names.length,
      matched: rows.length,
      updatable: updates.filter((u) => u.status === 'update-available').length,
      upToDate: updates.filter((u) => u.status === 'up-to-date').length,
      unknown: unmatched.length + updates.filter((u) => u.status !== 'update-available' && u.status !== 'up-to-date').length,
    },
  }
}
