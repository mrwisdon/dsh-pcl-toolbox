/**
 * modrinth.js —— Modrinth 模组市场（PCL 的「下载 → 模组」那块）。
 *
 * Modrinth 的 v2 API 很简单，难点在**筛选**和**依赖**：
 *   · 搜索用 facets 表达「项目类型 + 游戏版本 + 加载器」三个约束，格式是 JSON 数组再 URL 编码
 *   · 版本列表可以用 game_versions / loaders 查询参数直接过滤
 *   · 版本对象里的 dependencies 只有 project_id + dependency_type（required/optional/...），
 *     要装依赖得拿 project_id 再查一次它的兼容版本 → 这里做成 BFS（默认深度 2，防链式爆炸）
 *
 * 不依赖 BMCLAPI（它不镜像 Modrinth），直连 api.modrinth.com；文件在 cdn.modrinth.com。
 */

import path from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRun } from './download.js'
import { fetchJson } from './http.js'

const API = 'https://api.modrinth.com/v2'
const UA = 'dsh-mc-toolbox/0.1.0 (DeepSeek Harness plugin; local)'

async function api(pathAndQuery) {
  const { json } = await fetchJson(API + pathAndQuery, {
    timeoutMs: 25000,
    headers: { 'user-agent': UA, accept: 'application/json' },
  })
  return json
}

async function apiPost(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) throw new Error(`Modrinth POST ${pathname} HTTP ${res.status}`)
  return res.json()
}

const LOADER_CATEGORIES = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge', quilt: 'quilt' }

function encodeFacets(facets) {
  return encodeURIComponent(JSON.stringify(facets))
}

/** 搜索项目。loader 为空时不加加载器约束（原版）。 */
export async function search({ query = '', gameVersion, loader, limit = 20, offset = 0, sortBy = 'relevance', projectType = 'mod' } = {}) {
  const type = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'].includes(String(projectType)) ? String(projectType) : 'mod'
  const facets = [['project_type:' + type]]
  if (gameVersion) facets.push(['versions:' + gameVersion])
  const cat = LOADER_CATEGORIES[String(loader || '')]
  if (cat) facets.push(['categories:' + cat])
  const lim = Math.max(1, Math.min(50, Number(limit) || 20))
  const off = Math.max(0, Number(offset) || 0)
  const q = new URLSearchParams({
    query: String(query || ''),
    facets: JSON.stringify(facets),
    limit: String(lim),
    offset: String(off),
    index: ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(sortBy) ? sortBy : 'relevance',
  })
  const json = await api('/search?' + q.toString())
  const hits = (json?.hits || []).map((h) => ({
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    follows: h.follows,
    iconUrl: h.icon_url || null,
    categories: h.categories || [],
    versions: (h.versions || []).slice(-3),
    projectType: h.project_type,
  }))
  return { total: json?.total_hits ?? hits.length, offset: off, limit: lim, hits }
}

/** 项目详情（含 body/链接）。 */
export async function project(idOrSlug) {
  const p = await api('/project/' + encodeURIComponent(String(idOrSlug)))
  return {
    projectId: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body || '',
    downloads: p.downloads,
    followers: p.followers,
    iconUrl: p.icon_url || null,
    sourceUrl: p.source_url || null,
    issuesUrl: p.issues_url || null,
    categories: p.categories || [],
    loaders: p.loaders || [],
    gameVersions: p.game_versions || [],
    license: p.license?.id || null,
  }
}

function compactVersion(v) {
  return {
    projectId: v.project_id || null,
    versionId: v.id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    datePublished: v.date_published || null,
    downloads: v.downloads || 0,
    versionType: v.version_type || 'release',
    dependencies: (v.dependencies || []).map((d) => ({
      projectId: d.project_id || null,
      versionId: d.version_id || null,
      dependencyType: d.dependency_type || 'required',
      fileName: d.file_name || null,
    })),
    files: (v.files || []).map((f) => ({
      filename: f.filename,
      url: f.url,
      size: f.size,
      sha1: f.hashes?.sha1 || null,
      sha512: f.hashes?.sha512 || null,
      primary: Boolean(f.primary),
    })),
  }
}

/** 某个项目在指定 MC 版本 + 加载器下的可用版本（新的在前）。 */
export async function versions(projectId, { gameVersion, loader } = {}) {
  const q = new URLSearchParams()
  if (gameVersion) q.set('game_versions', JSON.stringify([gameVersion]))
  const cat = LOADER_CATEGORIES[String(loader || '')]
  if (cat) q.set('loaders', JSON.stringify([cat]))
  const suffix = q.toString() ? '?' + q.toString() : ''
  const list = await api(`/project/${encodeURIComponent(String(projectId))}/version${suffix}`)
  return (Array.isArray(list) ? list : []).map(compactVersion)
}

