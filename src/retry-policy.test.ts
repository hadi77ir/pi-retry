import {
  branchErrorTail,
  trailingErrors,
  isIdenticalRepeat,
  rewindToResumePoint,
  isContinuableResumePoint,
  classifyError,
  classifyWithPreset,
  extractResetAt,
  isOrphanedEditorText,
  parseRetryDelayMs,
  parseRetryAfterHeader,
  resolveWaitMs,
  formatWait,
  CONTINUATION_PROMPTS,
  CUSTOM_PROMPT_OPTION,
} from "./retry-policy.js";
import { describe, expect, it } from "vitest";

describe("classifyError", () => {
  it("treats 429 and rate-limit wording as rate-limited", () => {
    expect(classifyError("429 Too Many Requests: rate limit exceeded")).toBe("rate-limited");
    expect(classifyError("Rate limit exceeded, please slow down")).toBe("rate-limited");
    expect(classifyError("Overloaded: the model is overloaded")).toBe("rate-limited");
  });

  it("treats 5xx and transport failures as transient", () => {
    expect(classifyError("503 Service Unavailable")).toBe("transient");
    expect(classifyError("500 Internal Server Error")).toBe("transient");
    expect(classifyError("fetch failed: socket hang up")).toBe("transient");
    expect(classifyError("Connection error: other side closed")).toBe("transient");
  });

  it("treats subscription/quota/free-gate exhaustion as quota", () => {
    expect(classifyError("GoUsageLimitError: Monthly usage limit reached")).toBe("quota");
    expect(classifyError("FreeUsageLimitError: limit reached")).toBe("quota");
    expect(classifyError("Rate limit exceeded: free-models-per-day. Add credits to continue")).toBe("quota");
    expect(classifyError("You have insufficient_quota, check plan and billing")).toBe("quota");
    // z.ai Coding-Plan quota drain
    expect(
      classifyError("429 code 1113 Insufficient balance or no resource package. Please recharge."),
    ).toBe("quota");
    expect(classifyError("Usage limit reached for 5 hour. Your limit will reset at midnight")).toBe("quota");
  });

  it("treats context overflow as overflow, not as throttling", () => {
    expect(classifyError("prompt is too long: 213462 tokens > 200000 maximum")).toBe("overflow");
    expect(classifyError("input token count exceeds the maximum allowed")).toBe("overflow");
  });

  it("never mistakes throttling text for overflow", () => {
    expect(classifyError("ThrottlingException: Too many tokens, please wait before trying again.")).toBe(
      "rate-limited",
    );
    expect(classifyError("Service unavailable: too many tokens, try again later")).toBe("rate-limited");
  });

  it("treats auth/model failures as permanent", () => {
    expect(classifyError("401 invalid api key provided")).toBe("permanent");
    expect(classifyError("model not found: no such model 'gpt-99'")).toBe("permanent");
  });

  it("returns unknown for anything else", () => {
    expect(classifyError("Something completely unexpected happened")).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
  });
});

describe("parseRetryDelayMs", () => {
  it("parses plain-English delays", () => {
    expect(parseRetryDelayMs("Please try again in 30 seconds")).toBe(30_000);
    expect(parseRetryDelayMs("Please try again in 836ms")).toBe(836);
    expect(parseRetryDelayMs("Retry-After: 20")).toBe(20_000);
    expect(parseRetryDelayMs("retry in 2s")).toBe(2000);
    expect(parseRetryDelayMs("wait 2 minutes before retrying")).toBe(120_000);
  });

  it("parses gateway JSON delay fields (e.g. Z.AI style)", () => {
    expect(parseRetryDelayMs('{"error":"slow_down","retry_after":45}')).toBe(45_000);
    expect(parseRetryDelayMs('{"error":"slow_down","retry_after_ms":1500}')).toBe(1500);
  });

  it("returns undefined when no delay is stated", () => {
    expect(parseRetryDelayMs("429 Too Many Requests")).toBeUndefined();
    expect(parseRetryDelayMs(undefined)).toBeUndefined();
  });
});

