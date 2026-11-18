// 账号域：余额卡与每日签到。
//
// 端点对齐 new-api 的 internal/relay/channel/codebuddy/balance.go 与 checkin.go。
// 两处都在账号域 / 余额域上，与聊天域（copilot.tencent.com）不同 —— 国际版的余额域
// 更是 www.workbuddy.ai，与它的聊天域 www.codebuddy.ai 分开。

const SUMMARY_PATH = "/billing/meter/get-user-resource-summary"
const RESOURCE_PATH = "/v2/billing/meter/get-user-resource"
const CHECKIN_STATUS_PATH = "/billing/meter/checkin-activity-status"
const CHECKIN_PATH = "/v2/billing/meter/daily-checkin"

// accountHeaders 是余额 / 签到请求的固定头。
// 这些接口用 axios 风格的 UA（与 Go 侧 "axios/1.13.6" 一致），不是 CLI 的。
function accountHeaders(access, uid, domain) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: "Bearer " + access,
    "X-User-Id": uid,
    "X-Domain": domain,
    "User-Agent": "axios/1.13.6",
  }
}

// postMeter 请求账号域的计费接口，返回 { status, code, msg, data }。
async function postMeter(site, path, access, uid, body, { signal, domain = site.balanceDomain } = {}) {
  const res = await fetch(site.balance + path, {
    method: "POST",
    headers: accountHeaders(access, uid, domain),
    body: JSON.stringify(body ?? {}),
    signal: signal ?? AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    // 上游偶尔回裸 HTML（401），保持 env 为空
  }
  const code = Number.parseInt(env.code, 10) || 0
  return { status: res.status, code, msg: env.msg ?? "", data: env.data ?? {}, text }
}

// capacity 读计费接口的容量字段：可能是字符串 "438.88" 或数字；空是 0。
// 读不出来时返回 0 而不是抛错：一个坏字段不该让整张卡消失。
export function capacity(value) {
  if (value === null || value === undefined || value === "") return 0
  const n = typeof value === "number" ? value : Number(String(value))
  return Number.isFinite(n) ? n : 0
}

// compact 把数字压成 "1.2k" 之类的短写法，用于卡片上的显示文本。
function compact(n) {
  if (!Number.isFinite(n)) return "0"
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

// usageOf 把 get-user-resource-summary 的响应读成 usage 卡的窗口。
//
// 返回 { plan, windows }。Credits 窗口按 CreditGroups 聚合（有 groups 时用 groups，
// 否则按 Packages 的 PackageCode 是否属于套餐区分 plan / extra）。剩下的、没有总额
// 的包（CycleRemainCapacity）是一个独立的余额窗口。
export function usageOf(summary) {
  const out = { plan: summary?.IsPaidUser === true ? "Pro" : "Free plan", windows: [] }
  const groups = (Array.isArray(summary?.CreditGroups) ? summary.CreditGroups : []).filter(
    (g) => g && g.CycleTotalCapacity !== undefined && g.CycleTotalCapacity !== "",
  )
  const plan = { total: 0, used: 0 }
  const extra = { total: 0, used: 0 }
  const add = (bucket, g) => {
    bucket.total += capacity(g.CycleTotalCapacity)
    bucket.used += capacity(g.CycleUsedCapacity)
  }
  if (groups.length) {
    for (const g of groups) add(g?.Kind === "plan_base" ? plan : extra, g)
  } else {
    for (const p of summary?.Packages ?? []) {
      if (p?.CycleTotalCapacity === undefined || p.CycleTotalCapacity === "") continue
      // 没有 groups 时无法区分套餐与赠送，全部算进 plan：宁可少一个窗口，
      // 也不要把赠送额度伪装成套餐额度
      add(plan, p)
    }
  }
  const total = plan.total + extra.total
  if (total > 0) {
    const used = plan.used + extra.used
    out.windows.push({
      name: "Credits",
      used: (100 * used) / total,
      display: `${compact(used)} / ${compact(total)}`,
      amount: used,
      limit: total,
      unit: "credits",
    })
  }
  // 没有总额的包是一个余额窗口（余额窗口没有 used / limit）
  let balance = 0
  let bags = 0
  for (const p of summary?.Packages ?? []) {
    if (p?.CycleTotalCapacity !== undefined && p.CycleTotalCapacity !== "") continue
    if (p?.CycleRemainCapacity === undefined || p.CycleRemainCapacity === "") continue
    balance += capacity(p.CycleRemainCapacity)
    bags++
  }
  if (bags > 0 && (total === 0 || balance > 0)) {
    out.windows.push({
      name: "Prepaid credits",
      balance,
      display: `${compact(balance)} credits`,
      unit: "credits",
    })
  }
  return out
}

// fetchUsage 读账号的余额卡。失败抛错，由 auth.usage 转成卡片上的错误。
export async function fetchUsage(site, access, uid, { signal, domain = site.balanceDomain } = {}) {
  const res = await postMeter(site, SUMMARY_PATH, access, uid, {}, { signal, domain })
  if (res.status === 401) throw Object.assign(new Error(`${site.name} 拒绝了这个登录`), { status: 401 })
  if (res.status !== 200 || res.code !== 0) {
    throw new Error(`${site.name} 的余额读不出来：HTTP ${res.status}${res.code ? `, code ${res.code}` : ""}${res.msg ? `, ${res.msg}` : ""}`)
  }
  return usageOf(res.data)
}

// GetUserResourcePath 是查询账号可用余额（credits）的接口路径。
export const GetUserResourcePath = RESOURCE_PATH

// fetchUserResource 查询账号剩余可用额度（TotalDosage，单位 credits）。
//
// 与 new-api 的 GetUserResource 同口径：按「未过期套餐」查，TotalDosage 是所有
// 未过期套餐的剩余之和。返回原始数值，不在这里扣缓冲 —— 缓冲是计费侧的业务规则，
// 余额卡只报真实数字。
export async function fetchUserResource(site, access, uid, { signal, domain = site.balanceDomain } = {}) {
  const now = new Date()
  const end = new Date(now)
  end.setFullYear(end.getFullYear() + 100)
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const res = await postMeter(
    site,
    RESOURCE_PATH,
    access,
    uid,
    {
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(end),
      PageNumber: 1,
      PageSize: 100,
      // CodeBuddy（腾讯云代码助手）的产品编码
      ProductCode: "p_tcaca",
      Status: [0, 3],
    },
    { signal, domain },
  )
  if (res.status !== 200 || res.code !== 0) {
    throw new Error(`${site.name} 的余额读不出来：HTTP ${res.status}${res.code ? `, code ${res.code}` : ""}`)
  }
  const dosage = res.data?.Response?.Data?.TotalDosage
  if (dosage === undefined || dosage === null) throw new Error(`${site.name} 的余额响应缺少 TotalDosage`)
  return capacity(dosage)
}

// ---- 签到 ---------------------------------------------------------------------

// checkinOf 跑一次签到，返回 magpie 的 checkin 钩子要的
// { outcome, credit?, streak?, message? }。
//
// outcome 取值：claimed（刚签到）、done（今天已在）、ineligible、inactive、
// failed。上游 10001 的语义不唯一（已签到 / 活动未开启都用它），所以先读
// checkin-activity-status 判断活动是否开启、今天是否已在，再决定要不要真签到。
export async function checkinOf(site, access, uid, { signal } = {}) {
  const status = await postMeter(site, CHECKIN_STATUS_PATH, access, uid, {}, { signal })
  if (status.status === 401) {
    return { outcome: "failed", message: `${site.name} 拒绝了这个登录` }
  }
  if (status.status === 200 && status.code === 0) {
    const s = status.data
    if (s.active !== true) return { outcome: "inactive" }
    if (s.today_checked_in === true) {
      const credit = Number(s.today_credit ?? s.daily_credit)
      return { outcome: "done", ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}) }
    }
  }
  const claim = await postMeter(site, CHECKIN_PATH, access, uid, {}, { signal })
  if (claim.status === 200 && claim.code === 0) {
    const credit = Number(claim.data?.credit)
    const streak = Number(claim.data?.streak_days)
    return {
      outcome: "claimed",
      ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}),
      ...(Number.isFinite(streak) && streak > 0 ? { streak } : {}),
    }
  }
  // 10001 在签到接口上是「活动未开启或已过期」，在状态接口上是「今天已签到」
  if (claim.code === 10001) {
    if (/已签到/.test(claim.msg)) return { outcome: "done" }
    return { outcome: "inactive", ...(claim.msg ? { message: claim.msg } : {}) }
  }
  return { outcome: "failed", message: claim.msg || `HTTP ${claim.status}${claim.code ? `, code ${claim.code}` : ""}` }
}
