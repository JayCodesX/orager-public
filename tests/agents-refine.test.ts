/**
 * Unit tests for src/agents/refine.ts — prompt variant generation and
 * A/B feedback loop. No API calls. DB tests use in-memory SQLite.
 */

import { describe, it, expect } from "bun:test";
import { openDb } from "../src/native-sqlite.js";
import { runMigrations } from "../src/db-migrations.js";
import { recordAgentScore, getVariantStats } from "../src/agents/score.js";
import {
  generatePromptVariants,
  assignVariant,
  createSeededRng,
  getBestVariant,
  serializeVariant,
  deserializeVariant,
  type PromptVariant,
  type VariantStrategy,
} from "../src/agents/refine.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTestDb() {
  const db = await openDb(":memory:");
  runMigrations(db, [
    {
      version: 1,
      name: "create_agents_table_with_variant_id",
      sql: `
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, name TEXT, definition TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'db',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL, session_id TEXT,
          success INTEGER NOT NULL DEFAULT 1, turns INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
          variant_id TEXT, model_id TEXT,
          judge_score REAL, judge_pass INTEGER,
          recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_scores_agent_id ON agent_scores(agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_scores_recorded_at ON agent_scores(recorded_at);
      `,
    },
  ]);
  return db;
}

const SEED = "You are a helpful code reviewer. Review the provided code for bugs and style issues. Do not add new features. Only report what you find.";

// ── generatePromptVariants ────────────────────────────────────────────────────

describe("generatePromptVariants", () => {
  it("returns N+1 variants (original + N strategies)", () => {
    const strategies: VariantStrategy[] = [
      "concise",
      "chain_of_thought",
      "role_emphasis",
      "output_format",
      "constraint_relax",
      "examples",
    ];
    const variants = generatePromptVariants("reviewer", SEED, strategies);
    expect(variants).toHaveLength(strategies.length + 1); // +1 for original
  });

  it("with no strategies arg returns all 12 variants (original + 11)", () => {
    const variants = generatePromptVariants("reviewer", SEED);
    expect(variants).toHaveLength(12);
  });

  it("original strategy returns the prompt unchanged", () => {
    const variants = generatePromptVariants("reviewer", SEED, []);
    expect(variants).toHaveLength(1);
    expect(variants[0].strategy).toBe("original");
    expect(variants[0].prompt).toBe(SEED);
    expect(variants[0].variantId).toBe("reviewer-v0-original");
    expect(variants[0].parentVariantId).toBeNull();
  });

  it("chain_of_thought strategy prepends the thinking instruction", () => {
    const variants = generatePromptVariants("agent", SEED, ["chain_of_thought"]);
    const cot = variants.find((v) => v.strategy === "chain_of_thought")!;
    expect(cot).toBeDefined();
    expect(cot.prompt.startsWith("Before responding, think through the problem step by step.")).toBe(true);
    expect(cot.variantId).toBe("agent-v2-cot");
  });

  it("output_format strategy appends the structure instruction", () => {
    const variants = generatePromptVariants("agent", SEED, ["output_format"]);
    const fmt = variants.find((v) => v.strategy === "output_format")!;
    expect(fmt).toBeDefined();
    expect(fmt.prompt).toContain("Structure your response with: 1) a one-line summary");
    expect(fmt.prompt).toContain("confidence level (high/medium/low)");
    expect(fmt.variantId).toBe("agent-v4-format");
  });

  it("concise strategy result is shorter than input", () => {
    const prompt = "Please review this code carefully. Note that it is important. Your job is to find all issues. Always remember to be thorough.";
    const variants = generatePromptVariants("agent", prompt, ["concise"]);
    const concise = variants.find((v) => v.strategy === "concise")!;
    expect(concise).toBeDefined();
    expect(concise.prompt.length).toBeLessThan(prompt.length);
  });

  it("role_emphasis strategy prepends expert phrase to first sentence", () => {
    const variants = generatePromptVariants("agent", SEED, ["role_emphasis"]);
    const role = variants.find((v) => v.strategy === "role_emphasis")!;
    expect(role).toBeDefined();
    expect(role.prompt).toContain("You are a world-class expert");
    expect(role.variantId).toBe("agent-v3-role");
  });

  it("constraint_relax strategy appends qualifier to Do not / Only lines", () => {
    const variants = generatePromptVariants("agent", SEED, ["constraint_relax"]);
    const relaxed = variants.find((v) => v.strategy === "constraint_relax")!;
    expect(relaxed).toBeDefined();
    expect(relaxed.prompt).toContain("unless strictly necessary");
  });

  it("examples strategy appends the one-shot example block", () => {
    const variants = generatePromptVariants("agent", SEED, ["examples"]);
    const ex = variants.find((v) => v.strategy === "examples")!;
    expect(ex).toBeDefined();
    expect(ex.prompt).toContain("Example of good output:");
    expect(ex.prompt).toContain("recordAgentScore");
    expect(ex.variantId).toBe("agent-v6-examples");
  });

  it("each variant has the correct agentId", () => {
    const variants = generatePromptVariants("mybot", SEED);
    for (const v of variants) {
      expect(v.agentId).toBe("mybot");
    }
  });
});

