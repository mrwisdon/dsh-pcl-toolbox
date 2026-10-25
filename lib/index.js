/**
 * pcl-toolbox（PCL 工具箱 · 第三方修改版）—— host 半边。
 *
 * 同源路由（前缀 /mc）：
 *   GET  /mc/state      面板主数据源：配置 + 版本列表 + Java 列表 + 运行状态 + 日志尾巴
 *   GET  /mc/versions   只取版本列表（?refresh=1 强制重扫）
 *   POST /mc/plan       出启动计划（不启动）：Java/classpath/natives/缺失文件/命令行预览
 *   POST /mc/launch     真启动
 *   POST /mc/stop       停（Windows 用 taskkill /T /F，连带 Java 的子进程）
 *   GET  /mc/status     运行状态 + 日志尾巴 + 是否真的起来了
 *   POST /mc/open       打开实例目录里的某个子目录
 *   POST /mc/config     保存默认配置（内存/用户名/Java/上次选的版本）
 *   GET  /mc/diag       体检：目录/版本数/Java 候选/配置文件路径
 *
 * ⚠️ 路由契约：dsh-host-webserver 只按 handler(req, res) 调用，没有第三个 url 参数；
 * handler 一抛异常，宿主会在你的错误处理之前回一个空 body 的 400。所以这里自己解析 req.url，
 * 并整体 try/catch，永远回 JSON。
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  describeVersions,
  instancePaths,
  invalidateVersions,
  javaCandidates,
  launch,
  loadConfig,
  openDir,
  pluginRootFromLib,
  resolvePlan,
  saveConfig,
  status,
  stop,
} from './launch.js'
import { describeJava } from './java.js'
import { makeDownloaderHandler } from './downloader.js'
import { DEFAULT_MIRROR } from './mirror.js'
import { makeMsHandler } from './ms-routes.js'
import { makeInstanceHandler } from './inst-routes.js'
import { makeJavaHandler } from './java-routes.js'
import { makeLoaderHandler } from './loader-routes.js'
import { makeModHandler } from './mod-routes.js'
import { makePackHandler } from './pack-routes.js'
import { readSettings, writeSettings } from './settings.js'
import { DONATE_URL, BUY_URL, AUTHOR_NAME, launchStats } from './precheck.js'
import { speedtest } from './network.js'
import { makeSkinHandler } from './skin-routes.js'
import { describeAccount } from './msa.js'
import { buildAccount } from './args.js'

export const name = 'pcl-toolbox'
export const inject = ['webServer']

const ROUTE_PREFIX = '/mc'
const DOWNLOAD_PREFIX = '/mc/dl'
const MS_PREFIX = '/mc/ms'
const INST_PREFIX = '/mc/inst'
const JAVA_PREFIX = '/mc/java'
const LOADER_PREFIX = '/mc/loader'
const MOD_PREFIX = '/mc/mod'
const PACK_PREFIX = '/mc/pack'
const SKIN_PREFIX = '/mc/skin'
const ROOT = pluginRootFromLib()

/** 下载页签的配置：默认落到启动器用的 .minecraft，下完即可启动。 */
function resolveDownloadConfig() {
  const cfg = loadConfig(ROOT)
  const rawDir = String(cfg.downloadDir || '').trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '')
  const mirror = String(cfg.downloadMirror || '')
  return {
    dir: rawDir ? path.resolve(rawDir) : cfg.minecraftDir,
    concurrency: cfg.downloadConcurrency,
    mirror: /^https?:\/\//.test(mirror) ? mirror : DEFAULT_MIRROR,
    sourcePreference: cfg.downloadSourcePreference,
  }
}

const downloaderHandler = makeDownloaderHandler(resolveDownloadConfig, { prefix: DOWNLOAD_PREFIX })

const skinHandler = makeSkinHandler({
  root: ROOT,
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { msClientId: cfg.msClientId }
  },
})

const packHandler = makePackHandler({
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { minecraftDir: cfg.minecraftDir, mirror: cfg.downloadMirror || DEFAULT_MIRROR }
  },
})

const modHandler = makeModHandler({
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { minecraftDir: cfg.minecraftDir, gameDirMode: cfg.gameDirMode }
  },
})

const loaderHandler = makeLoaderHandler({
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { minecraftDir: cfg.minecraftDir, mirror: cfg.downloadMirror || DEFAULT_MIRROR }
  },
})

const javaHandler = makeJavaHandler({
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { minecraftDir: cfg.minecraftDir, mirror: cfg.downloadMirror || DEFAULT_MIRROR }
  },
})

const instanceHandler = makeInstanceHandler({
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { minecraftDir: cfg.minecraftDir, gameDirMode: cfg.gameDirMode }
  },
})

const msHandler = makeMsHandler({
  root: ROOT,
  resolveConfig: () => {
    const cfg = loadConfig(ROOT)
    return { msClientId: cfg.msClientId, msFlow: cfg.msFlow }
  },
})

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

