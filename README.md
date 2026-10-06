# pi-retry-action

Manual `/retry` for [pi](https://github.com/earendil-works/pi), done as an
**action** — not as a prompt.

Unlike auto-retry extensions that append hidden `Retry the previous request.`
/ `Continue exactly where you left off…` messages to the chat (extra context on
every failure), this extension re-sends the last tried client turn **without
adding any message**:

1. The trailing error assistant message is dropped from the live transcript
   (it stays in the session journal for history — exactly like pi's native
   retry) and the turn is resumed with `agent.continue()`.
2. If the last turn is a *finished* assistant message, there is nothing to
   re-send, so `/retry` asks you instead:

   > Select which prompt to send from this list.
   >
   > `Continue.` · `Continue the work as instructed.` ·
   > `Continue the work as instructed, until done.` ·
   > `Continue with the same style as before` · `Retry.` ·
   > `Retry what has been requested from you.` · `Now you may continue.` ·
   > `Progress towards the finish line.` · …plus a few similar sentences and a
   > `Custom prompt…` entry.

   The chosen prompt is sent as a normal user message.

## Upstream rules

Retry decisions follow the same rules pi itself enforces upstream
(`pi-ai` `isRetryableAssistantError` / `isContextOverflow`, mirrored in
`src/retry-policy.ts`):

| Error | `/retry` behavior |
|---|---|
| 429 / rate limit / overloaded / temporary throttling | Wait, then retry |
| 5xx / network / connection / stream failures | Retry immediately |
| Quota / subscription / free-tier-gate / budget exhaustion (`GoUsageLimitError`, `FreeUsageLimitError`, `insufficient_quota`, OpenRouter free pool, z.ai Coding-Plan quota drain, …) | Refuse, with guidance |
| Context overflow | Refuse, points at `/compact` |
| Invalid API key / unknown model / other permanent failures | Refuse, with guidance |
| Anything unrecognized | Attempt once (explicit user action) |

A temporary rate limit puts the command into **waiting for next retry** mode
for the server-requested duration. Precedence: fresh `Retry-After` /
`retry-after-ms` response header (captured via `after_provider_response`) >
delay parsed from the error text (plain English *and* gateway JSON such as
Z.AI-style `"retry_after"` / `"retry_after_ms"`) > 5s default. Delays above
the 2-minute cap are not waited out — the command tells you to come back
later. Sending any message or pressing Escape cancels the wait.

This complements pi's native automatic retry (`retry.*` settings in
`settings.json`), which keeps handling failures inline with fixed backoff.
`/retry` is the manual action you take once an error has surfaced — e.g.
after native retries are exhausted, or when you want the server's own
`Retry-After` honored instead of guessed backoff.

## Provider presets (Z.AI)

`src/retry-policy.ts` holds provider-specific presets; everything else goes
through the generic classifier. The Z.AI preset was captured live against
`zai/glm-5.3`:

```
429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-06 21:10:01"}
```

Despite the HTTP 429, code `1308` is a **multi-hour usage window, not a
transient throttle** — waiting seconds and retrying would be wrong, so the
preset classifies `1113` (insufficient balance / no resource package) and
`1308` as quota exhaustion and reports the extracted reset time
(`quota resets at 2026-10-06 21:10:01`). The preset only applies when the
active provider is Z.AI itself (proxies such as openrouter/cline stay on the
generic path, which still catches the same wording). Unseen Z.AI codes fall
through to generic classification.

## Install

```bash
pi install /devel/pi-retry
# or: pi install git:github.com/<you>/pi-retry-action
```

> Conflict note: this registers `/retry`. If you also have
> `@monotykamary/pi-retry` installed, pi will suffix them (`/retry:1`,
> `/retry:2`). Remove the one you don't want (`pi remove …`).

Or drop the files into an auto-discovered location:

```bash
cp retry.ts ~/.pi/agent/extensions/pi-retry-action.ts
```

## Usage

```
/retry            Re-send the last client turn (action, no prompt added).
                  Finished assistant turn? Pick a continuation prompt.
/retry continue   Force the continuation prompt picker.
/retry status     Show last-turn diagnostics without doing anything.
/retry <text>     Send <text> as your next prompt.
/retry help       Show this help.
```

## How the zero-message retry works

Extensions are not handed the `Agent` instance, and the public API
(`sendMessage` / `sendUserMessage`) can only *append* messages. So the
extension captures the live agent the same way `AgentSession` subscribes to
it (via `Agent.prototype.subscribe`, same proven pattern as
`@monotykamary/pi-retry`), removes the trailing error from
`agent.state.messages`, and calls `agent.continue()`. Persistence, tool
execution and TUI rendering keep flowing through the existing agent
subscription; only `before_agent_start` injection and the post-run
retry/compaction pass are skipped for that resumed turn — acceptable for an
explicit manual retry, and refused outright for overflow errors.

## Development

```bash
npm install
npm test        # vitest — classification, delay parsing, wait decisions
npm run typecheck
```

---

*This extension has been developed completely by "Muse Spark 1.3 Contributor on pi agent".*