// ── assignVariant ─────────────────────────────────────────────────────────────

describe("assignVariant", () => {
  it("with seeded RNG is deterministic (same seed = same choice)", () => {
    const variants = generatePromptVariants("agent", SEED);
    const rng1 = createSeededRng(42);
    const rng2 = createSeededRng(42);
    const choice1 = assignVariant("agent", variants, rng1);
    const choice2 = assignVariant("agent", variants, rng2);
    expect(choice1.variantId).toBe(choice2.variantId);
  });

  it("different seeds may produce different choices", () => {
    const variants = generatePromptVariants("agent", SEED);
    // With 7 variants and different seeds, we expect different results eventually
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      seen.add(assignVariant("agent", variants, createSeededRng(seed)).variantId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("returns a variant from the provided list", () => {
    const variants = generatePromptVariants("agent", SEED);
    for (let i = 0; i < 20; i++) {
      const choice = assignVariant("agent", variants, createSeededRng(i));
      expect(variants.some((v) => v.variantId === choice.variantId)).toBe(true);
    }
  });

  it("throws when variants list is empty", () => {
    expect(() => assignVariant("agent", [], createSeededRng(1))).toThrow();
  });
});

// ── getBestVariant ────────────────────────────────────────────────────────────

describe("getBestVariant", () => {
  it("returns null when no variant data exists", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED);
    const best = await getBestVariant(db, "explorer", variants);
    expect(best).toBeNull();
  });

  it("returns null when fewer than 3 runs per variant", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED);
    const cotVariant = variants.find((v) => v.strategy === "chain_of_thought")!;

    // Only 2 successful runs for cot variant
    for (let i = 0; i < 2; i++) {
      recordAgentScore(db, {
        agentId: "explorer",
        success: true,
        turns: 3,
        costUsd: 0.01,
        durationMs: 1000,
        variantId: cotVariant.variantId,
      });
    }

    const best = await getBestVariant(db, "explorer", variants);
    expect(best).toBeNull();
  });

  it("returns null when best variant does not beat original by >5%", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED);
    const originalVariant = variants.find((v) => v.strategy === "original")!;
    const cotVariant = variants.find((v) => v.strategy === "chain_of_thought")!;

    // Original: 3 runs, 100% success
    for (let i = 0; i < 3; i++) {
      recordAgentScore(db, {
        agentId: "explorer",
        success: true,
        turns: 3,
        costUsd: 0.01,
        durationMs: 1000,
        variantId: originalVariant.variantId,
      });
    }

    // CoT: 3 runs, same 100% success (no improvement > 5%)
    for (let i = 0; i < 3; i++) {
      recordAgentScore(db, {
        agentId: "explorer",
        success: true,
        turns: 3,
        costUsd: 0.01,
        durationMs: 1000,
        variantId: cotVariant.variantId,
      });
    }

    const best = await getBestVariant(db, "explorer", variants);
    expect(best).toBeNull();
  });

  it("returns winner when one variant has >5% better success rate than original", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED);
    const originalVariant = variants.find((v) => v.strategy === "original")!;
    const formatVariant = variants.find((v) => v.strategy === "output_format")!;

    // Original: 5 runs, 40% success — meets PROMOTION_MIN_RUNS threshold
    for (let i = 0; i < 2; i++)
      recordAgentScore(db, { agentId: "explorer", success: true, turns: 3, costUsd: 0.01, durationMs: 1000, variantId: originalVariant.variantId });
    for (let i = 0; i < 3; i++)
      recordAgentScore(db, { agentId: "explorer", success: false, turns: 3, costUsd: 0.01, durationMs: 1000, variantId: originalVariant.variantId });

    // format: 5 runs, 100% success (well above 50% + 5%)
    for (let i = 0; i < 5; i++) {
      recordAgentScore(db, {
        agentId: "explorer",
        success: true,
        turns: 3,
        costUsd: 0.01,
        durationMs: 1000,
        variantId: formatVariant.variantId,
      });
    }

    const best = await getBestVariant(db, "explorer", variants);
    expect(best).not.toBeNull();
    expect(best!.variantId).toBe(formatVariant.variantId);
    expect(best!.strategy).toBe("output_format");
  });
});

// ── serializeVariant / deserializeVariant ─────────────────────────────────────

