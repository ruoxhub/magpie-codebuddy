import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { usageOf, capacity, fetchUsage, fetchUserResource, checkinOf } from "../lib/account.mjs"

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

const siteAt = (base) => ({ id: "t", name: "T", balance: base, balanceDomain: "www.example.com" })

test("capacity 读字符串、数字与空值", () => {
  assert.equal(capacity("438.88"), 438.88)
  assert.equal(capacity(438.88), 438.88)
  assert.equal(capacity(""), 0)
  assert.equal(capacity(null), 0)
  assert.equal(capacity(undefined), 0)
  // 坏字段返回 0，而不是让整张卡消失
  assert.equal(capacity("abc"), 0)
})

test("usageOf 按 CreditGroups 聚合成一个 Credits 窗口", () => {
  // 实测 2026-11-14 的响应形态
  const summary = {
    IsPaidUser: false,
    CreditGroups: [
      { Kind: "plan_base", CycleTotalCapacity: "100", CycleUsedCapacity: "0" },
      { Kind: "plan_bonus", CycleTotalCapacity: "0", CycleUsedCapacity: "0" },
      { Kind: "addon", CycleTotalCapacity: "0", CycleUsedCapacity: "0" },
      { Kind: "benefit", CycleTotalCapacity: "60", CycleUsedCapacity: "28.66999998" },
    ],
    Packages: [],
  }
  const got = usageOf(summary)
  assert.equal(got.plan, "Free plan")
  assert.equal(got.windows.length, 1)
  const w = got.windows[0]
  assert.equal(w.name, "Credits")
  assert.equal(w.limit, 160)
  assert.ok(Math.abs(w.amount - 28.67) < 0.001)
  assert.ok(Math.abs(w.used - (100 * 28.66999998) / 160) < 0.001)
  assert.equal(w.unit, "credits")
})

test("usageOf 付费账号标 Pro", () => {
  assert.equal(usageOf({ IsPaidUser: true, CreditGroups: [] }).plan, "Pro")
})

test("usageOf 没有 groups 时按 Packages 聚合", () => {
  const got = usageOf({
    Packages: [
      { PackageCode: "A", CycleTotalCapacity: "60", CycleUsedCapacity: "10" },
      { PackageCode: "B", CycleTotalCapacity: "40", CycleUsedCapacity: "0" },
    ],
  })
  assert.equal(got.windows.length, 1)
  assert.equal(got.windows[0].limit, 100)
  assert.equal(got.windows[0].amount, 10)
})

test("usageOf 把没有总额的包读成独立余额窗口", () => {
  const got = usageOf({
    Packages: [
      { PackageCode: "A", CycleTotalCapacity: "100", CycleUsedCapacity: "20" },
      { PackageCode: "B", CycleRemainCapacity: "31.33" },
    ],
  })
  assert.equal(got.windows.length, 2)
  const prepaid = got.windows.find((w) => w.name === "Prepaid credits")
  assert.ok(prepaid)
  assert.equal(prepaid.balance, 31.33)
  assert.equal(prepaid.unit, "credits")
  // 余额窗口没有 used / limit
  assert.equal("used" in prepaid, false)
  assert.equal("limit" in prepaid, false)
})

test("usageOf 空响应返回无窗口，不编造数字", () => {
  assert.deepEqual(usageOf({}).windows, [])
  assert.deepEqual(usageOf(undefined).windows, [])
})

test("fetchUsage 打 get-user-resource-summary，带 Bearer 与 X-Domain", async () => {
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.method, "POST")
    assert.equal(req.url, "/billing/meter/get-user-resource-summary")
    assert.equal(req.headers.authorization, "Bearer AT")
    assert.equal(req.headers["x-user-id"], "U1")
    assert.equal(req.headers["x-domain"], "www.example.com")
    res.end(JSON.stringify({ code: 0, data: { IsPaidUser: true, CreditGroups: [{ Kind: "plan_base", CycleTotalCapacity: "10", CycleUsedCapacity: "5" }] } }))
  })
  try {
    const got = await fetchUsage(siteAt(base), "AT", "U1")
    assert.equal(got.plan, "Pro")
    assert.equal(got.windows[0].limit, 10)
  } finally {
    server.close()
  }
})

test("fetchUsage 遇到 401 带上 status=401", async () => {
  const { server, base } = await startServer((req, body, res) => {
    res.statusCode = 401
    res.end("<html>401</html>")
  })
  try {
    await assert.rejects(() => fetchUsage(siteAt(base), "AT", "U1"), (e) => {
      assert.equal(e.status, 401)
      return true
    })
  } finally {
    server.close()
  }
})

test("fetchUsage 在业务码非 0 时说清 code 与 msg", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 10001, msg: "uid or enterpriseID is empty" })))
  try {
    await assert.rejects(() => fetchUsage(siteAt(base), "AT", "U1"), /10001.*uid or enterpriseID is empty/)
  } finally {
    server.close()
  }
})

