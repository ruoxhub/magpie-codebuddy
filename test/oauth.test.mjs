import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { startSignIn, pollToken, waitForToken, fetchAccount, refreshToken, expiresAtOf, setAccountHeaders, importedAccounts } from "../lib/oauth.mjs"

// startServer 起一个本地上游，handler 收到 (req, body, res)。
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks).toString("utf8")
      handler(req, body, res)
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

const siteAt = (base) => ({ id: "t", name: "T", account: base, domain: "www.example.com", platform: "ide" })

test("expiresAtOf 优先用响应的 expiresAt", () => {
  assert.equal(expiresAtOf("a.b.c", 1700000000000), 1700000000000)
})

test("expiresAtOf 缺 expiresAt 时从 JWT 的 exp 读", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString("base64url")
  const jwt = `x.${payload}.y`
  assert.equal(expiresAtOf(jwt, 0), 1700000000000)
})

test("expiresAtOf 对坏令牌返回 0，不抛错", () => {
  assert.equal(expiresAtOf("", 0), 0)
  assert.equal(expiresAtOf("not-a-jwt", 0), 0)
  assert.equal(expiresAtOf("a.!!!.c", 0), 0)
})

test("setAccountHeaders 声明不要网关默认用户上下文", () => {
  const h = new Headers()
  setAccountHeaders(h)
  assert.equal(h.get("X-No-Authorization"), "true")
  assert.equal(h.get("X-No-User-Id"), "true")
  assert.equal(h.get("X-No-Enterprise-Id"), "true")
  assert.equal(h.get("X-No-Department-Info"), "true")
  assert.ok(h.get("User-Agent").startsWith("Mozilla/5.0"))
})

test("setAccountHeaders 带令牌时不发 X-No-Authorization", () => {
  const h = new Headers()
  setAccountHeaders(h, { authorization: "tok" })
  assert.equal(h.get("X-No-Authorization"), null)
})

test("startSignIn 取 state 与 authUrl，并补 loginSessionId", async () => {
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.method, "POST")
    assert.match(req.url, /^\/v2\/plugin\/auth\/state\?platform=ide$/)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ code: 0, data: { state: "S1", authUrl: "https://login.example.com/x" } }))
  })
  try {
    const got = await startSignIn(siteAt(base))
    assert.equal(got.state, "S1")
    const url = new URL(got.url)
    assert.equal(url.origin, "https://login.example.com")
    assert.ok(url.searchParams.get("loginSessionId"))
  } finally {
    server.close()
  }
})

test("startSignIn 缺 state 时抛错", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 0, data: {} })))
  try {
    await assert.rejects(() => startSignIn(siteAt(base)), /没有返回 state/)
  } finally {
    server.close()
  }
})

test("startSignIn 拒绝非 https 的登录页", async () => {
  const { server, base } = await startServer((req, body, res) =>
    res.end(JSON.stringify({ code: 0, data: { state: "S", authUrl: "http://insecure.example.com/x" } })),
  )
  try {
    await assert.rejects(() => startSignIn(siteAt(base)), /不是 https/)
  } finally {
    server.close()
  }
})

test("auth/state 非 0/200 业务码当错误", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 500, msg: "boom" })))
  try {
    await assert.rejects(() => startSignIn(siteAt(base)), /boom/)
  } finally {
    server.close()
  }
})

test("pollToken 未拿令牌时 got=false，业务码 11217 不算错误", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 11217, msg: "等待授权", data: {} })))
  try {
    const got = await pollToken(siteAt(base), "S1")
    assert.equal(got.got, false)
    assert.equal(got.code, 11217)
  } finally {
    server.close()
  }
})

test("pollToken 拿到令牌时读齐各字段", async () => {
  const { server, base } = await startServer((req, body, res) =>
    res.end(
      JSON.stringify({
        code: 0,
        data: { accessToken: "AT", refreshToken: "RT", tokenType: "Bearer", expiresAt: 1800000000000, domain: "www.example.com" },
      }),
    ),
  )
  try {
    const got = await pollToken(siteAt(base), "S1")
    assert.equal(got.got, true)
    assert.deepEqual(got.token, { access: "AT", refresh: "RT", tokenType: "Bearer", expires: 1800000000000, domain: "www.example.com" })
  } finally {
    server.close()
  }
})

