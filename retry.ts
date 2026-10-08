/**
 * pi-retry-action — manual `/retry` done as an action, not as a prompt.
 *
 * - `/retry` re-sends the last tried client turn to the LLM provider WITHOUT
 *   appending any synthetic "retry..." / "continue..." message to the chat.
 *   The trailing error assistant message is dropped from the live transcript
 *   (kept in the session journal for history, exactly like pi's native retry)
 *   and the turn is continued from the last user / tool-result message.
 * - If the last turn is a *finished* assistant message, `/retry` asks which
 *   prompt to send: "Select which prompt to send from this list."
 * - Upstream rules are honored: 429/rate-limit/5xx/transient errors may retry
 *   (rate limits wait out the server-requested delay first); quota / free-tier
 *   gate / budget exhaustion, context overflow and permanent failures never
 *   retry and explain what to do instead.
 * - A temporary rate limit puts the command into "waiting for next retry"
 *   mode for the `Retry-After` duration (or the provider's own delay, e.g.
 *   Z.AI-style error text), with Escape / any new message cancelling the wait.
 *
 * This complements pi's native automatic retry (`retry.*` settings): native
 * retry keeps handling failures inline with fixed backoff, while `/retry` is
 * the manual action you take once an error has surfaced.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { matchesKey } from "@earendil-works/pi-tui";

import {
  classifyWithPreset,
  isRetryAllowed,
  parseRetryAfterHeader,
  parseRetryDelayMs,
  resolveWaitMs,
  formatWait,
  MAX_WAIT_MS,
  branchErrorTail,
  isOrphanedEditorText,
  trailingErrors,
  isIdenticalRepeat,
  rewindToResumePoint,
  isContinuableResumePoint,
  CONTINUATION_PROMPTS,
  CUSTOM_PROMPT_OPTION,
  type ErrorKind,
} from "./src/retry-policy.js";

// ---------------------------------------------------------------------------
// Live Agent capture
// ---------------------------------------------------------------------------
//
// Extensions are not handed the Agent instance, but a zero-message retry must
// operate on the live transcript (`agent.state.messages`) and resume it with
// `agent.continue()` — both unavailable through the public ExtensionAPI (which
// can only *append* messages). Capture the instance the same way AgentSession
// subscribes to it; this fires for fresh sessions and resumes alike.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _agent: Agent | null = null;

try {
  const proto = Agent.prototype as unknown as {
    subscribe: (...args: unknown[]) => unknown;
  };
  const origSubscribe = proto.subscribe;
  if (typeof origSubscribe === "function" && !(origSubscribe as { __piRetryPatched?: boolean }).__piRetryPatched) {
    const patched = function (this: unknown, ...args: unknown[]) {
      _agent = this as Agent;
      return (origSubscribe as (...a: unknown[]) => unknown).apply(this, args);
    };
    (patched as { __piRetryPatched?: boolean }).__piRetryPatched = true;
    proto.subscribe = patched as (...args: unknown[]) => unknown;
  }
} catch {
  // If the Agent class cannot be patched (repackaged host, SDK mode), manual
  // retry falls back to a clear diagnostic instead of failing silently.
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Last observed provider HTTP response, for Retry-After aware waiting. */
let _lastProviderResponse: {
  status: number;
  headers: Record<string, string | undefined>;
  at: number;
} | null = null;

/** Freshness window for trusting a captured Retry-After header. */
const RETRY_AFTER_FRESH_MS = 5 * 60_000;

/** True while a manual retry turn is being driven. */
let _retryInFlight = false;
/** True while sitting in "waiting for next retry". Set by Escape. */
let _waitCancelled = false;
/** Bumped on session start/shutdown so stale waits/retries abort. */
let _sessionGeneration = 0;

let _terminalInputUnsubscribe: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnyMessage = {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
};

function getLiveMessages(): AnyMessage[] | null {
  const state = (_agent as unknown as { state?: { messages?: unknown } } | null)?.state;
  if (!state || !Array.isArray(state.messages)) return null;
  return state.messages as AnyMessage[];
}

function readEditorText(ctx: ExtensionCommandContext): string {
  try {
    const text = ctx.ui.getEditorText();
    return typeof text === "string" ? text : "";
  } catch {
    // Headless modes have no editor.
    return "";
  }
}

function readBranchEntries(ctx: ExtensionCommandContext): Array<unknown> {
  try {
    return ctx.sessionManager.getBranch() as Array<unknown>;
  } catch {
    return [];
  }
}

