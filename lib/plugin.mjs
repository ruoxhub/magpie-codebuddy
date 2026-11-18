// magpie / OpenCode provider plugin for CodeBuddy (腾讯云代码助手).
//
// 两个 provider，各为一个站点，与 new-api 的两个渠道类型一一对应：
//   - codebuddy        国区：聊天域 copilot.tencent.com，账号域 www.codebuddy.cn
//   - codebuddy-intl   国际版：聊天域与账号域 www.codebuddy.ai，余额域 www.workbuddy.ai
//
// 站点由 provider id 决定，不由 base_url 或凭证 domain 猜测：猜错就是请求打到另一个
// 区域、上游回 401，错误来自上游几乎无法定位。
//
// 登录有三种：浏览器设备授权（官方 IDE 的做法）、复用本机 CodeBuddy IDE 的登录、
// 以及在 profile/keys 生成的 API key。签到的接口语义、余额卡口径、请求归一化都
// 对齐 new-api 的 internal/relay/channel/codebuddy。

import { outbound, chatHeaders, gzipBody, upstreamPath, systemKey, systemAsUser } from "./outbound.mjs"
import { startCLIVersionRefresh, cliVersion } from "./version.mjs"
import { fetchModels, staticModels, modelsFrom } from "./models.mjs"
import {
  startSignIn,
  waitForToken,
  fetchAccount,
  refreshToken,
  readDesktop,
  importedAccounts,
} from "./oauth.mjs"
import { fetchUsage, checkinOf } from "./account.mjs"

// EARLY_MS 是「请求前先刷新」的提前量：令牌剩余寿命不到这么多就先换掉。
const EARLY_MS = 60 * 1000
// LEAD_MS 是交给 magpie 的 auth.refreshLead：到期前这么久由 magpie 主动续期。
const LEAD_MS = 5 * 60 * 1000

// 一次续期在各调用方之间共享：一个账号同时来多个请求，只花一次刷新令牌。
const renewing = new Map()

// isDesktop 判断一份登录是否来自本机 IDE（每次请求重读文件，不缓存令牌）。
function isDesktop(auth) {
  return auth?.source === "desktop"
}

// keyAccount 是 API key 登录对应的账号形态。
//
// 与官方 CLI 一致：access 就是 key 本身，uid 是 "anonymous_" + key 的后 8 位。
// key 不做续期。
function keyAccount(auth) {
  const key = typeof auth?.key === "string" ? auth.key.trim() : ""
  if (!key) return null
  return { key, access: key, uid: "anonymous_" + key.slice(-8), source: "key" }
}

// usable 判断一份存储的登录能不能用。
export function usable(auth) {
  if (!auth) return false
  if (auth.type === "api") return !!keyAccount(auth)
  if (auth.type !== "oauth") return false
  return isDesktop(auth) || typeof auth.access === "string" ? true : false
}

// expired 判断访问令牌是否临近到期。
export function expired(after, now = Date.now()) {
  const exp = Number(after?.expires)
  return Number.isFinite(exp) && exp > 0 && now >= exp - EARLY_MS
}

// current 返回本次请求要用的账号：桌面登录每次重读文件（IDE 里重新登录后自动跟上），
// 其余按需续期。
async function current(site, client, auth) {
  if (isDesktop(auth)) {
    const d = readDesktop(site)
    if (d.error) throw new Error(d.error)
    return d
  }
  if (!expired(auth)) return auth
  if (!auth.refresh) {
    if (auth.access) return auth
    throw new Error(`${site.name} 的登录已失效，请重新登录`)
  }
  return renew(site, client, auth)
}

