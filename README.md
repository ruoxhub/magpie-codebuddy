# magpie-codebuddy

把 **CodeBuddy（腾讯云代码助手）** 接入 Magpie / OpenCode 的 provider 插件。两个 provider 各对应一个站点：

| provider | 站点 | 聊天域 | 账号域 | 余额域 |
|---|---|---|---|---|
| `codebuddy` | 国区 | `copilot.tencent.com` | `www.codebuddy.cn` | `www.codebuddy.cn` |
| `codebuddy-intl` | 国际版 | `www.codebuddy.ai` | `www.codebuddy.ai` | `www.workbuddy.ai` |

站点由 provider id 决定，不由 `base_url` 或凭证里的 `domain` 猜：猜错就是请求打到另一个区域、上游回 401，而错误来自上游几乎无法定位。

## 功能

- **四种登录**
  1. 浏览器登录 —— 官方 IDE 的设备授权流程（`/v2/plugin/auth/state` → 轮询 `/v2/plugin/auth/token` → `/v2/plugin/login/account`），完成后自动继续。
  2. IDE 的登录 —— 直接复用本机 CodeBuddy IDE 已登录的账号，只读它的登录文件，不复制令牌。每次请求重读，IDE 里重新登录后这里自动跟上。
  3. 粘贴 JSON 导入 —— 把 IDE 登录文件（或浏览器登录导出的 JSON）贴进去就能存成一个账号，用于在另一台机器上恢复登录、批量导入、或 IDE 已经卸了但手里还留着登录文件的情况（见下）。
  4. API key —— 在 `profile/keys` 生成的 key，按官方 CLI 的方式发（`Authorization: Bearer` + `X-API-Key`，uid 是 `anonymous_` + key 后 8 位）。
- **自动续期** —— 访问令牌到期前 5 分钟由 Magpie 续期；一次续期在并发请求间共享，不会把同一个 refresh token 花两次。
- **余额卡** —— 按 `CreditGroups` 聚合出 `Credits` 窗口（已用 / 总额），没有总额的包另算一个 `Prepaid credits` 余额窗口。
- **每日签到**（仅国区）—— 先读签到活动状态，活动没开就不去签，避免把「活动未开启」误报成「已签到」。
- **账号自己的模型清单** —— 读 `/v3/config`；读不到时回落到内置清单，不会把模型列表整个搞没。
- **推理档位** —— 从 `/v3/config` 的 `supportedEfforts` / `defaultEffort` / `canDisableThinking` 读出每个模型的档位，交给 magpie 与客户端选。实测 26 个 cli 模型里 25 个支持推理。
- **免费模型** —— 从 `credits` 读出每个模型花多少 credits，`x0.00` 标为免费（路由会优先用），读不出来的是未知而不是免费。实测国际版只有 `hy3` 与 `deepseek-v4.1-flash` 免费。
- **按对话派生请求 id** —— 上游按 `X-Conversation-Request-ID` 统计请求数：一次发送的多个步骤（工具调用后重发、重试）若每次带新 id，会在用量里变成多条独立请求。所以同一会话的 conversation/turn 稳定，只有 `X-Request-ID` 每请求一新。没有会话就全部随机。
- **请求归一化** —— 与 new-api 的 CodeBuddy 渠道同口径：
  - `developer` 角色改名为 `system`（实测原样发会被 11128 拒）
  - `tool_choice` 对象形态 → 字符串（函数型取裸函数名）
  - `image_url` 字符串 → `{url}`（实测字符串形态会被 11101 拒）
  - `max_completion_tokens` → `max_tokens`
  - 首条非 `system` 时注入兜底 system
  - 会被上游拒的 Claude Code 开场只加一行身份前缀，原文保留（见下）
  - 其余会被拒的原话按 `FLAGGED` 逐消息改写（见 [REFUSED.md](./REFUSED.md)）
  - 11128 仍拒时把 system 提示词搬进 user 消息再发一次（见下）
  - `reasoning_effort` 的 `none` / `off` 按模型能力处理（见下）
  - 恒 `stream: true` 且带 `usage`，并补 `cache_retention: "long"`（见下）

## 安装

```sh
magpie plugin add magpie-codebuddy
```

## 使用

登录后在任意 agent 里用 `codebuddy/<模型>` 或 `codebuddy-intl/<模型>`，例如 `codebuddy-intl/glm-5.3`。

模型清单随账号而定，从上游 `/v3/config` 读。国际版常见的有 `glm-5.3`、`deepseek-v4.1-flash`、`gpt-5.5`、`kimi-k3`、`gemini-3.8-flash`、`grok-4.7` 等；国区是 `deepseek-v4-pro`、`glm-5.3`、`kimi-k3-1`、`hy3` 等。

