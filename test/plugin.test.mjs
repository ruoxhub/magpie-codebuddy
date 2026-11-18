import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { gunzipSync } from "node:zlib"

import { CodeBuddyPlugin, CodeBuddyIntlPlugin } from "../index.mjs"
import { makePlugin, usable, expired } from "../lib/plugin.mjs"
import { SITES } from "../lib/sites.mjs"

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      handler(req, Buffer.concat(chunks), res)
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

// localSite 把站点的三个域都指到本地模拟上游。
//
// 生产里 magpie 交给插件的是 plugin:// 地址，真正的目标 host 由站点决定
// （见 index.mjs 的 fetch），所以测试只能从站点这一侧注入本地地址。
function localSite(site, base) {
  return { ...site, chat: base, account: base, balance: base }
}

// pluginFor 用本地站点造插件，并跑一遍 loader。
async function pluginFor(site, auth) {
  const plugin = makePlugin(site)
  const client = { auth: { set: async () => {} }, app: { log: async () => {} } }
  const hooks = await plugin({ client, directory: process.cwd(), worktree: process.cwd() })
  const getAuth = async () => auth
  const options = await hooks.auth.loader(getAuth)
  return { hooks, client, options, getAuth }
}

// bodyOf 读出请求体，解 gzip。
function bodyOf(req, raw) {
  const buf = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw
  return buf.toString("utf8")
}

// sse 回一个最小的流式响应。
function sse(res) {
  res.setHeader("Content-Type", "text/event-stream")
  res.end('data: {"id":"c","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
}

test("插件导出两个 provider 函数", () => {
  assert.equal(typeof CodeBuddyPlugin, "function")
  assert.equal(typeof CodeBuddyIntlPlugin, "function")
})

test("config 钩子给出 npm / api / models，不覆盖用户已设的值", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider.codebuddy
  assert.equal(p.name, "CodeBuddy")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, "https://copilot.tencent.com/v2")
  assert.ok(Object.keys(p.models).length > 0)

  const cfg2 = { provider: { codebuddy: { name: "我的 CodeBuddy", api: "https://x" } } }
  await hooks.config(cfg2)
  assert.equal(cfg2.provider.codebuddy.name, "我的 CodeBuddy")
  assert.equal(cfg2.provider.codebuddy.api, "https://x")
})

test("国际版 provider 指向 www.codebuddy.ai/v2", async () => {
  const hooks = await CodeBuddyIntlPlugin({ client: {}, directory: process.cwd() })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  assert.equal(cfg.provider["codebuddy-intl"].api, "https://www.codebuddy.ai/v2")
})

test("国区有 checkin 钩子，国际版没有", async () => {
  const cn = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const intl = await CodeBuddyIntlPlugin({ client: {}, directory: process.cwd() })
  assert.equal(typeof cn.auth.checkin, "function")
  assert.equal(typeof intl.auth.checkin, "undefined")
})

test("四种登录方式都在，oauth 的 authorize 是函数", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  assert.deepEqual(
    hooks.auth.methods.map((m) => m.type),
    ["oauth", "oauth", "oauth", "api"],
  )
  for (const m of hooks.auth.methods) {
    if (m.type === "oauth") assert.equal(typeof m.authorize, "function")
    assert.ok(m.label)
  }
  // 粘贴导入那个方法必须声明 prompts，否则 magpie 会让用户再填一次 key
  const pasted = hooks.auth.methods.find((m) => m.label.includes("粘贴 JSON"))
  assert.ok(pasted, "缺少粘贴导入方法")
  assert.equal(pasted.prompts.length, 1)
  assert.equal(pasted.prompts[0].key, "account")
  assert.equal(hooks.auth.refreshLead, 5 * 60 * 1000)
})

test("未登录时 loader 返回空对象（magpie 因此不当它在线）", async () => {
  const { options } = await pluginFor(SITES.codebuddy, { type: "oauth" })
  assert.deepEqual(options, {})
})

