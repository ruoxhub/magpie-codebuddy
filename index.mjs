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
//
// 这个文件只导出两个插件函数，别的什么都不导出：OpenCode 1.x 会拒绝一个导出里除了
// 插件还有别的东西的包（所以 _internal 之类的东西不在入口）。OpenCode 2.x 由
// opencode2.mjs 适配。插件工厂在 lib/plugin.mjs。

import { SITES } from "./lib/sites.mjs"
import { makePlugin } from "./lib/plugin.mjs"

export const CodeBuddyPlugin = makePlugin(SITES.codebuddy)
export const CodeBuddyIntlPlugin = makePlugin(SITES["codebuddy-intl"])
