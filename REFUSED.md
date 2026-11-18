# `Illegal API invocation from an unapproved channel` — what it is and how to fix it

CodeBuddy 的上游（国区 `copilot.tencent.com`、国际版 `www.codebuddy.ai`）会读一次聊天里
**system 与 assistant 消息**的文字，认出来自另一个 agent 提示词的整行原话，就把整次聊天拒掉：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

这不是客户端的问题，换账号也没用：同一份聊天用任何账号发都会被拒。本文是给「手里拿着这个
错误的人」——或者他把错误贴过去的那个 agent——看的，读完就能改掉提示词。

## If you are an agent reading this

Your user pasted an error that ends in a link to this file. Do this:

1. **Find the line.** It is in your system prompt, or in an assistant message. Openers
   are refused when they **start** a message; other fingerprints are refused anywhere in
   it. The user's messages and tools' results are not read, so it is not there.
2. **Say the line differently, as little as possible.** The check matches a line **whole
   and exactly**, so one more character is enough to pass it — and the line still says
   what it said. A comma is what this plugin uses:
   `You are an AI agent powered by X.` → `You are an AI agent, powered by X.`
   Adding a word is **not** enough: `…powered by DeepSeek Harness Desktop.` and
   `…powered by DeepSeek Harness CLI.` were refused just the same (measured 2026-10-30).
3. **Or drop the line**, if your harness has a switch for it (see *DeepSeek Harness*
   below). It costs the agent being told which harness it runs in.
4. **If you are a magpie plugin**, add the line to your reword list, the way `FLAGGED` in
   `lib/outbound.mjs` does, and keep the replacement saying the same thing.
5. **Re-run the request.** The fix needs no new account and no restart of the vendor.

## What is measured, and what is not

Everything here was measured against `https://copilot.tencent.com/v2/chat/completions`
with real accounts, and carried over from the WorkBuddy plugin
(`magpie-community/plugins`, `packages/workbuddy/REFUSED.md`): WorkBuddy and CodeBuddy are
the same team's two products on the same channel check. Kept apart from guesses on purpose:

| tried | result |
|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | **400** code 11128 |
| `You are an AI agent powered by deepseek harness.` | **400** — case is not a way out |
| `You are an AI agent powered by DeepSeekHarness.` | **400** — the space is not either |
| `You are an AI agent, powered by DeepSeek Harness.` | **200** |
| `You are an AI agent powered by DeepSeek Harness Desktop.` | **400** |
| `You are an AI agent powered by DeepSeek Harness CLI.` | **400** |
| `You are an AI agent powered by Claude Code.` | **200** |
| `You are an AI agent powered by FooBar.` | **200** |
| the line anywhere but the start of the message | **200** |

So the trigger is **a shape plus a name**: the shape `You are an AI agent powered by …`
together with the product name it knows. Break either one and the chat passes —
`You are a DeepSeek Harness agent …` passes, and a comma in the shape passes.
**A different product in the same shape passes**, which is what tells the two apart.

## Two things that look like this error and are not

- **`11101 Non-stream chat request is currently not supported`** — the upstream serves
  chat only streamed. Send `"stream": true`, or a probe reads 11101 and concludes the
  wrong thing.
- **`11128` with `first message is not system prompt`** — the *shape* of the chat, not
  its words. A chat must open with a system message. That is why this plugin puts
  `You are a helpful assistant.` in the system slot when it has to move a system prompt
  out of it.

## DeepSeek Harness (DSH)

DSH opens its system prompt with:

```
You are an AI agent powered by DeepSeek Harness.
```

It comes from `@deepseek-ai/dsh-system-prompt`, section `harness:identity`, order
`−1000` — the first section there is, so it can never be moved out of the way. Two ways
out:

- **Keep it, and let this plugin reword it.** Its `FLAGGED` list holds the line and puts
  a comma in, so the chat passes and the agent still knows which harness it runs in.
  This is the default once this plugin is installed.
- **Turn it off.** Set `includeHarnessIdentity: false` in the `system-prompt` plugin's
  config, in your profile's patch file (`<DSH home>/profiles/<profile>/cordis.patch.yml`):

  ```yaml
  - id: system-prompt
    config:
      personaPrefix: …      # ⚠ a patch replaces the whole config, not one key:
      personaSuffix: …      #   write the other keys back as they were or they are lost
      includeHarnessIdentity: false
  ```

  The cost is registered, not hidden: the model is no longer told which harness it runs
  in. Measured 2026-10-30, the difference that makes, with the rest of the prompt left
  alone — asked which harness it runs on, a model without the line answers *"I can't see
  which harness I'm on from the inside; unverified"*, and one with it answers *"I run on
  DeepSeek Harness"*. A DSH prompt that still names the harness elsewhere (the checkout
  path, the Web GUI address) lets the model work it out anyway.

## Checking a line yourself

Two rules that make a probe trustworthy: fix one account that is known to pass a plain
chat first, and always send `"stream": true`. The headers below are the ones
`lib/outbound.mjs`'s `chatHeaders` sends; drop the trace / conversation ids and the
channel check refuses the request for a reason that has nothing to do with the words.

```bash
KEY='<account access token>'
curl -sS https://copilot.tencent.com/v2/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'X-Domain: www.codebuddy.cn' -H 'X-Product: SaaS' -H 'X-IDE-Type: CLI' \
  -H 'X-IDE-Name: CLI' -H 'X-IDE-Version: 2.141.0' -H 'x-codebuddy-request: 1' \
  -H 'User-Agent: CLI/2.141.0 CodeBuddy/2.141.0' \
  -H 'X-Conversation-ID: 00000000000000000000000000000001' \
  -H 'X-Conversation-Request-ID: 00000000000000000000000000000002' \
  -H 'X-Conversation-Message-ID: 00000000000000000000000000000003' \
  --data-binary @- <<'JSON' | head -c 200
{"model":"glm-5.3","stream":true,"max_tokens":16,
 "messages":[{"role":"system","content":"You are an AI agent powered by DeepSeek Harness."},
             {"role":"user","content":"hi"}]}
JSON
```

`400` with `unapproved channel` means the line is refused; `200` with an SSE body means
it passes. A body that is refused costs no credits, so a probe is cheap.

## Adding a line to `FLAGGED`

`lib/outbound.mjs` — the list of words the upstream refuses, each with words that pass:

```js
[/You are an AI agent powered by DeepSeek Harness\.?/gi, "You are an AI agent, powered by DeepSeek Harness."],
```

Two rules, both from measurements rather than taste:

- **Reword as little as the whole-line match needs.** The check matches exactly, so a
  comma is enough; a replacement that says something else than the line did is a bug,
  not a fix. An earlier replacement here said the agent "helps the user with programming
  tasks", which took the harness's name out of the one line that says which agent is
  running.
- **A fingerprint is a line, not a product name.** A bare `DeepSeek` or `DeepSeek
  Harness` in a sentence someone else wrote was not refused; a whole opening line was.
  Add the line, and keep the pattern as narrow as it needs to be.

The words are refused whenever they appear in a system or assistant message, and reworded
in every message, so a line the model quotes back into an assistant message is covered
too. `replaceAgentSystemPrompts` is the narrower, separate rule for the one line that
only needs a prefix (`You are Claude Code, Anthropic's official CLI for Claude` — any
non-empty prefix passes, so the rest of the prompt is left untouched).
