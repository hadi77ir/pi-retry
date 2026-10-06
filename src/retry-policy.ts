/**
 * Pure retry-policy helpers for the pi-retry-action extension.
 *
 * Classification mirrors the upstream rules pi itself enforces:
 * - pi-ai `isRetryableAssistantError` (transient provider/transport failures:
 *   429/overloaded/rate-limit/5xx/network/stream errors) and its
 *   non-retryable provider-limit blocklist (GoUsageLimitError,
 *   FreeUsageLimitError, insufficient_quota, out of budget, ...).
 * - pi-ai `isContextOverflow` (+ NON_OVERFLOW exclusions), which must defer
 *   to compaction instead of retrying.
 *
 * This module has zero pi imports so it can be unit-tested standalone.
 */

export type ErrorKind =
  | "rate-limited"
  | "transient"
  | "quota"
  | "overflow"
  | "permanent"
  | "unknown";

/**
 * Patterns that prove an error is NOT a context-size problem even when it
 * contains overflow-looking words (mirrors pi-ai NON_OVERFLOW_PATTERNS,
 * plus a `throttl` guard so raw ThrottlingException text is never read as
 * overflow).
 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /throttl/i,
  /rate limit/i,
  /too many requests/i,
];

/** Context-overflow signals (mirrors pi-ai OVERFLOW_PATTERNS, condensed). */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

/**
 * Subscription / quota / budget / free-tier-gate exhaustion. Retrying is
 * pointless until the user acts or a long reset window passes, so upstream
 * treats these as non-retryable. Covers pi-ai's limit blocklist plus the
 * common gateway wordings (OpenRouter free pool, Alibaba window quotas,
 * Copilot allowance, z.ai Coding-Plan quota drain, suspended accounts).
 */
const QUOTA_PATTERNS = [
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /Monthly usage limit reached/i,
  /available balance/i,
  /insufficient[_\s]quota/i,
  /out of budget/i,
  /quota exceeded/i,
  /\bbilling\b/i,
  /hit your (?:[a-z]+ )?usage limit/i,
  /hit your limit/i,
  /usage_limit_reached/i,
  /usage\s*limit\s*(has\s*been\s*)?reached/i,
  /hour\s*limit\s*reached/i,
  /limit\s*will\s*reset\s*at/i,
  /session\s*(limit|quota)/i,
  /exceeded your usage limit/i,
  /exceeded your current quota/i,
  /free[-.]models[-.]per[-.]day/i,
  /hour\s*allocated\s*quota/i,
  /week\s*allocated\s*quota/i,
  /month\s*allocated\s*quota/i,
  /free\s*allocated\s*quota/i,
  /premium\s*request\s*allowance/i,
  /monthly\s*(limit|quota|budget|allowance)/i,
  /budget\s*(has\s*been\s*)?(exceeded|exhausted|limit)/i,
  /max(imum)?\s*budget\s*(exceeded|reached|limit)/i,
  /spending\s*limit/i,
  /exhausted your capacity/i,
  /quota will reset after/i,
  /reached the quota limit/i,
  /you can resume using this model/i,
  /no resource package/i,
  /account\b[^.]*\bis\s*suspended/i,
  /quota\s*(exhausted|depleted)/i,
];

/** Deterministic failures: retrying without a config/code change can never help. */
const PERMANENT_PATTERNS = [
  /invalid\s*api\s*key/i,
  /invalid\s*authentication/i,
  /api\s*key\s*(not\s*found|missing|revoked)/i,
  /model\s*not\s*found/i,
  /unknown\s*model/i,
  /no\s*such\s*model/i,
  /model\s*does\s*not\s*exist/i,
  /unsupported\s*model/i,
  /cannot continue from message role/i,
];

/** Temporary throttling: retryable, but only after the requested delay. */
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /temporar(?:il)?y\s+(?:unavailable|rate.?limited)/i,
  /try again (in|later)/i,
  /please retry/i,
  /throttl/i,
];

/** Other transient provider/transport failures (mirrors pi-ai retryables). */
const TRANSIENT_PATTERNS = [
  /\b50[0-9]\b/,
  /\b524\b/,
  /service.?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
  /provider.?returned.?error/i,
  /exceeded request buffer limit while retrying upstream/i,
  /network.?error/i,
  /connection.?error/i,
  /connection.?refused/i,
  /connection.?lost/i,
  /other side closed/i,
  /fetch failed/i,
  /getaddrinfo/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /upstream.?connect/i,
  /reset before headers/i,
  /socket hang up/i,
  /socket connection was closed/i,
  /timed? ?out/i,
  /timeout/i,
  /terminated/i,
  /websocket.?(closed|error)/i,
  /ended without/i,
  /stream ended before/i,
  /http2 request did not get a response/i,
  /retry delay/i,
  /you can retry your request/i,
  /please retry your request/i,
  /ResourceExhausted/i,
];