describe("parseRetryAfterHeader", () => {
  it("honors retry-after-ms", () => {
    expect(parseRetryAfterHeader({ "retry-after-ms": "1500" })).toBe(1500);
  });

  it("honors retry-after seconds", () => {
    expect(parseRetryAfterHeader({ "retry-after": "20" })).toBe(20_000);
  });

  it("honors HTTP-date retry-after", () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterHeader({ "retry-after": date });
    expect(ms).toBeGreaterThan(25_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it("returns undefined for missing/invalid headers", () => {
    expect(parseRetryAfterHeader({})).toBeUndefined();
    expect(parseRetryAfterHeader({ "retry-after": "garbage" })).toBeUndefined();
  });
});

describe("resolveWaitMs", () => {
  it("waits for rate-limited errors with header precedence", () => {
    expect(resolveWaitMs("rate-limited", 30_000, 5_000)).toEqual({
      waitMs: 5_000,
      source: "retry-after-header",
      exceedsCap: false,
    });
    expect(resolveWaitMs("rate-limited", 30_000, undefined)).toEqual({
      waitMs: 30_000,
      source: "error-message",
      exceedsCap: false,
    });
    expect(resolveWaitMs("rate-limited", undefined, undefined)).toMatchObject({ source: "default" });
  });

  it("flags delays beyond the cap instead of waiting silently", () => {
    const decision = resolveWaitMs("rate-limited", 600_000, undefined);
    expect(decision.exceedsCap).toBe(true);
  });

  it("never waits for non-rate-limit kinds", () => {
    for (const kind of ["transient", "unknown", "quota", "overflow", "permanent"] as const) {
      expect(resolveWaitMs(kind, 30_000, 30_000).waitMs).toBe(0);
    }
  });
});

describe("formatWait", () => {
  it("formats durations compactly", () => {
    expect(formatWait(500)).toBe("500ms");
    expect(formatWait(5000)).toBe("5s");
    expect(formatWait(125_000)).toBe("2m 5s");
    expect(formatWait(120_000)).toBe("2m");
  });
});

describe("classifyWithPreset (Z.AI)", () => {
  // Exact string observed live against zai/glm-5.3 (HTTP 429).
  const ZAI_1308 =
    '429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-06 21:10:01"}';

  it("treats Z.AI code 1308 as quota despite the 429 status", () => {
    expect(classifyWithPreset("zai", ZAI_1308)).toEqual({
      kind: "quota",
      detail: "Z.AI code 1308: quota resets at 2026-10-06 21:10:01",
    });
  });

  it("treats Z.AI code 1113 as quota", () => {
    expect(
      classifyWithPreset(
        "zai-coding",
        '429 code 1113 Insufficient balance or no resource package. Please recharge.',
      ).kind,
    ).toBe("quota");
  });

  it("falls back to generic classification for other Z.AI errors", () => {
    expect(classifyWithPreset("zai", "503 Service Unavailable").kind).toBe("transient");
    expect(classifyWithPreset("zai", "prompt is too long: 1 tokens > 0 maximum").kind).toBe("overflow");
  });

  it("does not apply the preset to other providers", () => {
    expect(classifyWithPreset("openrouter", ZAI_1308).kind).toBe("quota"); // generic still catches it
    expect(classifyWithPreset(undefined, ZAI_1308).kind).toBe("quota");
    expect(extractResetAt(ZAI_1308)).toBe("2026-10-06 21:10:01");
  });
});

describe("branch and resume points", () => {
  it("rewinds past trailing errors without mutating", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", stopReason: "error" },
      { role: "assistant", stopReason: "error" },
    ];
    const result = rewindToResumePoint(messages);
    expect(result.resume?.role).toBe("user");
    expect(result.rewindCount).toBe(2);
    expect(result.rewoundToolCall).toBe(false);
    expect(isContinuableResumePoint(result.resume)).toBe(true);
    expect(messages.length).toBe(3); // untouched
  });

  it("rewinds a trailing dangling tool call so it can be re-issued", () => {
    const result = rewindToResumePoint([
      { role: "user" },
      { role: "assistant", stopReason: "toolUse" },
    ]);
    expect(result.resume?.role).toBe("user");
    expect(result).toMatchObject({ rewindCount: 1, rewoundToolCall: true });
  });

  it("rewinds errors then a dangling call, but never completed turns", () => {
    expect(
      rewindToResumePoint([
        { role: "user" },
        { role: "assistant", stopReason: "toolUse" },
        { role: "assistant", stopReason: "error" },
      ]),
    ).toMatchObject({ rewindCount: 2, rewoundToolCall: true });
    expect(
      rewindToResumePoint([{ role: "user" }, { role: "assistant", stopReason: "stop" }]).rewindCount,
    ).toBe(0);
    expect(
      rewindToResumePoint([{ role: "user" }, { role: "toolResult" }]).rewindCount,
    ).toBe(0);
  });

  it("rejects non-continuable resume points", () => {
    expect(isContinuableResumePoint(undefined)).toBe(false);
    expect(isContinuableResumePoint({ role: "assistant", stopReason: "stop" })).toBe(false);
    expect(isContinuableResumePoint({ role: "custom" })).toBe(false);
    expect(isContinuableResumePoint({ role: "toolResult" })).toBe(true);
  });

  it("detects identical repeats", () => {
    const msgs = [
      { role: "user" },
      { role: "assistant", stopReason: "error", errorMessage: "Connection error." },
      { role: "assistant", stopReason: "error", errorMessage: "Connection error." },
    ];
    expect(trailingErrors(msgs)).toEqual(["Connection error.", "Connection error."]);
    expect(isIdenticalRepeat(trailingErrors(msgs))).toBe(true);
    expect(isIdenticalRepeat(["a", "b"])).toBe(false);
    expect(isIdenticalRepeat(["a"])).toBe(false);
    expect(isIdenticalRepeat([])).toBe(false);
  });

  it("finds a branch-tail error", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "503 boom" } },
    ];
    expect(branchErrorTail(entries)?.errorMessage).toBe("503 boom");
  });

  it("ignores errors superseded by newer messages", () => {
    const entries = [
      { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "503 boom" } },
      { type: "message", message: { role: "user" } },
    ];
    expect(branchErrorTail(entries)).toBeUndefined();
  });

  it("returns undefined for successful assistant tails and empty branches", () => {
    expect(
      branchErrorTail([{ type: "message", message: { role: "assistant", stopReason: "stop" } }]),
    ).toBeUndefined();
    expect(branchErrorTail([])).toBeUndefined();
  });

  it("detects orphaned editor text (tree-nav restored requests)", () => {
    expect(isOrphanedEditorText("", "hello")).toBe(false);
    expect(isOrphanedEditorText("  hello  ", "hello")).toBe(false);
    expect(isOrphanedEditorText("restored request", "older turn")).toBe(true);
    expect(isOrphanedEditorText("anything", undefined)).toBe(true);
  });
});

describe("opencode-go OpenAI-style rate limit (observed live)", () => {
  it("treats rate_limit_exceeded as rate-limited with default wait", () => {
    const msg =
      'OpenAI API error (429): {"code":"rate_limit_exceeded","message":"Output token rate limit exceeded. Please retry after a brief wait."}';
    expect(classifyError(msg)).toBe("rate-limited");
    // "a brief wait" names no duration — nothing to parse, default wait applies.
    expect(parseRetryDelayMs(msg)).toBeUndefined();
  });
});

describe("continuation prompts", () => {
  it("contains the requested options", () => {
    for (const required of [
      "Continue.",
      "Continue the work as instructed.",
      "Continue the work as instructed, until done.",
      "Continue with the same style as before",
      "Retry.",
      "Retry what has been requested from you.",
      "Now you may continue.",
      "Progress towards the finish line.",
    ]) {
      expect(CONTINUATION_PROMPTS).toContain(required);
    }
    expect(CUSTOM_PROMPT_OPTION).toBeTruthy();
  });
});
