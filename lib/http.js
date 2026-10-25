/**
 * http.js —— 带重试与超时的取数工具。
 *
 * 为什么需要：BMCLAPI 是公益镜像，偶发 5xx / 连接被掐很正常（实测过）。
 * 清单、版本 JSON、资源索引这几个「少而关键」的请求失败一次就整轮失败太脆，
 * 所以统一在这里重试；真正的海量文件下载走 download.js 自己的重试逻辑。
 */

import { DEFAULT_USER_AGENT } from './mirror.js'

const RETRY_DELAYS = [300, 900, 2400]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchBuffer(url, { timeoutMs = 30000, retries = RETRY_DELAYS.length, headers } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': DEFAULT_USER_AGENT, ...(headers || {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} ${url}`)
        error.status = res.status
        // 4xx 除了 408/429 都是「问了也没用」，不重试
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw error
        lastError = error
      } else {
        return Buffer.from(await res.arrayBuffer())
      }
    } catch (err) {
      lastError = err
      if (err?.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err
    }
    if (attempt < retries) await sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
  }
  throw lastError || new Error(`fetch failed: ${url}`)
}

export async function fetchJson(url, opts) {
  const buffer = await fetchBuffer(url, opts)
  return { json: JSON.parse(buffer.toString('utf8')), buffer }
}
