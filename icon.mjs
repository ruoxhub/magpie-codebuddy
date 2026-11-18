import { readDesktop } from "./lib/oauth.mjs"
import { SITES } from "./lib/sites.mjs"
const site = SITES["codebuddy-intl"]
const d = readDesktop(site)
if (d.error) process.exit(0)
// config 里有没有图标字段
const r = await fetch(site.chat + "/v3/config", { headers: {
  Accept: "application/json", Authorization: "Bearer " + d.access, "X-Domain": site.domain,
  "X-Product": "SaaS", "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "CLI/2.180.0 CodeBuddy/2.180.0", "X-User-Id": d.uid } })
const cfg = (await r.json()).data ?? {}
const keys = new Set()
const walk = (o, p = "") => { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { keys.add(p + k); if (typeof v === "object") walk(v, p + k + ".") } }
walk(cfg)
console.log("config 里含 icon/logo 的键:", [...keys].filter(k => /icon|logo|image|brand/i.test(k)).slice(0, 20).join(", ") || "无")
process.exit(0)
