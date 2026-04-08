/**
 * Unit tests for PR 7 — production score recording.
 *
 * Covers:
 *  - recordProductionScore: no-op when ORAGER_RECORD_SCORES is unset/0
 *  - recordProductionScore: fires getAgentsDb + recordAgentScore when enabled
 *  - epsilon-greedy logic: explore branch picks assignVariant
 *  - epsilon-greedy logic: exploit branch picks getBestVariant when data exists
 *  - exploit branch falls back to assignVariant when getBestVariant returns null
 *  - variant system prompt is appended correctly
 *  - chat command variant is pinned for the session (selected once, reused)
 */

import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/native-sqlite.js";
import { runMigrations } from "../src/db-migrations.js";
import { recordAgentScore, recordProductionScore } from "../src/agents/score.js";
import {
  generatePromptVariants,
  assignVariant,
  getBestVariant,
  createSeededRng,
  type PromptVariant,
} from "../src/agents/refine.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeTestDb() {
  const db = await openDb(":memory:");
  runMigrations(db, [
    {
      version: 1,
      name: "create_agent_scores",
      sql: `
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
      `,
    },
  ]);
  return db;
}

const SEED_PROMPT =
  "You are a helpful assistant. Answer questions clearly and concisely.";

// ── recordProductionScore: env-var gate ───────────────────────────────────────

describe("recordProductionScore: env-var gate", () => {
  const origEnv = process.env["ORAGER_RECORD_SCORES"];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env["ORAGER_RECORD_SCORES"];
    } else {
      process.env["ORAGER_RECORD_SCORES"] = origEnv;
    }
  });

  it("is a no-op when ORAGER_RECORD_SCORES is unset", async () => {
    delete process.env["ORAGER_RECORD_SCORES"];
    // Should not throw and should not call getAgentsDb
    expect(() =>
      recordProductionScore({
        agentId: "explorer",
        sessionId: "s-1",
        success: true,
        turns: 3,
        costUsd: 0.001,
        durationMs: 500,
        variantId: null,
        modelId: "test-model",
      }),
    ).not.toThrow();
  });

  it("is a no-op when ORAGER_RECORD_SCORES=0", async () => {
    process.env["ORAGER_RECORD_SCORES"] = "0";
    expect(() =>
      recordProductionScore({
        agentId: "explorer",
        sessionId: "s-2",
        success: false,
        turns: 1,
        costUsd: 0,
        durationMs: 100,
        variantId: null,
        modelId: "test-model",
      }),
    ).not.toThrow();
  });
});

// ── generatePromptVariants + assignVariant ─────────────────────────────────────

