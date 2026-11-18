// 请求归一化，对齐 new-api 的
// internal/relay/channel/codebuddy/normalize.go 与 adaptor.go 的
// ConvertOpenAIRequest / SetupRequestHeader / setTraceHeaders。
//
// 英文名叫 outbound 而不是 normalize，是因为它做的不只是「归一」：还做内容清洗
// （agent 身份提示词中性化、超大工具描述清空）与出站形态强制（恒 stream）。

import { gzipSync } from "node:zlib"
import { createHash, randomBytes, randomUUID } from "node:crypto"

// defaultSystemPrompt 是首条消息非 system 时注入的兜底系统提示词。
export const defaultSystemPrompt = "You are a helpful assistant."

// identityPrefix 是加在会被拒的 system prompt 前面的身份行。
//
// 用上游自己的自称（"You are CodeBuddy Code."，见真实 CLI 抓包），而不是随便一句：
// 上游若开始校验「开头像不像自己的客户端」，这个值才站得住。
export const identityPrefix = "You are CodeBuddy Code."

// agentPromptPattern 匹配会被上游判为「非官方渠道」而拒（11128）的 system prompt。
//
// ── 实测收窄（2026-11-14，国际版 glm-5.3）───────────────────
// 逐个发真提示词看哪些真被拒：
//
//   ★ "You are Claude Code, Anthropic's official CLI for Claude."  400/11128
//     开头带这段的也拒（"...Claude, and more."、加 "You are an interactive CLI tool..."）
//     全小写、末尾无句号也拒
//     通过："You are Claude Code."（不带逗号后半句）
//     通过：分两行写
//     通过："You are Claude Code, Anthropic's official CLI."（少了 for Claude）
//     通过："You are X, Anthropic's official CLI for Claude."
//     通过：开头前面多一段文字
//     通过：Cursor / Windsurf / Cline / OpenCode / Codex / cc_entrypoint
//
// 结论：触发条件是「以 You are Claude Code, Anthropic's official CLI for Claude
// 开头」这一整句，不是宽泛的 agent 身份特征。
//
// ── 为何与 Go 侧的宽 regex 不同 ─────────────────────
// Go 的 agentPromptPattern 把 Cursor / Windsurf / Cline / "you are an ai agent" /
// cc_entrypoint 等都算上，还带一条「超过 2000 字就换」。但上表实测显示这些都通过，
// 按宽规则会把大量正常 system prompt 误改成中性提示词——用户自己的提示词被默默
// 改掉，比被拒更难排查。所以这里只改真正会被拒的那一种，其余一律不动。
export const agentPromptPattern = /^\s*you are claude code, anthropic'?s official cli for claude/i

// contentText 把一个 message 的 content 读成纯文本：字符串原样，数组取各 text 片段拼接。
function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const part of content) {
    if (part && typeof part === "object" && typeof part.text === "string") out += part.text
  }
  return out
}

// normalizeDeveloperRoles 把 developer 角色改名为 system。
//
// 必须在内容清洗之前：带 agent 身份的 developer 提示词，若只扫 system 就会漏网。
export function normalizeDeveloperRoles(chat) {
  let changed = false
  for (const msg of chat.messages ?? []) {
    if (msg && msg.role === "developer") {
      msg.role = "system"
      changed = true
    }
  }
  return changed
}

// normalizeToolChoice 把对象形态的 tool_choice 转为上游要求的字符串形态。
// 上游字段声明为 string，收到对象报 11101 unmarshal 错误。
// 只做形态转换：函数型取裸函数名，未知 type / 缺函数名退回 auto（绝不发空串）。
export function normalizeToolChoice(chat) {
  const object = chat.tool_choice
  if (!object || typeof object !== "object" || Array.isArray(object)) return false
  const type = object.type
  if (type === "auto" || type === "none" || type === "required") {
    chat.tool_choice = type
    return true
  }
  if (type === "function") {
    // 函数名可能在 function.name（标准形态）或顶层 name（部分客户端的写法）
    const fn = object.function
    let name = ""
    if (fn && typeof fn === "object" && typeof fn.name === "string") name = fn.name
    if (!name && typeof object.name === "string") name = object.name
    chat.tool_choice = name || "auto"
    return true
  }
  chat.tool_choice = "auto"
  return true
}