## 粘贴 JSON 导入

magpie 里选「粘贴 JSON 导入」，把下面任何一种贴进去：

| 形态 | 来源 |
|---|---|
| `{ account: { uid, nickname }, auth: { accessToken, refreshToken, expiresAt, domain } }` | CodeBuddy IDE 的登录文件原样，直接拷贝粘贴 |
| `{ access, refresh, expires, uid, domain }` | 浏览器登录存进 magpie 的那份 |
| `{ uid, nickname, access_token, refresh_token, token_type, expires_at, domain }` | workbuddy / sub2api 这类工具导出的 snake_case 格式 |
| 数组，或 `{ accounts: [...] }` | 一次贴多个（**目前只导入第 1 个**，其余会提示再贴一次） |
| 每行一个令牌的纯文本 | 从别处凑出来的令牌列表 |

**字段名 camelCase 与 snake_case 都收**（`accessToken` / `access_token`、`expiresAt` / `expires_at`、`tokenType` / `token_type` 等）——导出源头各不相同，让用户去改成插件喜欢的那种只会让人贴错。

**只有 `refresh_token`、没有 `access_token` 也能导入**：存入前先用 refresh 换出新 access。实测（2026-11-18，国际版）access 传空字符串照样能换成功。

**但两个令牌都是空串的记录会被拒绝**：工具导出里常见这种被清空的空壳记录，它不是登录。

`expiresAt` 缺失时依次尝试：`expires_in` 相对秒数 → JWT 的 `exp` 声明；秒级绝对时间戳会换算成毫秒。

两条拒绝规则：

- **跨区拒绝** —— 登录里的 `domain` 与本站点不一致就拒（国区 `www.codebuddy.cn` vs 国际版 `www.codebuddy.ai`）。两边是同一套令牌但请求要打到各自的域，混用只会得到上游 401，且错误来自上游、极难定位。
- **令牌不可用就不存** —— 存入前用余额接口验一次（导进来的账号没有浏览器登录的 `state`，`/login/account` 要它，所以走 `/billing/meter/get-user-resource-summary`）。401 就明说「不认这个令牌」，而不是存进去后每次请求都失败。非 401 的读取失败（比如接口临时故障）不拦导入。

加密过的令牌（WorkBuddy 桌面端 5.6 起把令牌存成 `{$wbEncrypted: 1, envelope}`）会被直接拒绝并提示改用浏览器登录 —— 读不出明文，存进去没用。

## 为什么每个请求都带 `cache_retention: "long"`

实测 2026-11-18（国际版 `glm-5.3`，同一对话连发两轮，各重复 3 轮）：

| 配置 | 第 1 次命中 | 第 2 次命中 |
|---|---|---|
| 不带 `cache_retention` | 0, 0, 0 | 1984, 0, 1984 |
| `cache_retention: "long"` | **1792, 1792, 1984** | **1792, 1792, 1984** |

差别在**第一个请求**：带它时连对话的首个请求就能命中已有缓存，不带时首请求永远 0（全价）。CodeBuddy CLI 自己发这个字段。

本插件端到端复测（同一个 magpie session 两轮）：`1792 → 1792`。

调用方自己传了 `cache_retention` 就不覆盖。

**`verbosity` 与 `extra_vars` 没有补**：实测 `verbosity` 取 low/medium/high 时输出长度差异（545/454/447 字）落在噪声内，没有可辨识效果；两者都是客户端自报的元数据，且实测缺失、错填值都返回 200。

## 哪条 system prompt 会被改写，以及怎么改

实测 2026-11-14（国际版 `glm-5.3`），逐个发真实提示词看哪些被拒（11128）：

| system prompt | 结果 |
|---|---|
| `You are Claude Code, Anthropic's official CLI for Claude.` | **400 / 11128** |
| 同上，后面继续接内容 | **400 / 11128** |
| 同上，全小写 / 末尾无句号 | **400 / 11128** |
| `You are Claude Code.` | 200 |
| `You are Claude Code, Anthropic's official CLI.` | 200 |
| 分两行写上面那一句 | 200 |
| `You are Cursor, an AI code editor.` | 200 |
| `You are Windsurf / Cline / OpenCode / Codex …` | 200 |
| `cc_entrypoint=cli` | 200 |
| 3000 字的普通 system prompt | 200 |

### 改法是加身份前缀，不是整条换掉