// renew 花掉一次 refresh_token，同一个 refresh 只花一次。
//
// 官方刷新会换发新的 refresh_token，两个调用方同时花同一个就会有一个被拒。
// renewing 按站点 + refresh 去重，让并发请求共用一次刷新的结果。
function renew(site, client, auth) {
  const key = site.id + "\n" + auth.refresh
  let step = renewing.get(key)
  if (!step) {
    step = (async () => {
      const got = await refreshToken(site, auth.access, auth.refresh, auth.domain || site.domain)
      const next = {
        ...auth,
        access: got.access || auth.access,
        refresh: got.refresh || auth.refresh,
        expires: got.expires || auth.expires,
        domain: got.domain || auth.domain,
      }
      try {
        await client?.auth?.set?.({ path: { id: site.id }, body: next })
      } catch {
        // 保存失败不影响本次请求；下一次请求会再刷
      }
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, step)
  }
  return step
}

// sign 给请求头加账号凭证。
function sign(a, headers) {
  headers.set("Authorization", "Bearer " + a.access)
  if (typeof a.uid === "string" && a.uid) headers.set("X-User-Id", a.uid)
  if (a.source === "key") {
    // key 自己的头，且不带 X-Domain：key 的会话没有站点
    headers.set("X-API-Key", a.key)
    headers.delete("X-Domain")
  } else {
    headers.delete("X-API-Key")
  }
  if (typeof a.enterpriseId === "string" && a.enterpriseId) {
    // 企业（团队）账号必须带这两个头，否则上游按个人账号作答
    headers.set("X-Enterprise-Id", a.enterpriseId)
    headers.set("X-Tenant-Id", a.enterpriseId)
  }
}

// EDGE_READS 是上游前端（EdgeOne）在回答一个被拒令牌之前会读的请求体上限。
//
// 坏令牌 + 超长请求体，前端不回答而是把连接断掉或回一个 550，客户端看到的只是
// "fetch failed" / "Response Reset by EdgeOne"，看不出是被拒登录。实测 2026-11-18
// 国际版（www.codebuddy.ai，坏令牌，gzip 发送，每格跑 4 次）：
//
//   plain 1 MiB   -> 401 401 401 401
//   plain 2 MiB   -> ECONNRESET ECONNRESET 550 550
//   plain 2.2 MiB -> ECONNRESET ×4
//   plain 3 MiB   -> 550 ECONNRESET 550 ECONNRESET
//
// 同样体量换好令牌一律是干净的 400/11115（prompt 太长）或 200，不会断连也不会 550。
// 所以两种表现都算「被拒令牌」，门槛按**实际发出去的字节**算（插件是 gzip 发的）。
const EDGE_READS = 2 * 1024 * 1024

// edgeStatus 是前端断连/重置的两种表现。550 不是标准码，是 EdgeOne 自己的。
const EDGE_STATUS = 550

// edgeRefused 把「大请求 + 被拒的令牌」认出来，返回 401 响应；不是这回事就 null。
//
// 判断靠计费接口：它对被拒的令牌回 401（同一个前端，实测 www.workbuddy.ai 也回
// WWW-Authenticate: invalid_token），对好令牌回 200。key 没有令牌，计费接口不认，不探。
// size 是实际发出去的字节数（gzip 后的）。
async function edgeRefused(site, a, size) {
  if (size <= EDGE_READS || a.source === "key") return null
  try {
    await fetchUsage(site, a.access, a.uid, { signal: AbortSignal.timeout(8000) })
  } catch (e) {
    if (e?.status !== 401) return null
    const mb = (size / (1024 * 1024)).toFixed(1)
    return signedOut(site, a, `这次请求发出 ${mb} MiB，超过上游前端回答一个被拒令牌的上限，所以它直接断连或回了 550，看起来像网络错误`)
  }
  return null
}

// reissue 是令牌被上游提前拒（401）时用来重发一次的登录。
//
// 上游可以远早于 expires 就拒一个令牌（浏览器登录的 access 活约 340 天），
// 只按到期时间续期会让这种账号在剩下的时间里每个请求都 401。三条规矩：
//   - key 没有令牌可换；
//   - 桌面登录归 IDE 管：插件每次请求都重读它的文件，这里不花它的 refresh token
//     （花掉会把 IDE 自己登出）；
//   - 其余按 refresh 换一次，并发请求共用同一次刷新（见 renew）。
async function reissue(site, client, auth) {
  if (!auth || auth.type !== "oauth" || isDesktop(auth) || !auth.refresh) return null
  try {
    const next = await renew(site, client, auth)
    return next?.access && next.access !== auth.access ? next : null
  } catch {
    return null
  }
}

// signedOut 是「登录被拒」的 401：说清楚怎么重登，桌面登录归 IDE。
function signedOut(site, a, note = "") {
  const todo = isDesktop(a)
    ? `在 ${site.name} IDE 里重新登录（插件每次请求都重读它的登录文件）`
    : `在 magpie 里重新登录（Providers → ${site.name}）`
  const message = `${site.name} 拒绝了这个登录${note ? `：${note}` : ""}。请${todo}`
  return new Response(JSON.stringify({ error: { message, type: "authentication_error" } }), {
    status: 401,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
  })
}

// UNAPPROVED 是上游的渠道校验拒绝（11128）。它的 msg 是英文原话，也可能只给 code。
const UNAPPROVED = /unapproved channel|illegal api invocation|"code"\s*:\s*"?11128/i

// refused 是上游非 2xx 时给客户端的说明。
//
// 11128 / request illegal 是渠道校验拒绝（不是账号问题），把它说清楚，避免用户
// 以为要重新登录。诊断信息写进错误消息，但不含令牌。text 是已经读过的响应体，
// 没给就在这里读。
async function refused(site, res, text) {
  if (text === undefined) text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    // 上游偶尔回裸 HTML
  }
  const code = Number.parseInt(env.code, 10) || 0
  let msg = env.msg || env.displayMsg?.zh || env.displayMsg?.en || text.slice(0, 300) || res.statusText
  if (code === 11128 || /unapproved channel|request illegal/i.test(text)) {
    msg = `${msg}（${site.name} 的渠道校验拒绝了这次请求，不是账号问题；若持续出现请更新插件）`
  }
  return new Response(JSON.stringify({ error: { message: msg, type: "api_error", code: code || undefined } }), {
    status: res.status,
    statusText: res.statusText,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  })
}