/**
 * Classify an assistant error message per upstream rules.
 *
 * Order matters: overflow first (with throttling exclusions), then quota,
 * then permanent, then rate-limit, then other transients. Anything else is
 * "unknown" — outside upstream auto-retry rules, left to the user's explicit
 * `/retry` decision.
 */
export function classifyError(errorMessage: string | undefined): ErrorKind {
  if (!errorMessage || !errorMessage.trim()) return "unknown";
  const msg = errorMessage;
  const excluded = NON_OVERFLOW_PATTERNS.some(p => p.test(msg));
  if (!excluded && OVERFLOW_PATTERNS.some(p => p.test(msg))) return "overflow";
  if (QUOTA_PATTERNS.some(p => p.test(msg))) return "quota";
  if (PERMANENT_PATTERNS.some(p => p.test(msg))) return "permanent";
  if (RATE_LIMIT_PATTERNS.some(p => p.test(msg))) return "rate-limited";
  if (TRANSIENT_PATTERNS.some(p => p.test(msg))) return "transient";
  return "unknown";
}

/** True for kinds where a retry attempt is allowed at all. */
export function isRetryAllowed(kind: ErrorKind): boolean {
  return kind === "rate-limited" || kind === "transient" || kind === "unknown";
}

// ---------------------------------------------------------------------------
// Provider presets: exact error shapes observed against live providers.
// Everything not matched here falls through to the generic classifier above.
// ---------------------------------------------------------------------------

/** Provider ids served directly by Z.AI (not via proxies like openrouter/cline). */
const ZAI_PROVIDER_PATTERN = /zai/i;

/**
 * Z.AI machine-readable error codes with quota semantics (observed live):
 * - 1113: "Insufficient balance or no resource package. Please recharge."
 * - 1308: "Usage limit reached for 5 hour. Your limit will reset at <ts>"
 *
 * Note the trap: 1308 arrives as HTTP 429, but it is a multi-hour usage
 * window, NOT a transient throttle — waiting seconds and retrying is wrong.
 * Zhipu-style throttling codes (1302/1303/1304 family) are deliberately NOT
 * listed: unseen here, they fall through to generic message classification.
 */
const ZAI_QUOTA_CODES = new Set(["1113", "1308"]);

export interface PresetVerdict {
  kind: ErrorKind;
  /** Human detail, e.g. the extracted quota reset timestamp. */
  detail?: string;
}

/** Extract Z.AI's "Your limit will reset at <datetime>" tail, if present. */
export function extractResetAt(errorMessage: string): string | undefined {
  const m = /reset\s+at\s+([\d-: \/T.]+)/i.exec(errorMessage);
  return m ? m[1].trim() : undefined;
}

/**
 * Classify with provider-specific presets first, generic rules otherwise.
 *
 * @param providerId Active model provider id (e.g. from ctx.model), or undefined.
 */
export function classifyWithPreset(
  providerId: string | undefined,
  errorMessage: string | undefined,
): PresetVerdict {
  if (providerId && ZAI_PROVIDER_PATTERN.test(providerId) && errorMessage) {
    const code = /"code"\s*:\s*"?(\d+)"?/.exec(errorMessage)?.[1];
    if (code && ZAI_QUOTA_CODES.has(code)) {
      const resetAt = extractResetAt(errorMessage);
      return {
        kind: "quota",
        detail: resetAt ? `Z.AI code ${code}: quota resets at ${resetAt}` : `Z.AI code ${code}: quota exhausted`,
      };
    }
  }
  return { kind: classifyError(errorMessage) };
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

const UNIT = String.raw`(?:ms|milliseconds?|s(?:ecs?)?|seconds?|m(?:ins?)?|minutes?|h(?:ours?)?)`;

const DELAY_IN_MESSAGE = [
  // "Retry-After: 20", "retry after 5 seconds", "retrying after 2s"
  new RegExp(String.raw`retry(?:ing)?[-\s]after:?\s+(\d+(?:\.\d+)?)(?:\s*(` + UNIT + String.raw`))?\b`, "i"),
  // "Please try again in 836ms", "retry in 30 seconds", "reset in 2 minutes"
  new RegExp(String.raw`(?:try again|retry|reset|wait)\s+in\s+(\d+(?:\.\d+)?)\s*(` + UNIT + String.raw`)\b`, "i"),
  // "wait 30 seconds before retrying"
  new RegExp(String.raw`wait\s+(\d+(?:\.\d+)?)\s*(` + UNIT + String.raw`)\s+(?:before\s+)?(?:retry|try)`, "i"),
  // z.ai / gateway JSON bodies: {"retry_after": 20}, {"retry_after_ms": 500}
  /"retry_after_ms"\s*:\s*(\d+(?:\.\d+)?)/i,
  /"retry_after"\s*:\s*(\d+(?:\.\d+)?)/i,
];

function toMs(value: number, unit: string | undefined, defaultUnit: "ms" | "s"): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (unit === undefined) return value * (defaultUnit === "ms" ? 1 : 1000);
  const mult = UNIT_MS[unit.toLowerCase()];
  if (mult === undefined) return undefined;
  return value * mult;
}