function textOf(content: unknown, max = 80): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(block => {
        if (!block || typeof block !== "object") return "";
        const b = block as { type?: unknown; text?: unknown };
        return b.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .join("\n");
  }
  text = text.trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text || "(non-text turn)";
}

function lastUserText(messages: AnyMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return textOf(messages[i].content);
  }
  return undefined;
}

function notifySafe(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Session was replaced mid-flight; the old ctx is stale. Nothing to show on.
  }
}

function setStatusSafe(ctx: ExtensionCommandContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("pi-retry-action", text);
  } catch {
    // Non-TUI modes or stale ctx — status is best-effort.
  }
}

function freshHeaderDelayMs(): number | undefined {
  if (!_lastProviderResponse) return undefined;
  if (Date.now() - _lastProviderResponse.at > RETRY_AFTER_FRESH_MS) return undefined;
  if (!(_lastProviderResponse.status === 429 || _lastProviderResponse.status >= 500)) return undefined;
  return parseRetryAfterHeader(_lastProviderResponse.headers);
}

function activeProviderId(ctx: ExtensionCommandContext): string | undefined {
  const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
  if (typeof model?.provider === "string" && model.provider) return model.provider;
  if (typeof model?.id === "string" && model.id.includes("/")) return model.id.split("/")[0];
  return undefined;
}

function describeRefusal(kind: ErrorKind, errorMessage: string, detail?: string): string {
  const short = errorMessage.trim().slice(0, 160);
  const forceHint = ` To force continuation anyway, use '/retry continue'.`;
  if (kind === "quota") {
    return (
      `Not retrying: quota / free-tier-gate / budget exhaustion. ` +
      (detail ? `${detail}. ` : "") +
      `Fix the plan, billing or balance issue (or wait out the reset window), then /retry.` +
      forceHint + ` Provider said: ${short}`
    );
  }
  if (kind === "overflow") {
    return (
      `Not retrying: context overflow. Run /compact first to shrink the context, then /retry.` +
      forceHint + ` Provider said: ${short}`
    );
  }
  return (
    `Not retrying: permanent failure (fix the underlying issue first, then /retry).` +
    forceHint + ` Provider said: ${short}`
  );
}