function javaList(cfg, { limit = 12, budgetMs = 4000 } = {}) {
  const started = Date.now()
  const list = []
  for (const c of javaCandidates(cfg)) {
    if (list.length >= limit) break
    if (Date.now() - started > budgetMs) break // 探测 java -version 有成本，别把首屏拖死
    const d = describeJava(c)
    if (d.major == null && !d.ok) continue
    list.push(d)
  }
  list.sort((a, b) => (b.major ?? -1) - (a.major ?? -1))
  return list
}

function statePayload(cfg, { refresh = false } = {}) {
  const versions = describeVersions(cfg, { force: refresh })
  let st = {}
  try {
    st = status(ROOT)
  } catch {
    st = {}
  }
  const selected =
    cfg.selectedVersion && versions.some((v) => v.id === cfg.selectedVersion)
      ? cfg.selectedVersion
      : versions[0]?.id || null

  const payload = {
    ok: true,
    minecraftDir: cfg.minecraftDir,
    defaults: { memoryMb: cfg.memoryMb, username: cfg.username, java: cfg.java },
    msAccount: describeAccount(ROOT),
    msConfig: { flow: cfg.msFlow, clientIdConfigured: Boolean(String(cfg.msClientId || '').trim()) },
    javaList: javaList(cfg),
    versions,
    selected,
    running: Boolean(st.running),
    pid: st.running ? st.pid : null,
    startedAt: st.running ? st.startedAt : null,
    exitCode: st.exitCode ?? null,
    logPath: st.logPath || null,
    logTail: st.logTail || '',
    boot: st.boot || null,
    meta: st.running ? st.meta || null : null,
    lastError: st.lastError || null,
    error: null,
  }
  if (selected) {
    try {
      payload.paths = instancePaths(cfg, selected)
    } catch {
      payload.paths = null
    }
  }
  return payload
}

