// CLI 版本：npm 上 @tencent-ai/codebuddy-code 的 latest，用于 X-IDE-Version 与 User-Agent。
//
// 对齐 new-api 的 internal/relay/channel/codebuddy/cli_version.go：进程启动用兜底
// 版本，后台每 6 小时刷新一次；拉取失败保留旧值，不在请求路径上做远程调用。
//
// 为什么必须跟上游版本：请求头里的版本号是渠道校验的一部分，落后太多会被判为
// 非官方客户端（实测缺 gzip / trace 头直接 11128）。

export const CLI_VERSION_URL = "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest"

// FALLBACK_VERSION 是 npm 元数据尚不可用时使用的兜底版本。
export const FALLBACK_VERSION = "2.141.0"

const REFRESH_MS = 6 * 60 * 60 * 1000
const FETCH_MS = 10 * 1000

let current = FALLBACK_VERSION
let started = false

// cliVersion 返回当前生效的版本号。
export function cliVersion() {
  return current
}

// refreshCLIVersion 拉取一次 npm latest 版本。失败保留旧值。
export async function refreshCLIVersion({ signal } = {}) {
  try {
    const res = await fetch(CLI_VERSION_URL, {
      headers: { Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(FETCH_MS),
    })
    if (!res.ok) return current
    const meta = await res.json()
    const version = typeof meta?.version === "string" ? meta.version.trim() : ""
    if (version) current = version
  } catch {
    // 拉取失败保留旧值，由下一周期重试
  }
  return current
}

// startCLIVersionRefresh 启动后台版本刷新。重复调用只生效一次。
//
// 不阻塞插件加载：首次拉取与定时刷新都在后台跑，请求先用兜底版本发。
export function startCLIVersionRefresh() {
  if (started) return
  started = true
  void refreshCLIVersion()
  const timer = setInterval(() => void refreshCLIVersion(), REFRESH_MS)
  // 不因这个定时器把进程留住
  timer.unref?.()
}