test("API key 登录按官方 CLI 的形态发请求", async () => {
  const seen = {}
  const { server, base } = await startServer((req, raw, res) => {
    seen.url = req.url
    seen.headers = req.headers
    seen.body = bodyOf(req, raw)
    sse(res)
  })
  try {
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), { type: "api", key: "ck_1234567890" })
    assert.equal(options.apiKey, "ck_1234567890")
    const res = await options.fetch(base + "/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.url, "/v2/chat/completions")
    // key 的会话：Authorization 是 key 本身，同时带 X-API-Key，且没有 X-Domain
    assert.equal(seen.headers.authorization, "Bearer ck_1234567890")
    assert.equal(seen.headers["x-api-key"], "ck_1234567890")
    assert.equal(seen.headers["x-domain"], undefined)
    // uid 是 "anonymous_" + key 的后 8 位（官方 CLI 的做法）
    assert.equal(seen.headers["x-user-id"], "anonymous_" + "ck_1234567890".slice(-8))
    const body = JSON.parse(seen.body)
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    // 首条不是 system，注入了兜底 system
    assert.equal(body.messages[0].role, "system")
  } finally {
    server.close()
  }
})

test("oauth 登录带齐上游校验需要的头，且请求体 gzip 压缩", async () => {
  const seen = {}
  const { server, base } = await startServer((req, raw, res) => {
    seen.headers = req.headers
    seen.body = bodyOf(req, raw)
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1", domain: "www.codebuddy.ai" }
    const site = localSite(SITES.codebuddy, base)
    const { options } = await pluginFor(site, auth)
    const res = await options.fetch(base + "/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.headers["content-encoding"], "gzip")
    assert.equal(seen.headers.authorization, "Bearer AT")
    assert.equal(seen.headers["x-user-id"], "U1")
    // 缺任一项上游就 11128
    for (const key of ["x-domain", "x-ide-type", "x-ide-version", "x-agent-intent", "x-b3-sampled", "traceparent", "b3"]) {
      assert.ok(seen.headers[key], key)
    }
    assert.equal(seen.headers["x-domain"], site.domain)
  } finally {
    server.close()
  }
})

test("企业账号带 X-Enterprise-Id 与 X-Tenant-Id", async () => {
  const seen = {}
  const { server, base } = await startServer((req, raw, res) => {
    seen.headers = req.headers
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1", enterpriseId: "E9" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" })
    assert.equal(seen.headers["x-enterprise-id"], "E9")
    assert.equal(seen.headers["x-tenant-id"], "E9")
  } finally {
    server.close()
  }
})

test("上游 401 时说登录失效，并带 X-Magpie-Sign-In: expired", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    res.statusCode = 401
    res.end("<html>401</html>")
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    const res = await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
    assert.match((await res.json()).error.message, /重新登录/)
  } finally {
    server.close()
  }
})

test("上游 11128 时说清是渠道校验拒绝，不是账号问题", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ code: 11128, msg: "request illegal" }))
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    const res = await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.status, 400)
    // 账号没坏：不要把 11128 报成登录失效
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
    const body = await res.json()
    assert.equal(body.error.code, 11128)
    assert.match(body.error.message, /渠道校验/)
  } finally {
    server.close()
  }
})

test("其他上游错误原样带回上游的话", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    res.statusCode = 429
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ code: 13002, msg: "请求过于频繁" }))
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    const res = await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.status, 429)
    const body = await res.json()
    assert.equal(body.error.message, "请求过于频繁")
    assert.equal(body.error.code, 13002)
  } finally {
    server.close()
  }
})

test("成功响应带 X-Magpie-Sign-In: kept", async () => {
  const { server, base } = await startServer((req, raw, res) => sse(res))
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    const res = await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  } finally {
    server.close()
  }
})

test("客户端路径被改写到 /v2/chat/completions", async () => {
  const urls = []
  const { server, base } = await startServer((req, raw, res) => {
    urls.push(req.url)
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    for (const path of ["/v2/chat/completions", "/v1/chat/completions", "/v1/messages"]) {
      await options.fetch(base + path, { method: "POST", body: "{}" })
    }
    assert.deepEqual(urls, ["/v2/chat/completions", "/v2/chat/completions", "/v2/chat/completions"])
  } finally {
    server.close()
  }
})

test("非 JSON 请求体原样发出，不被搞坏", async () => {
  let sent
  const { server, base } = await startServer((req, raw, res) => {
    sent = bodyOf(req, raw)
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "not json at all" })
    assert.equal(sent, "not json at all")
  } finally {
    server.close()
  }
})

