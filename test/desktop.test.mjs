import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readDesktop, desktopFileOf, desktopAuthDir } from "../lib/oauth.mjs"
import { SITES } from "../lib/sites.mjs"

const site = SITES["codebuddy-intl"]

// authDir 造一个临时登录目录。
function authDir() {
  return mkdtempSync(join(tmpdir(), "cb-auth-"))
}

// writeAuth 写一份与实测形态一致的登录文件（2026-11-14，
// Tencent-Cloud.coding-copilot.info）。
function writeAuth(dir, name, obj) {
  writeFileSync(join(dir, name), JSON.stringify(obj))
}

const realInfo = (over = {}) => ({
  account: { uid: "U-1", nickname: "小明", type: "personal", ...(over.account ?? {}) },
  auth: {
    accessToken: "AT",
    refreshToken: "RT",
    tokenType: "Bearer",
    expiresAt: 1824777037815,
    refreshExpiresAt: 1824777037815,
    domain: "www.codebuddy.ai",
    ...(over.auth ?? {}),
  },
  ...(over.rest ?? {}),
})

// slashes 把路径统一成 /，让断言与平台上分隔符无关。
const slashes = (p) => p.replace(/\\/g, "/")

test("desktopAuthDir 按平台给出 IDE 的登录目录", () => {
  assert.match(slashes(desktopAuthDir({}, "win32", "C:\\Users\\x")), /CodeBuddyExtension\/Data\/Public\/auth$/)
  assert.match(slashes(desktopAuthDir({}, "darwin", "/Users/x")), /Library\/Application Support\/CodeBuddyExtension/)
  assert.match(slashes(desktopAuthDir({}, "linux", "/home/x")), /\.local\/share\/CodeBuddyExtension/)
})

test("desktopAuthDir 尊重 LOCALAPPDATA 与 XDG_DATA_HOME", () => {
  assert.match(slashes(desktopAuthDir({ LOCALAPPDATA: "D:\\Data" }, "win32", "C:\\Users\\x")), /^D:\/Data/)
  assert.match(slashes(desktopAuthDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/x")), /^\/data/)
})

test("desktopFileOf 优先当前文件，没有时取最新快照", () => {
  const dir = authDir()
  assert.equal(desktopFileOf(site, dir), null)
  writeAuth(dir, "Tencent-Cloud.coding-copilot.2026-01-01T00-00-00-000Z.1.aaa.info", realInfo())
  assert.ok(desktopFileOf(site, dir).endsWith(".info"))
  // 无时间戳的当前文件出现后就以它为准
  writeAuth(dir, "Tencent-Cloud.coding-copilot.info", realInfo())
  assert.equal(desktopFileOf(site, dir), join(dir, "Tencent-Cloud.coding-copilot.info"))
})

test("readDesktop 读得出实测形态的登录文件", () => {
  const dir = authDir()
  writeAuth(dir, "Tencent-Cloud.coding-copilot.info", realInfo())
  const got = readDesktop(site, join(dir, "Tencent-Cloud.coding-copilot.info"))
  assert.equal(got.error, undefined)
  assert.equal(got.access, "AT")
  assert.equal(got.refresh, "RT")
  assert.equal(got.uid, "U-1")
  assert.equal(got.name, "小明")
  assert.equal(got.expires, 1824777037815)
  assert.equal(got.source, "desktop")
})

test("readDesktop 对没有文件的目录返回错误而不是抛错", () => {
  const got = readDesktop(site, null)
  assert.match(got.error, /没有登录信息/)
})

test("readDesktop 说清加密的登录文件读不出来", () => {
  // WorkBuddy 桌面端 5.6 起把令牌加密存：{ $wbEncrypted: 1, envelope }
  const dir = authDir()
  writeAuth(dir, "x.info", { account: { uid: "U" }, auth: { accessToken: { $wbEncrypted: 1, envelope: "..." } } })
  const got = readDesktop(site, join(dir, "x.info"))
  assert.match(got.error, /加密/)
})

test("readDesktop 缺 accessToken 或 uid 时按未登录处理", () => {
  const dir = authDir()
  writeAuth(dir, "a.info", { account: { uid: "U" }, auth: {} })
  assert.match(readDesktop(site, join(dir, "a.info")).error, /没有登录信息/)
  writeAuth(dir, "b.info", { account: {}, auth: { accessToken: "AT" } })
  assert.match(readDesktop(site, join(dir, "b.info")).error, /没有登录信息/)
})

test("readDesktop 拒绝跨站点的登录文件", () => {
  // 国区与国际版共用同一套令牌，但请求要打到各自区域的域
  const dir = authDir()
  writeAuth(dir, "cn.info", realInfo({ auth: { domain: "www.codebuddy.cn" } }))
  const got = readDesktop(site, join(dir, "cn.info"))
  assert.match(got.error, /不是同一个区/)
})

test("readDesktop 接受与站点一致的 domain，包括大小写差异", () => {
  const dir = authDir()
  writeAuth(dir, "ok.info", realInfo({ auth: { domain: "WWW.CODEBUDDY.AI" } }))
  const got = readDesktop(site, join(dir, "ok.info"))
  assert.equal(got.error, undefined)
  assert.equal(got.access, "AT")
})

test("readDesktop 对坏 JSON 返回错误", () => {
  const dir = authDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "bad.info"), "{not json")
  assert.match(readDesktop(site, join(dir, "bad.info")).error, /读不出来/)
})
