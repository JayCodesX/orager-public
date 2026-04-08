/**
 * Tests for src/loop-helpers.ts
 *
 * Covers evaluateTurnModelRules(), isReadOnlyTool(), and runConcurrent().
 */

import { describe, it, expect } from "vitest";
import {
  evaluateTurnModelRules,
  isReadOnlyTool,
  runConcurrent,
} from "../src/loop-helpers.js";
import type { TurnModelRule, TurnContext } from "../src/types.js";

// ── Helper: minimal TurnContext factory ──────────────────────────────────────

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turn: 0,
    model: "default/model",
    cumulativeTokens: { prompt: 0, completion: 0, total: 0 },
    cumulativeCostUsd: 0,
    messages: [],
    ...overrides,
  };
}

// ── evaluateTurnModelRules ──────────────────────────────────────────────────

describe("evaluateTurnModelRules", () => {
  it("returns undefined when rules is undefined", () => {
    expect(evaluateTurnModelRules(undefined, makeCtx(), new Set())).toBeUndefined();
  });

  it("returns undefined when rules array is empty", () => {
    expect(evaluateTurnModelRules([], makeCtx(), new Set())).toBeUndefined();
  });

  it("afterTurn:3 does NOT fire on turn 2", () => {
    const rules: TurnModelRule[] = [{ model: "cheap/model", afterTurn: 3 }];
    const result = evaluateTurnModelRules(rules, makeCtx({ turn: 2 }), new Set());
    expect(result).toBeUndefined();
  });

  it("afterTurn:3 fires on turn 3", () => {
    const rules: TurnModelRule[] = [{ model: "cheap/model", afterTurn: 3 }];
    const result = evaluateTurnModelRules(rules, makeCtx({ turn: 3 }), new Set());
    expect(result).toBe("cheap/model");
  });

  it("afterTurn:3 fires on turn 5 (>=)", () => {
    const rules: TurnModelRule[] = [{ model: "cheap/model", afterTurn: 3 }];
    const result = evaluateTurnModelRules(rules, makeCtx({ turn: 5 }), new Set());
    expect(result).toBe("cheap/model");
  });

  it("once:true rule fires exactly once across multiple calls", () => {
    const rules: TurnModelRule[] = [{ model: "once/model", afterTurn: 0, once: true }];
    const firedOnce = new Set<number>();

    const first = evaluateTurnModelRules(rules, makeCtx({ turn: 1 }), firedOnce);
    expect(first).toBe("once/model");

    const second = evaluateTurnModelRules(rules, makeCtx({ turn: 2 }), firedOnce);
    expect(second).toBeUndefined();

    const third = evaluateTurnModelRules(rules, makeCtx({ turn: 3 }), firedOnce);
    expect(third).toBeUndefined();
  });

  it("costAbove:1.0 fires when cumulativeCostUsd=1.5", () => {
    const rules: TurnModelRule[] = [{ model: "budget/model", costAbove: 1.0 }];
    const result = evaluateTurnModelRules(rules, makeCtx({ cumulativeCostUsd: 1.5 }), new Set());
    expect(result).toBe("budget/model");
  });

  it("costAbove:1.0 does NOT fire when cumulativeCostUsd=0.5", () => {
    const rules: TurnModelRule[] = [{ model: "budget/model", costAbove: 1.0 }];
    const result = evaluateTurnModelRules(rules, makeCtx({ cumulativeCostUsd: 0.5 }), new Set());
    expect(result).toBeUndefined();
  });

  it("costAbove:1.0 does NOT fire when cumulativeCostUsd=1.0 (strictly greater)", () => {
    const rules: TurnModelRule[] = [{ model: "budget/model", costAbove: 1.0 }];
    const result = evaluateTurnModelRules(rules, makeCtx({ cumulativeCostUsd: 1.0 }), new Set());
    expect(result).toBeUndefined();
  });

  it("tokensAbove fires when prompt tokens exceed threshold", () => {
    const rules: TurnModelRule[] = [{ model: "token/model", tokensAbove: 1000 }];
    const ctx = makeCtx({ cumulativeTokens: { prompt: 1500, completion: 0, total: 1500 } });
    expect(evaluateTurnModelRules(rules, ctx, new Set())).toBe("token/model");
  });

  it("returns first matching rule when multiple match", () => {
    const rules: TurnModelRule[] = [
      { model: "first/model", afterTurn: 1 },
      { model: "second/model", afterTurn: 1 },
    ];
    expect(evaluateTurnModelRules(rules, makeCtx({ turn: 2 }), new Set())).toBe("first/model");
  });

  it("combined conditions: all must match", () => {
    const rules: TurnModelRule[] = [
      { model: "combo/model", afterTurn: 3, costAbove: 1.0 },
    ];
    // Turn matches but cost doesn't
    expect(evaluateTurnModelRules(rules, makeCtx({ turn: 5, cumulativeCostUsd: 0.5 }), new Set())).toBeUndefined();
    // Cost matches but turn doesn't
    expect(evaluateTurnModelRules(rules, makeCtx({ turn: 1, cumulativeCostUsd: 2.0 }), new Set())).toBeUndefined();
    // Both match
    expect(evaluateTurnModelRules(rules, makeCtx({ turn: 5, cumulativeCostUsd: 2.0 }), new Set())).toBe("combo/model");
  });
});