/** Interruptible wait. Returns true when the full delay elapsed, false when cancelled. */
async function waitForNextRetry(
  ctx: ExtensionCommandContext,
  waitMs: number,
  generation: number,
): Promise<boolean> {
  _waitCancelled = false;
  const deadline = Date.now() + waitMs;
  notifySafe(
    ctx,
    `Rate limited — waiting for next retry (${formatWait(waitMs)}). Send any message or press Escape to cancel.`,
    "info",
  );
  while (Date.now() < deadline) {
    if (
      _waitCancelled ||
      _sessionGeneration !== generation ||
      ctx.hasPendingMessages() ||
      !ctx.isIdle()
    ) {
      setStatusSafe(ctx, undefined);
      return false;
    }
    const remaining = deadline - Date.now();
    setStatusSafe(ctx, `waiting for next retry ${formatWait(remaining)}…`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  setStatusSafe(ctx, undefined);
  return !_waitCancelled && _sessionGeneration === generation && ctx.isIdle();
}

// ---------------------------------------------------------------------------
// Retry drivers
// ---------------------------------------------------------------------------

/**
 * True retry as an action: no message is appended to the chat.
 *
 * Every outcome is reported — a retry must never go silent after announcing
 * itself: success/failure surfaces through the normal transcript pipeline,
 * a start failure notifies loudly, completion notifies briefly, and a slow
 * provider gets a periodic status heartbeat while the run is pending.
 */
async function trueRetry(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reason: string,
  resumeRole: string,
  liveCount: number,
  note = "",
): Promise<void> {
  if (!_agent) {
    notifySafe(ctx, "Cannot retry: live agent is unavailable in this host. Send your message again manually.", "error");
    return;
  }
  if (_retryInFlight) {
    notifySafe(ctx, "A retry is already in flight.", "warning");
    return;
  }
  // Re-check right before continuing: another driver (native retry, a second
  // extension, a queued turn) may have started since the handler's idle check.
  // Continuing into an active run only throws "already processing".
  if (!ctx.isIdle()) {
    notifySafe(
      ctx,
      "Agent became busy before the retry started (another turn or retry began). Run /retry again once it settles.",
      "warning",
    );
    return;
  }
  _retryInFlight = true;
  const generation = _sessionGeneration;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    notifySafe(
      ctx,
      `${reason} — re-sending last turn (no prompt added)… [${liveCount} msgs, from ${resumeRole}]${note}`,
      "info",
    );
    const run = (_agent as unknown as { continue: () => Promise<void> }).continue();
    heartbeat = setInterval(() => {
      if (_sessionGeneration !== generation) return;
      setStatusSafe(ctx, "retry in progress… (waiting for provider)");
    }, 5000);
    await run;
    notifySafe(ctx, "Retry turn finished — see transcript.", "info");
  } catch (error) {
    notifySafe(
      ctx,
      `Retry failed to start: ${error instanceof Error ? error.message : String(error)}. To send a fresh prompt instead, use '/retry continue'.`,
      "error",
    );
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    setStatusSafe(ctx, undefined);
    _retryInFlight = false;
  }
}

/** Send a prompt as a new user turn, queueing behind a just-started run on races. */
function sendPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
  try {
    pi.sendUserMessage(prompt);
  } catch (error) {
    // Agent started streaming between the idle check and the send (e.g. a
    // queued follow-up fired). Queue behind it instead of failing.
    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch {
      notifySafe(
        ctx,
        `Could not send prompt: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }
}

async function continuationSelect(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    // Headless (print/json) mode cannot prompt — send the neutral default.
    sendPrompt(pi, ctx, "Continue.");
    return;
  }
  const choice = await ctx.ui.select("Select which prompt to send from this list.", [
    ...CONTINUATION_PROMPTS,
    CUSTOM_PROMPT_OPTION,
  ]);
  if (!choice) {
    notifySafe(ctx, "Retry cancelled.", "info");
    return;
  }
  let prompt = choice;
  if (choice === CUSTOM_PROMPT_OPTION) {
    const custom = await ctx.ui.input("Custom continuation prompt:", "Continue.");
    if (!custom || !custom.trim()) {
      notifySafe(ctx, "Retry cancelled.", "info");
      return;
    }
    prompt = custom.trim();
  }
  sendPrompt(pi, ctx, prompt);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("after_provider_response", event => {
    const raw = event.headers as unknown;
    const headers: Record<string, string | undefined> = {};
    try {
      if (raw && typeof (raw as { get?: unknown }).get === "function") {
        // Fetch Headers instance.
        const h = raw as { forEach: (cb: (v: string, k: string) => void) => void };
        h.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
      } else if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === "string") headers[key.toLowerCase()] = value;
          else if (Array.isArray(value) && typeof value[0] === "string") {
            headers[key.toLowerCase()] = value[0];
          }
        }
      }
    } catch {
      // Header capture is best-effort; classification falls back to message parsing.
    }
    _lastProviderResponse = { status: event.status, headers, at: Date.now() };
  });

  pi.on("session_start", (_event, ctx) => {
    _sessionGeneration++;
    _waitCancelled = true;
    _terminalInputUnsubscribe?.();
    _terminalInputUnsubscribe = null;
    if (ctx.mode === "tui") {
      try {
        _terminalInputUnsubscribe = ctx.ui.onTerminalInput(data => {
          if (matchesKey(data, "escape")) _waitCancelled = true;
          return undefined;
        });
      } catch {
        _terminalInputUnsubscribe = null;
      }
    }
  });

  pi.on("session_shutdown", () => {
    _sessionGeneration++;
    _waitCancelled = true;
    _terminalInputUnsubscribe?.();
    _terminalInputUnsubscribe = null;
  });

  pi.registerCommand("retry", {
    description:
      "Re-send the last client turn as an action (no prompt added). Finished assistant turn? Pick a continuation prompt. Subcommands: status, continue, help.",
    handler: async (args, ctx) => {
      const sub = args.trim();

      // --- /retry status: diagnostics, no side effects ---------------------
      if (/^status\b/i.test(sub)) {
        const messages = getLiveMessages();
        if (!messages || messages.length === 0) {
          notifySafe(ctx, "Retry status: empty transcript — nothing to retry.", "info");
          return;
        }
        const tail = messages[messages.length - 1];
        const lastUser = lastUserText(messages);
        let report = "=== Retry status ===\n";
        report += `Last turn: ${lastUser ? `user: "${lastUser}"` : "(no user turn)"}\n`;
        report += `Tail message: role=${tail.role}${tail.stopReason ? `, stopReason=${tail.stopReason}` : ""}\n`;
        if (tail.role === "assistant" && tail.stopReason === "error") {
          const err = tail.errorMessage ?? "Unknown error";
          const { kind } = classifyWithPreset(activeProviderId(ctx), err);
          report += `Error kind: ${kind} (retry ${isRetryAllowed(kind) ? "allowed" : "refused"})\n`;
          report += `Error: ${err.slice(0, 200)}\n`;
          const headerMs = freshHeaderDelayMs();
          const parsedMs = parseRetryDelayMs(err);
          const decision = resolveWaitMs(kind, parsedMs, headerMs);
          if (decision.source !== "none") {
            report += decision.exceedsCap
              ? `Server asks to wait ${formatWait(decision.waitMs)} (exceeds ${formatWait(MAX_WAIT_MS)} cap)\n`
              : `Wait before retry: ${formatWait(decision.waitMs)} (from ${decision.source})\n`;
          }
        } else if (tail.role === "assistant") {
          report += "Finished assistant turn — /retry will offer continuation prompts.\n";
        } else if (tail.role === "user" || tail.role === "toolResult") {
          const branchErr = branchErrorTail(readBranchEntries(ctx));
          report += branchErr
            ? `Branch ends with error (${classifyWithPreset(activeProviderId(ctx), branchErr.errorMessage).kind}) — rules apply before continuing.\n`
            : "Unanswered client turn — /retry will re-send it directly.\n";
        } else {
          report += `Trailing "${tail.role}" message — /retry cannot continue from it; send a new message instead.\n`;
        }
        const editorPreview = readEditorText(ctx).trim().replace(/\s+/g, " ");
        report += editorPreview
          ? `Editor holds: "${editorPreview.length > 80 ? `${editorPreview.slice(0, 80)}…` : editorPreview}"\n`
          : "Editor: empty\n";
        notifySafe(ctx, report, "info");
        return;
      }

      // --- /retry continue: force the continuation prompt picker ------------
      if (/^continue\b/i.test(sub)) {
        if (!ctx.isIdle()) {
          notifySafe(ctx, "Agent is busy — wait for it to finish, then /retry continue.", "warning");
          return;
        }
        await ctx.waitForIdle();
        await continuationSelect(pi, ctx);
        return;
      }

      if (/^(help|--help|-h)\b/i.test(sub) || sub.startsWith("-")) {
        notifySafe(
          ctx,
          "Usage:\n" +
            "  /retry            Re-send the last client turn (action, no prompt added). Finished assistant turn? Pick a continuation prompt.\n" +
            "  /retry continue   Force the continuation prompt picker.\n" +
            "  /retry status     Show last-turn diagnostics without doing anything.\n" +
            "  /retry <text>     Send <text> as your next prompt.",
          "info",
        );
        return;
      }

      // --- /retry <free text>: send it as the next prompt --------------------
      if (sub.length > 0) {
        if (!ctx.isIdle()) {
          notifySafe(ctx, "Agent is busy — wait for it to finish before sending.", "warning");
          return;
        }
        pi.sendUserMessage(sub);
        return;
      }

      // --- /retry: the action -------------------------------------------------
      if (!ctx.isIdle()) {
        notifySafe(ctx, "Agent is busy — wait for it to finish (or stop it), then /retry.", "warning");
        return;
      }
      await ctx.waitForIdle();

      const generation = _sessionGeneration;
      const messages = getLiveMessages();
      if (!messages || messages.length === 0) {
        notifySafe(ctx, "Nothing to retry: the transcript is empty.", "warning");
        return;
      }

      const tail = messages[messages.length - 1];

      // Case 1: trailing error — the true retry action (possibly after waiting).
      if (tail.role === "assistant" && tail.stopReason === "error") {
        const errorMessage = tail.errorMessage ?? "Unknown error";
        const { kind, detail } = classifyWithPreset(activeProviderId(ctx), errorMessage);
        if (!isRetryAllowed(kind)) {
          notifySafe(ctx, describeRefusal(kind, errorMessage, detail), "warning");
          return;
        }
        const decision = resolveWaitMs(kind, parseRetryDelayMs(errorMessage), freshHeaderDelayMs());
        if (decision.exceedsCap) {
          notifySafe(
            ctx,
            `Server asked to wait ${formatWait(decision.waitMs)} before retrying, which exceeds the ${formatWait(MAX_WAIT_MS)} cap. ` +
              `Not waiting — run /retry again later.`,
            "warning",
          );
          return;
        }
        if (decision.waitMs > 0) {
          const elapsed = await waitForNextRetry(ctx, decision.waitMs, generation);
          if (!elapsed) {
            notifySafe(ctx, "Retry cancelled before the wait finished.", "info");
            return;
          }
          // Re-validate after the wait: the world may have moved on.
          const fresh = getLiveMessages();
          const freshTail = fresh?.[fresh.length - 1];
          if (
            !fresh ||
            freshTail?.role !== "assistant" ||
            freshTail.stopReason !== "error"
          ) {
            notifySafe(ctx, "Transcript changed during the wait — not retrying blindly. Run /retry again.", "warning");
            return;
          }
        }
        const live = getLiveMessages();
        if (!live) {
          notifySafe(ctx, "Cannot retry: live transcript is unavailable.", "error");
          return;
        }
        // Peek first: refusal paths must not mutate the transcript.
        const { resume: resumeFrom, rewindCount, rewoundToolCall } = rewindToResumePoint(live);
        if (!isContinuableResumePoint(resumeFrom)) {
          notifySafe(
            ctx,
            `Cannot re-send: transcript ends with "${resumeFrom?.role ?? "nothing"}" before the error(s). Send a new message instead.`,
            "warning",
          );
          return;
        }
        const repeatNote = isIdenticalRepeat(trailingErrors(live))
          ? " Previous attempt(s) failed identically — the resume point itself may be invalid (e.g. an orphaned tool result the provider rejects). Consider '/retry continue'."
          : "";
        const toolCallNote = rewoundToolCall
          ? " Rewound a dangling tool call with no result — it will be re-issued."
          : "";
        // Rewind only on the path that actually continues: drop the trailing
        // errors (and the dangling call, if any), then send context as-is.
        // Nothing is appended — the completion arrives as the next turn(s).
        live.splice(live.length - rewindCount, rewindCount);
        const hint = lastUserText(live);
        await trueRetry(pi, ctx, hint ? `Retrying "${hint}"` : "Retrying last turn", resumeFrom.role, live.length, `${toolCallNote}${repeatNote}`);
        return;
      }

      // Case 3: unanswered client turn — send context as-is, nothing new.
      // But first check
      // the journal branch: if it ends with an error the live transcript no
      // longer shows (compaction-stripped, or a mid-turn tree landing), the
      // turn is not blindly continued — error rules apply instead.
      if (tail.role === "user" || tail.role === "toolResult") {
        const branchErr = branchErrorTail(readBranchEntries(ctx));
        if (branchErr) {
          const verdict = classifyWithPreset(activeProviderId(ctx), branchErr.errorMessage);
          if (!isRetryAllowed(verdict.kind)) {
            notifySafe(
              ctx,
              describeRefusal(verdict.kind, branchErr.errorMessage ?? "Unknown error", verdict.detail),
              "warning",
            );
            return;
          }
        }
        const hint = tail.role === "user" ? textOf(tail.content) : "unfinished tool turn";
        await trueRetry(pi, ctx, `Re-sending "${hint}"`, tail.role, messages.length);
        return;
      }

      // Case 4: finished assistant turn (stop/length/aborted/...) — ask which
      // prompt to send. This is a continuation, not a retry, so the chosen
      // prompt IS sent as a new user message (explicitly consented).
      // A retry itself never creates messages — so when the editor holds an
      // unsent request (e.g. restored there by tree navigation), it is left
      // alone and pointed at instead of picker-overridden or auto-sent.
      if (tail.role === "assistant") {
        const editorText = readEditorText(ctx);
        const hasUser = messages.some(m => m.role === "user");
        if (isOrphanedEditorText(editorText, hasUser ? lastUserText(messages) : undefined)) {
          notifySafe(
            ctx,
            `Not retrying from the transcript: the editor holds an unsent request ("${textOf(editorText.trim())}"). Send it (Enter), clear it, or pick a continuation via '/retry continue'.`,
            "warning",
          );
          return;
        }
        await continuationSelect(pi, ctx);
        return;
      }

      notifySafe(
        ctx,
        `Cannot retry from a trailing "${tail.role}" message. Send a new message instead.`,
        "warning",
      );
    },
  });
}
