/**
 * downloader.js —— 下载引擎的 HTTP 门面（合并后挂在 /mc/dl 下），从「MC 下载」插件并进来。
 *
 * 与启动半边的关系：**只共享配置**（默认下载目录 = 启动器用的 .minecraft），不共享状态。
 * 路由与字段保持原样（state / manifest / plan / start / cancel / open / diag / files），
 * 这样合并后的面板不需要改内部逻辑。
 *
 * 数据链：manifest(镜像) → 版本 JSON → 资源索引 → buildPlan() → createRun() 并发下载 + sha1 校验。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { DEFAULT_MIRROR, currentPlatform, urls, buildPlan } from './mirror.js'
import { createRun } from './download.js'
import { fetchBuffer, fetchJson } from './http.js'

const MANIFEST_TTL_MS = 10 * 60 * 1000
const LOG_MAX = 200

const S = {
  manifest: { at: 0, data: null },
  plans: new Map(), // version -> { plan, at }
  task: null,
  seq: 0,
}

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

function sha1Of(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function pushLog(task, line) {
  task.log.push(line)
  if (task.log.length > LOG_MAX) task.log.splice(0, task.log.length - LOG_MAX)
}

function isRunning(task) {
  return Boolean(task && (task.phase === 'planning' || task.phase === 'downloading'))
}

async function getManifest(cfg) {
  const now = Date.now()
  if (S.manifest.data && now - S.manifest.at < MANIFEST_TTL_MS) return S.manifest.data
  const { json } = await fetchJson(urls.manifest(cfg.mirror))
  if (!json || !Array.isArray(json.versions)) throw new Error('镜像返回的版本清单格式不对（没有 versions 数组）')
  S.manifest = { at: now, data: json }
  return json
}

async function buildPlanFor(cfg, version, dir) {
  const manifest = await getManifest(cfg)
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) throw new Error(`镜像清单里没有版本 ${version}`)

  const vjUrl = urls.versionJson(cfg.mirror, version)
  const vjBuf = await fetchBuffer(vjUrl)
  const versionJson = JSON.parse(vjBuf.toString('utf8'))
  if (!versionJson || !versionJson.id) throw new Error('版本 JSON 缺少 id 字段')

  const ai = versionJson.assetIndex
  if (!ai || !ai.sha1 || !ai.id) throw new Error('版本 JSON 没有 assetIndex，无法计算资源清单')
  const aiBuf = await fetchBuffer(urls.assetIndex(cfg.mirror, ai))
  const assetIndex = JSON.parse(aiBuf.toString('utf8'))
  if (!assetIndex || !assetIndex.objects) throw new Error('资源索引格式不对（没有 objects）')

  const plan = buildPlan({
    version,
    versionJson,
    versionJsonSha1: sha1Of(vjBuf),
    versionJsonSize: vjBuf.length,
    assetIndex,
    mirror: cfg.mirror,
    platform: currentPlatform(),
    sourcePreference: cfg.sourcePreference,
    versionJsonOfficialUrl: entry.url || null,
  })
  plan.dir = dir
  plan.assetIndexId = ai.id
  plan.manifestEntry = { id: entry.id, type: entry.type, releaseTime: entry.releaseTime }
  plan.files = plan.files.map((f) => ({ ...f }))
  return plan
}

function planSummary(plan) {
  const byKind = {}
  for (const [kind, slot] of Object.entries(plan.byKind)) byKind[kind] = { n: slot.n, bytes: slot.bytes }
  return {
    version: plan.version,
    dir: plan.dir,
    files: plan.files.length,
    bytes: plan.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0),
    byKind,
    mirror: plan.mirror,
    platform: plan.platform,
    assetIndexId: plan.assetIndexId ?? null,
    warnings: plan.warnings || [],
  }
}

function snapshot(cfg) {
  const task = S.task
  if (!task) return { ok: true, mirror: cfg.mirror, config: { dir: cfg.dir, concurrency: cfg.concurrency }, task: null }
  const stats = task.stats || null
  return {
    ok: true,
    mirror: cfg.mirror,
    config: { dir: cfg.dir, concurrency: cfg.concurrency },
    task: {
      id: task.id,
      version: task.version,
      dir: task.dir,
      phase: task.phase,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt ?? null,
      filesTotal: stats ? stats.filesTotal : 0,
      filesDone: stats ? stats.filesDone : 0,
      filesSkipped: stats ? stats.filesSkipped : 0,
      filesFailed: stats ? stats.filesFailed : 0,
      bytesTotal: stats ? stats.bytesTotal : 0,
      bytesDone: stats ? stats.bytesDone : 0,
      speedBps: stats ? stats.speedBps : 0,
      etaSec: stats ? stats.etaSec : null,
      byKind: stats ? stats.byKind : {},
      active: stats ? stats.active : [],
      errors: stats ? stats.errors : [],
      usedAlt: stats ? stats.usedAlt : 0,
      throttled: stats ? stats.throttled : 0,
      log: task.log.slice(-60),
      error: task.error ?? null,
    },
  }
}

function startTask(cfg, { version, dir, concurrency }) {
  if (isRunning(S.task)) {
    const err = new Error('已有任务在跑，先取消或等它结束')
    err.code = 'BUSY'
    throw err
  }
  const task = {
    id: `t${++S.seq}`,
    version,
    dir,
    phase: 'planning',
    startedAt: Date.now(),
    finishedAt: null,
    log: [],
    stats: null,
    error: null,
    run: null,
  }
  S.task = task
  pushLog(task, `准备 ${version} → ${dir}`)

  ;(async () => {
    try {
      const cached = S.plans.get(version)
      const plan =
        cached && Date.now() - cached.at < MANIFEST_TTL_MS && cached.plan.dir === dir
          ? cached.plan
          : await buildPlanFor(cfg, version, dir)
      S.plans.set(version, { at: Date.now(), plan })
      pushLog(
        task,
        `计划就绪：${plan.files.length} 个文件 / ${(plan.files.reduce((s, f) => s + (Number(f.size) || 0), 0) / 1048576).toFixed(1)} MB`,
      )
      for (const w of plan.warnings || []) pushLog(task, `注意：${w}`)

      task.phase = 'downloading'
      const run = createRun({
        dir,
        files: plan.files,
        concurrency: concurrency || cfg.concurrency,
        onLog: (line) => pushLog(task, line),
      })
      task.run = run
      task.stats = run.stats
      await run.start()
      task.phase = run.stats.phase === 'downloading' ? 'done' : run.stats.phase
      if (run.stats.phase === 'error') task.error = `${run.stats.filesFailed} 个文件失败（见 errors）`
    } catch (err) {
      task.phase = 'error'
      task.error = String(err?.message || err)
      pushLog(task, `出错：${task.error}`)
    } finally {
      task.finishedAt = Date.now()
    }
  })()

  return task
}

async function diag(cfg) {
  const checks = []
  const probe = async (label, url, headers) => {
    const started = Date.now()
    try {
      const res = await fetch(url, { headers: headers || {}, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      const buf = Buffer.from(await res.arrayBuffer())
      checks.push({
        label,
        url,
        ok: res.ok,
        status: res.status,
        ms: Date.now() - started,
        bytes: buf.length,
        sha1: buf.length > 0 && buf.length <= 8 * 1024 * 1024 ? sha1Of(buf) : null,
      })
    } catch (err) {
      checks.push({ label, url, ok: false, status: null, ms: Date.now() - started, error: String(err?.message || err) })
    }
  }

  let version = null
  let assetHash = null
  try {
    const manifest = await getManifest(cfg)
    version = manifest.latest?.release || manifest.versions?.[0]?.id || null
    checks.push({ label: 'manifest', url: urls.manifest(cfg.mirror), ok: true, status: 200, ms: 0, versions: manifest.versions.length, latest: manifest.latest })
    if (version) {
      const vj = await fetchJson(urls.versionJson(cfg.mirror, version))
      checks.push({ label: 'versionJson', url: urls.versionJson(cfg.mirror, version), ok: true, status: 200, ms: 0, bytes: vj.buffer.length })
      const ai = vj.json.assetIndex
      if (ai?.id) {
        const idx = await fetchJson(urls.assetIndex(cfg.mirror, ai))
        const hashes = Object.values(idx.json.objects || {}).map((o) => o.hash).filter(Boolean)
        assetHash = hashes[777] || hashes[0] || null
        checks.push({ label: 'assetIndex', url: urls.assetIndex(cfg.mirror, ai), ok: true, status: 200, ms: 0, bytes: idx.buffer.length, objects: hashes.length })
      }
    }
  } catch (err) {
    checks.push({ label: 'manifest', url: urls.manifest(cfg.mirror), ok: false, error: String(err?.message || err) })
  }

  await probe('clientJar(range)', version ? urls.clientJar(cfg.mirror, version) : urls.manifest(cfg.mirror), { Range: 'bytes=0-1023' })
  await probe('maven(range)', urls.maven(cfg.mirror, 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar'), { Range: 'bytes=0-1023' })
  if (assetHash) await probe('assetObject(range)', urls.assetObject(cfg.mirror, assetHash), { Range: 'bytes=0-1023' })

  return { ok: checks.every((c) => c.ok), mirror: cfg.mirror, version, platform: currentPlatform(), checks }
}

function openTarget(cfg, target) {
  const map = {
    dir: cfg.dir,
    versions: path.join(cfg.dir, 'versions'),
    libraries: path.join(cfg.dir, 'libraries'),
    assets: path.join(cfg.dir, 'assets'),
  }
  const targetPath = map[target] || cfg.dir
  fs.mkdirSync(targetPath, { recursive: true })
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [targetPath], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, path: targetPath }
  } catch (err) {
    return { ok: false, path: targetPath, error: String(err?.message || err) }
  }
}

/**
 * @param {() => {dir:string, concurrency:number, mirror:string, sourcePreference:string}} resolveConfig
 * @returns {(req,res)=>Promise<void>}  挂到 prefix `/mc-dl` 的 handler
 */
