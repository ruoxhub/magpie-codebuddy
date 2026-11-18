import test from "node:test"
import assert from "node:assert/strict"

import { SITES, SITE_IDS, siteOf, matchesSiteHost } from "../lib/sites.mjs"

test("两个站点按 provider id 取到，互不串台", () => {
  assert.equal(siteOf("codebuddy").chat, "https://copilot.tencent.com")
  assert.equal(siteOf("codebuddy").account, "https://www.codebuddy.cn")
  assert.equal(siteOf("codebuddy-intl").chat, "https://www.codebuddy.ai")
  assert.equal(siteOf("codebuddy-intl").account, "https://www.codebuddy.ai")
})

test("国际版的余额域与账号域不同（www.workbuddy.ai）", () => {
  assert.equal(siteOf("codebuddy-intl").balance, "https://www.workbuddy.ai")
  assert.equal(siteOf("codebuddy-intl").domain, "www.codebuddy.ai")
  assert.equal(siteOf("codebuddy-intl").balanceDomain, "www.workbuddy.ai")
})

test("未知 provider id 回落国区，绝不回落国际版", () => {
  // 反过来会把所有默认国区账号翻成国际版，全网 401
  assert.equal(siteOf("nope").id, "codebuddy")
  assert.equal(siteOf(undefined).id, "codebuddy")
  assert.equal(siteOf("codebuddy-intl").id, "codebuddy-intl")
})

test("SITE_IDS 与 SITES 的键一致，国区在前", () => {
  assert.deepEqual(SITE_IDS, ["codebuddy", "codebuddy-intl"])
  assert.deepEqual(Object.keys(SITES), SITE_IDS)
})

test("matchesSiteHost 比主机，不比特串", () => {
  const site = SITES["codebuddy-intl"]
  for (const ok of [
    "https://www.codebuddy.ai",
    "https://www.codebuddy.ai/",
    "HTTPS://WWW.CODEBUDDY.AI",
    "www.codebuddy.ai",
    "https://www.codebuddy.ai/v2/chat/completions",
  ]) {
    assert.equal(matchesSiteHost(site, ok), true, ok)
  }
})

test("matchesSiteHost 拒绝跨站与空值", () => {
  const site = SITES.codebuddy
  for (const bad of ["", "   ", "https://copilot.tencent.com", "https://www.codebuddy.ai", "not a url:::"]) {
    assert.equal(matchesSiteHost(site, bad), false, bad)
  }
})

test("国际版不提供签到，国区提供", () => {
  // 对齐 codeBuddyIntlKind.SupportsCheckin() == false
  assert.equal(SITES.codebuddy.checkin, true)
  assert.equal(SITES["codebuddy-intl"].checkin, false)
})

test("两个站点各有非空的兜底模型清单，且没有 default", () => {
  for (const id of SITE_IDS) {
    const list = SITES[id].models
    assert.ok(list.length > 0, id)
    for (const [model] of list) assert.notEqual(model, "default", `${id}/${model}`)
  }
})