test("到期前会先刷新令牌，并把新令牌存回", async () => {
  let refreshed = 0
  let sentAuth
  const { server, base } = await startServer((req, raw, res) => {
    if (req.url === "/v2/plugin/auth/token/refresh") {
      refreshed++
      res.end(JSON.stringify({ code: 0, data: { accessToken: "NEW", refreshToken: "RT2", expiresAt: Date.now() + 3600e3 } }))
      return
    }
    sentAuth = req.headers.authorization
    sse(res)
  })
  try {
    const saved = []
    const auth = { type: "oauth", access: "OLD", refresh: "RT", expires: Date.now() + 1000, uid: "U1" }
    const site = localSite(SITES.codebuddy, base)
    const plugin = makePlugin(site)
    const hooks = await plugin({
      client: { auth: { set: async (x) => saved.push(x) }, app: { log: async () => {} } },
      directory: process.cwd(),
    })
    const options = await hooks.auth.loader(async () => auth)
    await options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" })
    assert.equal(refreshed, 1)
    assert.equal(sentAuth, "Bearer NEW")
    assert.equal(saved.length, 1)
    assert.equal(saved[0].body.access, "NEW")
  } finally {
    server.close()
  }
})

test("并发请求只花一次刷新令牌", async () => {
  let refreshed = 0
  const { server, base } = await startServer((req, raw, res) => {
    if (req.url === "/v2/plugin/auth/token/refresh") {
      refreshed++
      // 慢一点，让并发请求都落在这一次刷新上
      setTimeout(() => res.end(JSON.stringify({ code: 0, data: { accessToken: "NEW", refreshToken: "RT2" } })), 30)
      return
    }
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "OLD", refresh: "RT", expires: Date.now() + 1000, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    await Promise.all([
      options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" }),
      options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" }),
      options.fetch(base + "/v2/chat/completions", { method: "POST", body: "{}" }),
    ])
    assert.equal(refreshed, 1)
  } finally {
    server.close()
  }
})

test("usage 钩子：API key 明说查不到余额，不冒充失败", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const got = await hooks.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.match(got.error, /余额查不到/)
  assert.equal(got.signIn, "kept")
})

test("usage 钩子：未登录时不报 expired", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const got = await hooks.auth.usage(async () => ({ type: "oauth" }))
  assert.equal(got.error, "未登录")
  assert.equal(got.signIn, "kept")
})

test("usage 钩子：读到余额窗口", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    assert.equal(req.url, "/billing/meter/get-user-resource-summary")
    res.end(JSON.stringify({ code: 0, data: { IsPaidUser: true, CreditGroups: [{ Kind: "plan_base", CycleTotalCapacity: "10", CycleUsedCapacity: "5" }] } }))
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { hooks } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    const got = await hooks.auth.usage(async () => auth)
    assert.equal(got.plan, "Pro")
    assert.equal(got.windows[0].limit, 10)
    assert.equal(got.signIn, "kept")
  } finally {
    server.close()
  }
})

test("checkin 钩子：API key 是 ineligible，未登录是 failed", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  assert.equal((await hooks.auth.checkin(async () => ({ type: "api", key: "k" }))).outcome, "ineligible")
  assert.equal((await hooks.auth.checkin(async () => ({ type: "oauth" }))).outcome, "failed")
})

test("checkin 钩子：国区真去签到", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    if (req.url.endsWith("checkin-activity-status")) {
      return res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }))
    }
    res.end(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 2 } }))
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { hooks } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    assert.deepEqual(await hooks.auth.checkin(async () => auth), { outcome: "claimed", credit: 100, streak: 2 })
  } finally {
    server.close()
  }
})

test("provider.models 在登录不可用时报错回退到静态清单", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const given = cfg.provider.codebuddy
  const got = await hooks.provider.models(given, { auth: { type: "oauth" } })
  // 原样交回它拿到的清单，magpie 会据此标记为回落
  assert.equal(got, given.models)
})

