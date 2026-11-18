import test from "node:test"
import assert from "node:assert/strict"

import {
  outbound,
  normalizeToolChoice,
  normalizeImageUrls,
  normalizeMaxTokens,
  ensureLeadingSystemMessage,
  normalizeDeveloperRoles,
  replaceAgentSystemPrompts,
  unflag,
  unflagged,
  normalizeReasoningEffort,
  forceStream,
  chatHeaders,
  gzipBody,
  upstreamPath,
  identityPrefix,
  defaultSystemPrompt,
} from "../lib/outbound.mjs"
import { SITES } from "../lib/sites.mjs"

test("tool_choice 对象转字符串：auto / none / required", () => {
  for (const type of ["auto", "none", "required"]) {
    const chat = { tool_choice: { type } }
    assert.equal(normalizeToolChoice(chat), true)
    assert.equal(chat.tool_choice, type)
  }
})

test("tool_choice 函数型取裸函数名，缺名回落 auto", () => {
  const named = { tool_choice: { type: "function", function: { name: "get_weather" } } }
  normalizeToolChoice(named)
  assert.equal(named.tool_choice, "get_weather")

  // 部分客户端把函数名写在顶层
  const topLevel = { tool_choice: { type: "function", name: "search" } }
  normalizeToolChoice(topLevel)
  assert.equal(topLevel.tool_choice, "search")

  const nameless = { tool_choice: { type: "function", function: {} } }
  normalizeToolChoice(nameless)
  assert.equal(nameless.tool_choice, "auto")

  // 未知 type 也回落 auto，绝不发空串
  const unknown = { tool_choice: { type: "something" } }
  normalizeToolChoice(unknown)
  assert.equal(unknown.tool_choice, "auto")
})

test("tool_choice 已是字符串时不动", () => {
  const chat = { tool_choice: "auto" }
  assert.equal(normalizeToolChoice(chat), false)
  assert.equal(chat.tool_choice, "auto")
})

test("image_url 字符串包装为对象，空串保持原样", () => {
  const chat = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: "data:image/png;base64,AAA" },
          { type: "image_url", image_url: "" },
          { type: "text", text: "看图" },
        ],
      },
    ],
  }
  assert.equal(normalizeImageUrls(chat), true)
  assert.deepEqual(chat.messages[0].content[0].image_url, { url: "data:image/png;base64,AAA" })
  // 空串包成 {"url":""} 只会让上游多一条无效图片
  assert.equal(chat.messages[0].content[1].image_url, "")
  assert.equal(chat.messages[0].content[2].text, "看图")
})

test("image_url 已是对象时不重复包装", () => {
  const chat = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }
  assert.equal(normalizeImageUrls(chat), false)
})

test("max_completion_tokens 译为 max_tokens 并清空原字段", () => {
  const chat = { max_completion_tokens: 512 }
  assert.equal(normalizeMaxTokens(chat), true)
  assert.equal(chat.max_tokens, 512)
  assert.equal("max_completion_tokens" in chat, false)
})

test("max_completion_tokens 为 0 不翻译，但仍清空", () => {
  const chat = { max_completion_tokens: 0 }
  normalizeMaxTokens(chat)
  assert.equal(chat.max_tokens, undefined)
  assert.equal("max_completion_tokens" in chat, false)
})

test("max_tokens 已有值时不动它", () => {
  const chat = { max_tokens: 100, max_completion_tokens: 512 }
  normalizeMaxTokens(chat)
  assert.equal(chat.max_tokens, 100)
  assert.equal("max_completion_tokens" in chat, false)
})

test("首条非 system 时插入兜底 system", () => {
  const chat = { messages: [{ role: "user", content: "hi" }] }
  assert.equal(ensureLeadingSystemMessage(chat), true)
  assert.equal(chat.messages[0].role, "system")
  assert.equal(chat.messages[0].content, defaultSystemPrompt)
  assert.equal(chat.messages.length, 2)
})

test("首条已是 system 或消息为空时不动", () => {
  const withSystem = { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }
  assert.equal(ensureLeadingSystemMessage(withSystem), false)
  assert.equal(withSystem.messages.length, 2)

  const empty = { messages: [] }
  assert.equal(ensureLeadingSystemMessage(empty), false)
  assert.equal(empty.messages.length, 0)
})