function pickPrimaryFile(v) {
  const files = v.files || []
  return files.find((f) => f.primary) || files[0] || null
}

/**
 * 解析「装这个项目要下哪些文件」：主文件 + required 依赖（BFS，深度可控）。
 * @returns {{files:Array, unresolved:Array, chosen:object}}
 */
export async function resolveInstall({ projectId, modVersionId, gameVersion, loader, maxDepth = 2 } = {}) {
  const firstList = await versions(projectId, { gameVersion, loader })
  if (!firstList.length) {
    throw new Error(`这个项目在 ${gameVersion || '该版本'} / ${loader || '任意加载器'} 下没有可用版本`)
  }
  const chosen = modVersionId ? firstList.find((v) => v.versionId === modVersionId) || firstList[0] : firstList[0]

  const queue = [{ version: chosen, depth: 0, from: null }]
  const seenProjects = new Set([String(projectId)])
  const files = []
  const unresolved = []

  while (queue.length) {
    const item = queue.shift()
    const file = pickPrimaryFile(item.version)
    if (file) {
      files.push({
        projectId: item.version.projectId || projectId,
        versionId: item.version.versionId,
        filename: file.filename,
        url: file.url,
        size: file.size,
        sha1: file.sha1,
        versionNumber: item.version.versionNumber,
        dependencyOf: item.from,
        depth: item.depth,
      })
    }
    if (item.depth >= maxDepth) continue
    for (const dep of item.version.dependencies) {
      if (dep.dependencyType !== 'required') continue
      const pid = dep.projectId ? String(dep.projectId) : null
      if (!pid || seenProjects.has(pid)) continue
      seenProjects.add(pid)
      try {
        const list = await versions(pid, { gameVersion, loader })
        if (!list.length) {
          unresolved.push({ projectId: pid, reason: 'no-compatible-version' })
          continue
        }
        queue.push({ version: list[0], depth: item.depth + 1, from: item.version.versionId })
      } catch (err) {
        unresolved.push({ projectId: pid, reason: String(err?.message || err).slice(0, 120) })
      }
    }
  }
  return { chosen, files, unresolved }
}

/** 实例的 mods 目录。 */
export function modsDir(minecraftDir, gameDirMode, instanceVersionId) {
  const base = gameDirMode === 'shared' ? minecraftDir : path.join(minecraftDir, 'versions', instanceVersionId)
  return path.join(base, 'mods')
}

/** 列出实例里已装的模组文件。 */
export function listInstalledMods({ minecraftDir, gameDirMode, instanceVersionId }) {
  const dir = modsDir(minecraftDir, gameDirMode, instanceVersionId)
  if (!existsSync(dir)) return { dir, entries: [] }
  const entries = []
  for (const name of readdirSync(dir)) {
    if (!/\.jar(\.disabled)?$/i.test(name)) continue
    const st = statSync(path.join(dir, name))
    entries.push({ name, size: st.size, mtime: st.mtimeMs, disabled: /\.disabled$/i.test(name) })
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  return { dir, entries }
}

/** 把文件下到 mods/（已存在且大小一致就跳过）。 */
export async function downloadFiles({ dir, files, concurrency = 4, onLog }) {
  const out = []
  const plan = []
  for (const f of files) {
    const target = path.join(dir, f.filename)
    let exists = false
    try {
      exists = statSync(target).size === f.size
    } catch {
      exists = false
    }
    if (exists) {
      out.push({ filename: f.filename, skipped: true })
      continue
    }
    plan.push({ rel: f.filename, url: f.url, sources: [f.url], size: f.size, sha1: f.sha1, kind: 'mods' })
  }
  let run = null
  if (plan.length) {
    run = createRun({ dir, files: plan, concurrency, onLog })
    await run.start()
  }
  return {
    downloaded: run ? run.stats.filesDone : 0,
    skipped: out.length,
    failed: run ? run.stats.failed ?? run.stats.filesFailed : 0,
    bytes: run ? run.stats.bytesDone : 0,
    errors: run ? run.stats.errors : [],
  }
}

/** 整合包版本：只保留带 `.mrpack` 文件的版本，可按 MC 版本过滤。 */
export async function packVersions(projectId, { mcVersion } = {}) {
  const list = await versions(projectId, { gameVersion: mcVersion })
  return list
    .map((v) => {
      const mrpack = (v.files || []).find((f) => /\.mrpack$/i.test(f.filename))
      return mrpack ? { ...v, mrpack } : null
    })
    .filter(Boolean)
}

/** 用本地 jar 的 sha1 反查它属于哪个 Modrinth 项目（用于「已装模组」显示名字/更新）。 */
export async function lookupHashes(sha1List) {
  const list = (sha1List || []).filter(Boolean).slice(0, 100)
  if (!list.length) return {}
  try {
    return await apiPost('/version_files', { hashes: list, algorithm: 'sha1' })
  } catch {
    return {}
  }
}