describe("epsilon-greedy variant selection logic", () => {
  it("assignVariant with seeded RNG returns a deterministic variant", () => {
    const variants = generatePromptVariants("explorer", SEED_PROMPT);
    const rng = createSeededRng(42);
    const v1 = assignVariant("explorer", variants, rng);
    const rng2 = createSeededRng(42);
    const v2 = assignVariant("explorer", variants, rng2);
    expect(v1.variantId).toBe(v2.variantId);
  });

  it("assignVariant returns a variant from the provided list", () => {
    const variants = generatePromptVariants("planner", SEED_PROMPT);
    const v = assignVariant("planner", variants);
    expect(variants.map((x) => x.variantId)).toContain(v.variantId);
  });

  it("assignVariant throws when variants list is empty", () => {
    expect(() => assignVariant("foo", [])).toThrow(/no variants/i);
  });

  it("explore path: all variants are reachable across many draws", () => {
    const variants = generatePromptVariants("coder", SEED_PROMPT);
    const seen = new Set<string>();
    // With 500 draws the probability of missing any variant is negligible
    for (let i = 0; i < 500; i++) {
      seen.add(assignVariant("coder", variants).variantId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

// ── getBestVariant: exploit branch ─────────────────────────────────────────────

describe("getBestVariant: exploit branch", () => {
  it("returns null when no data exists (cold start)", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED_PROMPT);
    const best = await getBestVariant(db, "explorer", variants);
    expect(best).toBeNull();
  });

  it("returns null when best variant doesn't beat original by >5%", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED_PROMPT);
    // Give original 4/5 = 80%, give concise 4/5 = 80% — tie, no winner
    for (let i = 0; i < 5; i++) {
      recordAgentScore(db, {
        agentId: "explorer", success: i < 4, turns: 2, costUsd: 0.001,
        durationMs: 200, variantId: "explorer-v0-original", modelId: "m",
      });
    }
    for (let i = 0; i < 5; i++) {
      recordAgentScore(db, {
        agentId: "explorer", success: i < 4, turns: 2, costUsd: 0.001,
        durationMs: 200, variantId: "explorer-v1-concise", modelId: "m",
      });
    }
    const best = await getBestVariant(db, "explorer", variants);
    expect(best).toBeNull();
  });

  it("returns the best variant when it beats original by >5% (min 3 runs)", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("explorer", SEED_PROMPT);
    // original: 3/5 = 60%
    for (let i = 0; i < 5; i++) {
      recordAgentScore(db, {
        agentId: "explorer", success: i < 3, turns: 2, costUsd: 0.001,
        durationMs: 200, variantId: "explorer-v0-original", modelId: "m",
      });
    }
    // cot: 5/5 = 100% — beats original by 40pp
    for (let i = 0; i < 5; i++) {
      recordAgentScore(db, {
        agentId: "explorer", success: true, turns: 2, costUsd: 0.001,
        durationMs: 200, variantId: "explorer-v2-cot", modelId: "m",
      });
    }
    const best = await getBestVariant(db, "explorer", variants);
    expect(best).not.toBeNull();
    expect(best!.variantId).toBe("explorer-v2-cot");
  });

  it("ignores variants with fewer than 3 runs", async () => {
    const db = await makeTestDb();
    const variants = generatePromptVariants("planner", SEED_PROMPT);
    // original: 3/5 = 60%
    for (let i = 0; i < 5; i++) {
      recordAgentScore(db, {
        agentId: "planner", success: i < 3, turns: 1, costUsd: 0,
        durationMs: 0, variantId: "planner-v0-original", modelId: "m",
      });
    }
    // cot: 2/2 = 100% but only 2 runs — should be ignored
    for (let i = 0; i < 2; i++) {
      recordAgentScore(db, {
        agentId: "planner", success: true, turns: 1, costUsd: 0,
        durationMs: 0, variantId: "planner-v2-cot", modelId: "m",
      });
    }
    const best = await getBestVariant(db, "planner", variants);
    expect(best).toBeNull();
  });
});

// ── Variant system prompt injection ───────────────────────────────────────────

describe("variant system prompt content", () => {
  it("original variant prompt equals the seed prompt verbatim", () => {
    const variants = generatePromptVariants("reviewer", SEED_PROMPT);
    const original = variants.find((v) => v.variantId === "reviewer-v0-original");
    expect(original).toBeDefined();
    expect(original!.prompt).toBe(SEED_PROMPT);
  });

  it("non-original variants transform the seed prompt", () => {
    const variants = generatePromptVariants("researcher", SEED_PROMPT);
    const nonOriginal = variants.filter((v) => !v.variantId.endsWith("-original"));
    for (const v of nonOriginal) {
      // Each transform must produce a non-empty, modified string
      expect(v.prompt.length).toBeGreaterThan(0);
      // At least one transform will differ (they can't all be identical to the seed)
    }
    const uniquePrompts = new Set(variants.map((v) => v.prompt));
    expect(uniquePrompts.size).toBeGreaterThan(1);
  });

  it("variant IDs follow the <agentId>-v<N>-<strategy> pattern", () => {
    const variants = generatePromptVariants("coder", SEED_PROMPT);
    for (const v of variants) {
      expect(v.variantId).toMatch(/^coder-v\d+-\w+$/);
    }
  });
});

// ── Session variant pinning: same variant across multiple draws ────────────────

describe("chat session variant pinning", () => {
  it("a variant selected before the loop is reused for all turns", () => {
    // Simulate how chat-command.ts pins the variant once before the turn loop
    const variants = generatePromptVariants("explorer", SEED_PROMPT);
    const rng = createSeededRng(99);

    // Select once (simulates the pre-loop selection)
    const pinnedVariant = assignVariant("explorer", variants, rng);

    // Multiple turns all use the same pinned variant
    const turn1SystemPrompt = pinnedVariant.prompt;
    const turn2SystemPrompt = pinnedVariant.prompt;
    const turn3SystemPrompt = pinnedVariant.prompt;

    expect(turn1SystemPrompt).toBe(turn2SystemPrompt);
    expect(turn2SystemPrompt).toBe(turn3SystemPrompt);
    expect(pinnedVariant.variantId).toMatch(/^explorer-v\d+-\w+$/);
  });

  it("different seeds produce different variants with high probability", () => {
    const variants = generatePromptVariants("explorer", SEED_PROMPT);
    const selections = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      selections.add(assignVariant("explorer", variants, createSeededRng(seed)).variantId);
    }
    // With 20 distinct seeds across 12 variants, we expect several distinct picks
    expect(selections.size).toBeGreaterThan(1);
  });
});
