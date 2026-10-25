/**
 * pack-routes.js —— 整合包（.mrpack）的 HTTP 门面（/mc/pack/*）。
 *
 *   GET  /mc/pack/list?mc=&q=            搜整合包（Modrinth project_type:modpack）
 *   POST /mc/pack/versions  {projectId, mcVersion?}   该整合包有哪些 .mrpack 版本
 *   POST /mc/pack/inspect   {path}                    本地 .mrpack 预览
 *   POST /mc/pack/install   {source:'modrinth'|'local', projectId?, versionId?, mcVersion?, path?, name?}
 *   GET  /mc/pack/state                               安装进度
 *   GET  /mc/pack/marker?instance=                    实例是不是整合包、来自哪个包
 */

import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeJava, discoverJavas, selectJava } from './java.js'
import { inspectPack, installPack, readPackMarker } from './modpack.js'
import { packVersions, search } from './modrinth.js'
import { resolveVersionJson } from './versions.js'

const S = { task: null, seq: 0 }
const LOG_MAX = 300

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

function pushLog(task, line) {
  task.log.push(String(line).slice(0, 400))
  if (task.log.length > LOG_MAX) task.log.splice(0, LOG_MAX)
}

function isRunning() {
  return Boolean(S.task && ['downloading', 'loader', 'files', 'overrides', 'planning'].includes(S.task.phase))
}

function snapshot() {
  const t = S.task
  if (!t) return { ok: true, task: null }
  const st = t.stats || null
  return {
    ok: true,
    task: {
      id: t.id,
      name: t.name || null,
      phase: t.phase,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt ?? null,
      filesTotal: st ? st.filesTotal : 0,
      filesDone: st ? st.filesDone : 0,
      bytesTotal: st ? st.bytesTotal : 0,
      bytesDone: st ? st.bytesDone : 0,
      speedBps: st ? st.speedBps : 0,
      summary: t.summary || null,
      log: t.log.slice(-60),
      error: t.error ?? null,
    },
  }
}

function consoleJava(exe) {
  if (!exe) return exe
  const java = path.join(path.dirname(exe), 'java.exe')
  return existsSync(java) ? java : exe
}

function pickJavaFor(minecraftDir, mcVersion) {
  let major = null
  try {
    major = resolveVersionJson(minecraftDir, mcVersion).json.javaVersion?.majorVersion ?? null
  } catch {
    major = null
  }
  const cands = discoverJavas(minecraftDir, { pclConfigDirs: [path.join(process.env.APPDATA || '', 'PCL')] })
  const sel = selectJava({ requiredMajor: major, candidates: cands })
  describeJava({ folder: path.dirname(path.dirname(sel.java.exe)), exe: sel.java.exe, probeExe: sel.java.exe, from: sel.from })
  return { exe: consoleJava(sel.java.exe), major: sel.java.major ?? major, from: sel.from }
}