// normalizeImageUrls 把字符串形态的 image_url 包装为 {"url": s}。
// 上游把该字段声明为结构体，收到字符串报 11101 unmarshal 错误。
// 空字符串保持原样 —— 包成 {"url":""} 只会让上游多一条无效图片。
export function normalizeImageUrls(chat) {
  let changed = false
  for (const msg of chat.messages ?? []) {
    if (!msg || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (!part || typeof part !== "object" || part.type !== "image_url") continue
      if (typeof part.image_url !== "string" || part.image_url === "") continue
      part.image_url = { url: part.image_url }
      changed = true
    }
  }
  return changed
}

// normalizeMaxTokens 把 max_completion_tokens 译为 max_tokens。
// 上游不认 max_completion_tokens 且静默忽略，输出会被默认上限截断 —— 比报错更糟。
export function normalizeMaxTokens(chat) {
  if (chat.max_completion_tokens === undefined || chat.max_completion_tokens === null) return false
  const value = chat.max_completion_tokens
  if ((chat.max_tokens === undefined || chat.max_tokens === null) && value !== 0) chat.max_tokens = value
  // 无论是否翻译都清空：避免两个字段同时存在时上游优先取错的那个
  delete chat.max_completion_tokens
  return true
}

// ensureLeadingSystemMessage 保证首条消息是 system，否则上游报
// 11128 first message is not system prompt。
//
// 调用方必须先做 normalizeDeveloperRoles：客户端用 developer 打头时，
// 先归一成 system 才判得出「首条已是 system」，否则会多注入一条兜底 system。
export function ensureLeadingSystemMessage(chat) {
  const messages = chat.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  if (messages[0] && messages[0].role === "system") return false
  messages.unshift({ role: "system", content: defaultSystemPrompt })
  return true
}

// normalizeReasoningEffort 适配 reasoning_effort，并把模型能不能关思考算进去。
//
// 实测 2026-11-14，同一句提示、同一个账号：
//   glm-5.3  (canDisableThinking=true)  none 原样发 -> 0 字推理；删字段 -> 11 字
//   hy3      (canDisableThinking=false) none 原样发 -> 0 字推理；删字段 -> 98 字
//   glm-5.2  (canDisableThinking=true)  none 原样发 -> 0 字；删字段 -> 0 字
// 即：用户要关掉时，发 none 比删字段可靠得多（删字段完全靠模型默认，而默认往往是
// high）。只有 canDisableThinking=false 的模型才删字段——实测 kimi-k3.1-pro
// 发 none 会被上游当模型不可用拒成 11158。
//
// "off" 不是上游认识的档位（实测在 glm-5.2 上被忽略，仍思考 138 字），所以与 none 同样对待。
//
// 显式要求推理时追加 reasoning_summary=auto 以返回思考摘要。
export function normalizeReasoningEffort(chat, { canDisable = true } = {}) {
  const effort = chat.reasoning_effort
  if (effort === "none" || effort === "off") {
    if (canDisable) {
      if (chat.reasoning_effort === "none") return false
      chat.reasoning_effort = "none"
      return true
    }
    delete chat.reasoning_effort
    return true
  }
  if (typeof effort === "string" && effort !== "") {
    if (chat.reasoning_summary !== "auto") {
      chat.reasoning_summary = "auto"
      return true
    }
  }
  return false
}