// ── isReadOnlyTool ──────────────────────────────────────────────────────────

describe("isReadOnlyTool", () => {
  it.each([
    ["getUser",     true],
    ["listFiles",   true],
    ["readConfig",  true],
    ["fetchData",   true],
    ["GET_STATUS",  true],
  ])("isReadOnlyTool(%s) → true", (name, expected) => {
    expect(isReadOnlyTool(name)).toBe(expected);
  });

  it.each([
    ["createUser",  false],
    ["updateFile",  false],
    ["deleteEntry", false],
    ["postMessage", false],
    ["patchConfig", false],
  ])("isReadOnlyTool(%s) → false (write keyword)", (name) => {
    expect(isReadOnlyTool(name)).toBe(false);
  });

  it("returns false for names without read or write keywords", () => {
    expect(isReadOnlyTool("doSomething")).toBe(false);
  });

  it("write keyword takes precedence over read keyword", () => {
    // contains both "get" and "update"
    expect(isReadOnlyTool("getAndUpdateUser")).toBe(false);
  });
});

// ── runConcurrent ───────────────────────────────────────────────────────────

describe("runConcurrent", () => {
  it("runs all items and returns results in order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runConcurrent(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("returns empty array for empty input", async () => {
    const results = await runConcurrent([], 3, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it("throws when limit is 0", async () => {
    await expect(
      runConcurrent([1], 0, async (n) => n),
    ).rejects.toThrow(/limit must be a positive integer/);
  });

  it("throws when limit is negative", async () => {
    await expect(
      runConcurrent([1], -1, async (n) => n),
    ).rejects.toThrow(/limit must be a positive integer/);
  });

  it("propagates errors from worker functions", async () => {
    await expect(
      runConcurrent([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await runConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n;
    });
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("stops picking up new items when abort signal fires (B9)", async () => {
    const ac = new AbortController();
    let started = 0;
    const results = await runConcurrent([1, 2, 3, 4, 5], 1, async (n) => {
      started++;
      if (n === 2) ac.abort(); // abort after 2nd item
      await new Promise((r) => setTimeout(r, 5));
      return n;
    }, ac.signal);
    // Items 1–2 started; item 2 triggered abort; items 3–5 never started
    expect(started).toBeLessThanOrEqual(3); // at most item 3 may have started before check
    // Completed items are in results; un-started slots are undefined
    expect(results[0]).toBe(1);
    expect(results[1]).toBe(2);
  });
});
