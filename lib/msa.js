/**
 * msa.js —— 微软正版登录（Microsoft Account → Xbox Live → Minecraft）。
 *
 * 六个步骤（与 PCL 的 ModLaunch.vb:880-1090 完全一致）：
 *   1. 拿微软 OAuth AccessToken      —— 两种前端流程，见下
 *   2. XBL：user.auth.xboxlive.com    —— RpsTicket "d=<ms token>" → XBL Token
 *   3. XSTS：xsts.auth.xboxlive.com   —— → { XSTS Token, UHS }
 *   4. MC：/authentication/login_with_xbox  { identityToken: "XBL3.0 x=<uhs>;<xsts>" } → MC token
 *   5. 权益：/entitlements/mcstore    —— 没有 items 说明没买游戏 / XGP 到期
 *   6. 档案：/minecraft/profile       —— → { id(uuid), name }
 *
 * 两个前端流程（差别只在第 1 步）：
 *   A. auth-code（默认，零配置）：用历史公共 id `00000000402b5328` 打开 login.live.com 授权页，
 *      用户登录后浏览器会跳到 `https://login.live.com/oauth20_desktop.srf?code=...`，
 *      把那条 URL（或只把 code）粘回来 → 换 token。实测该授权页仍返回 200。
 *   B. device-code（需自备 Entra client id）：v2.0 设备码端点要求「已登记、接受个人账户、
 *      公共客户端」的应用。实测三个历史公共 id 在 /consumers 下全部 AADSTS700016，
 *      所以这条路必须填自己的 client id（免费登记，见 README）。
 *
 * 安全约定：refresh token / MC access token 只落在 <插件根>/.mc-launch/account.json（0600），
 * 绝不通过 GET 路由回传给浏览器；路由只回 { name, uuid, mode, expiresAt } 这类展示字段。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const LEGACY_CLIENT_ID = '00000000402b5328' // Live Connect 应用（auth-code 流程使用）
const LEGACY_REDIRECT = 'https://login.live.com/oauth20_desktop.srf'
const LEGACY_SCOPE = 'XboxLive.signin offline_access'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'
const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
const V2_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'

/** 把上游的错误翻译成人能看懂的一句话（含 PCL 收录的 XSTS 错误码解释）。 */
function explain(msg, status) {
  const text = String(msg || '')
  const rules = [
    ['2148916227', '该 Xbox 账号已被微软封禁，无法登录。'],
    ['2148916233', '这个微软账号还没有注册 Xbox 账户，请先去注册。'],
    ['2148916235', '你所在的国家/地区无法登录 Xbox 账号，请换网络环境（加速器/VPN）。'],
    ['2148916238', '账号年龄不足 13 岁（或出生日期未填），需要先修改出生日期。'],
    ['ACCOUNT_SUSPENDED', '该 Minecraft 账号已被封禁。'],
    ['must sign in again', '授权已失效，需要重新登录。'],
    ['service abuse', '该账号被微软判定为滥用并封禁。'],
    ['invalid_grant', '授权码无效或已过期（每次登录只能用一次），重新点一次登录再试。'],
    ['unauthorized_client', '这个 client id 没有登记为「公共客户端并允许个人账户」，无法用于此流程。'],
  ]
  for (const [key, human] of rules) if (text.includes(key)) return human
  if (status === 429) return '登录尝试太频繁（429），等几分钟再试。'
  if (status === 403) return '当前 IP 的登录尝试异常（403）。用了 VPN/加速器的话换节点或关掉再试。'
  if (status === 503) return 'Mojang 服务器暂时不可用（503），稍后再试。'
  if (status === 404) return '这个账号还没有 Minecraft 玩家档案，先去 minecraft.net 建一个名字。'
  return null
}

async function postJson(url, body, { headers, timeoutMs = 25000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 就把原文当错误信息 */
  }
  if (!res.ok) {
    const human = explain(text, res.status)
    const err = new Error(human || `HTTP ${res.status} ${url} ${text.slice(0, 200)}`)
    err.status = res.status
    err.upstream = text.slice(0, 600)
    err.human = human
    throw err
  }
  return json || {}
}

async function postForm(url, params, { headers, timeoutMs = 25000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(headers || {}) },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 同上 */
  }
  return { ok: res.ok, status: res.status, json: json || {}, text }
}

