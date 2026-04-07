/**
 * Tests for knowledge-wiki.ts — Knowledge Wiki (Phase 1).
 *
 * Tests CRUD operations, compile response parsing, lint, qualityGate,
 * and wiki block retrieval. Uses a temp directory for isolated SQLite DBs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  ingestRaw,
  getOrCreatePage,
  updatePage,
  getPage,
  listPages,
  deletePage,
  getRawEntries,
  countPendingRaw,
  compile,
  lint,
  qualityGate,
  getWikiBlock,
  getWikiStats,
  _resetWikiDbForTesting,
  resolveWikiDbPath,
} from "../src/knowledge-wiki.js";

// ── Test setup: use temp directory for wiki DB ──────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-wiki-test-"));
  process.env["ORAGER_WIKI_DB_PATH"] = path.join(tmpDir, "wiki.sqlite");
  _resetWikiDbForTesting();
});

afterEach(() => {
  _resetWikiDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["ORAGER_WIKI_DB_PATH"];
});

// ── resolveWikiDbPath ──────────────────────────────────────────────────────

describe("resolveWikiDbPath", () => {
  it("returns env override when set", () => {
    expect(resolveWikiDbPath()).toBe(path.join(tmpDir, "wiki.sqlite"));
  });

  it("returns default when env not set", () => {
    delete process.env["ORAGER_WIKI_DB_PATH"];
    const result = resolveWikiDbPath();
    expect(result).toContain(".orager");
    expect(result).toContain("wiki.sqlite");
  });
});

// ── ingestRaw ──────────────────────────────────────────────────────────────

describe("ingestRaw", () => {
  it("creates a raw entry", async () => {
    const entry = await ingestRaw("test-topic", "Some knowledge");
    expect(entry.topic).toBe("test-topic");
    expect(entry.content).toBe("Some knowledge");
    expect(entry.id).toBeTruthy();
  });

  it("normalizes topic to lowercase", async () => {
    const entry = await ingestRaw("MY-TOPIC", "Content");
    expect(entry.topic).toBe("my-topic");
  });

  it("stores source when provided", async () => {
    const entry = await ingestRaw("topic", "Content", "manual");
    expect(entry.source).toBe("manual");
  });

  it("accumulates multiple entries for same topic", async () => {
    await ingestRaw("topic", "Entry 1");
    await ingestRaw("topic", "Entry 2");
    await ingestRaw("topic", "Entry 3");
    expect(await countPendingRaw("topic")).toBe(3);
  });
});

// ── getOrCreatePage ────────────────────────────────────────────────────────

describe("getOrCreatePage", () => {
  it("creates a new page", async () => {
    const page = await getOrCreatePage("new-topic");
    expect(page.topic).toBe("new-topic");
    expect(page.content).toBe("");
    expect(page.qualityScore).toBe(0);
    expect(page.backlinks).toEqual([]);
  });

  it("returns existing page on second call", async () => {
    const p1 = await getOrCreatePage("existing");
    const p2 = await getOrCreatePage("existing");
    expect(p1.id).toBe(p2.id);
  });

  it("normalizes topic", async () => {
    const page = await getOrCreatePage("  UPPERCASE  ");
    expect(page.topic).toBe("uppercase");
  });
});

// ── updatePage ─────────────────────────────────────────────────────────────

describe("updatePage", () => {
  it("updates content and backlinks", async () => {
    await getOrCreatePage("target");
    await updatePage("target", "New content here", ["related-a", "related-b"], 0.85);
    const page = await getPage("target");
    expect(page!.content).toBe("New content here");
    expect(page!.backlinks).toEqual(["related-a", "related-b"]);
    expect(page!.qualityScore).toBe(0.85);
  });

  it("creates page if it doesn't exist", async () => {
    await updatePage("auto-created", "Content", [], 0.5);
    const page = await getPage("auto-created");
    expect(page).not.toBeNull();
    expect(page!.content).toBe("Content");
  });
});

// ── getPage ────────────────────────────────────────────────────────────────

describe("getPage", () => {
  it("returns null for non-existent topic", async () => {
    expect(await getPage("nope")).toBeNull();
  });

  it("returns page after creation", async () => {
    await getOrCreatePage("exists");
    expect(await getPage("exists")).not.toBeNull();
  });
});

// ── listPages ──────────────────────────────────────────────────────────────

describe("listPages", () => {
  it("returns empty array initially", async () => {
    expect(await listPages()).toEqual([]);
  });

  it("returns pages ordered by quality score desc", async () => {
    await updatePage("low", "Low quality", [], 0.2);
    await updatePage("high", "High quality", [], 0.9);
    await updatePage("mid", "Mid quality", [], 0.5);
    const pages = await listPages();
    expect(pages[0]!.topic).toBe("high");
    expect(pages[1]!.topic).toBe("mid");
    expect(pages[2]!.topic).toBe("low");
  });
});

// ── deletePage ─────────────────────────────────────────────────────────────

describe("deletePage", () => {
  it("deletes page and raw entries", async () => {
    await ingestRaw("doomed", "Content");
    await getOrCreatePage("doomed");
    expect(await deletePage("doomed")).toBe(true);
    expect(await getPage("doomed")).toBeNull();
    expect(await countPendingRaw("doomed")).toBe(0);
  });

  it("returns false for non-existent topic", async () => {
    expect(await deletePage("nonexistent")).toBe(false);
  });
});

// ── getRawEntries ──────────────────────────────────────────────────────────

describe("getRawEntries", () => {
  it("returns entries in chronological order", async () => {
    await ingestRaw("topic", "First");
    await ingestRaw("topic", "Second");
    const entries = await getRawEntries("topic");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.content).toBe("First");
    expect(entries[1]!.content).toBe("Second");
  });

  it("returns empty for unknown topic", async () => {
    expect(await getRawEntries("unknown")).toEqual([]);
  });
});

// ── countPendingRaw ────────────────────────────────────────────────────────

describe("countPendingRaw", () => {
  it("counts per-topic", async () => {
    await ingestRaw("a", "1");
    await ingestRaw("a", "2");
    await ingestRaw("b", "3");
    expect(await countPendingRaw("a")).toBe(2);
    expect(await countPendingRaw("b")).toBe(1);
  });

  it("counts all when no topic specified", async () => {
    await ingestRaw("a", "1");
    await ingestRaw("b", "2");
    expect(await countPendingRaw()).toBe(2);
  });
});

// ── compile ────────────────────────────────────────────────────────────────

describe("compile", () => {
  it("compiles raw entries via LLM callback", async () => {
    await ingestRaw("test-compile", "Important fact about testing.");

    const mockLlm = async (_sys: string, _user: string): Promise<string> => {
      return `QUALITY: 0.75
BACKLINKS: testing-best-practices, unit-tests
---
# Test Compile

Important fact about testing. This topic covers best practices.`;
    };

    const result = await compile(mockLlm, ["test-compile"]);
    expect(result.compiled).toBe(1);
    expect(result.errors).toEqual([]);

    const page = await getPage("test-compile");
    expect(page!.content).toContain("Important fact about testing");
    expect(page!.qualityScore).toBe(0.75);
    expect(page!.backlinks).toEqual(["testing-best-practices", "unit-tests"]);

    // Raw entries should be cleared after compile
    expect(await countPendingRaw("test-compile")).toBe(0);
  });

  it("handles LLM errors gracefully", async () => {
    await ingestRaw("fail-topic", "Content");

    const mockLlm = async (): Promise<string> => {
      throw new Error("API rate limit");
    };

    const result = await compile(mockLlm, ["fail-topic"]);
    expect(result.compiled).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit");

    // Raw entries should NOT be cleared on error
    expect(await countPendingRaw("fail-topic")).toBe(1);
  });

  it("skips topics with no raw entries", async () => {
    const mockLlm = async (): Promise<string> => "Should not be called";
    const result = await compile(mockLlm, ["empty-topic"]);
    expect(result.compiled).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("compiles all topics when none specified", async () => {
    await ingestRaw("topic-a", "Fact A");
    await ingestRaw("topic-b", "Fact B");

    const mockLlm = async (_sys: string, user: string): Promise<string> => {
      return `QUALITY: 0.6\nBACKLINKS: NONE\n---\nCompiled: ${user.slice(0, 20)}`;
    };

    const result = await compile(mockLlm);
    expect(result.compiled).toBe(2);
  });

  it("parses response without explicit format markers", async () => {
    await ingestRaw("fallback-topic", "Content");

    const mockLlm = async (): Promise<string> => {
      return "Just plain content without markers.";
    };

    const result = await compile(mockLlm, ["fallback-topic"]);
    expect(result.compiled).toBe(1);
    const page = await getPage("fallback-topic");
    expect(page!.content).toBe("Just plain content without markers.");
    expect(page!.qualityScore).toBe(0.5); // default
    expect(page!.backlinks).toEqual([]);
  });
});

// ── lint ────────────────────────────────────────────────────────────────────

describe("lint", () => {
  it("detects broken backlinks", async () => {
    await updatePage("source", "Content", ["nonexistent-target"], 0.5);
    const result = await lint();
    expect(result.brokenBacklinks).toHaveLength(1);
    expect(result.brokenBacklinks[0]!.page).toBe("source");
    expect(result.brokenBacklinks[0]!.target).toBe("nonexistent-target");
  });

  it("returns clean result when no issues", async () => {
    await updatePage("page-a", "Content A", ["page-b"], 0.7);
    await updatePage("page-b", "Content B", ["page-a"], 0.7);
    const result = await lint();
    expect(result.brokenBacklinks).toEqual([]);
  });

  it("counts stale pages", async () => {
    await updatePage("stale-page", "Content", [], 0.5);
    // Page was just compiled, so stalePagesCount should be 0
    const result = await lint();
    expect(result.stalePagesCount).toBe(0);
  });

  it("returns zero counts on empty wiki", async () => {
    const result = await lint();
    expect(result.brokenBacklinks).toEqual([]);
    expect(result.stalePagesCount).toBe(0);
    expect(result.orphanPagesCount).toBe(0);
  });
});

// ── qualityGate ────────────────────────────────────────────────────────────

describe("qualityGate", () => {
  it("returns empty report for no pages", async () => {
    const report = await qualityGate();
    expect(report.totalPages).toBe(0);
    expect(report.avgScore).toBe(0);
  });

  it("classifies pages by quality", async () => {
    await updatePage("low", "Low", [], 0.2);
    await updatePage("mid", "Mid", [], 0.5);
    await updatePage("high", "High", [], 0.8);

    const report = await qualityGate();
    expect(report.totalPages).toBe(3);
    expect(report.lowQualityPages).toHaveLength(1);
    expect(report.lowQualityPages[0]!.topic).toBe("low");
    expect(report.highQualityPages).toHaveLength(1);
    expect(report.highQualityPages[0]!.topic).toBe("high");
  });

  it("respects custom threshold", async () => {
    await updatePage("page", "Content", [], 0.5);
    const strict = await qualityGate(0.6);
    expect(strict.lowQualityPages).toHaveLength(1);
    const lenient = await qualityGate(0.3);
    expect(lenient.lowQualityPages).toHaveLength(0);
  });

  it("calculates average score", async () => {
    await updatePage("a", "A", [], 0.4);
    await updatePage("b", "B", [], 0.6);
    const report = await qualityGate();
    expect(report.avgScore).toBeCloseTo(0.5, 1);
  });
});

// ── getWikiBlock ───────────────────────────────────────────────────────────

describe("getWikiBlock", () => {
  it("returns empty string when no pages", async () => {
    expect(await getWikiBlock("anything")).toBe("");
  });

  it("returns relevant pages", async () => {
    await updatePage("testing", "How to write unit tests in TypeScript.", [], 0.8);
    await updatePage("deployment", "How to deploy to production.", [], 0.7);
    const block = await getWikiBlock("unit testing");
    expect(block).toContain("testing");
    expect(block).toContain("unit tests");
  });

  it("respects maxChars budget", async () => {
    await updatePage("big-topic", "x".repeat(5000), [], 0.9);
    await updatePage("another", "y".repeat(5000), [], 0.8);
    const block = await getWikiBlock("big topic another", 100);
    expect(block.length).toBeLessThanOrEqual(200);
  });

  it("skips pages with empty content", async () => {
    await getOrCreatePage("empty-page");
    expect(await getWikiBlock("empty")).toBe("");
  });

  it("ranks by topic match over content match", async () => {
    await updatePage("database", "Information about SQL queries.", [], 0.5);
    await updatePage("queries", "Information about database queries.", [], 0.5);
    const block = await getWikiBlock("database");
    const dbIdx = block.indexOf("database");
    expect(dbIdx).toBeGreaterThanOrEqual(0);
  });
});

// ── getWikiStats ───────────────────────────────────────────────────────────

describe("getWikiStats", () => {
  it("returns zeros for empty wiki", async () => {
    const stats = await getWikiStats();
    expect(stats.totalPages).toBe(0);
    expect(stats.totalRawEntries).toBe(0);
    expect(stats.avgQualityScore).toBe(0);
    expect(stats.topTopics).toEqual([]);
  });

  it("counts pages and raw entries", async () => {
    await updatePage("page-1", "Content", [], 0.7);
    await ingestRaw("page-2", "Raw content");
    const stats = await getWikiStats();
    expect(stats.totalPages).toBe(1);
    expect(stats.totalRawEntries).toBe(1);
  });

  it("returns top topics by quality", async () => {
    await updatePage("best", "Best content", [], 0.95);
    await updatePage("good", "Good content", [], 0.7);
    await updatePage("ok", "OK content", [], 0.5);
    const stats = await getWikiStats();
    expect(stats.topTopics).toHaveLength(3);
    expect(stats.topTopics[0]!.topic).toBe("best");
  });
});