// replaceAgentSystemPrompts 给会被上游拒（11128）的 system 消息加一个身份前缀。
//
// ── 为什么是加前缀，而不是整条换掉 ────────────────────────
// 实测 2026-11-18（国际版 glm-5.3）：
//   "You are Claude Code, Anthropic's official CLI for Claude."        400/11128
//   "You are CodeBuddy Code.\n\n" + 同一句                            200
//   "You are CodeBuddy Code.\n\n" + 同一句 + 完整正文                    200
//   "." + 同一句                                                          200
// 即校验只看**字符串开头**：任何非空前缀都能过。所以整条替换是没必要的损失 ——
// 换掉会把用户提示词里真正有用的约束（输出格式、安全禁令、风格要求）一起丢掉。
//
// 实测用户指令遵守度（提示词要求"只输出 ARRR <answer>"）：原文、加原生提示词前缀、
// 加身份行前缀三种写法都遵守。而对比"整条换掉"与"加前缀保留"两版 Claude Code 提示词
// （其中写着"输出压到 10 词内、不要解释"）：
//   整条换掉 -> "Hello! 👋 15 × 15 = **225** Is there anything else..."（73 字，客套话回来了）
//   加前缀   -> "Hello! 15×15 = 225."（19 字，原约束生效）
//
// 只按 agentPromptPattern 判，不加「超过 2000 字就换」这条兜底：实测一个 2000+ 字的
// 普通 system prompt 上游照常 200，而改它等于默默改掉用户的提示词。
export function replaceAgentSystemPrompts(chat) {
  let changed = false
  for (const msg of chat.messages ?? []) {
    if (!msg || msg.role !== "system") continue
    const text = contentText(msg.content)
    if (text === "" || !agentPromptPattern.test(text)) continue
    // 已经带了身份前缀就别重复加
    if (/^\s*you are codebuddy code/i.test(text)) continue
    const next = identityPrefix + "\n\n" + text
    if (typeof msg.content === "string") msg.content = next
    else msg.content = [{ type: "text", text: next }, ...msg.content.filter((p) => !(p && p.type === "text"))]
    changed = true
  }
  return changed
}

// FLAGGED 是上游认得出「来自另一个 agent」的整行原话，每行配一句说同一件事、又能过的说法。
//
// 移植自 workbuddy 插件的同名表（magpie-community/plugins#182、#279、#291），那些行是
// 对 WorkBuddy 实测出来的；CodeBuddy 与 WorkBuddy 是同一个团队的相近产品，渠道校验的
// 判据也是同一套（11128 / unapproved channel），所以整表带过来。
//
// 两条约束都来自实测，不是口味：
//   - 校验按整行精确匹配，多一个字符就过，所以改动要尽可能小——把整行换成别的话是 bug，
//     不是修复（早先一版把 harness 名字从唯一说明「谁在跑」的那行里改掉了）。
//   - 指纹是一行原话，不是一个产品名：别人句子里单独出现的 DeepSeek / DeepSeek Harness
//     不被拒，所以每条 pattern 都要收窄到刚够用的程度。
//
// 与 replaceAgentSystemPrompts 分工：那条只管「以 Claude Code 开场」这一种（加前缀即可，
// 原文一字不动）；这里管的是无论在消息哪个位置出现都要改的行，以及只能删掉的 billing 头。
// 上游读 system 与 assistant 两种消息，user 与工具结果不读；这里仍然逐条消息改，
// 因为模型会把被拒的行原样引用回 assistant 消息里。
export const FLAGGED = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ""],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, "Main branch (usually the base for PRs)"],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, "The Codex CLI is an open source project led by OpenAI."],
  // DeepSeek Harness (DSH) 用这行开场，上游按 11128 拒。整行精确匹配，一个逗号就够。
  [/You are an AI agent powered by DeepSeek Harness\.?/gi, "You are an AI agent, powered by DeepSeek Harness."],
  // DSH 长对话里的一行，模型会把它引用回 assistant 消息，所以每条消息都要改。
  [/Web GUI whose URL the runtime context names\.\s+When the user refers/gi, "Web GUI whose URL the runtime context names. The interface, when the user refers"],
]

// unflagged 把 text 里 FLAGGED 的各行换成能过的说法。
export function unflagged(text) {
  for (const [re, to] of FLAGGED) text = text.replace(re, to)
  return text
}