test("developer 角色归一为 system", () => {
  const chat = { messages: [{ role: "developer", content: "x" }, { role: "user", content: "hi" }] }
  assert.equal(normalizeDeveloperRoles(chat), true)
  assert.equal(chat.messages[0].role, "system")
})

test("developer 打头时只注入一条 system，不会多注一条", () => {
  // 顺序约束：developer→system 必须早于首条 system 注入
  const chat = { messages: [{ role: "developer", content: "be nice" }, { role: "user", content: "hi" }] }
  const { chat: shaped } = outbound(chat)
  assert.equal(shaped.messages.length, 2)
  assert.equal(shaped.messages[0].role, "system")
  assert.equal(shaped.messages[0].content, "be nice")
})

test("会被上游拒（11128）的 Claude Code 开场只加身份前缀，原提示词保留", () => {
  // 实测：校验只看字符串开头，任何非空前缀都能过，所以不必整条换掉
  const sys = "You are Claude Code, Anthropic's official CLI for Claude.\nNever run rm -rf."
  const chat = { messages: [{ role: "system", content: sys }, { role: "user", content: "hi" }] }
  assert.equal(replaceAgentSystemPrompts(chat), true)
  assert.equal(chat.messages[0].content, identityPrefix + "\n\n" + sys)
  // 用户自己的约束还在
  assert.ok(chat.messages[0].content.includes("Never run rm -rf."))
})

test("已经带身份前缀的不重复加", () => {
  const sys = identityPrefix + "\n\nYou are Claude Code, Anthropic's official CLI for Claude."
  const chat = { messages: [{ role: "system", content: sys }] }
  assert.equal(replaceAgentSystemPrompts(chat), false)
  assert.equal(chat.messages[0].content, sys)
})

test("上游实测通过的 agent 身份提示词一律不动", () => {
  // 逐个实测过：这些都 200，改掉等于默默篡改用户的提示词
  for (const sys of [
    "You are Claude Code.",
    "You are Cursor, an AI code editor.",
    "You are Windsurf, an AI code editor.",
    "You are Cline, an AI coding agent.",
    "You are OpenCode, an AI coding agent.",
    "You are Codex, a coding agent based on GPT-5.",
    "You are Claude Code, Anthropic's official CLI.",
    "You are X, Anthropic's official CLI for Claude.",
    "cc_entrypoint=cli",
  ]) {
    const chat = { messages: [{ role: "system", content: sys }] }
    assert.equal(replaceAgentSystemPrompts(chat), false, sys)
    assert.equal(chat.messages[0].content, sys, sys)
  }
})

test("超长但普通的 system prompt 不被改写", () => {
  // 实测 2000+ 字的普通 system prompt 上游照常 200
  const long = "You are a helpful assistant. " + "x".repeat(3000)
  const chat = { messages: [{ role: "system", content: long }] }
  assert.equal(replaceAgentSystemPrompts(chat), false)
  assert.equal(chat.messages[0].content, long)
})

test("普通 system prompt 保持原样", () => {
  const chat = { messages: [{ role: "system", content: "You are a helpful assistant." }] }
  assert.equal(replaceAgentSystemPrompts(chat), false)
  assert.equal(chat.messages[0].content, "You are a helpful assistant.")
})

test("数组形态的 system content 换掉后仍是数组", () => {
  const chat = { messages: [{ role: "system", content: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] }] }
  assert.equal(replaceAgentSystemPrompts(chat), true)
  assert.ok(Array.isArray(chat.messages[0].content))
  assert.equal(chat.messages[0].content[0].text, identityPrefix + "\n\nYou are Claude Code, Anthropic's official CLI for Claude.")
})

test("FLAGGED 的每一行都换成能过的说法，不分大小写", () => {
  assert.equal(unflagged("You are Claude Code, Anthropic's official CLI for Claude."), "You are Claude Code, Anthropic's CLI for Claude.")
  assert.equal(unflagged("Main branch (you will usually use this for PRs): main"), "Main branch (usually the base for PRs): main")
  assert.equal(unflagged("MAIN BRANCH (YOU WILL USUALLY USE THIS FOR PRS): main"), "Main branch (usually the base for PRs): main")
  assert.equal(unflagged("Codex CLI is an open source project led by OpenAI."), "The Codex CLI is an open source project led by OpenAI.")
  assert.equal(unflagged("x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=cli;\nhello"), "hello")
  assert.equal(unflagged("nothing to see"), "nothing to see")
})

