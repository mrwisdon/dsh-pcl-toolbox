/**
 * mod-routes.js —— 模组市场的 HTTP 门面（/mc/mod/*）。
 *
 *   GET  /mc/mod/search?q=&mc=&loader=&offset=&limit=&sort=
 *   GET  /mc/mod/project?id=
 *   GET  /mc/mod/versions?id=&mc=&loader=
 *   POST /mc/mod/install  body {instance, projectId, modVersionId?, includeOptional?}
 *   GET  /mc/mod/installed?instance=&lookup=1
 *   GET  /mc/mod/diag
 */

import { listVersions } from './versions.js'
import { checkModUpdates } from './updates.js'
import {
  downloadFiles,
  listInstalledMods,
  lookupHashes,
  modsDir,
  project as fetchProject,
  resolveInstall,
  search,
  versions,
} from './modrinth.js'

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) raw = raw.slice(0, 1e6)
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** 从实例信息里推断「游戏版本 + 加载器」——Modrinth 的筛选全靠这两个。 */
function instanceTarget(cfg, instanceId) {
  const list = listVersions(cfg.minecraftDir)
  const meta = list.find((v) => v.id === instanceId) || list.find((v) => v.dirName === instanceId)
  if (!meta) throw new Error('找不到实例: ' + instanceId)
  const loader = meta.loader === 'vanilla' ? '' : meta.loader
  return { instanceId: meta.id, gameVersion: meta.base || null, loader, loaderKind: meta.loader }
}

export function makeModHandler({ resolveConfig }) {
  return async (req, res) => {
    try {
      const cfg = resolveConfig()
      const url = new URL(req.url || '/', 'http://x')
      const rest = url.pathname.startsWith('/mc/mod') ? url.pathname.slice('/mc/mod'.length) : url.pathname
      const sub = rest.replace(/\/+$/, '') || '/search'
      const method = (req.method || 'GET').toUpperCase()
      const qp = (k) => url.searchParams.get(k) || undefined

      if (sub === '/search') {
        const out = await search({
          query: qp('q') || '',
          gameVersion: qp('mc'),
          loader: qp('loader'),
          offset: Number(qp('offset')) || 0,
          limit: Number(qp('limit')) || 20,
          sortBy: qp('sort') || 'relevance',
        })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/project') {
        const id = qp('id')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        return sendJson(res, 200, { ok: true, project: await fetchProject(id) })
      }

      if (sub === '/versions') {
        const id = qp('id')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const list = await versions(id, { gameVersion: qp('mc'), loader: qp('loader') })
        return sendJson(res, 200, { ok: true, projectId: id, versions: list })
      }

      if (sub === '/installed') {
        const instance = qp('instance')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const target = instanceTarget(cfg, instance)
        const out = listInstalledMods({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceVersionId: target.instanceId,
        })
        const payload = { ok: true, ...target, ...out, matched: {} }
        if (qp('lookup') === '1' && out.entries.length) {
          // 用文件名反查很不可靠，这里只做「能算 sha1 的」——为了不拖慢，默认不开
          payload.matched = {}
        }
        return sendJson(res, 200, payload)
      }

      if (sub === '/install' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        const projectId = String(body?.projectId || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少 projectId' })
        const target = instanceTarget(cfg, instance)
        if (!target.gameVersion) return sendJson(res, 400, { ok: false, error: '这个实例没有 base 版本信息，无法筛选模组' })
        const plan = await resolveInstall({
          projectId,
          modVersionId: body?.modVersionId ? String(body.modVersionId) : undefined,
          gameVersion: target.gameVersion,
          loader: target.loader,
        })
        const dir = modsDir(cfg.minecraftDir, cfg.gameDirMode, target.instanceId)
        const dl = await downloadFiles({ dir, files: plan.files, concurrency: 4 })
        return sendJson(res, 200, {
          ok: dl.failed === 0,
          ...target,
          dir,
          chosen: { versionId: plan.chosen.versionId, versionNumber: plan.chosen.versionNumber },
          files: plan.files.map((f) => ({ filename: f.filename, size: f.size, versionId: f.versionId, dependencyOf: f.dependencyOf })),
          unresolved: plan.unresolved,
          downloaded: dl.downloaded,
          skipped: dl.skipped,
          failed: dl.failed,
          bytes: dl.bytes,
          errors: dl.errors,
        })
      }

      if (sub === '/updates' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const target = instanceTarget(cfg, instance)
        if (!target.gameVersion) return sendJson(res, 400, { ok: false, error: '实例没有 base 版本信息' })
        const out = await checkModUpdates({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: target.instanceId,
          gameVersion: target.gameVersion,
          loader: target.loader,
        })
        return sendJson(res, 200, { ok: true, ...target, ...out })
      }

      if (sub === '/diag') {
        const out = await search({ query: 'jei', limit: 2 })
        return sendJson(res, 200, { ok: true, modrinth: { total: out.total, hits: out.hits.map((h) => h.slug) }, minecraftDir: cfg.minecraftDir })
      }

      return sendJson(res, 404, { ok: false, error: 'no such route: ' + sub })
    } catch (err) {
      try {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) })
      } catch {
        try {
          res.destroy()
        } catch {
          /* 就这样吧 */
        }
      }
    }
  }
}