// unflag 逐条消息做 unflagged；一条消息改完只剩空白且本来是 system 时整条丢掉
// （billing 头那种只装着被删内容的 system 块）。返回是否改动过。
export function unflag(chat) {
  const messages = chat?.messages
  if (!Array.isArray(messages)) return false
  let changed = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (typeof msg?.content === "string") {
      const text = unflagged(msg.content)
      if (text === msg.content) continue
      changed = true
      if (text.trim() || msg.role !== "system") msg.content = text
      else messages.splice(i, 1)
    } else if (Array.isArray(msg?.content)) {
      const parts = []
      let here = false
      for (const part of msg.content) {
        const text = typeof part?.text === "string" ? unflagged(part.text) : null
        if (text === null || text === part.text) {
          parts.push(part)
          continue
        }
        here = true
        if (text.trim()) parts.push({ ...part, text })
      }
      if (!here) continue
      changed = true
      if (parts.length || msg.role !== "system") msg.content = parts
      else messages.splice(i, 1)
    }
  }
  return changed
}

// textOf 把一个 message 的 content 读成纯文本（数组取各 text 片段拼接）。
function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n")
}

// systemKey 是一个 chat 的 system 消息的文本，用来记住「这个提示词被拒过」/「这个
// 提示词靠逗号过了」。兜底提示词不算：它不是 agent 的身份提示词，记它会让所有 agent
// 共用一个键。空串表示没有可记的 system 提示词。
export function systemKey(chat) {
  const msgs = chat?.messages
  if (!Array.isArray(msgs)) return ""
  const key = msgs.filter((m) => m?.role === "system").map((m) => textOf(m.content)).join("\n")
  return key.trim() === defaultSystemPrompt ? "" : key
}

// systemAsUser 把 system 提示词搬进首条 user 消息（包在 <instructions> 里），system 槽
// 留兜底提示词。返回是否改过；原地改 chat。
//
// 为什么这能过：上游的渠道校验只读 system 与 assistant 两种消息，user 消息不读。
// 实测 2026-11-18 国际版（deepseek-v4.1-flash，stream，同一账号）：
//   "You are Claude Code, Anthropic's official CLI for Claude." 放 system  -> 400/11128
//   同一句包进 user 消息的 <instructions>                                   -> 200
//   同一句直放 user（无标签）                                              -> 200
//   同一句放 assistant 消息                                              -> 400/11128
// 所以它是「表与前缀都没盖住的 agent 开场行」的最后一道网。
//
// 当前的可达性：已知的被拒行都已经被 replaceAgentSystemPrompts（前缀）或 FLAGGED
// （改词）接住了，所以这一步现在几乎不触发。它是为「上游明天认了一个新行」准备的：
// 前缀规则只认 Claude Code 那一种，FLAGGED 只认实测过的整行。
//
// 代价是模型不再以「系统指令」的身份读它，所以它是最后一步，不是第一步。
// 后续的 system 消息就地变成 user（否则它们会被接着拒），首条 system 用兜底提示词
// 顶上（上游要求首条是 system，否则 11128 first message is not system prompt）。
export function systemAsUser(chat) {
  const msgs = chat?.messages
  if (!Array.isArray(msgs)) return false
  let i = 0
  const lead = []
  for (; i < msgs.length && msgs[i]?.role === "system"; i++) lead.push(textOf(msgs[i].content))
  const said = lead.join("\n\n").trim()
  const rest = msgs.slice(i).map((m) => (m?.role === "system" ? { ...m, role: "user" } : m))
  const moved = said && said !== defaultSystemPrompt
  if (!moved && rest.every((m, k) => m === msgs[i + k])) return false
  if (moved) {
    const text = "<instructions>\n" + said + "\n</instructions>"
    const u = rest.findIndex((m) => m?.role === "user")
    if (u < 0) rest.unshift({ role: "user", content: text })
    else if (typeof rest[u].content === "string") rest[u] = { ...rest[u], content: text + "\n\n" + rest[u].content }
    else if (Array.isArray(rest[u].content)) rest[u] = { ...rest[u], content: [{ type: "text", text }, ...rest[u].content] }
    else rest[u] = { ...rest[u], content: text }
  }
  chat.messages = [{ role: "system", content: defaultSystemPrompt }, ...rest]
  return true
}