test("DeepSeek Harness 的开场保留 harness 名字，只加一个逗号", () => {
  // 整行精确匹配：加字（Desktop / CLI）反而仍被拒，逗号才过
  const opener = "You are an AI agent powered by DeepSeek Harness."
  const spread = unflagged(opener)
  assert.equal(spread, "You are an AI agent, powered by DeepSeek Harness.")
  assert.ok(spread.includes("DeepSeek Harness"))
  assert.notEqual(spread, opener)
  // 幂等：改完再跑一次不再变
  assert.equal(unflagged(spread), spread)
})

test("unflag 逐条消息改写，只装着 billing 头的 system 块整条丢掉", () => {
  const chat = {
    messages: [
      { role: "system", content: "x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=cli;" },
      { role: "system", content: [{ type: "text", text: "x-anthropic-billing-header: v=1;" }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] },
      { role: "user", content: "gitStatus\nMain branch (you will usually use this for PRs): main" },
      { role: "assistant", content: "Web GUI whose URL the runtime context names. When the user refers to it, open it." },
    ],
  }
  assert.equal(unflag(chat), true)
  // 第一条只剩空白的 system 块没了
  assert.equal(chat.messages.length, 3)
  assert.deepEqual(chat.messages[0], { role: "system", content: [{ type: "text", text: "You are Claude Code, Anthropic's CLI for Claude." }] })
  // user 消息里的行也改（上游不读 user，但统一改成本更低）
  assert.equal(chat.messages[1].content, "gitStatus\nMain branch (usually the base for PRs): main")
  // 模型引用回 assistant 消息的那行也改（#291）
  assert.equal(chat.messages[2].content, "Web GUI whose URL the runtime context names. The interface, when the user refers to it, open it.")
})

test("没有命中 FLAGGED 的 chat 一字不改", () => {
  const chat = { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] }
  assert.equal(unflag(chat), false)
  assert.equal(chat.messages[0].content, "be brief")
})

test("outbound 全流程：FLAGGED 的行在前缀之后被改写", () => {
  const chat = {
    messages: [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude.\nMain branch (you will usually use this for PRs): main" },
      { role: "user", content: "hi" },
    ],
  }
  const { chat: shaped, changed } = outbound(chat)
  assert.equal(changed, true)
  assert.equal(
    shaped.messages[0].content,
    identityPrefix + "\n\nYou are Claude Code, Anthropic's CLI for Claude.\nMain branch (usually the base for PRs): main",
  )
})

test("reasoning_effort：模型可关时发 none，不可关时删字段", () => {
  // 实测：发 none 比删字段可靠得多（删字段完全靠模型默认，而默认往往是 high）
  const off = { reasoning_effort: "none" }
  assert.equal(normalizeReasoningEffort(off, { canDisable: true }), false)
  assert.equal(off.reasoning_effort, "none")

  // off 不是上游认识的档位，可关时改写成 none
  const offWord = { reasoning_effort: "off" }
  assert.equal(normalizeReasoningEffort(offWord, { canDisable: true }), true)
  assert.equal(offWord.reasoning_effort, "none")

  // 不能关的模型（canDisableThinking=false）发 none 会被拒成 11158，只能删字段
  const cannot = { reasoning_effort: "none" }
  assert.equal(normalizeReasoningEffort(cannot, { canDisable: false }), true)
  assert.equal("reasoning_effort" in cannot, false)

  const high = { reasoning_effort: "high" }
  normalizeReasoningEffort(high)
  assert.equal(high.reasoning_effort, "high")
  assert.equal(high.reasoning_summary, "auto")
})