test("waitForToken 轮询到令牌为止", async () => {
  let calls = 0
  const { server, base } = await startServer((req, body, res) => {
    calls++
    if (calls < 2) return res.end(JSON.stringify({ code: 11217, data: {} }))
    res.end(JSON.stringify({ code: 0, data: { accessToken: "AT2", refreshToken: "RT2" } }))
  })
  try {
    const token = await waitForToken(siteAt(base), "S1", { interval: 5 })
    assert.equal(token.access, "AT2")
    assert.equal(calls, 2)
  } finally {
    server.close()
  }
})

test("waitForToken 超时抛错", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 11217, data: {} })))
  try {
    await assert.rejects(() => waitForToken(siteAt(base), "S1", { deadline: Date.now() - 1 }), /授权超时/)
  } finally {
    server.close()
  }
})

test("waitForToken 在已取消的 signal 上立刻停下", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 11217, data: {} })))
  const ctl = new AbortController()
  ctl.abort()
  try {
    await assert.rejects(() => waitForToken(siteAt(base), "S1", { signal: ctl.signal }), /取消/)
  } finally {
    server.close()
  }
})

test("fetchAccount 读 uid 与昵称，带 X-Domain 与 Bearer", async () => {
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.headers.authorization, "Bearer AT")
    assert.equal(req.headers["x-domain"], "www.example.com")
    res.end(JSON.stringify({ code: 0, data: { uid: "U1", nickname: "小明", enterpriseId: "E1" } }))
  })
  try {
    const who = await fetchAccount(siteAt(base), "AT", "S1", "www.example.com")
    assert.equal(who.uid, "U1")
    assert.equal(who.nickname, "小明")
    assert.equal(who.enterpriseId, "E1")
  } finally {
    server.close()
  }
})

test("refreshToken 同时带 Authorization 与 X-Refresh-Token", async () => {
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.method, "POST")
    assert.equal(req.url, "/v2/plugin/auth/token/refresh")
    assert.equal(req.headers.authorization, "Bearer OLD")
    assert.equal(req.headers["x-refresh-token"], "R1")
    // 与官方 IDE 一致的刷新来源声明
    assert.equal(req.headers["x-auth-refresh-source"], "ide-main")
    res.end(JSON.stringify({ code: 0, data: { accessToken: "NEW", refreshToken: "R2", expiresAt: 1900000000000 } }))
  })
  try {
    const got = await refreshToken(siteAt(base), "OLD", "R1", "www.example.com")
    assert.equal(got.access, "NEW")
    assert.equal(got.refresh, "R2")
    assert.equal(got.expires, 1900000000000)
  } finally {
    server.close()
  }
})

test("refreshToken 业务码非 0 时抛错并带上 code", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 40001, msg: "refresh token 失效" })))
  try {
    await assert.rejects(() => refreshToken(siteAt(base), "OLD", "R1", ""), (e) => {
      assert.equal(e.code, 40001)
      assert.match(e.message, /失效/)
      return true
    })
  } finally {
    server.close()
  }
})

test("refreshToken 响应缺 accessToken 时抛错", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 0, data: {} })))
  try {
    await assert.rejects(() => refreshToken(siteAt(base), "OLD", "R1", ""), /缺少 accessToken/)
  } finally {
    server.close()
  }
})
// ---- 粘贴 JSON 导入 ---------------------------------------------------------
test("导入：读 IDE 登录文件的原样形态", () => {
  const text = JSON.stringify({
    account: { uid: "u-123", nickname: "小明" },
    auth: { accessToken: "acc-token", refreshToken: "ref-token", expiresAt: 1799999999999, domain: "www.codebuddy.ai", tokenType: "Bearer" },
  })
  const got = importedAccounts(text)
  assert.equal(got.length, 1)
  assert.equal(got[0].access, "acc-token")
  assert.equal(got[0].refresh, "ref-token")
  assert.equal(got[0].expires, 1799999999999)
  assert.equal(got[0].uid, "u-123")
  assert.equal(got[0].name, "小明")
  assert.equal(got[0].domain, "www.codebuddy.ai")
})

