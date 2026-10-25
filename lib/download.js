/**
 * download.js —— 下载引擎：并发池 + 断点续传 + SHA-1 校验 + 实时进度。
 *
 * 设计要点（都是必需的，不是花活）：
 *  - 先写 `<dest>.part` 再 rename，中途被杀不会留下半个「看起来已完成」的文件。
 *  - 已存在且 size 相符的文件仍要校验 sha1；校验不过就重下（镜像缓存污染是真的会发生）。
 *  - Range 续传：有 .part 就带 `Range: bytes=N-`；服务器不认（回 200）就老老实实从头写。
 *  - 进度用「活跃表求和」而不是全局自增，重试/续传都不会把字节数算重。
 *  - 速度用 4 秒滑动窗口，避免瞬时抖动把 ETA 算飞。
 *  - 单个文件失败只记账不打断整轮（镜像偶发 5xx 很正常），最后errors一次性给前端。
 *
 * 关于代理：Node 的 fetch（undici）**不读** HTTP(S)_PROXY 环境变量，天然直连。
 * 这正好是我们要的 —— BMCLAPI 的 /assets/ 路径经本地代理会 000，必须直连。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RETRY_DELAYS = [400, 1200, 3000]
const SAMPLE_WINDOW_MS = 4000
const TICK_MS = 500
const MAX_ERRORS = 40
/** 单次请求「多久没收到任何字节」就判定卡死并重试。镜像偶发挂连接时全靠这个兜底。 */
const IDLE_TIMEOUT_MS = 15000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function sha1File(filePath) {
  const hash = crypto.createHash('sha1')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function statSize(filePath) {
  try {
    const st = await fsp.stat(filePath)
    return st.isFile() ? st.size : -1
  } catch {
    return -1
  }
}

class AbortedError extends Error {
  constructor() {
    super('download cancelled')
    this.name = 'AbortedError'
    this.aborted = true
  }
}

class HttpError extends Error {
  constructor(status, url, retryAfter) {
    super(`HTTP ${status} ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.retryAfter = retryAfter || null
  }
}

/**
 * 创建一轮下载。调用 start() 开始，cancel() 立刻停。
 * stats 是「活的」：宿主侧直接把它映射进 /mc-dl/state。
 */
export function createRun({ dir, files, concurrency = 8, onProgress, onLog } = {}) {
  if (!dir) throw new Error('createRun: 缺少 dir')
  const list = Array.isArray(files) ? files.slice() : []
  // 公益镜像友好：默认 8 并发（原来 16 容易触发限流）
const concurrencyN = Math.max(1, Math.min(Number(concurrency) || 8, 32))

  const stats = {
    phase: 'downloading',
    dir,
    concurrency: concurrencyN,
    filesTotal: list.length,
    filesDone: 0,
    filesSkipped: 0,
    filesFailed: 0,
    bytesTotal: list.reduce((sum, f) => sum + (Number(f.size) || 0), 0),
    bytesDone: 0,
    speedBps: 0,
    etaSec: null,
    active: [],
    errors: [],
    byKind: {}, // kind -> { n, done }
    usedAlt: 0, // 因为镜像限流/抽风而改走官方资源 CDN 的文件数
    throttled: 0, // 吃到 429 的次数
  }

  for (const f of list) {
    const kind = f.kind || 'other'
    if (!stats.byKind[kind]) stats.byKind[kind] = { n: 0, done: 0 }
    stats.byKind[kind].n += 1
  }

  const activeMap = new Map() // rel -> { rel, size, done }
  const samples = []
  let finishedBytes = 0
  let ticker = null
  let aborted = false
  let controller = new AbortController()

  const log = (message) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`
    try {
      onLog?.(line)
    } catch {
      /* 日志坏了不影响下载 */
    }
  }

  function recompute() {
    let live = 0
    for (const entry of activeMap.values()) live += entry.done
    stats.bytesDone = finishedBytes + live
    stats.active = [...activeMap.values()].slice(0, concurrencyN)
  }

  function startTicker() {
    if (ticker) return
    ticker = setInterval(() => {
      const now = Date.now()
      samples.push({ t: now, b: stats.bytesDone })
      while (samples.length > 3 && now - samples[0].t > SAMPLE_WINDOW_MS) samples.shift()
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = (last.t - first.t) / 1000
      stats.speedBps = dt >= 0.4 ? Math.max(0, Math.round((last.b - first.b) / dt)) : 0
      const remain = Math.max(0, stats.bytesTotal - stats.bytesDone)
      stats.etaSec = stats.speedBps > 0 ? Math.ceil(remain / stats.speedBps) : null
      recompute()
      try {
        onProgress?.()
      } catch {
        /* 订阅者坏了不影响下载 */
      }
    }, TICK_MS)
    if (typeof ticker.unref === 'function') ticker.unref()
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
  }

  function pushError(entry) {
    if (stats.errors.length >= MAX_ERRORS) return
    stats.errors.push(entry)
  }

  /** 已存在且可信 → 跳过；返回 true 表示这个文件不用下了。 */
  async function trySkip(file, dest) {
    const size = await statSize(dest)
    if (size < 0) return false
    if (file.size && size !== file.size) return false
    if (file.sha1) {
      const actual = await sha1File(dest)
      if (actual !== file.sha1) {
        log(`校验不符，重下：${file.rel}（期望 ${file.sha1.slice(0, 8)}…，实际 ${actual.slice(0, 8)}…）`)
        return false
      }
    }
    finishedBytes += Number(file.size) || size || 0
    stats.filesSkipped += 1
    if (stats.byKind[file.kind]) stats.byKind[file.kind].done += 1
    recompute()
    return true
  }

  async function fetchToPart(file, dest, entry) {
    const partPath = `${dest}.part`
    let existing = await statSize(partPath)
    if (existing < 0) existing = 0
    entry.done = existing
    // 每个文件带一条有序候选源（镜像优先，官方兜底）。
    // 对应 PCL 的 NetFile(Sources)：一个文件多个下载源，失败就顺延到下一个。
    const sources = (Array.isArray(file.sources) && file.sources.length
      ? file.sources
      : [file.url, file.alt]
    ).filter(Boolean)
    let sourceIdx = 0
    let currentUrl = sources[0]
    let throttleHits = 0
    let hardFailures = 0

    // attempt 只是安全上限；真正的重试预算由 hardFailures 管
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (aborted) throw new AbortedError()

      // 每次尝试一个独立 controller：外层的 cancel 要能掐断它，
      // 它自己的「空闲超时」也要能单独掐断这次尝试（然后重试，而不是整轮失败）。
      const local = new AbortController()
      const linkAbort = () => {
        try {
          local.abort()
        } catch {
          /* 已经断了 */
        }
      }
      controller.signal.addEventListener('abort', linkAbort, { once: true })
      let idleTimer = null
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          try {
            local.abort()
          } catch {
            /* 已经断了 */
          }
        }, IDLE_TIMEOUT_MS)
        if (typeof idleTimer.unref === 'function') idleTimer.unref()
      }

      try {
        const headers = { 'user-agent': DEFAULT_USER_AGENT }
        if (existing > 0) headers.Range = `bytes=${existing}-`
        bumpIdle() // 连 TTFB 也算在空闲里：镜像卡住不回复同样要重试
        const res = await fetch(currentUrl, {
          headers,
          redirect: 'follow',
          signal: local.signal,
        })

        if (res.status === 416) {
          // .part 比远端还大/不对，丢掉重来
          await fsp.rm(partPath, { force: true })
          existing = 0
          entry.done = 0
          continue
        }
        if (res.status === 429) {
          // BMCLAPI 的 /assets/ 是「302 + 限流」结构，429 带 Retry-After-short
          const ra = Number(res.headers.get('retry-after-short') || res.headers.get('retry-after') || 0) || 5
          throw new HttpError(429, currentUrl, ra)
        }
        if (!res.ok) throw new HttpError(res.status, currentUrl)

        const resuming = existing > 0 && res.status === 206
        if (!resuming) {
          existing = 0
          entry.done = 0
        }

        bumpIdle()
        const body = res.body ? Readable.fromWeb(res.body) : Readable.from([])
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            entry.done += chunk.length
            bumpIdle()
            recompute()
            cb(null, chunk)
          },
        })
        const sink = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' })
        await pipeline(body, counter, sink)
        return existing
      } catch (err) {
        if (aborted) throw new AbortedError() // 外层取消，不是这次尝试的问题

        // 429：BMCLAPI 的 /assets/ 是高频率请求会返回 403/429 的限流后端。
        // PCL 的结论（ModNet.vb:1083）是「镜像的 403/429 只代表限流，不代表源坏了，
        // 不应据此禁用源」——所以先按 Retry-After 退避重试，连续两次才考虑换源。
        if (err?.status === 429) {
          stats.throttled += 1
          throttleHits += 1
          const waitMs = Math.min(30000, Math.max(1000, (Number(err.retryAfter) || 5) * 1000))
          log(`429 限流，等 ${Math.round(waitMs / 1000)}s 再试（第 ${throttleHits} 次）：${file.rel}`)
          await sleep(waitMs)
          if (throttleHits >= 2 && sourceIdx < sources.length - 1) {
            sourceIdx += 1
            currentUrl = sources[sourceIdx]
            stats.usedAlt += 1
            log(`连续限流，改走第 ${sourceIdx + 1}/${sources.length} 个源：${file.rel}`)
          }
          existing = Math.max(0, await statSize(`${dest}.part`))
          entry.done = existing
          continue
        }

        // 网络层失败 / 5xx：直接顺延到下一个源（同 PCL：源失败就换，别耗死）
        const networkish = !err?.status || err.status >= 500
        if (networkish && existing === 0 && sourceIdx < sources.length - 1) {
          sourceIdx += 1
          currentUrl = sources[sourceIdx]
          stats.usedAlt += 1
          log(`该源不通（${err?.name || 'HTTP ' + err.status}），换第 ${sourceIdx + 1}/${sources.length} 个源：${file.rel}`)
          await sleep(120)
          continue
        }

        hardFailures += 1
        if (hardFailures > RETRY_DELAYS.length) throw err
        const delay = RETRY_DELAYS[Math.min(hardFailures - 1, RETRY_DELAYS.length - 1)]
        const reason =
          err?.name === 'AbortError'
            ? `空闲超过 ${IDLE_TIMEOUT_MS / 1000}s 无数据`
            : String(err?.message || err).slice(0, 160)
        log(`重试 ${hardFailures}/${RETRY_DELAYS.length}：${file.rel} —— ${reason}`)
        await sleep(delay)
        existing = Math.max(0, await statSize(`${dest}.part`))
        entry.done = existing
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        controller.signal.removeEventListener('abort', linkAbort)
      }
    }
  }

  async function handleFile(file) {
    const dest = path.join(dir, file.rel)
    await fsp.mkdir(path.dirname(dest), { recursive: true })

    if (await trySkip(file, dest)) return

    const entry = { rel: file.rel, size: Number(file.size) || 0, done: 0 }
    activeMap.set(file.rel, entry)
    try {
      await fetchToPart(file, dest, entry)
      const partPath = `${dest}.part`
      if (file.sha1) {
        const actual = await sha1File(partPath)
        if (actual !== file.sha1) {
          await fsp.rm(partPath, { force: true })
          throw new Error(`SHA-1 校验失败：期望 ${file.sha1}，实际 ${actual}`)
        }
      }
      await fsp.rm(dest, { force: true }) // Windows 上 rename 不覆盖已有文件
      await fsp.rename(partPath, dest)
      finishedBytes += entry.done
      stats.filesDone += 1
      if (stats.byKind[file.kind]) stats.byKind[file.kind].done += 1
    } catch (err) {
      stats.filesFailed += 1
      const message = String(err?.message || err)
      pushError({
        rel: file.rel,
        url: file.url,
        status: err?.status ?? null,
        message: message.slice(0, 300),
      })
      log(`失败：${file.rel} —— ${message.slice(0, 200)}`)
      if (err instanceof AbortedError) throw err
    } finally {
      activeMap.delete(file.rel)
      recompute()
    }
  }

  async function run() {
    startTicker()
    log(`开始下载：${stats.filesTotal} 个文件 / ${(stats.bytesTotal / 1048576).toFixed(1)} MB，并发 ${concurrencyN}`)
    const queue = list.slice()
    let fatal = null

    const worker = async () => {
      for (;;) {
        if (aborted) return
        const file = queue.shift()
        if (!file) return
        try {
          await handleFile(file)
        } catch (err) {
          if (err instanceof AbortedError) {
            fatal = err
            return
          }
          pushError({ rel: file.rel, url: file.url, status: null, message: String(err?.message || err).slice(0, 300) })
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrencyN, Math.max(1, queue.length)) }, worker))
    stopTicker()
    recompute()

    if (aborted) {
      stats.phase = 'cancelled'
      log('已取消。')
    } else if (fatal) {
      stats.phase = 'cancelled'
    } else if (stats.filesFailed > 0) {
      stats.phase = 'error'
      log(`结束：${stats.filesFailed} 个文件失败。`)
    } else {
      stats.phase = 'done'
      log(`完成：${stats.filesDone} 下载 / ${stats.filesSkipped} 跳过（已存在且校验通过）。`)
    }
    stats.speedBps = 0
    stats.etaSec = null
    stats.active = []
    return stats
  }

  function cancel() {
    if (aborted) return false
    aborted = true
    try {
      controller.abort()
    } catch {
      /* 已经断了 */
    }
    return true
  }

  return { stats, start: run, cancel, get aborted() { return aborted } }
}