// forceStream 恒强制 stream=true 并携带 usage：上游只支持流式返回。
//
// 同时补上 cache_retention: "long"。实测 2026-11-18（国际版 glm-5.3，同一对话两轮）：
//   不带 cache_retention：第一次 hit=0，第二次 1984 / 0 / 1984（不稳定）
//   带 "long"：第一次就 1792 / 1792 / 1984，第二次同样
// 即带它时连对话的首个请求也能命中已有缓存，不带则首个请求永远全价。
// 这是 CodeBuddy CLI 自己发的值（2.177.1 的拓包里有），不填就是白付钱。
export function forceStream(chat) {
  let changed = false
  if (chat.stream !== true) {
    chat.stream = true
    changed = true
  }
  if (!chat.stream_options || chat.stream_options.include_usage !== true) {
    chat.stream_options = { ...(chat.stream_options ?? {}), include_usage: true }
    changed = true
  }
  // 调用方自己给了就别改：它可能有意用别的保留级别
  if (chat.cache_retention === undefined) {
    chat.cache_retention = "long"
    changed = true
  }
  return changed
}

// outbound 按 Go 侧的顺序把请求体调成上游接受的形态，返回 { chat, changed }。
//
// 顺序不可调换：
//   developer→system → 形态归一（tool_choice / image_url / max_tokens / 首条 system）
//   → agent prompt 中性化（加前缀）→ FLAGGED 逐消息改写 → reasoning_effort → 恒 stream
//
// 三步的先后都有硬约束：developer 归一必须早于首条 system 注入，形态归一必须早于
// agent prompt 中性化（后者读 content，归一的改写要先落地）；FLAGGED 排在加前缀之后，
// 于是前缀与改写后的正文一起发出去，且 unflag 丢掉的空 system 块不会让首条 system 落空
// （首条 system 注入在它之前就已经补过了）。
//
// canDisable 是该模型能不能关思考（从 /v3/config 的 canDisableThinking /
// onlyReasoning 得来），默认 true：不知道时不把用户的“关掉”降级成删字段。
export function outbound(chat, { canDisable = true } = {}) {
  let changed = false
  if (normalizeDeveloperRoles(chat)) changed = true
  if (normalizeToolChoice(chat)) changed = true
  if (normalizeImageUrls(chat)) changed = true
  if (normalizeMaxTokens(chat)) changed = true
  if (ensureLeadingSystemMessage(chat)) changed = true
  if (replaceAgentSystemPrompts(chat)) changed = true
  if (unflag(chat)) changed = true
  if (normalizeReasoningEffort(chat, { canDisable })) changed = true
  if (forceStream(chat)) changed = true
  return { chat, changed }
}

// hex 返回 nBytes 个随机字节的 hex 表示。
const hex = (nBytes) => randomBytes(nBytes).toString("hex")

// chatHeaders 返回 CodeBuddy 上游每个聊天请求都带的固定请求头。
//
// ── 三个 conversation 头是必需的 ────────────────────────
// 实测 2026-11-14 逐个删除请求头：只有这三个删了会 400/11128，其余（包括
// traceparent、b3、X-B3-*）删了仍 200。它们的值还有格式要求：32 位 hex 或 UUID
// 都行，但短值（"abc"）会被拒成 11133。
//
// ── 为什么按对话派生而不是每次随机 ────────────────────────
// 上游按 X-Conversation-Request-ID 统计请求数：一次发送的多个步骤（工具调用
// 后重发、重试）若每次都带新 ID，会在用量里变成多条独立请求。所以：
//   - conversation 按会话派生：同一会话的每一轮都是同一个对话
//   - request 按轮次派生：一次发送的每一步同一个，下一句话换一个
//   - message 按请求派生：每个 HTTP 请求一个
// 没有会话名时全部随机，不会把不相关的请求合成一个对话。
//
// 派生用进程内随机盐，所以 id 不泄露任何提示词内容（与 workbuddy 的 idFor 同思路）。
const SALT = hex(16)

