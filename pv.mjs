// extra_vars / verbosity 是否影响实际输出
import { readDesktop } from "./lib/oauth.mjs"
import { SITES } from "./lib/sites.mjs"
const site = SITES["codebuddy-intl"]
const d = readDesktop(site)
if (d.error) process.exit(0)
const zlib = await import("node:zlib")
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random()*256).toString(16).padStart(2,"0")).join("")
async function ask(extra) {
  const H = { "Content-Type": "application/json", Authorization: "Bearer " + d.access, "X-Domain": site.domain,
    "X-Conversation-ID": hex(16), "X-Conversation-Request-ID": hex(16), "X-Conversation-Message-ID": hex(16), "Content-Encoding": "gzip" }
  const body = { model: "glm-5.3", max_tokens: 300, stream: true, stream_options: { include_usage: true },
    messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "Explain what a monad is in two sentences." }], ...extra }
  const r = await fetch(site.chat + "/v2/chat/completions", { method: "POST", headers: H, body: zlib.gzipSync(Buffer.from(JSON.stringify(body))) })
  const t = await r.text()
  let content = "", reasoning = 0, u
  for (const f of t.split("\n").filter(l => l.startsWith("data: {"))) {
    try { const j = JSON.parse(f.slice(6)); const dl = j.choices?.[0]?.delta ?? {}; content += dl.content ?? ""; reasoning += (dl.reasoning_content ?? "").length; if (j.usage) u = j.usage } catch {}
  }
  return `content=${content.length} reasoning=${reasoning} out=${u?.completion_tokens}`
}
console.log("verbosity 对输出长度的影响（同一提示）：")
for (const v of [undefined, "low", "medium", "high"]) {
  const r = await ask(v === undefined ? {} : { verbosity: v })
  console.log(`  verbosity=${String(v).padEnd(8)} ${r}`)
  await new Promise(x => setTimeout(x, 500))
}
process.exit(0)
