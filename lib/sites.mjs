// CodeBuddy 的两个站点，对齐 new-api 的 internal/relay/channel/codebuddy/site.go。
//
// 站点由 provider id 决定，不由 base_url 或凭证 domain 猜测：猜错的后果是请求打到
// 另一个区域，上游回 401，错误来自上游几乎无法定位。provider id 对了，站点就对了。
//
// 两个站点的域不同：
//   - 国区：聊天域 copilot.tencent.com（与账号域 www.codebuddy.cn 分离）
//   - 国际版：聊天域与账号域同为 www.codebuddy.ai，余额查询域是 www.workbuddy.ai
export const SITES = {
  codebuddy: {
    id: "codebuddy",
    name: "CodeBuddy",
    // 聊天域（推理请求）
    chat: "https://copilot.tencent.com",
    // 账号域（OAuth / 登录 / 刷新）
    account: "https://www.codebuddy.cn",
    // 余额与签到域
    balance: "https://www.codebuddy.cn",
    // X-Domain 头（聊天请求）
    domain: "www.codebuddy.cn",
    // 余额查询的 X-Domain 头
    balanceDomain: "www.codebuddy.cn",
    // auth/state?platform= 的取值
    platform: "ide",
    // 桌面端 IDE 的登录文件键（CodeBuddy IDE 自身，明文可读）
    desktopAuthID: "Tencent-Cloud.coding-copilot",
    // 站点是否提供签到：国际版签到端点未实测，界面不给入口（对齐 codeBuddyIntlKind）
    checkin: true,
    // 模型清单（/v3/config 拉不到时的兜底），对齐 constant.go 的 ModelList
    models: [
      ["deepseek-v4-pro", "DeepSeek V4 Pro"],
      ["deepseek-v4-flash", "DeepSeek V4 Flash"],
      ["deepseek-v3-2-volc", "DeepSeek V3.2"],
      ["minimax-m2.5", "MiniMax M2.5"],
      ["minimax-m3", "MiniMax M3"],
      ["minimax-m2.7", "MiniMax M2.7"],
      ["glm-5.3", "GLM-5.3"],
      ["glm-5.2", "GLM-5.2"],
      ["glm-5.1", "GLM-5.1"],
      ["glm-5.0", "GLM-5.0"],
      ["glm-5.0-turbo", "GLM-5.0 Turbo"],
      ["glm-5v-turbo", "GLM-5V Turbo"],
      ["glm-4.7", "GLM-4.7"],
      ["glm-4.6", "GLM-4.6"],
      ["glm-4.6v", "GLM-4.6V"],
      ["kimi-k3-1", "Kimi K3"],
      ["kimi-k2.7", "Kimi K2.7"],
      ["kimi-k2.6", "Kimi K2.6"],
      ["kimi-k2.5", "Kimi K2.5"],
      ["kimi-k2-thinking", "Kimi K2 Thinking"],
      ["hy3", "Hy3"],
      ["hunyuan-chat", "Hunyuan Chat"],
    ],
  },
  "codebuddy-intl": {
    id: "codebuddy-intl",
    name: "CodeBuddy Intl",
    chat: "https://www.codebuddy.ai",
    account: "https://www.codebuddy.ai",
    // 余额查询在国际版走 www.workbuddy.ai（与账号域不同），对齐 SiteIntl
    balance: "https://www.workbuddy.ai",
    domain: "www.codebuddy.ai",
    balanceDomain: "www.workbuddy.ai",
    platform: "ide",
    desktopAuthID: "Tencent-Cloud.coding-copilot",
    // 国际版不提供签到：端点鉴权后的行为未实测（对齐 codeBuddyIntlKind.SupportsCheckin）
    checkin: false,
    models: [
      ["default-model", "Default"],
      ["fast-model", "Fast"],
      ["balanced-model", "Balanced"],
      ["primary-model", "Primary"],
      ["hy4-preview", "Hy4 Preview"],
      ["hy3", "Hy3"],
      ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
      ["deepseek-v4.1-flash-sg", "DeepSeek V4.1 Flash SG"],
      ["gpt-6-astra", "GPT-6 Astra"],
      ["gpt-6.1-sol", "GPT-6.1 Sol"],
      ["gpt-6-sol", "GPT-6 Sol"],
      ["gpt-6-luna", "GPT-6 Luna"],
      ["gpt-5.6-sol", "GPT-5.6 Sol"],
      ["gpt-5.6-terra", "GPT-5.6 Terra"],
      ["gpt-5.6-luna", "GPT-5.6 Luna"],
      ["gpt-5.5", "GPT-5.5"],
      ["gpt-5.4", "GPT-5.4"],
      ["glm-5.3-flash", "GLM-5.3 Flash"],
      ["glm-5.3", "GLM-5.3"],
      ["glm-5.2", "GLM-5.2"],
      ["minimax-m3.1-flash", "MiniMax M3.1 Flash"],
      ["kimi-k3.1-pro", "Kimi K3.1 Pro"],
      ["kimi-k3.1-pro-highspeed", "Kimi K3.1 Pro Highspeed"],
      ["kimi-k3", "Kimi K3"],
      ["grok-4.7", "Grok 4.7"],
      ["gemini-3.8-flash", "Gemini 3.8 Flash"],
    ],
  },
}

// SITE_IDS 是两个 provider id，顺序固定（国区在前）。
export const SITE_IDS = ["codebuddy", "codebuddy-intl"]

// siteOf 按 provider id 取站点；未知 id 回落国区。
//
// 回落方向不可反转：国区是默认站点，国际版是显式 opt-in。反过来会把所有默认
// 国区账号翻成国际版，全网 401。
export function siteOf(id) {
  return SITES[id] ?? SITES.codebuddy
}

// matchesSiteHost 判断 baseURL 的主机是否就是该站点的账号域。
//
// 比主机而不是整串：尾斜杠、大小写、路径前缀、无 scheme 都是同一个站点的无害写法，
// 逐字符比较会把它们全判成不一致。主机不匹配（含跨站混用）返回 false。
export function matchesSiteHost(site, baseURL) {
  const raw = String(baseURL ?? "").trim()
  if (!raw) return false
  let parsed
  try {
    parsed = new URL(raw.includes("://") ? raw : `//${raw}`, "http://placeholder")
  } catch {
    return false
  }
  return parsed.hostname.toLowerCase() === site.domain.toLowerCase()
}
