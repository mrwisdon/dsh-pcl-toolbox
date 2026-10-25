/**
 * loader-routes.js —— 加载器安装的 HTTP 门面（/mc/loader/*）。
 *
 *   GET  /mc/loader/list?type=&mc=   可选版本列表
 *   POST /mc/loader/install          安装（后台跑，返回 taskId）
 *   GET  /mc/loader/state            进度
 *   POST /mc/loader/cancel
 *   GET  /mc/loader/instances?type=  已装实例
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { findLoaderInstances, installFabricLike, installForgeLike, isValidLoaderType, listLoaderVersions, repairLibraries } from './loaders.js'
import { describeJava, discoverJavas, selectJava } from './java.js'
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
  if (task.log.length > LOG_MAX) task.log.splice(0, task.log.length - LOG_MAX)
}

function isRunning() {
  return Boolean(S.task && ['planning', 'installing', 'downloading'].includes(S.task.phase))
}

function snapshot() {
  const t = S.task
  if (!t) return { ok: true, task: null }
  const st = t.stats || null
  return {
    ok: true,
    task: {
      id: t.id,
      type: t.type,
      mcVersion: t.mcVersion,
      version: t.version,
      phase: t.phase,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt ?? null,
      filesTotal: st ? st.filesTotal : 0,
      filesDone: st ? st.filesDone : 0,
      bytesTotal: st ? st.bytesTotal : 0,
      bytesDone: st ? st.bytesDone : 0,
      speedBps: st ? st.speedBps : 0,
      result: t.result || null,
      log: t.log.slice(-60),
      error: t.error ?? null,
    },
  }
}

/** installer 要能看到输出；javaw 也行，但有同目录 java.exe 就优先用（更稳）。 */
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
  const d = describeJava({ folder: path.dirname(path.dirname(sel.java.exe)), exe: sel.java.exe, probeExe: sel.java.exe, from: sel.from })
  return { exe: consoleJava(sel.java.exe), major: d.major ?? major, from: sel.from }
}

function startInstall({ minecraftDir, mirror, body }) {
  if (isRunning()) {
    const err = new Error('已有加载器安装任务在跑')
    err.code = 'BUSY'
    throw err
  }
  const type = String(body?.type || '')
  const mcVersion = String(body?.mcVersion || '')
  if (!isValidLoaderType(type)) throw new Error('未知加载器类型: ' + type)
  if (!mcVersion) throw new Error('缺少 mcVersion')

  const task = {
    id: `l${++S.seq}`,
    type,
    mcVersion,
    version: body?.loaderVersion ? String(body.loaderVersion) : null,
    phase: 'planning',
    startedAt: Date.now(),
    finishedAt: null,
    log: [],
    stats: null,
    result: null,
    error: null,
  }
  S.task = task
  pushLog(task, `准备安装 ${type}（MC ${mcVersion}）`)

  ;(async () => {
    try {
      task.phase = 'installing'
      if (type === 'fabric' || type === 'quilt') {
        const out = await installFabricLike({
          type,
          minecraftDir,
          mcVersion,
          loaderVersion: body?.loaderVersion ? String(body.loaderVersion) : undefined,
          name: body?.name ? String(body.name) : undefined,
          mirror,
          concurrency: 6,
          onLog: (l) => pushLog(task, l),
        })
        task.version = out.plan.id
        task.stats = out.run ? out.run.stats : null
        task.result = { id: out.id, dir: out.dir, libraries: out.libraries, missing: out.missing, mainClass: out.plan.mainClass, chain: out.plan.mainClassSources }
        task.phase = out.missing === 0 ? 'done' : 'error'
        if (out.missing) task.error = `还缺 ${out.missing} 个库`
      } else {
        const java = pickJavaFor(minecraftDir, mcVersion)
        pushLog(task, `用 Java ${java.major}（${java.from}）跑 installer`)
        const out = await installForgeLike({
          type,
          minecraftDir,
          mcVersion,
          build: body?.loaderVersion ? String(body.loaderVersion) : undefined,
          mirror,
          javaExe: java.exe,
          onLog: (l) => pushLog(task, l),
        })
        task.result = { created: out.created, exitCode: out.exitCode, note: out.note, logTail: out.logTail }
        task.phase = out.ok ? 'done' : 'error'
        if (!out.ok) task.error = out.note || `installer 退出码 ${out.exitCode}`
      }
    } catch (err) {
      task.phase = 'error'
      task.error = String(err?.human || err?.message || err)
      pushLog(task, '出错：' + task.error)
    } finally {
      task.finishedAt = Date.now()
    }
  })()

  return task
}

export function makeLoaderHandler({ resolveConfig }) {
  return async (req, res) => {
    try {
      const cfg = resolveConfig()
      const url = new URL(req.url || '/', 'http://x')
      const rest = url.pathname.startsWith('/mc/loader') ? url.pathname.slice('/mc/loader'.length) : url.pathname
      const sub = rest.replace(/\/+$/, '') || '/list'
      const method = (req.method || 'GET').toUpperCase()

      if (sub === '/list') {
        const type = url.searchParams.get('type') || 'fabric'
        const mcVersion = url.searchParams.get('mc') || ''
        if (!mcVersion) return sendJson(res, 400, { ok: false, error: '缺少 mc 参数' })
        const out = await listLoaderVersions({ type, mcVersion, mirror: cfg.mirror })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/state') return sendJson(res, 200, snapshot())

      if (sub === '/instances') {
        const type = url.searchParams.get('type') || 'fabric'
        return sendJson(res, 200, { ok: true, instances: findLoaderInstances(cfg.minecraftDir, type) })
      }

      if (sub === '/install' && method === 'POST') {
        const body = await readBody(req)
        const task = startInstall({ minecraftDir: cfg.minecraftDir, mirror: cfg.mirror, body })
        return sendJson(res, 200, { ok: true, taskId: task.id })
      }

      if (sub === '/repair' && method === 'POST') {
        const body = await readBody(req)
        const versionId = String(body?.versionId || '')
        if (!versionId) return sendJson(res, 400, { ok: false, error: '缺少 versionId' })
        const logs = []
        const out = await repairLibraries({
          minecraftDir: cfg.minecraftDir,
          versionId,
          mirror: cfg.mirror,
          concurrency: 8,
          onLog: (l) => logs.push(String(l).slice(0, 300)),
        })
        return sendJson(res, 200, { ok: true, ...out, log: logs.slice(-40) })
      }

      if (sub === '/cancel' && method === 'POST') {
        return sendJson(res, 409, { ok: false, error: '加载器安装不支持中途取消（installer 已在跑）' })
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