test("provider.models 换账号自己的清单", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    assert.equal(req.url, "/v3/config")
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          models: [{ id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true, supportsToolCall: true }],
        },
      }),
    )
  })
  try {
    const site = localSite(SITES.codebuddy, base)
    const plugin = makePlugin(site)
    const hooks = await plugin({ client: {}, directory: process.cwd() })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U9" }
    const got = await hooks.provider.models(cfg.provider.codebuddy, { auth })
    assert.deepEqual(Object.keys(got), ["glm-5.3"])
    assert.equal(got["glm-5.3"].limit.context, 1000)
    assert.equal(got["glm-5.3"].capabilities.attachment, true)
  } finally {
    server.close()
  }
})

test("provider.models 拉取失败时回退到静态清单", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    res.statusCode = 500
    res.end("boom")
  })
  try {
    const site = localSite(SITES.codebuddy, base)
    const plugin = makePlugin(site)
    const hooks = await plugin({ client: {}, directory: process.cwd() })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const given = cfg.provider.codebuddy
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U8" }
    assert.equal(await hooks.provider.models(given, { auth }), given.models)
  } finally {
    server.close()
  }
})

test("refresh 钩子：oauth 换回变化的字段，桌面与 key 不动", async () => {
  const { server, base } = await startServer((req, raw, res) => {
    assert.equal(req.url, "/v2/plugin/auth/token/refresh")
    res.end(JSON.stringify({ code: 0, data: { accessToken: "NEW" } }))
  })
  try {
    const site = localSite(SITES.codebuddy, base)
    const plugin = makePlugin(site)
    const hooks = await plugin({ client: {}, directory: process.cwd() })
    const got = await hooks.auth.refresh({ type: "oauth", access: "OLD", refresh: "RT" })
    assert.deepEqual(got, { access: "NEW" })

    assert.equal(await hooks.auth.refresh({ type: "oauth", source: "desktop" }), undefined)
    assert.equal(await hooks.auth.refresh({ type: "api", key: "k" }), undefined)
    assert.equal(await hooks.auth.refresh({ type: "oauth", access: "AT" }), undefined)
  } finally {
    server.close()
  }
})

test("developer 角色在出站前被归一为 system（上游原样发会 11128）", async () => {
  const seen = {}
  const { server, base } = await startServer((req, raw, res) => {
    seen.body = JSON.parse(bodyOf(req, raw))
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    await options.fetch(base + "/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }] }),
    })
    assert.equal(seen.body.messages[0].role, "system")
    assert.equal(seen.body.messages[0].content, "be brief")
  } finally {
    server.close()
  }
})

test("image_url 字符串形态在出站前被包成对象（字符串形态会被 11101 拒）", async () => {
  const seen = {}
  const { server, base } = await startServer((req, raw, res) => {
    seen.body = JSON.parse(bodyOf(req, raw))
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    await options.fetch(base + "/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "glm-5.3",
        messages: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,AA" }] }],
      }),
    })
    assert.deepEqual(seen.body.messages[1].content[0].image_url, { url: "data:image/png;base64,AA" })
  } finally {
    server.close()
  }
})