实测 2026-11-18 进一步确认：校验只看**字符串开头**。

| 写法 | 结果 |
|---|---|
| `You are Claude Code, ...` 开头 | 400 / 11128 |
| `You are CodeBuddy Code.` + 换行 + 那句 | **200** |
| `You are CodeBuddy Code.` + 换行 + 那句 + 完整正文 | **200** |
| `.` + 那句 | **200**（任何非空前缀都行） |

所以插件在命中的提示词前面加一行 `You are CodeBuddy Code.`（上游自己的自称，取自真实 CLI 抓包），**原文一字不改**。

不整条换掉，是因为换掉会丢掉用户提示词里真正有用的约束。对比同一份 Claude Code 提示词（其中写着“输出压到 10 词内、不要解释”）：

| 处理 | 实际回复 |
|---|---|
| 整条换成中性提示词 | `Hello! 👋 15 × 15 = **225** Is there anything else I can help you with?`（73 字，客套话回来了） |
| 加身份前缀（现在） | `Hello! 15 × 15 = 225`（19 字，原约束生效） |

端到端复测：同一份提示词直发上游 `400 / 11128`，经插件 `200` 且回复守规矩。

**为什么比 new-api 的渠道窄**：Go 侧 `agentPromptPattern` 把 Cursor / Windsurf / Cline / “you are an ai agent” / `cc_entrypoint` 都算上，还带“超过 2000 字就换”。上表显示这些全部通过，按宽规则会误改大量正常提示词。

## 推理档位为什么这么处理

实测 2026-11-14，同一句提示、同一个账号（国际版，模型 `glm-5.3` / `hy3` / `glm-5.2`）：

| 模型 | `canDisableThinking` | 发 `none` | 删字段 |
|---|---|---|---|
| `glm-5.3` | true | 0 字推理 | 11 字推理 |
| `hy3` | false | 0 字推理 | 98 字推理 |
| `glm-5.2` | true | 0 字 | 0 字 |

结论：

- **删字段不能可靠地关掉推理**。删了之后走模型默认，而默认往往是 `high`（`glm-5.2` 的 `defaultEffort` 就是 `high`，删字段后却恰好不推理，属于巧合）。
- 所以用户要关掉时，**能关的模型就发 `none`**，只有 `canDisableThinking: false` 的模型才删字段——实测 `kimi-k3.1-pro` 发 `none` 会被上游当模型不可用拒成 `11158`。
- `off` 不是上游认识的档位（实测在 `glm-5.2` 上被忽略，仍思考 138 字），所以改写成 `none`。

## 参考 WorkBuddy 插件后刻意没做的事
WorkBuddy 与 CodeBuddy 是同一个团队的相近产品，WorkBuddy 插件里有大量上游拒答的绕过逻辑。逐条实测了这些机制对 CodeBuddy 是否成立：

| WorkBuddy 里的机制 | CodeBuddy 实测 | 结论 |
|---|---|---|
| `/v1/messages`（Anthropic 路由） | `/v1/messages` → **404** | 不实现 |
| `fitTools` / schema 改写（`type` 数组、`$ref`、`anyOf` 等） | 全部 **200** | 不改写 |
| `BAD_SIGNATURE` / 11159 思考签名重试 | 不支持 `thinking` 块，直接 11101 | 不实现 |
| 工具描述 ≥64KB 时清空 | 70KB 描述 **200** | 不清空 |
| `AFTER_TOOLS_REFUSED` / 11153（工具结果后跟 user 消息） | **200** | 不实现 |
| `REFUSED` / `unflagged` 词句改写链 | 已移植，见 [REFUSED.md](./REFUSED.md) | 只搬 `FLAGGED` 那张表 || `enterpriseOf` 企业账号推导 | 签到/余额已带 `X-Enterprise-Id` | 不做额外推导 |

写在这里是为了防止后来的人“看 WorkBuddy 有就补上”——那些绕过逻辑每一条都会改写用户的请求，没有对应的上游行为时它们只是纯粹的副作用。

唯一搬过来的是 `FLAGGED` 词句改写链：上游对“来自另一个 agent 的整行原话”的判据是同一个 11128，与 CodeBuddy / WorkBuddy 哪个产品无关，所以整张表带了过来（`lib/outbound.mjs` 的 `unflag`）。表里每一行都对应一条实测，加行之前先看 [REFUSED.md](./REFUSED.md) 里的两条规则。

## 11128 的兜底重发

`FLAGGED` 只认得已知的整行原话，未收录的 agent 开场行还是会 400/11128。所以 11128
时把 system 提示词搬进首条 user 消息（包在 `<instructions>` 里），system 槽留
`You are a helpful assistant.`，重发一次。