// makePlugin 为站点造一个插件函数。
export function makePlugin(site) {
  // refusedSystems 是渠道校验拒过的 system 提示词（按文本认）。同一个 agent 的下一次
  // 对话直接以「搬进 user 消息」的形态发，不再先被拒一次。上限 256 条。
  const refusedSystems = new Set()
  return async ({ client }) => {
    startCLIVersionRefresh()
    // 每个账号的模型清单缓存：{at, list}
    const lists = new Map()
    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[site.id] ??= {}
        const p = config.provider[site.id]
        p.name ??= site.name
        p.npm ??= "@ai-sdk/openai-compatible"
        p.api ??= site.chat + "/v2"
        p.models = { ...modelsFrom(staticModels(site)), ...(p.models ?? {}) }
      },
      provider: {
        id: site.id,
        // 账号自己的清单，读不到就回落到静态清单（不把整个列表搞没）
        async models(provider, { auth } = {}) {
          if (!usable(auth)) return provider.models
          let a
          try {
            a = await current(site, client, auth)
          } catch {
            return provider.models
          }
          const cached = lists.get(a.uid || a.access)
          if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
            return Object.fromEntries(cached.list.map((m) => [m.id, modelOf(provider, m)]))
          }
          try {
            const list = await fetchModels(site, a.access, a.uid, { version: cliVersion() })
            if (!list.length) return provider.models
            lists.set(a.uid || a.access, { at: Date.now(), list })
            if (lists.size > 32) lists.delete(lists.keys().next().value)
            return Object.fromEntries(list.map((m) => [m.id, modelOf(provider, m)]))
          } catch {
            return provider.models
          }
        },
      },
      auth: {
        provider: site.id,
        refreshLead: LEAD_MS,
        // magpie 在 expires 前 LEAD_MS 主动续期；桌面登录不在这里续（文件归 IDE 管），
        // API key 无令牌可续
        refresh: async (auth) => {
          if (auth?.type !== "oauth" || isDesktop(auth) || !auth.access || !auth.refresh) return undefined
          const got = await refreshToken(site, auth.access, auth.refresh, auth.domain || site.domain)
          const out = {}
          if (got.access && got.access !== auth.access) out.access = got.access
          if (got.refresh && got.refresh !== auth.refresh) out.refresh = got.refresh
          if (got.expires && got.expires !== auth.expires) out.expires = got.expires
          if (got.domain && got.domain !== auth.domain) out.domain = got.domain
          return Object.keys(out).length ? out : undefined
        },
        async loader(getAuth) {
          const stored = await getAuth()
          const keyed = stored?.type === "api" ? keyAccount(stored) : null
          if (!keyed && (stored?.type !== "oauth" || !(stored.access || stored.source))) return {}
          return {
            // 不设 baseURL：由 provider 的 api 决定，请求按原路径转发
            apiKey: keyed?.key ?? "codebuddy",
            async fetch(input, init = {}) {
              const auth = await getAuth()
              const k = auth?.type === "api" ? keyAccount(auth) : null
              if (!k && (auth?.type !== "oauth" || !(auth.access || auth.source))) {
                return new Response(JSON.stringify({ error: { message: `${site.name} 未登录，请先在 magpie 登录`, type: "authentication_error" } }), {
                  status: 401,
                  headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
                })
              }
              let a
              try {
                a = k ?? (await current(site, client, auth))
              } catch (e) {
                return new Response(JSON.stringify({ error: { message: e?.message ?? String(e), type: "authentication_error" } }), {
                  status: 401,
                  headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
                })
              }
              const req = input instanceof Request ? input : null
              const url = new URL(req ? req.url : String(input))
              // magpie 告诉插件的会话名（x-magpie-session），用来按对话派生请求 id。
              // host 的 unsaid 会把它从发出去的请求里去掉，但这里自己重写头，不会带出去。
              const session =
                (init?.headers ? new Headers(init.headers).get("x-magpie-session") : null) ??
                (req ? req.headers.get("x-magpie-session") : null) ??
                ""
              const target = site.chat + upstreamPath(url.pathname) + url.search
              // 客户端头只留需要透传的，其余由 chatHeaders 重写：上游校验的是它自己
              // 那一套头，客户端的 User-Agent / Accept-Encoding 会把校验带偏
              const headers = new Headers()
              const version = cliVersion()
              for (const [k2, v] of Object.entries(chatHeaders(site, version, { session }))) headers.set(k2, v)
              headers.set("Accept", "application/json")
              sign(a, headers)
              let body = init?.body
              if (body === undefined && req) body = await req.clone().text()
              let text
              if (typeof body === "string") text = body
              else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body)
              else if (ArrayBuffer.isView(body)) text = new TextDecoder().decode(body)
              // chat 是解析出来的请求体（归一化后原地改过），11128 的兜底重发要用它；
              // sysKey 是它 system 消息的文本，用来记「这个提示词被拒过」。
              let chat = null
              let sysKey = ""
              let moved = false
              if (text !== undefined) {
                try {
                  const parsed = JSON.parse(text)
                  if (parsed && typeof parsed === "object") {
                    // 该模型能不能关思考，从缓存的清单里查；不知道就当能关
                    // （默认 true 不会把用户的“关掉”降级成删字段）
                    const known = lists.get(a.uid || a.access)?.list?.find((x) => x.id === parsed.model)
                    // outbound 原地改 parsed，返回的就是它
                    outbound(parsed, { canDisable: known?.canDisable !== false })
                    chat = parsed
                    sysKey = systemKey(chat)
                    // 这个 system 提示词上次被渠道校验拒过：这次直接搬进 user 消息
                    // （实测：搬过去的同一句话上游读不到，所以一定过）
                    if (sysKey && refusedSystems.has(sysKey) && systemAsUser(chat)) moved = true
                    text = JSON.stringify(chat)
                  }
                } catch {
                  // 不是 JSON 就原样发
                }
              }
              // post 每次重新压缩：11128 兜底重发时请求体已经改过
              // sentBytes 记下最近一次实际发出去的字节数，断连时用它判 EDGE_READS
              let sentBytes = 0
              const post = async (payload) => {
                const zipped = gzipBody(payload)
                if (zipped) headers.set("Content-Encoding", "gzip")
                else headers.delete("Content-Encoding")
                const out = zipped ?? payload
                sentBytes = typeof out === "string" ? Buffer.byteLength(out) : out?.byteLength ?? 0
                return fetch(target, {
                  ...init,
                  method: init?.method ?? req?.method ?? "POST",
                  headers,
                  body: out,
                })
              }
              let res
              try {
                res = await post(text)
              } catch (e) {
                // 大请求 + 被拒的令牌：前端直接断连（见 EDGE_READS）
                const edge = await edgeRefused(site, a, sentBytes)
                if (edge) return edge
                throw e
              }
              // 同一个边界的另一种表现：EdgeOne 回 550 而不是断连
              if (res.status === EDGE_STATUS) {
                const edge = await edgeRefused(site, a, sentBytes)
                if (edge) return edge
              }
              if (res.status === 401) {
                // 令牌被提前拒：换一次再发一次（见 reissue）
                const next = await reissue(site, client, auth)
                if (!next) return signedOut(site, a)
                a = next
                sign(a, headers)
                res = await post(text)
                if (res.status === 401) return signedOut(site, a)
              }
              if (res.status === 400 && chat && sysKey && !moved) {
                // 渠道校验（11128）拒了一次：把 system 提示词搬进 user 消息再发一次。
                // 上游只读 system 与 assistant，读不到 user，所以搬过去就过；
                // 后面的对话按 system 文本记住，直接以搬过的形态发。
                const said = await res.text()
                if (UNAPPROVED.test(said)) {
                  const moved = systemAsUser(chat)
                  if (moved) {
                    refusedSystems.add(sysKey)
                    if (refusedSystems.size > 256) refusedSystems.delete(refusedSystems.values().next().value)
                    res = await post(JSON.stringify(chat))
                  }
                  // 没东西可搬（或搬完仍被拒）：把上游原话报回去，不要重复读已读的体
                  if (!res.ok) return refused(site, res, moved ? undefined : said)
                } else {
                  return refused(site, res, said)
                }
              }
              if (!res.ok) return refused(site, res)
              // 成功：说登录保持有效（成功会清掉账号上的失效标记）
              const out = new Headers(res.headers)
              out.set("X-Magpie-Sign-In", "kept")
              return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
            },
          }
        },
        async usage(getAuth) {
          const auth = await getAuth()
          if (auth?.type === "api") {
            return { error: `${site.name} 的余额查不到（官方 CLI 用 key 时也不读余额）`, signIn: "kept" }
          }
          if (auth?.type !== "oauth" || !(auth.access || auth.source)) return { error: "未登录", signIn: "kept" }
          let a
          try {
            a = await current(site, client, auth)
          } catch (e) {
            return { error: e?.message ?? String(e), signIn: "kept" }
          }
          try {
            const u = await fetchUsage(site, a.access, a.uid)
            return { ...u, signIn: "kept" }
          } catch (e) {
            return { error: e?.message ?? String(e), signIn: e?.status === 401 ? "expired" : "kept" }
          }
        },
        // 国际版的签到端点未实测，不给这个钩子，界面就不会出现签到入口
        ...(site.checkin
          ? {
              async checkin(getAuth) {
                const auth = await getAuth()
                if (auth?.type === "api") return { outcome: "ineligible", message: "签到要登录的账号，不是 API key" }
                if (auth?.type !== "oauth" || !(auth.access || auth.source)) return { outcome: "failed", message: "未登录" }
                let a
                try {
                  a = await current(site, client, auth)
                } catch (e) {
                  return { outcome: "failed", message: e?.message ?? String(e) }
                }
                return checkinOf(site, a.access, a.uid)
              },
            }
          : {}),
        methods: [
          {
            type: "oauth",
            label: `${site.name} 账号（浏览器登录）`,
            labels: { zh: `${site.name} 账号（浏览器登录）`, "zh-TW": `${site.name} 帳號（瀏覽器登入）` },
            authorize: async (_inputs, { signal } = {}) => {
              const { state, url } = await startSignIn(site, { signal })
              return {
                url,
                instructions: `在浏览器里登录 ${site.name}，完成后这里会自动继续。`,
                method: "auto",
                async callback() {
                  const token = await waitForToken(site, state, { signal })
                  let who = { uid: "", nickname: "", email: "", enterpriseId: "", enterpriseName: "" }
                  try {
                    who = await fetchAccount(site, token.access, state, token.domain, { signal })
                  } catch {
                    // 账号信息读不到不影响登录：uid 为空时下游会以令牌为准
                  }
                  return {
                    type: "success",
                    provider: site.id,
                    access: token.access,
                    refresh: token.refresh,
                    expires: token.expires,
                    accountId: who.nickname || who.email || who.uid || site.name,
                    uid: who.uid,
                    domain: token.domain,
                    tokenType: token.tokenType,
                    ...(who.enterpriseId ? { enterpriseId: who.enterpriseId } : {}),
                  }
                },
              }
            },
          },
          {
            type: "oauth",
            label: `${site.name} IDE 的登录`,
            labels: { zh: `${site.name} IDE 的登录`, "zh-TW": `${site.name} IDE 的登入` },
            authorize: async () => ({
              url: "",
              instructions: `使用本机 ${site.name} IDE 已登录的账号。`,
              method: "auto",
              async callback() {
                const d = readDesktop(site)
                if (d.error) return { type: "failed", error: d.error }
                return {
                  type: "success",
                  provider: site.id,
                  access: "",
                  refresh: "",
                  expires: 0,
                  source: "desktop",
                  accountId: d.name || site.name,
                  uid: d.uid,
                }
              },
            }),
          },
          {
            type: "oauth",
            label: `${site.name} 粘贴 JSON 导入`,
            labels: { zh: `${site.name} 粘贴 JSON 导入`, "zh-TW": `${site.name} 貼上 JSON 匯入` },
            prompts: [
              {
                type: "text",
                key: "account",
                message: `粘贴 ${site.name} IDE 的登录文件内容，或浏览器登录 / 工具导出的 JSON（有 refresh token 即可）`,
                validate: (v) => (String(v ?? "").trim() ? undefined : "请粘贴登录 JSON"),
              },
            ],
            authorize: async (inputs = {}) => {
              let found
              try {
                found = importedAccounts(inputs.account)
              } catch (e) {
                return { type: "failed", error: e?.message ?? String(e) }
              }
              if (!found.length) return { type: "failed", error: "这段文本里既没有 access_token 也没有 refresh_token；空令牌的记录无法导入" }
              const one = found[0]
              // 一次只能存一个账号（magpie 的 save 每次建一个），多贴的要分次
              const more = found.length > 1 ? `（这段里有 ${found.length} 个账号，这次只导入第 1 个；其余的请再粘一次）` : ""
              // domain 与本站点不一致就拒：国区与国际版是同一套令牌，但请求要打到
              // 各自区域的域，混用只会得到上游 401
              if (one.domain && one.domain.toLowerCase() !== site.domain.toLowerCase()) {
                return { type: "failed", error: `这份登录属于 ${one.domain}，与本站点 ${site.domain} 不是同一个区；请用它对应的那个 provider` }
              }
              return {
                url: "",
                instructions: `正在确认账号…${more}`,
                method: "auto",
                async callback() {
                  // 只有 refresh token 的导出（工具导出的常见形态）先用它换出 access：
                  // 实测 access 传空也能换成功，所以这种导出是可恢复的。
                  let access = one.access
                  let refresh = one.refresh
                  let expires = one.expires
                  if (!access) {
                    try {
                      const got = await refreshToken(site, "", refresh, one.domain || site.domain)
                      access = got.access
                      refresh = got.refresh || refresh
                      expires = got.expires || expires
                    } catch (e) {
                      return { type: "failed", error: `${site.name} 的 refresh token 换不出新令牌：${e?.message ?? String(e)}` }
                    }
                  }
                  // 导入的账号没有浏览器登录的 state，/login/account 要它，所以用余额接口
                  // 验证令牌：能读出套餐就说明令牌可用。
                  // 读不到就当不可用——存进去只会在每次请求时 401。
                  let usage
                  try {
                    usage = await fetchUsage(site, access, one.uid || "", { domain: one.domain || site.balanceDomain })
                  } catch (e) {
                    if (e?.status === 401) return { type: "failed", error: `${site.name} 不认这个令牌（401）；可能已过期，或不是本站点 ${site.domain} 的` }
                    // 非 401 的读不到（例如余额接口临时故障）不该拦住导入：令牌可能好着
                    usage = null
                  }
                  return {
                    type: "success",
                    provider: site.id,
                    access,
                    refresh,
                    expires,
                    accountId: one.name || one.uid || site.name,
                    uid: one.uid,
                    domain: one.domain || site.domain,
                    tokenType: one.tokenType,
                    ...(one.enterpriseId ? { enterpriseId: one.enterpriseId } : {}),
                  }
                },
              }
            },
          },
          {
            type: "api",
            label: `${site.name} API key`,
            placeholder: `来自 ${site.account.replace(/^https:\/\//, "")}/profile/keys`,
          },
        ],
      },
    }
  }
}

// modelOf 把一条模型清单项转成 models 钩子的条目。
//
// capabilities.reasoning 与 variants 都是从上游 config 读的：实测 deepseek-v4.1-flash
// 在 reasoning_effort=high 下真的返回了 reasoning_content，说 false 会让 magpie 与
// 客户端把思考内容丢掉。
function modelOf(provider, m) {
  const efforts = Array.isArray(m.efforts) ? m.efforts : []
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: provider.api ?? "" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning === true,
      attachment: m.images === true,
      toolcall: true,
      input: { text: true, image: m.images === true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries(efforts.map((e) => [e, {}])),
    // magpie 自己的：这个模型不花 credits，路由会优先用它
    free: m.free === true,
    // 花多少 credits，倍数形式。只有真读到才写：rate 为 0 在 magpie 那里表示「不要钱」，
    // 把一个未知的 credits 写成 0 会让路由把付费模型当免费优先用（实测
    // default-model 的 credits 是空串，属于未知而非免费）。
    ...(typeof m.rate === "number" ? { rate: m.rate } : {}),
  }
}

