/**
 * skin-routes.js —— 皮肤管理的 HTTP 门面（/mc/skin/*）。
 * 令牌只从 msa 的账号文件里取，**任何响应都不含 token**。
 */
import { ensureFreshAccount, LEGACY_CLIENT_ID, readAccount } from './msa.js'
import { currentProfile, resetSkin, setSkinFromUrl } from './skin.js'

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

export function makeSkinHandler({ root, resolveConfig }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const sub = (url.pathname.startsWith('/mc/skin') ? url.pathname.slice('/mc/skin'.length) : url.pathname).replace(/\/+$/, '') || '/current'
      const method = (req.method || 'GET').toUpperCase()

      const acc = readAccount(root)
      if (!acc) {
        return sendJson(res, 409, { ok: false, error: '还没登录正版账号（换肤是账号服务端行为，离线账号做不了）' })
      }
      const cfg = resolveConfig()
      const clientId = String(cfg.msClientId || '').trim() || LEGACY_CLIENT_ID
      const fresh = await ensureFreshAccount(root, clientId)
      if (!fresh) return sendJson(res, 409, { ok: false, error: '正版令牌已失效，请重新登录' })

      if (sub === '/current') {
        const profile = await currentProfile(fresh)
        return sendJson(res, 200, { ok: true, profile })
      }

      if (sub === '/set' && method === 'POST') {
        const body = await readBody(req)
        const out = await setSkinFromUrl(fresh, { url: body?.url, variant: body?.variant })
        const profile = await currentProfile(fresh)
        return sendJson(res, 200, { ok: true, ...out, profile })
      }

      if (sub === '/reset' && method === 'POST') {
        const out = await resetSkin(fresh)
        const profile = await currentProfile(fresh)
        return sendJson(res, 200, { ok: true, ...out, profile })
      }

      return sendJson(res, 404, { ok: false, error: 'no such route: ' + sub })
    } catch (err) {
      try {
        return sendJson(res, err?.status === 401 ? 401 : 400, { ok: false, error: String(err?.message || err) })
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
