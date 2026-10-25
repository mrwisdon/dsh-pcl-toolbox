/**
 * inst-routes.js —— 实例管理/诊断的 HTTP 门面（/mc/inst/*）。全部只碰本地文件。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { exportInstance, previewExport } from './export.js'
import { createBackup, deleteBackup, listBackups, listSaves, restoreBackup } from './backup.js'
import { buildShareReport } from './crashshare.js'
import {
  analyzeInstance,
  isValidKind,
  kindDir,
  listContent,
  readLog,
  summary,
  toggleMod,
  trashContent,
} from './instance.js'

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

function openPath(target, { select = false } = {}) {
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' && select ? ['/select,', target] : [target]
  const child = spawn(opener, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return target
}

/**
 * @param {object} o
 * @param {() => object} o.resolveConfig  返回 {minecraftDir, gameDirMode}
 */
export function makeInstanceHandler({ resolveConfig }) {
  return async (req, res) => {
    try {
      const cfg = resolveConfig()
      const url = new URL(req.url || '/', 'http://x')
      const rest = url.pathname.startsWith('/mc/inst') ? url.pathname.slice('/mc/inst'.length) : url.pathname
      const sub = rest.replace(/\/+$/, '') || '/summary'
      const method = (req.method || 'GET').toUpperCase()
      const qp = (k) => url.searchParams.get(k) || undefined

      if (sub === '/summary') {
        const versionId = qp('versionId')
        if (!versionId) return sendJson(res, 400, { ok: false, error: '缺少 versionId' })
        return sendJson(res, 200, { ok: true, ...summary(cfg, versionId) })
      }

      if (sub === '/content') {
        const versionId = qp('versionId')
        const kind = qp('kind') || 'mods'
        if (!versionId) return sendJson(res, 400, { ok: false, error: '缺少 versionId' })
        if (!isValidKind(kind)) return sendJson(res, 400, { ok: false, error: '未知分类: ' + kind })
        const out = listContent(cfg, versionId, kind)
        return sendJson(res, 200, { ok: true, kind, ...out })
      }

      if (sub === '/log') {
        const out = readLog(cfg, qp('versionId'), qp('kind') || 'logs', qp('name'), qp('tail') || 400)
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/toggle' && method === 'POST') {
        const body = await readBody(req)
        const entry = toggleMod(cfg, body?.versionId, String(body?.name || ''))
        return sendJson(res, 200, { ok: true, entry })
      }

      if (sub === '/delete' && method === 'POST') {
        const body = await readBody(req)
        const out = trashContent(cfg, body?.versionId, String(body?.kind || 'mods'), String(body?.name || ''))
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/open' && method === 'POST') {
        const body = await readBody(req)
        const versionId = body?.versionId
        const kind = String(body?.kind || 'mods')
        if (!versionId) return sendJson(res, 400, { ok: false, error: '缺少 versionId' })
        const dir = kindDir(cfg, versionId, kind)
        const name = body?.name ? String(body.name) : null
        if (name) {
          const full = path.join(dir, name)
          if (!existsSync(full)) return sendJson(res, 404, { ok: false, error: '不存在: ' + name })
          const isDir = statSync(full).isDirectory()
          return sendJson(res, 200, { ok: true, path: openPath(full, { select: !isDir }) })
        }
        return sendJson(res, 200, { ok: true, path: openPath(dir) })
      }

      if (sub === '/exportPreview') {
        const instance = qp('instance')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const out = previewExport({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: instance,
          include: qp('include') ? JSON.parse(qp('include')) : undefined,
        })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/export' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const logs = []
        const out = exportInstance({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: instance,
          outPath: body?.outPath ? String(body.outPath) : undefined,
          include: body?.include && typeof body.include === 'object' ? body.include : undefined,
          onLog: (l) => logs.push(String(l).slice(0, 300)),
        })
        return sendJson(res, 200, {
          ok: true,
          instance,
          outPath: out.outPath,
          entries: out.entries,
          bytes: out.bytes,
          compressed: out.compressed,
          manifest: out.manifest,
          skippedCount: out.skippedCount,
          skipped: out.skipped,
          log: logs.slice(-30),
        })
      }

      if (sub === '/saves') {
        const instance = qp('instance')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        return sendJson(res, 200, {
          ok: true,
          instance,
          ...listSaves({ minecraftDir: cfg.minecraftDir, gameDirMode: cfg.gameDirMode, instanceId: instance }),
        })
      }

      if (sub === '/backups') {
        const instance = qp('instance')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        return sendJson(res, 200, {
          ok: true,
          instance,
          ...listBackups({ minecraftDir: cfg.minecraftDir, gameDirMode: cfg.gameDirMode, instanceId: instance }),
        })
      }

      if (sub === '/backup' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const out = createBackup({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: instance,
          save: body?.save ? String(body.save) : undefined,
        })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/restore' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const out = restoreBackup({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: instance,
          backup: String(body?.backup || ''),
          save: body?.save ? String(body.save) : undefined,
        })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/backupDelete' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const out = deleteBackup({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: instance,
          backup: String(body?.backup || ''),
        })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/shareCrash' && method === 'POST') {
        const body = await readBody(req)
        const instance = String(body?.instance || '')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        const out = buildShareReport({
          minecraftDir: cfg.minecraftDir,
          gameDirMode: cfg.gameDirMode,
          instanceId: instance,
          name: body?.name ? String(body.name) : undefined,
        })
        return sendJson(res, 200, { ok: true, instance, ...out })
      }

      if (sub === '/analyze' && method === 'POST') {
        const body = await readBody(req)
        const versionId = body?.versionId
        if (!versionId) return sendJson(res, 400, { ok: false, error: '缺少 versionId' })
        const out = analyzeInstance(cfg, versionId, body?.kind, body?.name)
        return sendJson(res, 200, { ok: true, ...out })
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