能过的原因：上游只读 system 与 assistant 两种消息，user 消息不读。实测 2026-11-18
国际版（`deepseek-v4.1-flash`，`stream: true`，同一账号）：

| 形态 | 结果 |
|---|---|
| `You are Claude Code, Anthropic's official CLI for Claude.` 放 system | **400 / 11128** |
| 同一句包进 user 消息的 `<instructions>` | **200** |
| 同一句直放 user（无标签） | **200** |
| 同一句放 assistant 消息 | **400 / 11128** |

（不带 `stream: true` 会被拒成 11101 非流式，看起来像另一个问题。）

被拒过的 system 提示词按文本记在进程内（上限 256 条），同一 agent 的下一轮直接以搬过的
形态发，不再先被拒一次。

**当前可达性**：已知的被拒行都已经被身份前缀或 `FLAGGED` 接住了，所以这一步现在几乎
不触发。它是为「上游明天认了一个新行」准备的——前缀规则只认 Claude Code 那一种，
`FLAGGED` 只认实测过的整行。代价是模型不再以「系统指令」的身份读它，所以它是最后一步。

## 令牌被提前拒、与大请求的断连

两条都是实测出来的：

- **令牌可以远早于 `expires` 就被拒**（浏览器登录的 access 活约 340 天）。所以 401 时
  换一次 refresh 重发一次，而不是只按到期时间续期。桌面登录不花它的 refresh token
  （会把 IDE 自己登出，且它的文件每次都重读）；key 没有令牌可换。
- **坏令牌 + 请求体过大时上游前端不回答**：要么断连（`TypeError: fetch failed` /
  `ECONNRESET`），要么回一个 **550**（EdgeOne 自己的重置码）。客户端看到的两种都是
  「网络错误」，看不出是被拒登录。门槛算在 **gzip 后的实际字节**上，不是明文长度。

  实测 2026-11-18 国际版（坏令牌，gzip 发送，每格跑 4 次）：

  | 明文体积 | 结果 |
  |---|---|
  | 1 MiB | 401 ×4 |
  | 2 MiB | ECONNRESET ×2、550 ×2 |
  | 2.2 MiB | ECONNRESET ×4 |
  | 3 MiB | 550 ×2、ECONNRESET ×2 |

  同样体量换好令牌一律是 200 或 400/11115（prompt 太长），不断连也不 550。所以两种
  表现都按「被拒令牌」处理：拿计费接口探一次，它回 401 就报成登录失效。

## 已知限制

- **上游只支持流式**：非流式请求由 Magpie 转成流式再聚合，客户端拿到的仍是一条完整响应。
- **桌面端加密的登录读不出**：WorkBuddy 桌面端从 5.6 起把令牌加密存储（`{$wbEncrypted: 1, envelope}`），只有应用自己能打开。遇到这种文件时插件会明说，请改用浏览器登录。CodeBuddy IDE 自身的登录文件（`Tencent-Cloud.coding-copilot.info`）是明文的，可以读。
- **国区与国际版不通用登录文件**：两边的账号是同一套令牌，但请求要打到各自区域的域，所以插件会拒绝跨站点的登录文件。
- **国际版没有签到**：签到端点在鉴权后的行为未实测，所以不给入口，而不是给一个可能报错的按钮。
- **API key 查不到余额**：官方 CLI 用 key 时也不读余额，卡片会直说而不是显示 0。
- **渠道校验（11128 / request illegal）**：实测 2026-11-14 逐个删除请求头，真正必需的只有 `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID` 三个（删了任一 → 400/11128）；`traceparent`、`b3`、`X-B3-*`、`gzip` 删了都仍 200。三个头的值还有格式要求：32 位 hex 或 UUID 都行，短值（`abc`）会被拒成 11133。插件已按官方形态发齐。
- **上游目前不校验 TLS 指纹**：同一份令牌，Bun（17 个 cipher）与 Node undici（52 个 cipher）的 JA3 完全不同，两者都稳定返回 200。所以本插件不做 TLS 指纹模拟——做了反而会在上游某天开始校验时成为唯一说得清的线索之外的多余依赖。

## 测试

```sh
node --test test/*.test.mjs
```

覆盖站点选择、请求归一化的每一步、OAuth 轮询状态、余额解析、签到分类、桌面登录文件解析、以及插件的请求构造（含 gzip、完整请求头、401 / 11128 的处理）。

## 许可证

MIT，见 `LICENSE`。
