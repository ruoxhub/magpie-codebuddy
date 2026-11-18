import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { fetchModels, modelsOfConfig, staticModels, modelsFrom, creditsOf } from "../lib/models.mjs"
import { SITES, SITE_IDS } from "../lib/sites.mjs"

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      handler(req, Buffer.concat(chunks).toString("utf8"), res)
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

// 实测 2026-11-14 国际版 /v3/config 的形态（截取）
const liveConfig = {
  code: 0,
  msg: "OK",
  data: {
    models: [
      { id: "default-model", name: "Auto", maxInputTokens: 176000, maxOutputTokens: 24000, supportsImages: true, supportsToolCall: true },
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", maxInputTokens: 1000000, maxOutputTokens: 128000, supportsImages: true, supportsToolCall: true },
      { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 1000000, maxOutputTokens: 48000, supportsImages: true, supportsToolCall: true },
      // 图片 / 视频生成模型没有 supportsToolCall，要剔除
      { id: "hy-image-3.5", name: "Hy Image", supportsImages: false },
      // default 不是真实模型，要剔除
      { id: "default", name: "Default" },
    ],
  },
}

test("modelsOfConfig 剔除 default 与无 supportsToolCall 的生成模型", () => {
  const got = modelsOfConfig(liveConfig.data)
  assert.deepEqual(
    got.map((m) => m.id),
    ["default-model", "deepseek-v4.1-flash", "glm-5.3"],
  )
})

test("modelsOfConfig 读上下文与输出上限、图片能力", () => {
  const [first] = modelsOfConfig(liveConfig.data)
  assert.equal(first.name, "Auto")
  assert.equal(first.context, 176000)
  assert.equal(first.output, 24000)
  assert.equal(first.images, true)
})

test("modelsOfConfig 对缺字段的条目给 0 而不是编造", () => {
  const got = modelsOfConfig({ models: [{ id: "x", supportsToolCall: true }] })
  assert.equal(got[0].context, 0)
  assert.equal(got[0].output, 0)
  assert.equal(got[0].images, false)
  // 没有推理信息就不声称能推理，也不编造档位
  assert.equal(got[0].reasoning, false)
  assert.deepEqual(got[0].efforts, [])
})

test("modelsOfConfig 对空 / 坏输入返回空表", () => {
  assert.deepEqual(modelsOfConfig({}), [])
  assert.deepEqual(modelsOfConfig({ models: null }), [])
  assert.deepEqual(modelsOfConfig(undefined), [])
})

test("fetchModels 用 CLI 形态的 UA 与 X-Domain", async () => {
  const site = { ...SITES["codebuddy-intl"], chat: "" }
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.url, "/v3/config")
    assert.equal(req.headers.authorization, "Bearer AT")
    assert.equal(req.headers["x-domain"], "www.codebuddy.ai")
    // 纯 "CLI/<v>" 会被上游判为版本解析失败（12403）
    assert.equal(req.headers["user-agent"], "CLI/2.141.0 CodeBuddy/2.141.0")
    res.end(JSON.stringify(liveConfig))
  })
  try {
    const got = await fetchModels({ ...site, chat: base }, "AT", "U1", { version: "2.141.0" })
    assert.equal(got.length, 3)
  } finally {
    server.close()
  }
})

test("fetchModels 在业务码非 0 时抛错", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 12403, msg: "UA 解析失败" })))
  try {
    await assert.rejects(() => fetchModels({ ...SITES.codebuddy, chat: base }, "AT", "U1"), /12403/)
  } finally {
    server.close()
  }
})

test("fetchModels 对非 JSON 响应抛错", async () => {
  const { server, base } = await startServer((req, body, res) => res.end("<html>oops</html>"))
  try {
    await assert.rejects(() => fetchModels({ ...SITES.codebuddy, chat: base }, "AT", "U1"), /读不出来/)
  } finally {
    server.close()
  }
})

test("staticModels 覆盖两个站点，字段齐全", () => {
  for (const id of SITE_IDS) {
    const list = staticModels(SITES[id])
    assert.ok(list.length > 0, id)
    for (const m of list) {
      assert.equal(typeof m.id, "string")
      assert.ok(m.id.length > 0)
      assert.equal(typeof m.name, "string")
      assert.equal(typeof m.context, "number")
      assert.equal(typeof m.output, "number")
      assert.equal(typeof m.images, "boolean")
    }
  }
})

test("modelsFrom 生成的 config 条目能被 host 读", () => {
  const got = modelsFrom([
    { id: "glm-5.3", name: "GLM-5.3", context: 1000000, output: 48000, images: true },
    { id: "kimi-k3", name: "Kimi K3", context: 1000000, output: 32000, images: false },
  ])
  assert.deepEqual(Object.keys(got), ["glm-5.3", "kimi-k3"])
  assert.equal(got["glm-5.3"].limit.context, 1000000)
  assert.equal(got["glm-5.3"].tool_call, true)
  assert.equal(got["glm-5.3"].attachment, true)
  assert.deepEqual(got["glm-5.3"].modalities.input, ["text", "image"])
  assert.equal(got["kimi-k3"].attachment, false)
  assert.deepEqual(got["kimi-k3"].modalities.input, ["text"])
})