export function apply(ctx, _config) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      // 下载页签的路由都挂在 /mc/dl 下，交给下载引擎的 handler（同一个 HTTP 前缀，避免两个
      // prefix 路由在 '/mc' 与 '/mc-dl' 上互相截胡——prefix 匹配是按字符串前缀，'mc-dl' 会被 'mc' 吃掉）
      if (url.pathname === DOWNLOAD_PREFIX || url.pathname.startsWith(DOWNLOAD_PREFIX + '/')) {
        return await downloaderHandler(req, res)
      }
      // 正版登录
      if (url.pathname === MS_PREFIX || url.pathname.startsWith(MS_PREFIX + '/')) {
        return await msHandler(req, res)
      }
      // 实例内容管理 / 崩溃分析
      if (url.pathname === INST_PREFIX || url.pathname.startsWith(INST_PREFIX + '/')) {
        return await instanceHandler(req, res)
      }
      // Java 运行时管理
      if (url.pathname === JAVA_PREFIX || url.pathname.startsWith(JAVA_PREFIX + '/')) {
        return await javaHandler(req, res)
      }
      // 加载器安装（Fabric/Quilt/Forge/NeoForge）
      if (url.pathname === LOADER_PREFIX || url.pathname.startsWith(LOADER_PREFIX + '/')) {
        return await loaderHandler(req, res)
      }
      // 模组市场（Modrinth）
      if (url.pathname === MOD_PREFIX || url.pathname.startsWith(MOD_PREFIX + '/')) {
        return await modHandler(req, res)
      }
      // 整合包（.mrpack）
      if (url.pathname === PACK_PREFIX || url.pathname.startsWith(PACK_PREFIX + '/')) {
        return await packHandler(req, res)
      }
      // 皮肤（正版）
      if (url.pathname === SKIN_PREFIX || url.pathname.startsWith(SKIN_PREFIX + '/')) {
        return await skinHandler(req, res)
      }
      const sub = url.pathname.replace(/^\/mc/, '').replace(/\/+$/, '') || '/state'
      const method = (req.method || 'GET').toUpperCase()
      const cfg = loadConfig(ROOT)

      if (sub === '/state') {
        return sendJson(res, 200, statePayload(cfg, { refresh: url.searchParams.get('refresh') === '1' }))
      }

      if (sub === '/versions') {
        if (url.searchParams.get('refresh') === '1') invalidateVersions()
        return sendJson(res, 200, { ok: true, minecraftDir: cfg.minecraftDir, versions: describeVersions(cfg) })
      }

      if (sub === '/java') {
        return sendJson(res, 200, { ok: true, javaList: javaList(cfg, { limit: 30, budgetMs: 8000 }) })
      }

      if (sub === '/status') {
        return sendJson(res, 200, { ok: true, ...status(ROOT) })
      }

      if (sub === '/plan' && method === 'POST') {
        const body = await readBody(req)
        let accountOpt
        if (body?.accountMode === 'online') {
          const acc = describeAccount(ROOT)
          if (!acc.loggedIn) return sendJson(res, 409, { ok: false, error: '还没有登录正版账号' })
          accountOpt = {
            username: acc.name,
            uuid: acc.uuid,
            accessToken: '(stored)',
            userType: 'msa',
            mode: '正版登录',
          }
        }
        const plan = resolvePlan(cfg, {
          versionId: body?.versionId || undefined,
          memoryMb: body?.memoryMb,
          username: body?.username,
          java: body?.java || undefined,
          gameDirMode: body?.gameDirMode,
          extractNatives: false,
          account: accountOpt,
        })
        return sendJson(res, 200, {
          ok: true,
          plan: {
            versionId: plan.versionId,
            chain: plan.chain,
            mainClass: plan.mainClass,
            java: plan.java,
            javaRequired: plan.javaRequired,
            gameDir: plan.gameDir,
            classpathEntries: plan.classpathEntries,
            nativesDir: plan.nativesDir,
            nativesNote: plan.nativesNote,
            memoryMb: plan.memoryMb,
            account: plan.account,
            missing: plan.missing,
            missingCount: plan.missing.length,
            warnings: plan.warnings,
            commandPreview: plan.commandPreview,
            versionMeta: plan.versionMeta,
          },
        })
      }

      if (sub === '/launch' && method === 'POST') {
        const body = await readBody(req)
        const out = await launch(
          cfg,
          {
            versionId: body?.versionId || undefined,
            memoryMb: body?.memoryMb,
            username: body?.username,
            java: body?.java || undefined,
            gameDirMode: body?.gameDirMode,
            accountMode: body?.accountMode === 'online' ? 'online' : 'offline',
          },
          ROOT,
        )
        // 记住这次的选择，下次打开面板还是它
        try {
          saveConfig(ROOT, {
            selectedVersion: out.versionId,
            memoryMb: Number(body?.memoryMb) || cfg.memoryMb,
            username: body?.username ?? cfg.username,
          })
        } catch {
          /* 存不上不影响启动 */
        }
        return sendJson(res, 200, { ok: true, pid: out.pid, logPath: out.logPath, meta: out.meta, advice: out.advice || { launches: 0, hints: [] } })
      }

      if (sub === '/stop' && method === 'POST') {
        const out = stop(ROOT)
        return sendJson(res, out.ok ? 200 : 409, { ok: out.ok, ...out })
      }

      if (sub === '/open' && method === 'POST') {
        const body = await readBody(req)
        const out = openDir(String(body?.target || 'root'), cfg, body?.versionId || undefined)
        return sendJson(res, 200, out)
      }

      // ── 设置（带校验）与下载源测速
      if (sub === '/settings') {
        if (method === 'POST') {
          const body = await readBody(req)
          const out = writeSettings(ROOT, body || {})
          if (out.needs && out.needs.rescan) invalidateVersions()
          return sendJson(res, 200, { ok: true, ...out, settings: readSettings(ROOT) })
        }
        return sendJson(res, 200, { ok: true, ...readSettings(ROOT) })
      }

      if (sub === '/net/speedtest' && method === 'POST') {
        const out = await speedtest({ mirror: cfg.downloadMirror || DEFAULT_MIRROR })
        return sendJson(res, 200, { ok: true, ...out })
      }

      if (sub === '/config' && method === 'POST') {
        const body = await readBody(req)
        const saved = saveConfig(ROOT, body || {})
        invalidateVersions()
        return sendJson(res, 200, { ok: true, config: saved })
      }

      if (sub === '/advice') {
        return sendJson(res, 200, { ok: true, stats: launchStats(ROOT), author: AUTHOR_NAME, buyUrl: BUY_URL, donateUrl: DONATE_URL })
      }

      if (sub === '/diag') {
        const versions = describeVersions(cfg)
        const cands = javaCandidates(cfg)
        return sendJson(res, 200, {
          ok: true,
          platform: process.platform,
          node: process.version,
          pluginRoot: ROOT,
          minecraftDir: cfg.minecraftDir,
          minecraftDirExists: existsSync(cfg.minecraftDir),
          versionsDirExists: existsSync(path.join(cfg.minecraftDir, 'versions')),
          versionCount: versions.length,
          versionsWithErrors: versions.filter((v) => v.error).map((v) => ({ id: v.id, error: v.error })),
          javaCandidates: cands.length,
          stateFile: path.join(ROOT, '.mc-launch', 'state.json'),
          configFile: path.join(ROOT, 'mc-launch.config.json'),
        })
      }

      return sendJson(res, 404, { ok: false, error: 'no such route: ' + sub })
    } catch (err) {
      try {
        const msg = String(err?.message || err)
        const code = /找不到版本|没有可启动的版本/.test(msg) ? 404 : 500
        return sendJson(res, code, { ok: false, error: msg })
      } catch {
        try {
          res.destroy()
        } catch {
          /* 就这样吧 */
        }
      }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'mc-toolbox: launcher + downloader routes',
  )
}