test("x-magpie-session 不泄露给上游，但被用来派生请求 id", async () => {
  const seen = []
  const { server, base } = await startServer((req, raw, res) => {
    seen.push(req.headers)
    sse(res)
  })
  try {
    const auth = { type: "oauth", access: "AT", refresh: "", expires: 0, uid: "U1" }
    const { options } = await pluginFor(localSite(SITES.codebuddy, base), auth)
    const send = () => options.fetch(base + "/v2/chat/completions", {
      method: "POST",
      headers: new Headers({ "x-magpie-session": "sess-1", "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
    })
    await send()
    await send()
    // magpie 自己的头不发给上游
    for (const h of seen) assert.equal(h["x-magpie-session"], undefined)
    // 同一 session 的对话 id 稳定
    assert.equal(seen[0]["x-conversation-id"], seen[1]["x-conversation-id"])
    // 但每次请求的 request id 不同
    assert.notEqual(seen[0]["x-request-id"], seen[1]["x-request-id"])
  } finally {
    server.close()
  }
})

test("usable 判定：api key 与 oauth 可用，桌面登录也算", () => {
    assert.equal(usable({ type: "api", key: "k" }), true)
  assert.equal(usable({ type: "api", key: "" }), false)
  assert.equal(usable({ type: "oauth", access: "AT" }), true)
  assert.equal(usable({ type: "oauth", source: "desktop" }), true)
  assert.equal(usable({ type: "oauth" }), false)
  assert.equal(usable(null), false)
})

test("expired 判定：临近到期才算", () => {
    assert.equal(expired({ expires: Date.now() + 10 * 60 * 1000 }), false)
  assert.equal(expired({ expires: Date.now() + 10 * 1000 }), true)
  assert.equal(expired({ expires: 0 }), false)
  assert.equal(expired({}), false)
})

// ---- 粘贴 JSON 导入 ---------------------------------------------------------
test("粘贴导入：能读出 IDE 登录文件的账号并存成一份登录", async () => {
  let asked = ""
  const { server, base } = await startServer((req, body, res) => {
    asked = req.url
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 0, data: { IsPaidUser: true, CreditGroups: [{ Kind: "plan_base", CycleTotalCapacity: "100", CycleUsedCapacity: "10" }] } }))
  })
  try {
    const site = localSite(SITES.codebuddy, base)
    const plugin = makePlugin(site)
    const hooks = await plugin({ client: { auth: { set: async () => {} } }, directory: process.cwd() })
    const m = hooks.auth.methods.find((x) => x.label.includes("粘贴 JSON"))
    const started = await m.authorize({
      account: JSON.stringify({
        account: { uid: "uid-1", nickname: "小明" },
        auth: { accessToken: "acc", refreshToken: "ref", expiresAt: 1799999999999, domain: "www.codebuddy.cn" },
      }),
    })
    assert.notEqual(started.type, "failed", started.error)
    const r = await started.callback()
    assert.equal(r.type, "success", r.error)
    assert.equal(r.access, "acc")
    assert.equal(r.refresh, "ref")
    assert.equal(r.uid, "uid-1")
    assert.equal(r.accountId, "小明")
    assert.equal(r.expires, 1799999999999)
    // 用余额接口验令牌（导入没有浏览器登录的 state，不能走 /login/account）
    assert.match(asked, /get-user-resource-summary/)
  } finally {
    server.close()
  }
})

test("粘贴导入：令牌被上游拒（401）就不存，并说清原因", async () => {
  const { server, base } = await startServer((req, body, res) => {
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 401, msg: "unauthorized" }))
  })
  try {
    const site = localSite(SITES.codebuddy, base)
    const plugin = makePlugin(site)
    const hooks = await plugin({ client: { auth: { set: async () => {} } }, directory: process.cwd() })
    const m = hooks.auth.methods.find((x) => x.label.includes("粘贴 JSON"))
    const started = await m.authorize({ account: JSON.stringify({ accessToken: "bad", domain: "www.codebuddy.cn" }) })
    const r = await started.callback()
    assert.equal(r.type, "failed")
    assert.match(r.error, /不认这个令牌/)
  } finally {
    server.close()
  }
})

test("粘贴导入：跨区的登录被拒，且说清该用哪个 provider", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const m = hooks.auth.methods.find((x) => x.label.includes("粘贴 JSON"))
  const r = await m.authorize({ account: JSON.stringify({ accessToken: "a", domain: "www.codebuddy.ai" }) })
  assert.equal(r.type, "failed")
  assert.match(r.error, /不是同一个区/)
})

test("粘贴导入：空文本与无令牌文本都被拒，不造空账号", async () => {
  const hooks = await CodeBuddyPlugin({ client: {}, directory: process.cwd() })
  const m = hooks.auth.methods.find((x) => x.label.includes("粘贴 JSON"))
  assert.equal((await m.authorize({ account: "   " })).type, "failed")
  const noToken = await m.authorize({ account: JSON.stringify({ uid: "u" }) })
  assert.equal(noToken.type, "failed")
  assert.match(noToken.error, /既没有 access_token 也没有 refresh_token/)
})