test("fetchUserResource 带齐查询未过期套餐的参数", async () => {
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.url, "/v2/billing/meter/get-user-resource")
    const parsed = JSON.parse(body)
    assert.equal(parsed.ProductCode, "p_tcaca")
    assert.deepEqual(parsed.Status, [0, 3])
    assert.equal(parsed.PageSize, 100)
    assert.ok(parsed.PackageEndTimeRangeBegin)
    assert.ok(parsed.PackageEndTimeRangeEnd)
    res.end(JSON.stringify({ code: 0, data: { Response: { Data: { TotalCount: 3, TotalDosage: 131 } } } }))
  })
  try {
    assert.equal(await fetchUserResource(siteAt(base), "AT", "U1"), 131)
  } finally {
    server.close()
  }
})

test("fetchUserResource 缺 TotalDosage 时抛错", async () => {
  const { server, base } = await startServer((req, body, res) => res.end(JSON.stringify({ code: 0, data: { Response: { Data: {} } } })))
  try {
    await assert.rejects(() => fetchUserResource(siteAt(base), "AT", "U1"), /缺少 TotalDosage/)
  } finally {
    server.close()
  }
})

// ---- 签到 ---------------------------------------------------------------------

test("签到：活动未开启时是 inactive，绝不去调签到接口", async () => {
  const paths = []
  const { server, base } = await startServer((req, body, res) => {
    paths.push(req.url)
    res.end(JSON.stringify({ code: 0, data: { active: false, today_checked_in: false } }))
  })
  try {
    const got = await checkinOf(siteAt(base), "AT", "U1")
    assert.equal(got.outcome, "inactive")
    assert.deepEqual(paths, ["/billing/meter/checkin-activity-status"])
  } finally {
    server.close()
  }
})

test("签到：今天已在时报 done 与当日积分", async () => {
  const { server, base } = await startServer((req, body, res) => {
    assert.equal(req.url, "/billing/meter/checkin-activity-status")
    res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: true, today_credit: 100, daily_credit: 100 } }))
  })
  try {
    assert.deepEqual(await checkinOf(siteAt(base), "AT", "U1"), { outcome: "done", credit: 100 })
  } finally {
    server.close()
  }
})

test("签到：活动开启且今天未签时真去签到，读回积分与连签", async () => {
  const { server, base } = await startServer((req, body, res) => {
    if (req.url === "/billing/meter/checkin-activity-status") {
      return res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }))
    }
    assert.equal(req.url, "/v2/billing/meter/daily-checkin")
    res.end(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 3 } }))
  })
  try {
    assert.deepEqual(await checkinOf(siteAt(base), "AT", "U1"), { outcome: "claimed", credit: 100, streak: 3 })
  } finally {
    server.close()
  }
})

test("签到：10001 带「已签到」字样时是 done", async () => {
  const { server, base } = await startServer((req, body, res) => {
    if (req.url.endsWith("checkin-activity-status")) {
      return res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }))
    }
    res.statusCode = 400
    res.end(JSON.stringify({ code: 10001, msg: "今日已签到" }))
  })
  try {
    assert.equal((await checkinOf(siteAt(base), "AT", "U1")).outcome, "done")
  } finally {
    server.close()
  }
})

test("签到：10001 说活动未开启时是 inactive，并带上上游原话", async () => {
  // 实测 2026-11-14：daily-checkin 回 10001「签到活动未开启或已过期」
  const { server, base } = await startServer((req, body, res) => {
    if (req.url.endsWith("checkin-activity-status")) return res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }))
    res.statusCode = 400
    res.end(JSON.stringify({ code: 10001, msg: "签到活动未开启或已过期" }))
  })
  try {
    const got = await checkinOf(siteAt(base), "AT", "U1")
    assert.equal(got.outcome, "inactive")
    assert.equal(got.message, "签到活动未开启或已过期")
  } finally {
    server.close()
  }
})

test("签到：其它业务码是 failed，带上游原话", async () => {
  const { server, base } = await startServer((req, body, res) => {
    if (req.url.endsWith("checkin-activity-status")) return res.end(JSON.stringify({ code: 0, data: { active: true } }))
    res.statusCode = 500
    res.end(JSON.stringify({ code: 50000, msg: "上游炸了" }))
  })
  try {
    const got = await checkinOf(siteAt(base), "AT", "U1")
    assert.equal(got.outcome, "failed")
    assert.equal(got.message, "上游炸了")
  } finally {
    server.close()
  }
})

test("签到：状态接口 401 时是 failed，不冒充 expired", async () => {
  const { server, base } = await startServer((req, body, res) => {
    res.statusCode = 401
    res.end("<html>401</html>")
  })
  try {
    const got = await checkinOf(siteAt(base), "AT", "U1")
    assert.equal(got.outcome, "failed")
    assert.match(got.message, /拒绝了这个登录/)
  } finally {
    server.close()
  }
})
