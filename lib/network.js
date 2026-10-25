/**
 * network.js —— 下载源测速（PCL 的「下载源测速 / 自动选择」）。
 *
 * 对**镜像**和**官方**各打三类代表性请求，量「连接+首字节」延迟与实际吞吐，给一个结论：
 *   · manifest   （JSON，小）
 *   · 客户端 jar （Range 1MB，大文件吞吐）
 *   · 资源对象   （Range 64KB，注意镜像会 302 到签名 CDN）
 * 再按「成功率 → 平均吞吐 → 平均延迟」三项排序，推荐 downloadSourcePreference。
 *
 * 结论只用来说明"建议选哪个"，不改用户配置 —— 改不改由用户在设置页点保存。
 */

import { fetchBuffer } from './http.js'
import { DEFAULT_MIRROR, urls } from './mirror.js'

const CANDIDATES = [
  { key: 'mirror', label: 'BMCLAPI 镜像', base: DEFAULT_MIRROR },
  { key: 'official', label: 'Mojang 官方', base: 'https://piston-meta.mojang.com' },
]

async function timeIt(fn) {
  const t0 = Date.now()
  try {
    const bytes = await fn()
    return { ok: true, ms: Date.now() - t0, bytes }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, bytes: 0, error: String(err?.message || err).slice(0, 160) }
  }
}

async function rangeFetch(url, bytes) {
  const res = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}` }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.length
}

/**
 * @param {object} o
 * @param {string} [o.mirror]
 * @param {string} [o.version]  用哪个版本取 client jar（默认取清单里的最新 release）
 */
export async function speedtest({ mirror = DEFAULT_MIRROR, version } = {}) {
  const base = String(mirror || DEFAULT_MIRROR).replace(/\/+$/, '')
  const rows = []

  // 先用镜像拿清单与版本 JSON（拿不到就没法比，直接报错）
  const manifestBuf = await fetchBuffer(urls.manifest(base), { timeoutMs: 20000 })
  const manifest = JSON.parse(manifestBuf.toString('utf8'))
  const ver = version || manifest.latest?.release || manifest.versions?.[0]?.id || null
  if (!ver) throw new Error('版本清单里没有可用版本')
  const vjBuf = await fetchBuffer(urls.versionJson(base, ver), { timeoutMs: 20000 })
  const vj = JSON.parse(vjBuf.toString('utf8'))
  const clientSha1 = vj.downloads?.client?.sha1 || null
  const mavenRel = 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar'

  const targets = [
    {
      key: 'mirror',
      label: 'BMCLAPI 镜像',
      manifest: () => fetchBuffer(urls.manifest(base), { timeoutMs: 20000 }),
      client: () => rangeFetch(urls.clientJar(base, ver), 1024 * 1024),
      maven: () => rangeFetch(urls.maven(base, mavenRel), 256 * 1024),
    },
    {
      key: 'official',
      label: 'Mojang 官方',
      manifest: () => fetchBuffer('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { timeoutMs: 20000 }),
      client: clientSha1
        ? () => rangeFetch(`https://piston-data.mojang.com/v1/objects/${clientSha1}/client.jar`, 1024 * 1024)
        : null,
      maven: () => rangeFetch(`https://libraries.minecraft.net/${mavenRel}`, 256 * 1024),
    },
  ]

  for (const t of targets) {
    const manifestR = await timeIt(async () => (await t.manifest()).length)
    const clientR = t.client ? await timeIt(async () => await t.client()) : { ok: false, ms: 0, bytes: 0, error: '没有 sha1' }
    const mavenR = await timeIt(async () => await t.maven())
    const parts = [manifestR, clientR, mavenR]
    const okCount = parts.filter((p) => p.ok).length
    const throughput = clientR.ok && clientR.ms > 0 ? Math.round((clientR.bytes / clientR.ms) * 1000) : 0
    rows.push({
      key: t.key,
      label: t.label,
      manifest: manifestR,
      client: clientR,
      maven: mavenR,
      okCount,
      score: okCount,
      throughputBps: throughput,
      avgMs: Math.round(parts.reduce((s, p) => s + (p.ms || 0), 0) / parts.length),
    })
  }

  rows.sort((a, b) => b.score - a.score || b.throughputBps - a.throughputBps || a.avgMs - b.avgMs)
  const best = rows[0] || null
  const mirrorRow = rows.find((r) => r.key === 'mirror')
  const officialRow = rows.find((r) => r.key === 'official')
  let recommendation = 'mirror-first'
  if (best && best.key === 'official' && officialRow && mirrorRow) {
    const faster = mirrorRow.throughputBps > 0 && officialRow.throughputBps > mirrorRow.throughputBps * 1.3
    const mirrorBroken = mirrorRow.score < officialRow.score
    if (faster || mirrorBroken) recommendation = 'official-first'
  }
  return {
    version: ver,
    mirror: base,
    rows,
    best: best ? best.key : null,
    recommendation,
    note:
      recommendation === 'official-first'
        ? '官方源这次明显更快（镜像的 /assets 还会 302 到签名 CDN）。可以到设置页把「下载源偏好」改成官方优先。'
        : '镜像表现不差，保持「镜像优先」即可。',
  }
}
