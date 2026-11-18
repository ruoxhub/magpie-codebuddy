// 模型清单：/v3/config 动态拉取 + 静态兜底。
//
// 拉取规则对齐 new-api 的 internal/relay/channel/codebuddy/fetch_models.go：
// 取 data.models 里 id 非 default 且 supportsToolCall 的条目。实测 2026-11-14
// 与国际版 /v3/config 的 cli agent 列表逐个相等，所以不额外读 agents。

const CONFIG_PATH = "/v3/config"

// configHeaders 是 /v3/config 的请求头。
// User-Agent 必须是 "CLI/<v> CodeBuddy/<v>"：纯 "CLI/<v>" 会被上游判为版本解析
// 失败（12403），与 Go 侧 CLIUserAgent 一致。
export function configHeaders(site, accessToken, uid, version) {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: "Bearer " + accessToken,
    "X-User-Id": uid,
    "X-Domain": site.domain,
    "X-Product": "SaaS",
    "User-Agent": `CLI/${version} CodeBuddy/${version}`,
    "X-Request-ID": randomHex(16),
  }
}

const randomHex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("")

// fetchModels 从 /v3/config 拉取可用 chat 模型。
//
// 返回 [{ id, name, context, output, images }]，按上游顺序。失败抛错，由调用方
// 决定是回落静态清单还是把错误上抛。
export async function fetchModels(site, accessToken, uid, { version = "2.141.0", signal } = {}) {
  const res = await fetch(site.chat + CONFIG_PATH, {
    headers: configHeaders(site, accessToken, uid, version),
    signal: signal ?? AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let env
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error(`${site.name} 的模型清单读不出来（HTTP ${res.status}）`)
  }
  if (!res.ok) throw new Error(`${site.name} 的模型清单：HTTP ${res.status}`)
  const code = Number.parseInt(env.code, 10) || 0
  if (code !== 0) throw new Error(`${site.name} 的模型清单：${env.msg ?? ""} (${code})`)
  return modelsOfConfig(env.data ?? {})
}

// creditsOf 读一个模型花多少 credits，倍数形式（上游的 "x0.03"、"0" 或 0）。
//
// 与 workbuddy 的 creditsOf 同规则："x0.00" 是免费，读不出来就是未知（既不算免费
// 也不算付费）。实测 2026-11-14 国际版：hy3 与 deepseek-v4.1-flash 是 x0.00，其余付费。
export function creditsOf(value) {
  if (value === null || value === undefined || value === "") return undefined
  const n = Number(String(value).trim().toLowerCase().replace(/\s+credits?$/, "").replace(/^x/, ""))
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

// modelsOfConfig 按 Go 侧规则从 config 里挑模型。
//
// 剔除 default（不是真实模型）与没有 supportsToolCall 的图片 / 视频生成模型。
//
// 同时读出推理信息（实测 2026-11-14）：config 的 reasoning 给出
// supportedEfforts / defaultEffort / summary / canDisableThinking。这些不读出来，
// magpie 就没有档位可选，客户端也看不到思考内容（实测 deepseek-v4.1-flash 在
// reasoning_effort=high 下真的返回了 reasoning_content）。
//
// canDisableThinking 缺省不等于可关闭：实测只给 none 时，仅 canDisableThinking
// 为 true 或 onlyReasoning 为 false 的模型真的不思考了；其余模型给了也仍会思考。
// 所以“none”这一档只给真能关掉的模型，不靠猜。
export function modelsOfConfig(config) {
  const out = []
  for (const m of config?.models ?? []) {
    if (!m || typeof m.id !== "string" || m.id === "" || m.id === "default") continue
    if (m.supportsToolCall !== true) continue
    const rs = m.reasoning ?? {}
    const efforts = Array.isArray(rs.supportedEfforts) ? rs.supportedEfforts.filter((e) => typeof e === "string" && e !== "") : []
    const canDisable = m.onlyReasoning === false || rs.canDisableThinking === true
    const rate = creditsOf(m.credits)
    out.push({
      id: m.id,
      name: m.name || m.id,
      context: Number.isFinite(m.maxInputTokens) ? m.maxInputTokens : 0,
      output: Number.isFinite(m.maxOutputTokens) ? m.maxOutputTokens : 0,
      images: m.supportsImages === true,
      // 可关掉的模型多一个 none 档；不能关掉的不给，给了也是白给
      efforts: canDisable && efforts.length ? ["none", ...efforts] : efforts,
      defaultEffort: typeof rs.defaultEffort === "string" ? rs.defaultEffort : "",
      reasoning: m.supportsReasoning === true || !!m.reasoning,
      // 请求侧靠它能判断“关掉”该发 none 还是删字段（见 outbound 的 normalizeReasoningEffort）
      canDisable,
      // 花多少 credits；0 是免费（路由会优先用它），undefined 是未知
      rate,
      free: rate === 0,
    })
  }
  return out
}

// staticModels 是 /v3/config 拉不到时的兜底清单，与站点常量同源。
//
// 兜底清单没有推理信息：宁可不说，也不编造档位。
export function staticModels(site) {
  return site.models.map(([id, name]) => ({ id, name, context: 0, output: 0, images: false, efforts: [], defaultEffort: "", reasoning: false }))
}

// modelsFrom 把模型列表转成 config 钩子要的 models 映射。
//
// variants 是档位：OpenCode / magpie 靠它给出可选的努力程度，形态是
// { 档位名: 配置 } 而不是数组。一个声称思考却没有 variants 的模型，magpie 会去
// models.dev 借档位（borrowedEfforts），而那些档位未必是上游认的 —— 所以这里只报
// 上游真给了的。
export function modelsFrom(list) {
  const out = {}
  for (const m of list) {
    const efforts = Array.isArray(m.efforts) ? m.efforts : []
    out[m.id] = {
      name: m.name,
      limit: { context: m.context ?? 0, output: m.output ?? 0 },
      tool_call: true,
      reasoning: m.reasoning === true,
      ...(efforts.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
      attachment: m.images === true,
      modalities: {
        input: m.images === true ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      // magpie 自己的：免费模型路由会优先用；rate 只在真读到才写（未知不是 0）
      ...(m.free === true ? { free: true } : {}),
      ...(typeof m.rate === "number" ? { rate: m.rate } : {}),
    }
  }
  return out
}