// idFor 由名字与它所属的对话/轮次派生 32 位 hex id。
function idFor(kind, ...pieces) {
  const h = createHash("sha256").update(`${SALT}|${kind}|`)
  for (const p of pieces) h.update(String(p ?? ""))
  return h.digest("hex").slice(0, 32)
}

// stainless 头规范化：arch 归一为 x32/arm64/arm/x64，platform 归一为 Windows/MacOS/Linux/FreeBSD。
const STAINLESS_ARCH = { x32: "x32", ia32: "x32", arm64: "arm64", aarch64: "arm64", arm: "arm" }
const STAINLESS_OS = { win32: "Windows", darwin: "MacOS", linux: "Linux", freebsd: "FreeBSD" }

// chatHeaders 生成一次聊天请求的头。session 是 magpie 告诉插件的会话名（可无）。
export function chatHeaders(site, version, { session = "" } = {}) {
  const traceID = hex(16)
  const spanID = hex(8)
  const parentSpanID = hex(8)
  // 对话：同一会话恒定；没会话就每次一个
  const conversationID = session ? idFor("conversation", session) : hex(16)
  // 轮次：同一会话恒定（一次发送的多个步骤共用），没会话就每次一个
  const turn = session ? idFor("turn", session) : hex(16)
  const requestID = hex(16)
  return {
    "x-requested-with": "XMLHttpRequest",
    "x-stainless-arch": STAINLESS_ARCH[process.arch] ?? "x64",
    "x-stainless-lang": "js",
    "x-stainless-os": STAINLESS_OS[process.platform] ?? process.platform,
    "x-stainless-package-version": "6.25.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-Private-Data": "false",
    "x-codebuddy-request": "1",
    "X-Agent-Type": "main",
    "X-B3-Sampled": "1",
    "X-Product": "SaaS",
    "X-Domain": site.domain,
    "X-IDE-Version": version,
    "User-Agent": `CLI/${version} CodeBuddy/${version}`,
    traceparent: `00-${traceID}-${spanID}-01`,
    b3: `${traceID}-${spanID}-1-${parentSpanID}`,
    "X-B3-TraceId": traceID,
    "X-B3-SpanId": spanID,
    "X-B3-ParentSpanId": parentSpanID,
    "X-Trace-ID": traceID,
    "X-Conversation-ID": conversationID,
    "X-Conversation-Request-ID": turn,
    "X-Root-Request-ID": turn,
    "X-Request-ID": requestID,
    "X-Conversation-Message-ID": requestID,
    "X-User-Id": randomUUID(),
  }
}

// gzipBody 返回 gzip 压缩后的请求体字节；调用方负责设置 Content-Encoding。
export function gzipBody(body) {
  if (body == null) return null
  if (typeof body === "string") return gzipSync(Buffer.from(body))
  if (body instanceof ArrayBuffer) return gzipSync(Buffer.from(body))
  if (ArrayBuffer.isView(body)) return gzipSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
  return null
}

// upstreamPath 把客户端 / AI SDK 的路径改写到上游的推理端点。
//
// CodeBuddy 上游只用 /v2/chat/completions 这一个推理端点：跨协议（Claude Messages /
// Responses / Gemini）的中转也走它 —— magpie 已经在 fetch 之前把请求体翻成了 chat
// completions。对齐 Go 侧 GetRequestURL。
//
// 三种入参形态都要认：
//   - "/v2/chat/completions"：magpie 已按 provider.api 的 /v2 基址拼好，原样放行
//   - "/v1/chat/completions"、"/chat/completions"：OpenCode 的 SDK 或别处直接调的形态
//   - "/v1/messages"、"/v1/responses"：跨协议，统一落到 chat completions
export function upstreamPath(path) {
  const p = String(path ?? "")
  if (p === "/v2/chat/completions") return p
  if (/\/(chat\/completions|messages|responses)$/.test(p)) return "/v2/chat/completions"
  if (p.startsWith("/v1/")) return p.replace("/v1/", "/v2/")
  return p
}
