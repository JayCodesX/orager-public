/**
 * Tests for the 3-layer memory polish gaps:
 *   Gap 2 — renderRetrievedBlock deterministic sort
 *   Gap 3 — MEMORY_LAYER* constants exported from loop-helpers
 *   Gap 4 — getEntriesForDistillation excludes high-value types
 *   Gap 5 — ingestionMode / ingestionInterval settings validation
 *   Gap 6 — remember tool inspect / reset actions + deleteCheckpointsByContextId
 */

import { describe, it, expect, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// ── Gap 3: Layer constants ───────────────────────────────────────────────────

import {
  MEMORY_LAYER1_MASTER_MAX_CHARS,
  MEMORY_LAYER2_RETRIEVED_MAX_CHARS,
  MEMORY_LAYER3_CHECKPOINT_MAX_CHARS,
} from "../src/loop-helpers.js";

describe("Gap 3 — per-layer memory budget constants", () => {
  it("Layer 1 master cap is 8000 chars", () => {
    expect(MEMORY_LAYER1_MASTER_MAX_CHARS).toBe(8_000);
  });

  it("Layer 2 retrieved cap is 16384 chars", () => {
    expect(MEMORY_LAYER2_RETRIEVED_MAX_CHARS).toBe(16_384);
  });

  it("Layer 3 checkpoint cap is 4000 chars", () => {
    expect(MEMORY_LAYER3_CHECKPOINT_MAX_CHARS).toBe(4_000);
  });

  it("Layer 1 < Layer 2 (retrieved is the largest budget)", () => {
    expect(MEMORY_LAYER1_MASTER_MAX_CHARS).toBeLessThan(MEMORY_LAYER2_RETRIEVED_MAX_CHARS);
  });
});

// ── Gap 2: Deterministic sort ────────────────────────────────────────────────

import { renderRetrievedBlock } from "../src/memory.js";
import type { MemoryEntry } from "../src/types.js";

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    content: "test content",
    tags: [],
    createdAt: new Date().toISOString(),
    importance: 2,
    ...overrides,
  };
}

describe("Gap 2 — renderRetrievedBlock deterministic sort", () => {
  const entries: MemoryEntry[] = [
    makeEntry({ id: "z-001", type: "risk",    content: "risk item" }),
    makeEntry({ id: "a-002", type: "insight", content: "insight item" }),
    makeEntry({ id: "m-003", type: "fact",    content: "fact item" }),
    makeEntry({ id: "a-001", type: "insight", content: "insight item 2" }),
  ];

  it("default (score) preserves input order", () => {
    const result = renderRetrievedBlock(entries);
    const lines = result.split("\n");
    // first entry in input = first line in output
    expect(lines[0]).toContain("risk item");
    expect(lines[1]).toContain("insight item");
  });

  it("deterministic sort orders by type then id", () => {
    const result = renderRetrievedBlock(entries, 6000, "deterministic");
    const lines = result.split("\n");
    // Expected order: fact(m-003), insight(a-001), insight(a-002), risk(z-001)
    expect(lines[0]).toContain("fact item");
    expect(lines[1]).toContain("insight item 2"); // a-001 before a-002
    expect(lines[2]).toContain("insight item");
    expect(lines[3]).toContain("risk item");
  });

  it("deterministic sort is stable across identical calls", () => {
    const r1 = renderRetrievedBlock(entries, 6000, "deterministic");
    const r2 = renderRetrievedBlock([...entries].reverse(), 6000, "deterministic");
    expect(r1).toBe(r2);
  });

  it("deterministic sort with no type uses empty string (sorts before typed entries)", () => {
    const noTypeEntry = makeEntry({ id: "a-000", content: "no type" });
    const mixed = [makeEntry({ id: "z-001", type: "fact", content: "fact" }), noTypeEntry];
    const result = renderRetrievedBlock(mixed, 6000, "deterministic");
    const lines = result.split("\n");
    // no-type ("") sorts before "fact"
    expect(lines[0]).toContain("no type");
    expect(lines[1]).toContain("fact");
  });

  it("respects maxChars truncation in deterministic mode", () => {
    const longEntries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `id-${String(i).padStart(3, "0")}`, content: "x".repeat(200) })
    );
    const result = renderRetrievedBlock(longEntries, 500, "deterministic");
    expect(result.length).toBeLessThanOrEqual(500);
  });
});

// ── Gap 4: Type-aware distillation ──────────────────────────────────────────

import { getEntriesForDistillation, addMemoryEntrySqlite, clearMemoryStoreSqlite, _resetDbForTesting } from "../src/memory-sqlite.js";

