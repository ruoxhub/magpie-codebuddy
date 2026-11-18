// 登录：浏览器设备授权、本机 CodeBuddy IDE 登录复用、API key。
//
// 端点与请求头对齐 new-api 的 internal/relay/channel/codebuddy/oauth.go，
// 并在本机实测过 CodeBuddy IDE 的登录文件格式（见 readDesktop）。

import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// oauthBrowserUserAgent 是账号域请求使用的浏览器 UA。
//
// CodeBuddy 网关会校验 UA 的存在性：缺失时计费与账号接口返回 HTTP 403 / code=10085。
// 账号域不是 CLI 通道，这里用浏览器 UA —— 与官方桌面端（Chromium）一致。
export const oauthBrowserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

// 轮询节奏：前端等待授权的最长时间与轮询间隔。
const SIGN_IN_MS = 10 * 60 * 1000
const POLL_MS = 2000

// pendingCode 是 /auth/token 在「用户尚未完成授权」时返回的业务码。
const pendingCode = 11217

// hex 返回 16 字节随机数的 hex。
const hex = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("")

// setAccountHeaders 补齐账号域请求的固定请求头。
//
// X-No-* 显式声明「本次请求不要用网关默认用户上下文」，避免把令牌绑到错误主体上。
// X-No-Authorization 只用在未带 Authorization 头的请求上：带上 Authorization 的请求
// 发这个头反而自相矛盾。
export function setAccountHeaders(headers, { authorization = "" } = {}) {
  headers.set("User-Agent", oauthBrowserUserAgent)
  if (!authorization) headers.set("X-No-Authorization", "true")
  headers.set("X-No-User-Id", "true")
  headers.set("X-No-Enterprise-Id", "true")
  headers.set("X-No-Department-Info", "true")
}

// apiCall 请求账号域，读 {code, msg, data} 信封；code 非 0/200 视为错误。
async function apiCall(site, method, path, { headers = {}, body, signal } = {}) {
  const h = new Headers({ Accept: "application/json", ...headers })
  if (body !== undefined) h.set("Content-Type", "application/json")
  const res = await fetch(site.account + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    // 上游偶尔回裸 HTML（401），保持 env 为空
  }
  const code = Number.parseInt(env.code, 10) || 0
  const error = new Error(`${site.name}: ${env.msg || env.message || text.slice(0, 200) || res.statusText} (HTTP ${res.status}${code ? ", code " + code : ""})`)
  error.status = res.status
  error.code = code
  if (!res.ok) throw error
  if (code !== 0 && code !== 200) throw error
  return env.data ?? {}
}

// expiresAtOf 优先采用响应里的 expiresAt；缺失时从 JWT 访问令牌的 exp 声明解析，
// 保证自动刷新能正常工作。
export function expiresAtOf(accessToken, expiresAt) {
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt
  if (typeof accessToken !== "string" || !accessToken) return 0
  const parts = accessToken.split(".")
  if (parts.length < 2) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    return Number.isFinite(payload?.exp) && payload.exp > 0 ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

// startSignIn 请求 /v2/plugin/auth/state，返回授权地址与 state。
export async function startSignIn(site, { signal } = {}) {
  const data = await apiCall(site, "POST", `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, {
    headers: { "Content-Type": "application/json" },
    body: {},
    signal,
  })
  const state = typeof data.state === "string" ? data.state : ""
  if (!state) throw new Error(`${site.name} 没有返回 state`)
  const authURL = data.authUrl || data.auth_url || data.url || `${site.account}/login?platform=${site.platform}&state=${state}`
  const url = new URL(authURL)
  if (url.protocol !== "https:") throw new Error(`${site.name} 的登录页不是 https`)
  // loginSessionId 让同一浏览器的多次登录互不覆盖（与官方 IDE 一致）
  url.searchParams.set("loginSessionId", hex())
  return { state, url: url.toString() }
}

// pollToken 查一次 /auth/token；未完成授权时 got=false，属预期轮询状态而非错误。
export async function pollToken(site, state, { signal } = {}) {
  const h = new Headers({ Accept: "application/json" })
  setAccountHeaders(h)
  const res = await fetch(`${site.account}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    headers: h,
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    return { got: false }
  }
  const data = env.data ?? {}
  if (typeof data.accessToken !== "string" || !data.accessToken) return { got: false, code: Number.parseInt(env.code, 10) || 0 }
  return { got: true, token: tokenOf(data) }
}

// tokenOf 把 /auth/token 或 /auth/token/refresh 的 data 读成统一令牌形态。
export function tokenOf(data) {
  return {
    access: data.accessToken ?? data.access_token ?? "",
    refresh: data.refreshToken ?? data.refresh_token ?? "",
    tokenType: data.tokenType ?? data.token_type ?? "",
    expires: expiresAtOf(data.accessToken ?? data.access_token ?? "", data.expiresAt ?? data.expires_at ?? 0),
    domain: data.domain ?? "",
  }
}

// waitForToken 轮询 /auth/token 直到拿到令牌、超时或取消。
//
// interval 可以在测试里改小；默认 POLL_MS。
export async function waitForToken(site, state, { signal, deadline = Date.now() + SIGN_IN_MS, interval = POLL_MS } = {}) {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("登录已取消", "AbortError")
    let got
    try {
      got = await pollToken(site, state, { signal })
    } catch (e) {
      // 网络抖动不中断轮询，交由超时兜底
      if (signal?.aborted) throw e
      got = { got: false }
    }
    if (got.got) return got.token
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`${site.name} 授权超时（${Math.round(SIGN_IN_MS / 60000)} 分钟）`)
}