// ---- 推理能力（实测 2026-11-14）-------------------------------------------------

// liveReasoning 是实测过的 /v3/config 推理相关片段
const liveReasoning = {
  models: [
    // canDisableThinking=true：可以关掉思考
    { id: "glm-5.3", supportsToolCall: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: "high", supportedEfforts: ["low", "high", "max"] } },
    // onlyReasoning=false：也可以关掉
    { id: "glm-5.2", supportsToolCall: true, supportsReasoning: true, onlyReasoning: false, reasoning: { canDisableThinking: true, defaultEffort: "high", supportedEfforts: ["high", "xhigh"] } },
    // canDisableThinking=false：不能关，给它 none 会被上游拒成 11158
    { id: "kimi-k3.1-pro", supportsToolCall: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: "high", supportedEfforts: ["low", "high", "max"] } },
    // 没有推理信息的模型
    { id: "default-model", supportsToolCall: true, name: "Auto" },
  ],
}

const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]))

test("modelsOfConfig 读出推理档位与默认档", () => {
  const m = byId(modelsOfConfig(liveReasoning))["glm-5.3"]
  assert.equal(m.reasoning, true)
  assert.equal(m.defaultEffort, "high")
  assert.equal(m.canDisable, true)
  // 可关的模型多一个 none 档
  assert.deepEqual(m.efforts, ["none", "low", "high", "max"])
})

test("modelsOfConfig 不给不能关思考的模型加 none 档", () => {
  const m = byId(modelsOfConfig(liveReasoning))["kimi-k3.1-pro"]
  assert.equal(m.canDisable, false)
  // 给了也是白给：上游会当成不支持
  assert.deepEqual(m.efforts, ["low", "high", "max"])
})

test("modelsOfConfig 把 onlyReasoning=false 也算成可关", () => {
  const m = byId(modelsOfConfig(liveReasoning))["glm-5.2"]
  assert.equal(m.canDisable, true)
  assert.deepEqual(m.efforts, ["none", "high", "xhigh"])
})

test("modelsOfConfig 对没有推理信息的模型不说它思考", () => {
  const m = byId(modelsOfConfig(liveReasoning))["default-model"]
  assert.equal(m.reasoning, false)
  assert.deepEqual(m.efforts, [])
  assert.equal(m.defaultEffort, "")
})

test("modelsFrom 把档位写成 variants（否则 magpie 会去 models.dev 借不一定存在的档位）", () => {
  const got = modelsFrom(modelsOfConfig(liveReasoning))
  assert.equal(got["glm-5.3"].reasoning, true)
  assert.deepEqual(Object.keys(got["glm-5.3"].variants), ["none", "low", "high", "max"])
  // 没有档位的模型不写 variants
  assert.equal("variants" in got["default-model"], false)
  assert.equal(got["default-model"].reasoning, false)
})

// ---- credits / 免费模型（实测 2026-11-14）-------------------------------------

test("creditsOf 读倍数：x0.03 / 0 / 空串", () => {
  assert.equal(creditsOf("x0.00"), 0)
  assert.equal(creditsOf("x0.03"), 0.03)
  assert.equal(creditsOf("x0.34 credits"), 0.34)
  assert.equal(creditsOf(0), 0)
  // 空串是「未知」，不是免费
  assert.equal(creditsOf(""), undefined)
  assert.equal(creditsOf(null), undefined)
  assert.equal(creditsOf(undefined), undefined)
})

test("modelsOfConfig 把 x0.00 的模型标成免费，空 credits 留成未知", () => {
  const got = byId(
    modelsOfConfig({
      models: [
        { id: "free", supportsToolCall: true, credits: "x0.00" },
        { id: "paid", supportsToolCall: true, credits: "x0.34 credits" },
        // 实测 default-model 的 credits 是空串：未知，不是免费
        { id: "unknown", supportsToolCall: true, credits: "" },
      ],
    }),
  )
  assert.equal(got.free.free, true)
  assert.equal(got.free.rate, 0)
  assert.equal(got.paid.free, false)
  assert.equal(got.paid.rate, 0.34)
  assert.equal(got.unknown.free, false)
  // 关键：未知不能写成 0，否则路由会把付费模型当免费优先用
  assert.equal(got.unknown.rate, undefined)
})

test("modelsFrom 只在真读到 rate 时才带上它", () => {
  const got = modelsFrom(
    modelsOfConfig({
      models: [
        { id: "free", supportsToolCall: true, credits: "x0.00" },
        { id: "unknown", supportsToolCall: true, credits: "" },
      ],
    }),
  )
  assert.equal(got.free.free, true)
  assert.equal(got.free.rate, 0)
  // 未知的 rate 不写；没写与写 false 对 magpie 等价（它判的是 === true）
  assert.equal(got.unknown.free, undefined)
  assert.equal("rate" in got.unknown, false)
})