async function downloadTo(url, destDir, filename) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`下载整合包失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const file = path.join(destDir, filename)
  const fs = await import('node:fs')
  fs.writeFileSync(file, buf)
  return file
}

function startInstall({ minecraftDir, mirror, body }) {
  if (isRunning()) {
    const err = new Error('已有整合包任务在跑')
    err.code = 'BUSY'
    throw err
  }
  const task = { id: `p${++S.seq}`, phase: 'planning', startedAt: Date.now(), finishedAt: null, log: [], stats: null, summary: null, error: null, name: body?.name || null }
  S.task = task
  ;(async () => {
    let tmp = null
    try {
      let mrpackPath = null
      if (String(body?.source || '') === 'local') {
        mrpackPath = String(body?.path || '')
        if (!mrpackPath || !existsSync(mrpackPath)) throw new Error('本地整合包不存在: ' + mrpackPath)
        pushLog(task, '使用本地整合包 ' + mrpackPath)
      } else {
        const projectId = String(body?.projectId || '')
        if (!projectId) throw new Error('缺少 projectId')
        task.phase = 'downloading'
        const list = await packVersions(projectId, { mcVersion: body?.mcVersion ? String(body.mcVersion) : undefined })
        if (!list.length) throw new Error('这个整合包没有' + (body?.mcVersion ? '适配 ' + body.mcVersion + ' 的' : '') + ' .mrpack 版本')
        const chosen = body?.versionId ? list.find((v) => v.versionId === String(body.versionId)) || list[0] : list[0]
        task.name = chosen.name || task.name
        pushLog(task, `选中整合包版本 ${chosen.versionNumber}（${chosen.mrpack.filename}）`)
        tmp = mkdtempSync(path.join(os.tmpdir(), 'mc-pack-'))
        mrpackPath = await downloadTo(chosen.mrpack.url, tmp, chosen.mrpack.filename)
        pushLog(task, `已下载 .mrpack（${(chosen.mrpack.size / 1048576).toFixed(1)} MB）`)
      }

      const inspected = inspectPack(mrpackPath)
      pushLog(task, `整合包 ${inspected.name} · MC ${inspected.minecraft} · ${inspected.loader ? inspected.loader.type + ' ' + inspected.loader.version : '原版'} · ${inspected.fileCount} 个文件 · ${(inspected.bytes / 1048576).toFixed(1)} MB`)

      let javaExe = null
      if (inspected.loader && (inspected.loader.type === 'forge' || inspected.loader.type === 'neoforge')) {
        const j = pickJavaFor(minecraftDir, inspected.minecraft)
        javaExe = j.exe
        pushLog(task, `用 Java ${j.major}（${j.from}）跑 installer`)
      }

      task.phase = 'files'
      const summary = await installPack({
        mrpackPath,
        minecraftDir,
        mirror,
        name: body?.name ? String(body.name) : undefined,
        javaExe,
        onLog: (l) => pushLog(task, l),
        onProgress: (p) => {
          if (p && p.phase) task.phase = p.phase === 'files' ? 'files' : p.phase
        },
      })
      task.summary = summary
      task.phase = summary.ok ? 'done' : 'error'
      if (!summary.ok) task.error = `${summary.failed} 个文件下载失败`
    } catch (err) {
      task.phase = 'error'
      task.error = String(err?.human || err?.message || err)
      pushLog(task, '出错：' + task.error)
    } finally {
      task.finishedAt = Date.now()
      if (tmp) {
        try {
          rmSync(tmp, { recursive: true, force: true })
        } catch {
          /* 忽略 */
        }
      }
    }
  })()
  return task
}

export function makePackHandler({ resolveConfig }) {
  return async (req, res) => {
    try {
      const cfg = resolveConfig()
      const url = new URL(req.url || '/', 'http://x')
      const rest = url.pathname.startsWith('/mc/pack') ? url.pathname.slice('/mc/pack'.length) : url.pathname
      const sub = rest.replace(/\/+$/, '') || '/list'
      const method = (req.method || 'GET').toUpperCase()
      const qp = (k) => url.searchParams.get(k) || undefined

      if (sub === '/list') {
        const out = await search({ query: qp('q') || '', gameVersion: qp('mc'), limit: Number(qp('limit')) || 20, projectType: 'modpack' })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/versions' && method === 'POST') {
        const body = await readBody(req)
        const projectId = String(body?.projectId || '')
        if (!projectId) return sendJson(res, 400, { ok: false, error: '缺少 projectId' })
        const list = await packVersions(projectId, { mcVersion: body?.mcVersion ? String(body.mcVersion) : undefined })
        return sendJson(res, 200, {
          ok: true,
          projectId,
          versions: list.map((v) => ({
            versionId: v.versionId,
            versionNumber: v.versionNumber,
            gameVersions: v.gameVersions,
            datePublished: v.datePublished,
            file: v.mrpack,
          })),
        })
      }

      if (sub === '/inspect' && method === 'POST') {
        const body = await readBody(req)
        const p = String(body?.path || '')
        if (!p) return sendJson(res, 400, { ok: false, error: '缺少 path' })
        const out = inspectPack(p)
        return sendJson(res, 200, { ok: true, pack: out })
      }

      if (sub === '/install' && method === 'POST') {
        const body = await readBody(req)
        const task = startInstall({ minecraftDir: cfg.minecraftDir, mirror: cfg.mirror, body })
        return sendJson(res, 200, { ok: true, taskId: task.id })
      }

      if (sub === '/state') return sendJson(res, 200, snapshot())

      if (sub === '/marker') {
        const instance = qp('instance')
        if (!instance) return sendJson(res, 400, { ok: false, error: '缺少 instance' })
        return sendJson(res, 200, { ok: true, instance, marker: readPackMarker(cfg.minecraftDir, instance) })
      }

      return sendJson(res, 404, { ok: false, error: 'no such route: ' + sub })
    } catch (err) {
      try {
        return sendJson(res, err?.code === 'BUSY' ? 409 : 400, { ok: false, error: String(err?.human || err?.message || err) })
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
