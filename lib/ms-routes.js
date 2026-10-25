/**
 * ms-routes.js —— 正版登录的 HTTP 门面（/mc/ms/*）。
 *
 * 设计约束：
 *   · **token 永不出站**。GET 只回 name/uuid/owned/过期时间这类展示字段。
 *   · 两条前端流程都支持：auth-code（默认，零配置）与 device-code（需自备 client id）。
 *   · 设备码在内存里保存 {deviceCode, clientId}，用 flowId 换取，过期自动清理。
 */

import crypto from 'node:crypto'
import {
  LEGACY_CLIENT_ID,
  buildAuthCodeUrl,
  clearAccount,
  completeFromMicrosoftToken,
  describeAccount,
  ensureFreshAccount,
  exchangeAuthCode,
  parseAuthCode,
  pollDeviceCode,
  listAccounts,
  readAccount,
  refreshMicrosoftToken,
  setActiveAccount,
  startDeviceCode,
  writeAccount,
} from './msa.js'

const FLOW_TTL_MS = 20 * 60 * 1000
const flows = new Map() // flowId -> { deviceCode, clientId, createdAt }

function sweep() {
  const now = Date.now()
  for (const [id, f] of flows) if (now - f.createdAt > FLOW_TTL_MS) flows.delete(id)
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

/**
 * @param {object} o
 * @param {string} o.root
 * @param {() => {msClientId:string, msFlow:string}} o.resolveConfig
 */
export function makeMsHandler({ root, resolveConfig }) {
  const clientId = () => String(resolveConfig().msClientId || '').trim() || LEGACY_CLIENT_ID
  const configuredFlow = () => (resolveConfig().msFlow === 'device-code' ? 'device-code' : 'auth-code')

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const sub = (url.pathname.startsWith('/mc/ms') ? url.pathname.slice('/mc/ms'.length) : url.pathname).replace(/\/+$/, '') || '/state'
      const method = (req.method || 'GET').toUpperCase()

      if (sub === '/state') {
        sweep()
        const cfg = resolveConfig()
        const own = Boolean(String(cfg.msClientId || '').trim())
        return sendJson(res, 200, {
          ok: true,
          flow: configuredFlow(),
          clientId: own ? cfg.msClientId : LEGACY_CLIENT_ID,
          clientIdConfigured: own,
          account: describeAccount(root),
          hint: own
            ? '已配置自己的 client id，可用设备码登录（体验更好）。'
            : '用的是公共 Live Connect id，走「浏览器登录后把回跳 URL 粘回来」。想要设备码流程，在配置里填 msClientId。',
        })
      }

      if (sub === '/start' && method === 'POST') {
        sweep()
        const body = await readBody(req)
        const flow = body?.flow === 'device-code' ? 'device-code' : body?.flow === 'auth-code' ? 'auth-code' : configuredFlow()
        if (flow === 'auth-code') {
          return sendJson(res, 200, {
            ok: true,
            flow: 'auth-code',
            url: buildAuthCodeUrl(clientId()),
            hint: '在打开的页面登录微软账号；登录完成后浏览器会跳到 oauth20_desktop.srf 页面（可能是一片空白），把**地址栏那条 URL 整个复制**粘回面板。',
          })
        }
        const d = await startDeviceCode(clientId())
        const flowId = crypto.randomUUID()
        flows.set(flowId, { deviceCode: d.deviceCode, clientId: clientId(), createdAt: Date.now() })
        return sendJson(res, 200, {
          ok: true,
          flow: 'device-code',
          flowId,
          userCode: d.userCode,
          verificationUri: d.verificationUri,
          expiresIn: d.expiresIn,
          interval: d.interval,
          hint: '在打开的页面输入这个代码并登录，面板会自动轮询。',
        })
      }

      if (sub === '/poll' && method === 'POST') {
        sweep()
        const body = await readBody(req)
        const f = flows.get(String(body?.flowId || ''))
        if (!f) return sendJson(res, 410, { ok: false, error: '登录流程已过期，重新点一次登录' })
        const r = await pollDeviceCode(f.deviceCode, f.clientId)
        if (r.status !== 'ok') return sendJson(res, 200, { ok: true, status: r.status })
        flows.delete(String(body?.flowId || ''))
        const done = await completeFromMicrosoftToken(r.accessToken)
        writeAccount(root, {
          msRefreshToken: r.refreshToken,
          mcAccessToken: done.accessToken,
          mcExpiresAt: done.expiresAt,
          uuid: done.uuid,
          name: done.name,
          owned: done.owned,
          entitlements: done.entitlements,
        })
        return sendJson(res, 200, { ok: true, status: 'ok', account: describeAccount(root), mcName: done.name, owned: done.owned })
      }

      if (sub === '/complete' && method === 'POST') {
        const body = await readBody(req)
        const code = parseAuthCode(body?.input)
        if (!code) return sendJson(res, 400, { ok: false, error: '没能从粘贴内容里找到 code（整条 URL 或只是 code 都可以）' })
        const ms = await exchangeAuthCode(code, clientId())
        const done = await completeFromMicrosoftToken(ms.accessToken)
        writeAccount(root, {
          msRefreshToken: ms.refreshToken,
          mcAccessToken: done.accessToken,
          mcExpiresAt: done.expiresAt,
          uuid: done.uuid,
          name: done.name,
          owned: done.owned,
          entitlements: done.entitlements,
        })
        return sendJson(res, 200, { ok: true, account: describeAccount(root), mcName: done.name, owned: done.owned, entitlements: done.entitlements })
      }

      if (sub === '/refresh' && method === 'POST') {
        const acc = readAccount(root)
        if (!acc?.msRefreshToken) return sendJson(res, 409, { ok: false, error: '还没有登录过' })
        const ms = await refreshMicrosoftToken(acc.msRefreshToken, clientId())
        const done = await completeFromMicrosoftToken(ms.accessToken)
        writeAccount(root, {
          msRefreshToken: ms.refreshToken,
          mcAccessToken: done.accessToken,
          mcExpiresAt: done.expiresAt,
          uuid: done.uuid,
          name: done.name,
          owned: done.owned,
          entitlements: done.entitlements,
        })
        return sendJson(res, 200, { ok: true, account: describeAccount(root) })
      }

      if (sub === '/accounts') {
        return sendJson(res, 200, { ok: true, ...listAccounts(root) })
      }

      if (sub === '/switch' && method === 'POST') {
        const body = await readBody(req)
        const uuid = String(body?.uuid || '')
        if (!uuid) return sendJson(res, 400, { ok: false, error: '缺少 uuid' })
        const active = setActiveAccount(root, uuid)
        return sendJson(res, 200, { ok: true, active, account: describeAccount(root) })
      }

      if (sub === '/remove' && method === 'POST') {
        const body = await readBody(req)
        const left = clearAccount(root, body?.uuid ? String(body.uuid) : undefined)
        return sendJson(res, 200, { ok: true, left, account: describeAccount(root) })
      }

      if (sub === '/logout' && method === 'POST') {
        clearAccount(root)
        return sendJson(res, 200, { ok: true, account: describeAccount(root) })
      }

      if (sub === '/ensure' && method === 'POST') {
        // 面板/启动前确认：必要时用 refresh token 续一个可用的 MC token
        const out = await ensureFreshAccount(root, clientId())
        return sendJson(res, 200, { ok: true, ready: Boolean(out), account: describeAccount(root) })
      }

      return sendJson(res, 404, { ok: false, error: 'no such route: ' + sub })
    } catch (err) {
      try {
        return sendJson(res, 400, {
          ok: false,
          error: String(err?.human || err?.message || err),
          upstream: err?.upstream || null,
          needRelogin: Boolean(err?.needRelogin),
        })
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