describe("Gap 4 — getEntriesForDistillation excludes high-value types", () => {
  const TEST_KEY = `test-distill-${Date.now()}`;

  beforeEach(async () => {
    _resetDbForTesting();
    await clearMemoryStoreSqlite(TEST_KEY);
  });

  async function addEntry(type: string, importance: 1 | 2 | 3 = 1) {
    await addMemoryEntrySqlite(TEST_KEY, {
      content: `entry of type ${type}`,
      tags: [],
      importance,
      type: type as MemoryEntry["type"],
    });
  }

  // Note: rowToEntry doesn't map the type column to MemoryEntry.type,
  // so we verify the filter by checking content strings (each entry has
  // content "entry of type <typename>") and row counts.

  it("includes distillable types (insight, fact) with importance < 3", async () => {
    await addEntry("insight", 1);
    await addEntry("fact", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    const contents = entries.map(e => e.content);
    expect(contents).toContain("entry of type insight");
    expect(contents).toContain("entry of type fact");
  });

  it("excludes master_context regardless of importance", async () => {
    await addEntry("master_context", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    expect(entries.some(e => e.content.includes("master_context"))).toBe(false);
  });

  it("excludes session_summary", async () => {
    await addEntry("session_summary", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    expect(entries.some(e => e.content.includes("session_summary"))).toBe(false);
  });

  it("excludes decision", async () => {
    await addEntry("decision", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    expect(entries.some(e => e.content.includes("entry of type decision"))).toBe(false);
  });

  it("excludes risk", async () => {
    await addEntry("risk", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    expect(entries.some(e => e.content.includes("entry of type risk"))).toBe(false);
  });

  it("excludes competitor", async () => {
    await addEntry("competitor", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    expect(entries.some(e => e.content.includes("entry of type competitor"))).toBe(false);
  });

  it("excludes open_question", async () => {
    await addEntry("open_question", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    expect(entries.some(e => e.content.includes("entry of type open_question"))).toBe(false);
  });

  it("still excludes importance=3 entries (existing behavior)", async () => {
    await addEntry("insight", 3);
    await addEntry("insight", 1); // this one should appear
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    // only the importance-1 insight should appear, not importance-3
    expect(entries).toHaveLength(1);
    expect(entries[0].importance).toBe(1);
  });

  it("mixes of protected and distillable types — only returns distillable", async () => {
    await addEntry("insight", 1);
    await addEntry("decision", 1);
    await addEntry("fact", 2);
    await addEntry("risk", 1);
    const entries = await getEntriesForDistillation(TEST_KEY, 100);
    const contents = entries.map(e => e.content);
    expect(contents).toContain("entry of type insight");
    expect(contents).toContain("entry of type fact");
    expect(contents.some(c => c.includes("decision"))).toBe(false);
    expect(contents.some(c => c.includes("risk"))).toBe(false);
  });
});

// ── Gap 5: ingestionMode / ingestionInterval settings ────────────────────────

import { validateSettings } from "../src/settings.js";

describe("Gap 5 — ingestionMode / ingestionInterval settings", () => {
  it("accepts ingestionMode='periodic'", () => {
    const { settings, warnings } = validateSettings({ memory: { ingestionMode: "periodic" } });
    expect(settings.memory?.ingestionMode).toBe("periodic");
    expect(warnings.filter(w => w.includes("ingestionMode"))).toHaveLength(0);
  });

  it("accepts ingestionMode='every_turn'", () => {
    const { settings } = validateSettings({ memory: { ingestionMode: "every_turn" } });
    expect(settings.memory?.ingestionMode).toBe("every_turn");
  });

  it("rejects invalid ingestionMode and emits warning", () => {
    const { settings, warnings } = validateSettings({ memory: { ingestionMode: "always" } });
    expect(settings.memory?.ingestionMode).toBeUndefined();
    expect(warnings.some(w => w.includes("ingestionMode"))).toBe(true);
  });

  it("accepts ingestionInterval as positive integer", () => {
    const { settings, warnings } = validateSettings({ memory: { ingestionInterval: 6 } });
    expect(settings.memory?.ingestionInterval).toBe(6);
    expect(warnings.filter(w => w.includes("ingestionInterval"))).toHaveLength(0);
  });

  it("rejects ingestionInterval=0 and emits warning", () => {
    const { settings, warnings } = validateSettings({ memory: { ingestionInterval: 0 } });
    expect(settings.memory?.ingestionInterval).toBeUndefined();
    expect(warnings.some(w => w.includes("ingestionInterval"))).toBe(true);
  });

  it("rejects negative ingestionInterval", () => {
    const { settings, warnings } = validateSettings({ memory: { ingestionInterval: -1 } });
    expect(settings.memory?.ingestionInterval).toBeUndefined();
    expect(warnings.some(w => w.includes("ingestionInterval"))).toBe(true);
  });
});

// ── Gap 6: deleteCheckpointsByContextId ─────────────────────────────────────

import { _resetStoreForTesting, saveSessionCheckpoint, deleteCheckpointsByContextId } from "../src/session.js";

describe("Gap 6 — deleteCheckpointsByContextId", () => {
  const DB_PATH = path.join(os.tmpdir(), `orager-cp-test-${Date.now()}.db`);

  beforeEach(() => {
    process.env["ORAGER_SESSIONS_DB_PATH"] = DB_PATH;
    _resetStoreForTesting();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  });

  it("returns 0 when no checkpoints exist for context", async () => {
    const deleted = await deleteCheckpointsByContextId("nonexistent-ctx");
    expect(deleted).toBe(0);
  });

  it("deletes checkpoints matching the context_id", async () => {
    await saveSessionCheckpoint("thread-1", "ctx-A", 5, "summary A", []);
    await saveSessionCheckpoint("thread-2", "ctx-A", 10, "summary A2", []);
    const deleted = await deleteCheckpointsByContextId("ctx-A");
    expect(deleted).toBe(2);
  });

  it("does not delete checkpoints for a different context", async () => {
    await saveSessionCheckpoint("thread-X", "ctx-keep", 1, "keep me", []);
    await saveSessionCheckpoint("thread-Y", "ctx-delete", 1, "delete me", []);
    await deleteCheckpointsByContextId("ctx-delete");
    // ctx-keep should still be loadable
    const { loadLatestCheckpointByContextId } = await import("../src/session.js");
    const cp = await loadLatestCheckpointByContextId("ctx-keep");
    expect(cp).not.toBeNull();
    expect(cp?.summary).toBe("keep me");
  });
});