/**
 * Parse a provider-requested retry delay out of an error message.
 * Handles plain-English ("try again in 30 seconds", "Retry-After: 20"),
 * compact ("retry in 2s", "wait 500ms before retrying") and JSON
 * (`"retry_after"` seconds / `"retry_after_ms"` millis) wordings used by
 * gateways such as Z.AI. Returns undefined when no delay is stated.
 */
export function parseRetryDelayMs(errorMessage: string | undefined): number | undefined {
  if (!errorMessage) return undefined;
  for (let i = 0; i < DELAY_IN_MESSAGE.length; i++) {
    const m = DELAY_IN_MESSAGE[i].exec(errorMessage);
    if (!m) continue;
    const value = Number.parseFloat(m[1]);
    if (i === DELAY_IN_MESSAGE.length - 2) return toMs(value, undefined, "ms");
    if (i === DELAY_IN_MESSAGE.length - 1) return toMs(value, undefined, "s");
    const ms = toMs(value, m[2], "s");
    if (ms !== undefined && ms >= 0) return ms;
  }
  return undefined;
}

/** Parse HTTP `Retry-After` / `retry-after-ms` response headers (ms). */
export function parseRetryAfterHeader(headers: Record<string, string | undefined>): number | undefined {
  const msRaw = headers["retry-after-ms"];
  if (msRaw !== undefined) {
    const ms = toMs(Number.parseFloat(msRaw), undefined, "ms");
    if (ms !== undefined && ms > 0) return ms;
  }
  const raw = headers["retry-after"];
  if (raw === undefined) return undefined;
  const asSeconds = Number.parseFloat(raw);
  if (!Number.isNaN(asSeconds)) {
    const ms = toMs(asSeconds, undefined, "s");
    if (ms !== undefined && ms > 0) return ms;
  }
  const ms = Date.parse(raw) - Date.now();
  if (Number.isFinite(ms) && ms > 0) return ms;
  return undefined;
}

/** Default pause for a rate limit that names no delay. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
/** Never silently wait longer than this; ask the user to come back instead. */
export const MAX_WAIT_MS = 120_000;

export type WaitSource = "retry-after-header" | "error-message" | "default" | "none";

export interface WaitDecision {
  waitMs: number;
  source: WaitSource;
  /** True when the requested delay exceeds MAX_WAIT_MS (caller should not wait). */
  exceedsCap: boolean;
}

/**
 * Decide how long a manual retry must wait before re-sending the turn.
 * Only `rate-limited` errors wait; every other retryable kind goes at once.
 * Precedence: fresh Retry-After header > delay parsed from the error text >
 * default pause. Unknown kinds are retried immediately (explicit user action).
 */
export function resolveWaitMs(
  kind: ErrorKind,
  parsedMs: number | undefined,
  headerMs: number | undefined,
): WaitDecision {
  if (kind !== "rate-limited") return { waitMs: 0, source: "none", exceedsCap: false };
  const candidate = headerMs ?? parsedMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
  const source: WaitSource = headerMs !== undefined
    ? "retry-after-header"
    : parsedMs !== undefined
      ? "error-message"
      : "default";
  if (candidate > MAX_WAIT_MS) return { waitMs: candidate, source, exceedsCap: true };
  return { waitMs: candidate, source, exceedsCap: false };
}

/** Format a millisecond delay for status lines ("45s", "2m 5s", "500ms"). */
export function formatWait(ms: number): string {
  if (ms < 1000) return `${Math.ceil(ms)}ms`;
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Continuation prompts offered when the last turn is a finished assistant message. */
export const CONTINUATION_PROMPTS = [
  "Continue.",
  "Continue the work as instructed.",
  "Continue the work as instructed, until done.",
  "Continue with the same style as before",
  "Retry.",
  "Retry what has been requested from you.",
  "Now you may continue.",
  "Progress towards the finish line.",
  "Keep going.",
  "Please continue.",
  "Carry on from where you left off.",
  "Proceed with the task.",
] as const;

export const CUSTOM_PROMPT_OPTION = "Custom prompt…";
