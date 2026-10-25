/**
 * skin.js —— 正版皮肤管理（PCL 的「换肤」）。
 *
 * 三个动作都走 api.minecraftservices.com，需要**正版 Minecraft access token**：
 *   GET    /minecraft/profile          → 读当前皮肤/披风（令牌只在本模块内用，绝不回给浏览器）
 *   POST   /minecraft/profile/skins    → 按 URL 换肤（body: {variant, url}）
 *   DELETE /minecraft/profile/skins    → 恢复默认皮肤
 *
 * 离线账号没有这项能力（换肤是账号服务端行为）——如实拒绝，不假装能做。
 */

const API = 'https://api.minecraftservices.com'

async function callWithToken(token, pathname, init) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const msg = (json && (json.errorMessage || json.error || json.path)) || text.slice(0, 200) || 'HTTP ' + res.status
    const err = new Error(`Mojang 返回 ${res.status}：${msg}`)
    err.status = res.status
    throw err
  }
  return json || {}
}

/** 读当前账号的皮肤/披风（返回可直接给浏览器看的信息，不含 token）。 */
export async function currentProfile(account) {
  if (!account || !account.accessToken) throw new Error('没有可用的正版令牌：先在「启动」页签登录正版账号')
  const json = await callWithToken(account.accessToken, '/minecraft/profile', { method: 'GET' })
  return {
    name: json.name || account.name || null,
    uuid: json.id || account.uuid || null,
    skins: Array.isArray(json.skins)
      ? json.skins.map((s) => ({ id: s.id, state: s.state, url: s.url, variant: s.variant, alias: s.alias || null }))
      : [],
    capes: Array.isArray(json.capes) ? json.capes.map((c) => ({ id: c.id, state: c.state, url: c.url, alias: c.alias || null })) : [],
  }
}

/** 按 URL 换肤。variant: 'classic'（经典/Steve 手臂）| 'slim'（细手臂/Alex）。 */
export async function setSkinFromUrl(account, { url, variant = 'classic' }) {
  if (!account || !account.accessToken) throw new Error('没有可用的正版令牌：先在「启动」页签登录正版账号')
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new Error('皮肤地址必须是 http(s) URL')
  const v = String(variant || '').toLowerCase() === 'slim' ? 'slim' : 'classic'
  await callWithToken(account.accessToken, '/minecraft/profile/skins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant: v, url: target }),
  })
  return { ok: true, variant: v, url: target }
}

/** 恢复默认皮肤。 */
export async function resetSkin(account) {
  if (!account || !account.accessToken) throw new Error('没有可用的正版令牌：先在「启动」页签登录正版账号')
  await callWithToken(account.accessToken, '/minecraft/profile/skins', { method: 'DELETE' })
  return { ok: true }
}