test("导入：读浏览器登录的扁平形态（插件自己存的那份）", () => {
  const text = JSON.stringify({ access: "a", refresh: "r", expires: 0, uid: "u", domain: "www.codebuddy.ai" })
  const got = importedAccounts(text)
  assert.equal(got.length, 1)
  assert.equal(got[0].access, "a")
  assert.equal(got[0].uid, "u")
})

test("导入：秒级时间戳换算成毫秒", () => {
  const got = importedAccounts(JSON.stringify({ accessToken: "a", expiresAt: 1799999999 }))
  assert.equal(got[0].expires, 1799999999000)
})

test("导入：缺 expiresAt 时从 JWT 的 exp 声明补", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString("base64url")
  const got = importedAccounts(JSON.stringify({ accessToken: `h.${payload}.s` }))
  assert.equal(got[0].expires, 1800000000000)
})

test("导入：一次贴多个（数组 / accounts 包装）", () => {
  const a = { accessToken: "one", uid: "u1" }
  const b = { accessToken: "two", uid: "u2" }
  assert.equal(importedAccounts(JSON.stringify([a, b])).length, 2)
  assert.equal(importedAccounts(JSON.stringify({ accounts: [a, b] })).length, 2)
})

test("导入：纯文本每行一个令牌，跳过空行与注释", () => {
  const got = importedAccounts("# 注释\n\n tok-a \ntok-b\n")
  assert.deepEqual(got.map((x) => x.access), ["tok-a", "tok-b"])
})

test("导入：没有 accessToken 的条目跳过，不造一个空账号", () => {
  assert.deepEqual(importedAccounts(JSON.stringify({ uid: "u" })), [])
  assert.deepEqual(importedAccounts(""), [])
  assert.deepEqual(importedAccounts("   "), [])
})

test("导入：加密的令牌直接说清楚，而不是存个读不出的账号", () => {
  const text = JSON.stringify({ account: { uid: "u" }, auth: { accessToken: { $wbEncrypted: 1, envelope: {} } } })
  assert.throws(() => importedAccounts(text), /加密/)
})

test("导入：snake_case 字段（workbuddy / sub2api 这类工具的导出）", () => {
  const got = importedAccounts(JSON.stringify({
    id: "workbuddy_abc",
    uid: "c3c06836-2258-4000-ad31-3d079c14cf22",
    nickname: "懈君",
    access_token: "acc",
    refresh_token: "ref",
    token_type: "Bearer",
    expires_at: 1795246439610,
    domain: "www.codebuddy.cn",
  }))
  assert.equal(got.length, 1)
  assert.equal(got[0].access, "acc")
  assert.equal(got[0].refresh, "ref")
  assert.equal(got[0].tokenType, "Bearer")
  assert.equal(got[0].expires, 1795246439610)
  assert.equal(got[0].uid, "c3c06836-2258-4000-ad31-3d079c14cf22")
  assert.equal(got[0].name, "懈君")
  assert.equal(got[0].domain, "www.codebuddy.cn")
})

test("导入：只有 refresh_token 也收（实测 access 传空也能换出新令牌）", () => {
  const got = importedAccounts(JSON.stringify({ refresh_token: "ref", ncikname: "", expires_at: 1795246439610 }))
  assert.equal(got.length, 1)
  assert.equal(got[0].access, "")
  assert.equal(got[0].refresh, "ref")
})

test("导入：两个令牌都是空串就不算登录", () => {
  // 工具导出里常见的空壳记录：字段齐全但令牌被清空
  const got = importedAccounts(JSON.stringify({
    id: "workbuddy_abc", uid: "u", nickname: "某人", access_token: "", refresh_token: "", token_type: "Bearer", expires_at: 1795246439610, domain: "www.codebuddy.cn",
  }))
  assert.deepEqual(got, [])
})

test("导入：expires_in 相对秒数换算成绝对时间", () => {
  const before = Date.now()
  const got = importedAccounts(JSON.stringify({ access_token: "a", expires_in: 3600 }))
  assert.ok(got[0].expires >= before + 3599 * 1000)
  assert.ok(got[0].expires <= Date.now() + 3601 * 1000)
})

test("导入：email 也能当名字用", () => {
  const got = importedAccounts(JSON.stringify({ access_token: "a", email: "a@b.c" }))
  assert.equal(got[0].name, "a@b.c")
})