export function makeDownloaderHandler(resolveConfig, { prefix = '/mc/dl' } = {}) {
  return async (req, res) => {
    try {
      const cfg = resolveConfig()
      const url = new URL(req.url || '/', 'http://x')
      const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname
      const sub = rest.replace(/\/+$/, '') || '/state'
      const method = (req.method || 'GET').toUpperCase()

      if (sub === '/state') return sendJson(res, 200, snapshot(cfg))

      if (sub === '/manifest') {
        const manifest = await getManifest(cfg)
        return sendJson(res, 200, {
          ok: true,
          mirror: cfg.mirror,
          latest: manifest.latest || null,
          total: manifest.versions.length,
          versions: manifest.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })),
        })
      }

      if (sub === '/diag' && method !== 'POST') return sendJson(res, 200, await diag(cfg))

      if (sub === '/plan' && method === 'POST') {
        const body = await readBody(req)
        const version = String(body?.version || '')
        const dir = path.resolve(String(body?.dir || cfg.dir))
        if (!version) return sendJson(res, 400, { ok: false, error: '缺少 version' })
        if (isRunning(S.task)) return sendJson(res, 409, { ok: false, error: '已有任务在跑，先取消' })
        const plan = await buildPlanFor(cfg, version, dir)
        S.plans.set(version, { at: Date.now(), plan })
        return sendJson(res, 200, { ok: true, plan: planSummary(plan) })
      }

      if (sub === '/start' && method === 'POST') {
        const body = await readBody(req)
        const version = String(body?.version || '')
        if (!version) return sendJson(res, 400, { ok: false, error: '缺少 version' })
        const dir = path.resolve(String(body?.dir || cfg.dir))
        const concurrency = Number(body?.concurrency) || cfg.concurrency
        const task = startTask(cfg, { version, dir, concurrency })
        return sendJson(res, 200, { ok: true, taskId: task.id })
      }

      if (sub === '/cancel' && method === 'POST') {
        const task = S.task
        if (!task || !task.run || !isRunning(task)) return sendJson(res, 409, { ok: false, error: '当前没有在跑的任务' })
        return sendJson(res, 200, { ok: true, cancelled: task.run.cancel() })
      }

      if (sub === '/open' && method === 'POST') {
        const body = await readBody(req)
        const out = openTarget(cfg, String(body?.target || 'dir'))
        return sendJson(res, out.ok ? 200 : 500, out)
      }

      if (sub === '/files' && method !== 'POST') {
        const version = url.searchParams.get('version')
        if (!version) return sendJson(res, 400, { ok: false, error: '缺少 version 查询参数' })
        const dir = path.resolve(url.searchParams.get('dir') || cfg.dir)
        const plan = await buildPlanFor(cfg, version, dir)
        const rows = []
        for (const f of plan.files) {
          const dest = path.join(dir, f.rel)
          let size = -1
          try {
            size = (await fsp.stat(dest)).size
          } catch {
            size = -1
          }
          rows.push({ rel: f.rel, kind: f.kind, size: f.size, onDisk: size, done: size === f.size })
        }
        return sendJson(res, 200, { ok: true, version, dir, files: rows })
      }

      return sendJson(res, 404, { ok: false, error: `no such route: ${sub}` })
    } catch (err) {
      try {
        return sendJson(res, err?.code === 'BUSY' ? 409 : 500, { ok: false, error: String(err?.message || err) })
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
