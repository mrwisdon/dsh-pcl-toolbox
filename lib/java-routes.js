/**
 * java-routes.js —— Java 运行时管理的 HTTP 门面（/mc/java/*）。
 *
 *   GET  /mc/java/runtimes     索引里的组件 × 是否已安装
 *   GET  /mc/java/state        当前安装任务进度（面板轮询）
 *   POST /mc/java/plan         只算计划（文件数/字节），不下载
 *   POST /mc/java/install      真安装（后台跑，立刻返回 taskId）
 *   POST /mc/java/cancel       取消
 *   POST /mc/java/forVersion   某个版本需要哪个组件、装没装
 */

import { createRun } from './download.js'
import { DEFAULT_MIRROR } from './mirror.js'
import { listInstalled, listRuntimes, planInstall, runtimeForVersion, verifyInstall } from './javaruntime.js'
import { resolveVersionJson } from './versions.js'

const S = { task: null, seq: 0 }
const LOG_MAX = 120

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
  task.log.push(line)
  if (task.log.length > LOG_MAX) task.log.splice(0, task.log.length - LOG_MAX)
}

function isRunning() {
  return Boolean(S.task && (S.task.phase === 'planning' || S.task.phase === 'downloading' || S.task.phase === 'verifying'))
}

function snapshot() {
  const t = S.task
  if (!t) return { ok: true, task: null }
  const st = t.stats || null
  return {
    ok: true,
    task: {
      id: t.id,
      component: t.component,
      phase: t.phase,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt ?? null,
      filesTotal: st ? st.filesTotal : 0,
      filesDone: st ? st.filesDone : 0,
      filesSkipped: st ? st.filesSkipped : 0,
      filesFailed: st ? st.filesFailed : 0,
      bytesTotal: st ? st.bytesTotal : 0,
      bytesDone: st ? st.bytesDone : 0,
      speedBps: st ? st.speedBps : 0,
      etaSec: st ? st.etaSec : null,
      usedAlt: st ? st.usedAlt : 0,
      throttled: st ? st.throttled : 0,
      errors: st ? st.errors : [],
      verify: t.verify || null,
      log: t.log.slice(-40),
      error: t.error ?? null,
    },
  }
}

function startInstall({ minecraftDir, mirror, component }) {
  if (isRunning()) {
    const err = new Error('已有 Java 安装任务在跑')
    err.code = 'BUSY'
    throw err
  }
  const task = {
    id: `j${++S.seq}`,
    component,
    phase: 'planning',
    startedAt: Date.now(),
    finishedAt: null,
    log: [],
    stats: null,
    verify: null,
    error: null,
  }
  S.task = task
  pushLog(task, `准备安装 ${component}（${minecraftDir}）`)

  ;(async () => {
    try {
      const plan = await planInstall({ minecraftDir, mirror, component })
      pushLog(task, `计划就绪：${plan.files.length} 个文件 / ${(plan.bytes / 1048576).toFixed(1)} MB（版本 ${plan.version}）`)
      if (!plan.files.length) throw new Error('这个组件没有可下载的文件（索引结构异常）')
      task.phase = 'downloading'
      const run = createRun({
        dir: plan.dir,
        files: plan.files,
        concurrency: 6,
        onLog: (l) => pushLog(task, l),
      })
      task.run = run
      task.stats = run.stats
      await run.start()
      if (run.stats.phase === 'error') {
        task.error = `${run.stats.filesFailed} 个文件失败`
        task.phase = 'error'
        return
      }
      if (run.stats.phase === 'cancelled') {
        task.phase = 'cancelled'
        return
      }
      task.phase = 'verifying'
      const v = verifyInstall({ minecraftDir, component, expectedVersion: plan.version })
      task.verify = v
      task.phase = v.ok ? 'done' : 'error'
      if (!v.ok) task.error = v.message
      pushLog(task, v.message)
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

export function makeJavaHandler({ resolveConfig }) {
  return async (req, res) => {
    try {
      const cfg = resolveConfig()
      const url = new URL(req.url || '/', 'http://x')
      const rest = url.pathname.startsWith('/mc/java') ? url.pathname.slice('/mc/java'.length) : url.pathname
      const sub = rest.replace(/\/+$/, '') || '/runtimes'
      const method = (req.method || 'GET').toUpperCase()

      if (sub === '/runtimes') {
        const out = await listRuntimes({ minecraftDir: cfg.minecraftDir, mirror: cfg.mirror })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/state') return sendJson(res, 200, snapshot())

      if (sub === '/plan' && method === 'POST') {
        const body = await readBody(req)
        const component = String(body?.component || '')
        if (!component) return sendJson(res, 400, { ok: false, error: '缺少 component' })
        const plan = await planInstall({ minecraftDir: cfg.minecraftDir, mirror: cfg.mirror, component })
        return sendJson(res, 200, {
          ok: true,
          plan: {
            component: plan.component,
            version: plan.version,
            platform: plan.platform,
            files: plan.files.length,
            bytes: plan.bytes,
            skipped: plan.skipped,
          },
        })
      }

      if (sub === '/install' && method === 'POST') {
        const body = await readBody(req)
        const component = String(body?.component || '')
        if (!component) return sendJson(res, 400, { ok: false, error: '缺少 component' })
        const task = startInstall({ minecraftDir: cfg.minecraftDir, mirror: cfg.mirror, component })
        return sendJson(res, 200, { ok: true, taskId: task.id })
      }

      if (sub === '/cancel' && method === 'POST') {
        if (!S.task || !isRunning()) return sendJson(res, 409, { ok: false, error: '当前没有在跑的安装任务' })
        const cancelled = Boolean(S.task.run && S.task.run.cancel())
        return sendJson(res, 200, { ok: true, cancelled })
      }

      if (sub === '/forVersion' && method === 'POST') {
        const body = await readBody(req)
        const versionId = String(body?.versionId || '')
        if (!versionId) return sendJson(res, 400, { ok: false, error: '缺少 versionId' })
        let javaVersion = null
        try {
          javaVersion = resolveVersionJson(cfg.minecraftDir, versionId).json.javaVersion || null
        } catch (err) {
          return sendJson(res, 404, { ok: false, error: String(err?.message || err) })
        }
        const out = await runtimeForVersion({ minecraftDir: cfg.minecraftDir, mirror: cfg.mirror, javaVersion })
        return sendJson(res, 200, { ok: true, versionId, javaVersion, ...out })
      }

      if (sub === '/installed') {
        return sendJson(res, 200, { ok: true, installed: listInstalled(cfg.minecraftDir), platform: process.platform })
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