// ---------------------------------------------------------------- 流程 A：授权码
/** 生成让用户去登录的授权页 URL。 */
export function buildAuthCodeUrl(clientId = LEGACY_CLIENT_ID) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: LEGACY_REDIRECT,
    scope: LEGACY_SCOPE,
    display: 'touch',
    prompt: 'select_account',
  })
  return `https://login.live.com/oauth20_authorize.srf?${q.toString()}`
}

/** 从用户粘回来的东西里抠出 code：整条 URL 或纯 code 都接受。 */
export function parseAuthCode(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const m = /[?&]code=([^&\s]+)/.exec(raw)
  if (m) return decodeURIComponent(m[1])
  // 明显不是 URL 的话，当作用户只复制了 code
  if (!/^https?:/i.test(raw) && raw.length > 8) return raw
  return null
}

/** 用授权码换微软 token。 */
export async function exchangeAuthCode(code, clientId = LEGACY_CLIENT_ID) {
  const r = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id: clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: LEGACY_REDIRECT,
    scope: LEGACY_SCOPE,
  })
  if (!r.ok || !r.json?.access_token) {
    const human = explain(r.text, r.status) || `授权码换取 token 失败（HTTP ${r.status}）`
    const err = new Error(human)
    err.upstream = r.text.slice(0, 600)
    throw err
  }
  return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token || '' }
}

// ---------------------------------------------------------------- 流程 B：设备码
export async function startDeviceCode(clientId) {
  if (!clientId) throw new Error('设备码登录需要自己的 Entra client id（配置项 msClientId）')
  const r = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: LEGACY_SCOPE })
  if (!r.ok || !r.json?.device_code) {
    const human = explain(r.text, r.status)
    const err = new Error(
      human || r.json?.error_description || `设备码申请失败（HTTP ${r.status}）。这个 client id 可能没有登记为「公共客户端 + 允许个人账户」。`,
    )
    err.upstream = r.text.slice(0, 600)
    throw err
  }
  return {
    deviceCode: r.json.device_code,
    userCode: r.json.user_code,
    verificationUri: r.json.verification_uri,
    expiresIn: r.json.expires_in,
    interval: r.json.interval || 5,
  }
}

export async function pollDeviceCode(deviceCode, clientId) {
  const r = await postForm(V2_TOKEN_URL, {
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  })
  if (r.ok && r.json?.access_token) {
    return { status: 'ok', accessToken: r.json.access_token, refreshToken: r.json.refresh_token || '' }
  }
  const err = String(r.json?.error || '')
  if (err === 'authorization_pending') return { status: 'pending' }
  if (err === 'slow_down') return { status: 'slow_down' }
  if (err === 'expired_token') return { status: 'expired' }
  if (err === 'authorization_declined') return { status: 'declined' }
  const human = explain(r.text, r.status)
  const e = new Error(human || r.json?.error_description || `设备码轮询失败（HTTP ${r.status}）`)
  e.upstream = r.text.slice(0, 600)
  throw e
}

/** 用 refresh token 换新的微软 access token（长期免登录靠它）。 */
export async function refreshMicrosoftToken(refreshToken, clientId = LEGACY_CLIENT_ID) {
  const r = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: LEGACY_SCOPE,
  })
  if (r.ok && r.json?.access_token) {
    return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token || refreshToken, needRelogin: false }
  }
  const text = String(r.text || '')
  const needRelogin = /refresh_token|must sign in again|invalid_grant|expired/i.test(text)
  const err = new Error(explain(text, r.status) || `刷新登录失败（HTTP ${r.status}）`)
  err.needRelogin = needRelogin
  err.upstream = text.slice(0, 600)
  throw err
}

// ---------------------------------------------------------------- 步骤 2-6
export async function authenticateXboxLive(msAccessToken) {
  const json = await postJson(XBL_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: (String(msAccessToken).startsWith('d=') ? '' : 'd=') + msAccessToken,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })
  if (!json?.Token) throw new Error('Xbox Live 认证没有返回 Token')
  return json.Token
}

export async function authorizeXsts(xblToken) {
  const json = await postJson(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })
  const uhs = json?.DisplayClaims?.xui?.[0]?.uhs
  if (!json?.Token || !uhs) throw new Error('XSTS 授权没有返回 Token/UHS')
  return { xstsToken: json.Token, uhs }
}