describe("serializeVariant / deserializeVariant", () => {
  it("round-trips a PromptVariant", () => {
    const variants = generatePromptVariants("coder", SEED);
    for (const v of variants) {
      const serialized = serializeVariant(v);
      const deserialized = deserializeVariant(serialized);
      expect(deserialized.variantId).toBe(v.variantId);
      expect(deserialized.agentId).toBe(v.agentId);
      expect(deserialized.prompt).toBe(v.prompt);
      expect(deserialized.strategy).toBe(v.strategy);
      expect(deserialized.parentVariantId).toBe(v.parentVariantId);
    }
  });

  it("throws on missing required fields", () => {
    expect(() =>
      deserializeVariant(JSON.stringify({ variantId: "x", agentId: "y" })),
    ).toThrow();
  });

  it("throws on invalid JSON", () => {
    expect(() => deserializeVariant("not-json")).toThrow();
  });
});

// ── getVariantStats ───────────────────────────────────────────────────────────

describe("getVariantStats", () => {
  it("returns empty array when no variant data exists", async () => {
    const db = await makeTestDb();
    const stats = getVariantStats(db, "unknown-agent");
    expect(stats).toEqual([]);
  });

  it("returns empty array when scores exist but no variant_id is set", async () => {
    const db = await makeTestDb();
    // Record scores without variant_id
    recordAgentScore(db, { agentId: "agent", success: true, turns: 3, costUsd: 0.01, durationMs: 500 });
    recordAgentScore(db, { agentId: "agent", success: false, turns: 2, costUsd: 0.005, durationMs: 300 });
    const stats = getVariantStats(db, "agent");
    expect(stats).toEqual([]);
  });

  it("returns correct stats when variant scores exist", async () => {
    const db = await makeTestDb();
    const agentId = "tester";

    // v0-original: 4 runs, 3 successes = 75% success rate
    recordAgentScore(db, { agentId, success: true, turns: 2, costUsd: 0.01, durationMs: 100, variantId: `${agentId}-v0-original` });
    recordAgentScore(db, { agentId, success: true, turns: 4, costUsd: 0.02, durationMs: 200, variantId: `${agentId}-v0-original` });
    recordAgentScore(db, { agentId, success: true, turns: 6, costUsd: 0.03, durationMs: 300, variantId: `${agentId}-v0-original` });
    recordAgentScore(db, { agentId, success: false, turns: 1, costUsd: 0.005, durationMs: 50, variantId: `${agentId}-v0-original` });

    // v2-cot: 3 runs, 2 successes = 66.67% success rate
    recordAgentScore(db, { agentId, success: true, turns: 3, costUsd: 0.015, durationMs: 150, variantId: `${agentId}-v2-cot` });
    recordAgentScore(db, { agentId, success: true, turns: 5, costUsd: 0.025, durationMs: 250, variantId: `${agentId}-v2-cot` });
    recordAgentScore(db, { agentId, success: false, turns: 2, costUsd: 0.01, durationMs: 100, variantId: `${agentId}-v2-cot` });

    const stats = getVariantStats(db, agentId);
    expect(stats).toHaveLength(2);

    // Ordered by success rate DESC — original (0.75) first
    const originalStat = stats.find((s) => s.variantId === `${agentId}-v0-original`)!;
    expect(originalStat).toBeDefined();
    expect(originalStat.runs).toBe(4);
    expect(originalStat.successRate).toBe(0.75);

    const cotStat = stats.find((s) => s.variantId === `${agentId}-v2-cot`)!;
    expect(cotStat).toBeDefined();
    expect(cotStat.runs).toBe(3);
    // 2/3 ≈ 0.67
    expect(cotStat.successRate).toBeGreaterThan(0.6);
    expect(cotStat.successRate).toBeLessThan(0.7);
  });

  it("stats are ordered by success rate descending", async () => {
    const db = await makeTestDb();
    const agentId = "planner";

    // variant-a: 4 runs, 1 success = 25%
    for (let i = 0; i < 4; i++) {
      recordAgentScore(db, { agentId, success: i === 0, turns: 1, costUsd: 0.01, durationMs: 100, variantId: "variant-a" });
    }
    // variant-b: 4 runs, 4 successes = 100%
    for (let i = 0; i < 4; i++) {
      recordAgentScore(db, { agentId, success: true, turns: 1, costUsd: 0.01, durationMs: 100, variantId: "variant-b" });
    }
    // variant-c: 4 runs, 2 successes = 50%
    for (let i = 0; i < 4; i++) {
      recordAgentScore(db, { agentId, success: i < 2, turns: 1, costUsd: 0.01, durationMs: 100, variantId: "variant-c" });
    }

    const stats = getVariantStats(db, agentId);
    expect(stats[0].variantId).toBe("variant-b"); // 100%
    expect(stats[1].variantId).toBe("variant-c"); // 50%
    expect(stats[2].variantId).toBe("variant-a"); // 25%
  });
});