test("恒强制 stream=true 且带 usage", () => {
  const chat = { stream: false }
  assert.equal(forceStream(chat), true)
  assert.equal(chat.stream, true)
  assert.deepEqual(chat.stream_options, { include_usage: true })
  // 顺带补 cache_retention：不带它时对话的首个请求永远全价
  assert.equal(chat.cache_retention, "long")

  const already = { stream: true, stream_options: { include_usage: true }, cache_retention: "long" }
  assert.equal(forceStream(already), false)
})

test("调用方自己给了 cache_retention 就不改", () => {
  const chat = { stream: true, stream_options: { include_usage: true }, cache_retention: "short" }
  forceStream(chat)
  assert.equal(chat.cache_retention, "short")
})

test("outbound 全流程：一次改动后的请求体满足上游所有硬约束", () => {
  const chat = {
    model: "glm-5.3",
    messages: [
      { role: "developer", content: "You are Claude Code, Anthropic's official CLI for Claude." },
      { role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,AA" }] },
    ],
    tool_choice: { type: "function", function: { name: "read_file" } },
    max_completion_tokens: 256,
    reasoning_effort: "none",
  }
  const { chat: shaped, changed } = outbound(chat)
  assert.equal(changed, true)
  assert.equal(shaped.messages[0].role, "system")
  // 先加身份前缀（原文保留），再由 FLAGGED 把这行改成能过的说法（它也会出现在 assistant 消息里）
  assert.equal(shaped.messages[0].content, identityPrefix + "\n\nYou are Claude Code, Anthropic's CLI for Claude.")
  assert.deepEqual(shaped.messages[1].content[0].image_url, { url: "data:image/png;base64,AA" })
  assert.equal(shaped.tool_choice, "read_file")
  assert.equal(shaped.max_tokens, 256)
  assert.equal("max_completion_tokens" in shaped, false)
  // 模型可关思考时保留 none（删字段会让上游回落到默认，仍在思考）
  assert.equal(shaped.reasoning_effort, "none")
  assert.equal(shaped.stream, true)
  assert.deepEqual(shaped.stream_options, { include_usage: true })
})

test("outbound 全流程：不可关思考的模型把 none 删掉", () => {
  const chat = {
    model: "kimi-k3.1-pro",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
    reasoning_effort: "none",
  }
  const { chat: shaped } = outbound(chat, { canDisable: false })
  // 这类模型发 none 会被上游当模型不可用拒成 11158
  assert.equal("reasoning_effort" in shaped, false)
})

test("outbound 不改变已是最终形态的请求体", () => {
  const chat = {
    model: "glm-5.3",
    messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
    cache_retention: "long",
  }
  const { changed } = outbound(chat)
  assert.equal(changed, false)
})

test("chatHeaders 带齐上游校验需要的头", () => {
  const site = SITES.codebuddy
  const h = chatHeaders(site, "2.141.0")
  // HTTP 头大小写不敏感，按小写查找
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  // 缺 gzip / trace / X-B3-Sampled 任一项，上游直接 11128
  for (const key of [
    "X-Domain",
    "X-IDE-Type",
    "X-IDE-Name",
    "X-IDE-Version",
    "X-Agent-Intent",
    "X-Agent-Purpose",
    "X-Agent-Type",
    "X-Product",
    "X-B3-Sampled",
    "X-Requested-With",
    "x-codebuddy-request",
    "traceparent",
    "b3",
    "X-B3-TraceId",
    "X-B3-SpanId",
    "X-Trace-ID",
    "X-Conversation-ID",
    "X-Conversation-Request-ID",
    "X-Root-Request-ID",
    "X-Request-ID",
    "X-Conversation-Message-ID",
    "X-User-Id",
    "User-Agent",
  ]) {
    assert.ok(lower[key.toLowerCase()], key)
  }
  assert.equal(h["X-Domain"], site.domain)
  assert.equal(h["User-Agent"], "CLI/2.141.0 CodeBuddy/2.141.0")
  assert.match(h["X-User-Id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // stainless 头取自当前运行时，不是写死的常量
  assert.equal(h["x-stainless-runtime-version"], process.version)
  assert.match(h["x-stainless-arch"], /^(x32|x64|arm|arm64)$/)
  assert.match(h["x-stainless-os"], /^(Windows|MacOS|Linux|FreeBSD)$/)
})

test("chatHeaders 每次调用生成独立的 trace 与会话 id", () => {
  const a = chatHeaders(SITES.codebuddy, "2.141.0")
  const b = chatHeaders(SITES.codebuddy, "2.141.0")
  for (const key of ["X-Trace-ID", "X-Conversation-ID", "X-Request-ID", "X-User-Id"]) {
    assert.notEqual(a[key], b[key], key)
  }
  // traceparent 的第一段必须是 trace id
  assert.ok(a.traceparent.includes(a["X-Trace-ID"]))
})

test("chatHeaders 的 X-Domain 随站点变化", () => {
  assert.equal(chatHeaders(SITES.codebuddy, "2.141.0")["X-Domain"], "www.codebuddy.cn")
  assert.equal(chatHeaders(SITES["codebuddy-intl"], "2.141.0")["X-Domain"], "www.codebuddy.ai")
})

test("gzipBody 能压字符串、ArrayBuffer 与视图，其它返回 null", () => {
  assert.ok(Buffer.isBuffer(gzipBody("{}")))
  assert.ok(Buffer.isBuffer(gzipBody(new TextEncoder().encode("{}").buffer)))
  assert.ok(Buffer.isBuffer(gzipBody(new TextEncoder().encode("{}"))))
  assert.equal(gzipBody(null), null)
  assert.equal(gzipBody(123), null)
})

test("upstreamPath 把所有协议形态落到 /v2/chat/completions", () => {
  for (const path of [
    "/v2/chat/completions",
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/messages",
    "/v1/responses",
  ]) {
    assert.equal(upstreamPath(path), "/v2/chat/completions", path)
  }
  // 其它 /v1 路径按 Go 侧规则换成 /v2
  assert.equal(upstreamPath("/v1/models"), "/v2/models")
  // 已是非 v1 的路径原样
  assert.equal(upstreamPath("/v3/config"), "/v3/config")
})

// ---- 请求头必需性与会话派生（实测 2026-11-14）--------------------------------

test("三个 conversation 头是 32 位 hex（短值会被上游拒成 11133）", () => {
  const h = chatHeaders(SITES.codebuddy, "2.141.0")
  for (const k of ["X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
    assert.match(h[k], /^[0-9a-f]{32}$/, k)
  }
})

test("同一 session 的 conversation 与 turn 稳定，request 每次不同", () => {
  const a = chatHeaders(SITES.codebuddy, "2.141.0", { session: "s1" })
  const b = chatHeaders(SITES.codebuddy, "2.141.0", { session: "s1" })
  assert.equal(a["X-Conversation-ID"], b["X-Conversation-ID"])
  // 一次发送的多个步骤共用同一个 turn，上游才把它算作一次请求
  assert.equal(a["X-Conversation-Request-ID"], b["X-Conversation-Request-ID"])
  assert.notEqual(a["X-Request-ID"], b["X-Request-ID"])
  assert.notEqual(a["X-Conversation-Message-ID"], b["X-Conversation-Message-ID"])
})

test("换 session 后 conversation 与 turn 都变", () => {
  const a = chatHeaders(SITES.codebuddy, "2.141.0", { session: "s1" })
  const b = chatHeaders(SITES.codebuddy, "2.141.0", { session: "s2" })
  assert.notEqual(a["X-Conversation-ID"], b["X-Conversation-ID"])
  assert.notEqual(a["X-Conversation-Request-ID"], b["X-Conversation-Request-ID"])
})

test("没有 session 时每次都是新对话，不会把不相关请求合成一个", () => {
  const a = chatHeaders(SITES.codebuddy, "2.141.0")
  const b = chatHeaders(SITES.codebuddy, "2.141.0")
  assert.notEqual(a["X-Conversation-ID"], b["X-Conversation-ID"])
  assert.notEqual(a["X-Conversation-Request-ID"], b["X-Conversation-Request-ID"])
})

test("派生出的 id 不包含会话名原文", () => {
  const h = chatHeaders(SITES.codebuddy, "2.141.0", { session: "my-secret-project-name" })
  assert.ok(!h["X-Conversation-ID"].includes("secret"))
  assert.ok(!h["X-Conversation-Request-ID"].includes("secret"))
})