// fetchAccount 用刚获取的令牌拉取账号信息（uid / 昵称 / 企业等）。
export async function fetchAccount(site, accessToken, state, domain, { signal } = {}) {
  const h = new Headers({ Accept: "application/json", Authorization: "Bearer " + accessToken })
  setAccountHeaders(h, { authorization: accessToken })
  if (domain) h.set("X-Domain", domain)
  const res = await fetch(`${site.account}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    headers: h,
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error(`${site.name} 的账号信息读不出来（HTTP ${res.status}）`)
  }
  const code = Number.parseInt(env.code, 10) || 0
  if (code !== 0 && code !== 200) throw new Error(`${site.name} 返回账号信息失败 (code ${code})`)
  const data = env.data ?? {}
  return {
    uid: data.uid ?? "",
    nickname: data.nickname ?? "",
    email: data.email ?? "",
    enterpriseId: data.enterpriseId ?? "",
    enterpriseName: data.enterpriseName ?? "",
  }
}

// refreshToken 用 refresh_token 换取新的访问令牌。
// 需要同时携带当前 access_token 与 X-Refresh-Token，与官方 IDE 一致。
export async function refreshToken(site, access, refresh, domain, { signal } = {}) {
  const h = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: "Bearer " + access,
    "X-Refresh-Token": refresh,
    // 刷新来源声明「来自 IDE 主通道」，与官方 IDE 一致
    "X-Auth-Refresh-Source": "ide-main",
  })
  setAccountHeaders(h, { authorization: access })
  if (domain) h.set("X-Domain", domain)
  const res = await fetch(site.account + "/v2/plugin/auth/token/refresh", {
    method: "POST",
    headers: h,
    body: "{}",
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    throw Object.assign(new Error(`${site.name} 刷新令牌失败（HTTP ${res.status}）`), { status: res.status })
  }
  const code = Number.parseInt(env.code, 10) || 0
  if (code !== 0 && code !== 200) {
    throw Object.assign(new Error(`${site.name} 刷新令牌失败 (code ${code})：${env.msg ?? ""}`), { status: res.status, code })
  }
  const token = tokenOf(env.data ?? {})
  if (!token.access) throw Object.assign(new Error(`${site.name} 刷新令牌响应缺少 accessToken`), { status: res.status })
  return token
}

// ---- 本机 CodeBuddy IDE 的登录 -------------------------------------------------

// desktopAuthDir 是 CodeBuddy IDE 存登录信息的目录。
//
// 路径取自实测：Windows %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth，
// macOS ~/Library/Application Support/CodeBuddyExtension/…，Linux ~/.local/share/…。
export function desktopAuthDir(env = process.env, platform = process.platform, home = homedir()) {
  const base =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "CodeBuddyExtension")
      : platform === "win32"
        ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "CodeBuddyExtension")
        : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "CodeBuddyExtension")
  return join(base, "Data", "Public", "auth")
}

// desktopFileOf 返回该站点桌面登录文件的路径。
//
// 优先不带时间戳的 <authID>.info（当前登录）；没有时取最新的带时间戳快照 ——
// IDE 升级或重新登录会留下 <authID>.<时间>.<pid>.<uuid>.info，当前文件缺失时它是
// 唯一可用的线索。
export function desktopFileOf(site, dir = desktopAuthDir()) {
  const base = join(dir, site.desktopAuthID + ".info")
  try {
    if (statSync(base).isFile()) return base
  } catch {
    // 当前文件不存在，往下找快照
  }
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const snapshots = names
    .filter((n) => n.startsWith(site.desktopAuthID + ".") && n.endsWith(".info"))
    .map((n) => join(dir, n))
    .map((p) => {
      try {
        return { p, at: statSync(p).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
  return snapshots.length ? snapshots[0].p : null
}

// importedAccounts 把粘贴进来的一段文本读成若干份登录。
//
// 接受的形态（都是实测过的真实来源）：
//   1. CodeBuddy IDE 的登录文件原样：{ account: { uid, nickname }, auth: { accessToken,
//      refreshToken, expiresAt, domain, tokenType } } —— 与 readDesktop 同格式，
//      从 ~/.codebuddy/*.info 拷出来直接贴就行
//   2. 浏览器登录导出的扁平形态：{ access, refresh, expires, uid, domain }
//      （就是插件自己存进 magpie 的那份）
//   3. snake_case 的导出（workbuddy / sub2api 这类工具导出的）：
//      { uid, nickname, access_token, refresh_token, token_type, expires_at, domain }
//   4. 数组，或 { accounts: [...] }，一次贴多个
//   5. 每行一个 accessToken 的纯文本
//
// 字段名 camelCase 与 snake_case 都收，因为导出源头各不相同，同一个东西四种写法，
// 让用户去改成我们喜欢的那种只会让人贴错。
//
// 只有 refresh_token、没有 access_token 也收：实测（2026-11-18，国际版）
// access 传空字符串照样能换出新 access，所以这种导出是可恢复的，由调用方去刷。
//
// 两个都空 ❗ 不算有效条目：那不是登录，是一个空壳记录。
export function importedAccounts(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return []
  let parsed
  let isJSON = true
  try {
    parsed = JSON.parse(raw)
  } catch {
    isJSON = false
  }
  const found = []
  // 取值助手：同一含义的多种写法按优先级取第一个非空值。
  const str = (...vals) => vals.find((v) => typeof v === "string" && v.trim())?.trim() ?? ""
  const num = (...vals) => vals.find((v) => Number.isFinite(v) && v > 0) ?? 0
  // pick 从一份对象里读出登录，读不出返回 null。
  const pick = (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null
    // IDE 文件形态：令牌在 auth 下，账号信息在 account 下
    const a = o.auth && typeof o.auth === "object" ? o.auth : o
    // 桌面端加密过的令牌是对象而不是字符串，读不出明文就不算有令牌
    for (const v of [a.accessToken, a.access_token]) {
      if (v && typeof v === "object") return "encrypted"
    }
    const access = str(a.accessToken, a.access_token, a.access, o.access, o.accessToken, o.access_token)
    const refresh = str(a.refreshToken, a.refresh_token, a.refresh, o.refresh, o.refreshToken, o.refresh_token)
    // 两样都没有就不是登录（常见于工具导出里被清空的记录）
    if (!access && !refresh) return null
    const account = o.account && typeof o.account === "object" ? o.account : o
    const uid = str(account.uid, o.uid, o.user_id, o.userId)
    const domain = str(a.domain, o.domain)
    const tokenType = str(a.tokenType, a.token_type, o.tokenType, o.token_type)
    // email 也当名字用：有些导出把昵称塞在 email 里
    const name = str(account.nickname, o.nickname, o.name, o.account_name, o.email, account.email)
    // 绝对时间戳优先；否则从 expires_in / expiresIn（相对秒数）算；再否则读 JWT
    let expires = num(a.expiresAt, a.expires_at, o.expiresAt, o.expires_at, a.expires, o.expires)
    if (expires > 0 && expires < 1e12) expires *= 1000
    if (!expires) {
      const rel = num(a.expiresIn, a.expires_in, o.expiresIn, o.expires_in)
      if (rel > 0) expires = Date.now() + rel * 1000
    }
    if (!expires && access) expires = expiresAtOf(access, 0)
    const enter = str(account.enterpriseId, account.enterprise_id, o.enterpriseId, o.enterprise_id)
    return { access, refresh, expires, uid, domain, tokenType, name, enterpriseId: enter }
  }
  const take = (o) => {
    const got = pick(o)
    if (got === "encrypted") throw new Error("这份登录的令牌是加密的（桌面端 5.6 起），读不出明文；请用浏览器登录，或从 IDE 拷未加密的那份")
    if (got) found.push(got)
    else if (Array.isArray(o?.accounts)) o.accounts.forEach(take)
    return got
  }
  if (isJSON) {
    if (Array.isArray(parsed)) parsed.forEach(take)
    else if (parsed && typeof parsed === "object") take(parsed)
  } else {
    // 纯文本：每行一个令牌，空行与 # 开头的注释行跳过
    for (const line of raw.split(/\r?\n/)) {
      const l = line.trim()
      if (!l || l.startsWith("#")) continue
      found.push({ access: l, refresh: "", expires: expiresAtOf(l, 0), uid: "", domain: "", tokenType: "", name: "", enterpriseId: "" })
    }
  }
  return found
}
// readDesktop 读 CodeBuddy IDE 的登录信息，读不到返回 { error }。
//
// 文件形态（实测 2026-11-14，Tencent-Cloud.coding-copilot.info）：
//   { account: { uid, nickname, type }, auth: { accessToken, refreshToken,
//     expiresAt, refreshExpiresAt, tokenType, domain } }
// 时间戳是毫秒 epoch。WorkBuddy 桌面端从 5.6 起把令牌加密存储
// （{ $wbEncrypted: 1, envelope }），那种文件读不出令牌，只能走浏览器登录。
export function readDesktop(site, file = desktopFileOf(site)) {
  if (!file) return { error: `${site.name} 的 IDE 没有登录信息（没装或没登录）` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { error: `${site.name} 的 IDE 登录文件读不出来` }
  }
  const auth = parsed?.auth ?? {}
  if (auth.accessToken && typeof auth.accessToken === "object") {
    return { error: `${site.name} 的桌面端把登录信息加密了，读不出令牌；请用浏览器登录` }
  }
  const access = typeof auth.accessToken === "string" ? auth.accessToken : ""
  const uid = typeof parsed?.account?.uid === "string" ? parsed.account.uid : ""
  if (!access || !uid) return { error: `${site.name} 的 IDE 没有登录信息（没装或没登录）` }
  // 站点必须与文件里的 domain 一致：国区与国际版的账号是同一套令牌，
  // 但请求要打到各自区域的域。domain 对不上说明这份登录不是这个站点的。
  const domain = typeof auth.domain === "string" ? auth.domain : ""
  if (domain && domain.toLowerCase() !== site.domain.toLowerCase()) {
    return { error: `${site.name} 的 IDE 登录在 ${domain}，与本站点 ${site.domain} 不是同一个区` }
  }
  const now = Date.now()
  return {
    access,
    refresh: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expires: Number.isFinite(auth.expiresAt) && auth.expiresAt > 0 ? auth.expiresAt : Number.isFinite(auth.expiresIn) && auth.expiresIn > 0 ? now + auth.expiresIn * 1000 : 0,
    domain,
    tokenType: typeof auth.tokenType === "string" ? auth.tokenType : "",
    uid,
    name: parsed?.account?.nickname || uid,
    // 每次请求都重读文件：用户在 IDE 里重新登录后，这里自动跟上
    source: "desktop",
    file,
  }
}