export async function loginWithXbox(xstsToken, uhs) {
  const json = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
  if (!json?.access_token) throw new Error('Minecraft 登录没有返回 access_token')
  const expiresIn = Number(json.expires_in) || 86400
  return { accessToken: json.access_token, expiresAt: Date.now() + Math.max(60, expiresIn - 3600) * 1000 }
}

export async function checkEntitlements(mcAccessToken) {
  const res = await fetch(MC_ENTITLEMENTS_URL, {
    headers: { authorization: 'Bearer ' + mcAccessToken, accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(explain(text, res.status) || `权益检查失败（HTTP ${res.status}）`)
    err.status = res.status
    throw err
  }
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {
    /* 忽略 */
  }
  const items = Array.isArray(json.items) ? json.items : []
  return { owned: items.length > 0, items: items.map((i) => i.name).filter(Boolean) }
}

export async function getMinecraftProfile(mcAccessToken) {
  const res = await fetch(MC_PROFILE_URL, {
    headers: { authorization: 'Bearer ' + mcAccessToken, accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  if (res.status === 404) {
    const err = new Error('这个账号还没有 Minecraft 玩家档案（先去 minecraft.net 建一个）。')
    err.status = 404
    throw err
  }
  if (!res.ok) {
    const err = new Error(explain(text, res.status) || `获取 MC 档案失败（HTTP ${res.status}）`)
    err.status = res.status
    throw err
  }
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('MC 档案返回的不是 JSON')
  }
  if (!json.id || !json.name) throw new Error('MC 档案缺少 id/name')
  return { uuid: json.id, name: json.name, skins: json.skins || [], capes: json.capes || [] }
}

/** 拿到微软 token 之后，跑完 2→6 步。 */
export async function completeFromMicrosoftToken(msAccessToken) {
  const xbl = await authenticateXboxLive(msAccessToken)
  const { xstsToken, uhs } = await authorizeXsts(xbl)
  const mc = await loginWithXbox(xstsToken, uhs)
  const ent = await checkEntitlements(mc.accessToken)
  const profile = await getMinecraftProfile(mc.accessToken)
  return { ...mc, owned: ent.owned, entitlements: ent.items, uuid: profile.uuid, name: profile.name, skins: profile.skins }
}

// ---------------------------------------------------------------- 账号持久化（多账号）
/**
 * 存储：`.mc-launch/accounts.json` = { version:1, active:<uuid>, accounts:[{...}] }
 * 兼容旧版单账号文件 `.mc-launch/account.json` —— 读到就自动迁移成多账号格式（active = 它）。
 * 令牌只在这层出现，对外（describeAccount / 路由）只给展示字段。
 */

export function accountsFile(root) {
  return path.join(root, '.mc-launch', 'accounts.json')
}

/** 兼容旧版：单账号文件。 */
export function accountFile(root) {
  return path.join(root, '.mc-launch', 'account.json')
}

function emptyStore() {
  return { version: 1, active: null, accounts: [] }
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null
  const uuid = String(raw.uuid || '').trim()
  if (!uuid) return null
  return {
    uuid,
    name: raw.name || null,
    msRefreshToken: raw.msRefreshToken || '',
    mcAccessToken: raw.mcAccessToken || '',
    mcExpiresAt: Number(raw.mcExpiresAt) || 0,
    owned: raw.owned !== false,
    entitlements: Array.isArray(raw.entitlements) ? raw.entitlements : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

/** 读整个存储（必要时把旧单账号文件迁进来）。 */
export function readStore(root) {
  const file = accountsFile(root)
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      const accounts = (Array.isArray(j?.accounts) ? j.accounts : []).map(normalizeAccount).filter(Boolean)
      let active = j?.active && accounts.some((a) => a.uuid === j.active) ? String(j.active) : null
      if (!active && accounts.length) active = accounts[0].uuid
      return { version: 1, active, accounts }
    } catch {
      return emptyStore()
    }
  }
  // 迁移旧单账号
  const legacy = accountFile(root)
  if (existsSync(legacy)) {
    try {
      const raw = JSON.parse(readFileSync(legacy, 'utf8'))
      const acc = normalizeAccount(raw)
      if (acc) {
        const store = { version: 1, active: acc.uuid, accounts: [acc] }
        try {
          writeStore(root, store)
        } catch {
          /* 迁移失败那就先用内存里的 */
        }
        return store
      }
    } catch {
      /* 坏文件当没有 */
    }
  }
  return emptyStore()
}

export function writeStore(root, store) {
  const file = accountsFile(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows 上 chmod 基本是空操作 */
  }
  return store
}

/** 取某个账号（默认当前活动账号）。 */
export function readAccount(root, uuid) {
  const store = readStore(root)
  if (!store.accounts.length) return null
  if (!uuid) return store.accounts.find((a) => a.uuid === store.active) || store.accounts[0] || null
  return store.accounts.find((a) => a.uuid === uuid) || null
}

/** 写入/更新一个账号，并把它设为活动账号。 */
export function writeAccount(root, account) {
  const acc = normalizeAccount({ ...account, updatedAt: Date.now() })
  if (!acc) throw new Error('writeAccount: 账号缺少 uuid')
  const store = readStore(root)
  const idx = store.accounts.findIndex((a) => a.uuid === acc.uuid)
  if (idx >= 0) store.accounts[idx] = acc
  else store.accounts.push(acc)
  store.active = acc.uuid
  writeStore(root, store)
  return { ...acc, updatedAt: acc.updatedAt }
}

/** 移除账号（默认当前活动账号）。 */
export function clearAccount(root, uuid) {
  const store = readStore(root)
  const target = uuid || store.active
  store.accounts = store.accounts.filter((a) => a.uuid !== target)
  store.active = store.accounts.length ? store.accounts[0].uuid : null
  writeStore(root, store)
  // 旧单账号文件也一并清掉，避免迁移逻辑把已退出的账号又带回来
  try {
    const legacy = accountFile(root)
    if (existsSync(legacy)) writeFileSync(legacy, '{}', 'utf8')
  } catch {
    /* 忽略 */
  }
  return store.accounts.length
}

/** 切换活动账号。 */
export function setActiveAccount(root, uuid) {
  const store = readStore(root)
  if (!store.accounts.some((a) => a.uuid === uuid)) throw new Error('没有这个账号: ' + uuid)
  store.active = uuid
  writeStore(root, store)
  return store.active
}

/** 账号列表（展示字段，无 token）。 */
export function listAccounts(root) {
  const store = readStore(root)
  return {
    active: store.active,
    accounts: store.accounts.map((a) => ({
      uuid: a.uuid,
      name: a.name,
      owned: a.owned,
      active: a.uuid === store.active,
      mcExpiresAt: a.mcExpiresAt || null,
      updatedAt: a.updatedAt || null,
    })),
  }
}

/** 对外展示用：**绝不包含 token**。 */
export function describeAccount(root, uuid) {
  const store = readStore(root)
  const acc = readAccount(root, uuid)
  if (!acc) return { loggedIn: false, count: 0, accounts: [] }
  const list = listAccounts(root)
  return {
    loggedIn: Boolean(acc.mcAccessToken),
    name: acc.name || null,
    uuid: acc.uuid || null,
    owned: acc.owned !== false,
    mcExpiresAt: acc.mcExpiresAt || null,
    updatedAt: acc.updatedAt || null,
    needsRefresh: Boolean(acc.mcExpiresAt && acc.mcExpiresAt < Date.now() + 10 * 60 * 1000),
    count: list.accounts.length,
    accounts: list.accounts,
    activeUuid: store.active,
  }
}

/**
 * 启动前拿一个可用的 MC token：快过期就用 refresh token 重走一遍。
 * @param {string} [uuid] 指定账号，默认活动账号
 */
export async function ensureFreshAccount(root, clientId = LEGACY_CLIENT_ID, uuid) {
  const acc = readAccount(root, uuid)
  if (!acc) return null
  if (acc.mcAccessToken && acc.mcExpiresAt && acc.mcExpiresAt > Date.now() + 5 * 60 * 1000) {
    return { accessToken: acc.mcAccessToken, uuid: acc.uuid, name: acc.name }
  }
  if (!acc.msRefreshToken) return null
  const ms = await refreshMicrosoftToken(acc.msRefreshToken, clientId)
  const done = await completeFromMicrosoftToken(ms.accessToken)
  writeAccount(root, {
    uuid: acc.uuid,
    msRefreshToken: ms.refreshToken,
    mcAccessToken: done.accessToken,
    mcExpiresAt: done.expiresAt,
    name: done.name,
    owned: done.owned,
    entitlements: done.entitlements,
  })
  return { accessToken: done.accessToken, uuid: done.uuid, name: done.name }
}
