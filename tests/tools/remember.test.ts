/**
 * Tests for src/tools/remember.ts (makeRememberTool)
 *
 * Uses the SQLite memory path (ORAGER_MEMORY_SQLITE_DIR points to a temp dir).
 * Tests input validation, add/list/remove roundtrip, set_master/view_master,
 * content truncation, importance, reset, and unknown actions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── SQLite setup ───────────────────────────────────────────────────────────────
// Must mirror the pattern from tests/memory-sqlite.test.ts:
// set ORAGER_MEMORY_SQLITE_DIR → temp dir, reset singleton between tests.

let _testMemDir: string;
let _savedMemDir: string | undefined;

async function resetSqlite() {
  const mod = await import("../../src/memory-sqlite.js");
  mod._resetDbForTesting();
}

beforeEach(() => {
  _savedMemDir = process.env["ORAGER_MEMORY_SQLITE_DIR"];
  _testMemDir = path.join(os.tmpdir(), `orager-remember-test-${randomUUID()}`);
  fs.mkdirSync(_testMemDir, { recursive: true });
  process.env["ORAGER_MEMORY_SQLITE_DIR"] = _testMemDir;
});

afterEach(async () => {
  await resetSqlite();
  delete process.env["ORAGER_DB_PATH"];
  if (_savedMemDir !== undefined) process.env["ORAGER_MEMORY_SQLITE_DIR"] = _savedMemDir;
  else delete process.env["ORAGER_MEMORY_SQLITE_DIR"];
  fs.rmSync(_testMemDir, { recursive: true, force: true });
});

// ── factory helper ─────────────────────────────────────────────────────────────

async function makeTool(key = `test-${randomUUID()}`) {
  const { makeRememberTool } = await import("../../src/tools/remember.js");
  return { tool: makeRememberTool(key), key };
}

// ── Input validation ───────────────────────────────────────────────────────────

describe("remember — input validation", () => {
  it("returns error when action is missing", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/action is required/);
  });

  it("returns error for an unknown action", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "teleport" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unknown action/);
  });

  it("action=add returns error when content is missing", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "add" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/content is required/);
  });

  it("action=add returns error when content is empty string", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "add", content: "   " });
    expect(r.isError).toBe(true);
  });

  it("action=remove returns error when id is missing", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "remove" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/id is required/);
  });

  it("action=reset returns error without confirm:true", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "reset" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/confirm/);
  });

  it("action=set_master returns error when content is missing", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "set_master" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/content is required/);
  });
});

// ── add + list roundtrip ───────────────────────────────────────────────────────

describe("remember — add and list", () => {
  it("add stores an entry that appears in list", async () => {
    const { tool } = await makeTool();
    const addR = await tool.execute({ action: "add", content: "Project uses Bun not Node" });
    expect(addR.isError).toBe(false);
    expect(addR.content).toContain("Memory saved");
    expect(addR.content).toContain("Project uses Bun not Node");

    const listR = await tool.execute({ action: "list" });
    expect(listR.isError).toBe(false);
    expect(listR.content).toContain("Project uses Bun not Node");
  });

  it("list returns 'No memories stored yet.' when empty", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "list" });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No memories stored yet/);
  });

  it("add response includes the assigned id", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "add", content: "Some fact" });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/id:/);
  });

  it("add with tags includes tags in the response", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "add", content: "Tagged fact", tags: ["auth", "bug"] });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("auth");
    expect(r.content).toContain("bug");
  });

  it("add with importance=3 records high importance", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "add", content: "Critical fact", importance: "3" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("importance: 3");
  });

  it("content is truncated to 500 chars", async () => {
    const { tool } = await makeTool();
    const long = "x".repeat(600);
    const r = await tool.execute({ action: "add", content: long });
    expect(r.isError).toBe(false);
    // The stored content in the response should be capped at 500 chars
    const match = r.content.match(/\): (.+)$/);
    if (match) {
      expect(match[1].length).toBeLessThanOrEqual(500);
    }
  });
});

// ── remove ─────────────────────────────────────────────────────────────────────

describe("remember — remove", () => {
  it("removes an entry by id", async () => {
    const { tool } = await makeTool();
    const addR = await tool.execute({ action: "add", content: "Fact to remove" });
    // Extract id from response: "Memory saved (id: <id>, ..."
    const idMatch = addR.content.match(/id:\s*(\S+?)[,)]/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const removeR = await tool.execute({ action: "remove", id });
    expect(removeR.isError).toBe(false);
    expect(removeR.content).toContain("removed");

    const listR = await tool.execute({ action: "list" });
    expect(listR.content).not.toContain("Fact to remove");
  });

  it("returns non-error when id does not exist", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "remove", id: "nonexistent-id-999" });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No memory entry found/);
  });
});

// ── set_master + view_master ───────────────────────────────────────────────────

describe("remember — master context", () => {
  it("set_master then view_master roundtrip", async () => {
    const { tool } = await makeTool();
    const masterContent = "This is the product context for my project.";
    const setR = await tool.execute({ action: "set_master", content: masterContent });
    expect(setR.isError).toBe(false);
    expect(setR.content).toContain("Master context saved");

    const viewR = await tool.execute({ action: "view_master" });
    expect(viewR.isError).toBe(false);
    expect(viewR.content).toContain(masterContent);
  });

  it("view_master returns informative message when no master context set", async () => {
    const { tool } = await makeTool();
    const r = await tool.execute({ action: "view_master" });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No master context set/);
  });

  it("set_master rejects content exceeding the char limit", async () => {
    const { tool } = await makeTool();
    const { MASTER_CONTEXT_MAX_CHARS } = await import("../../src/memory-sqlite.js");
    const tooLong = "x".repeat(MASTER_CONTEXT_MAX_CHARS + 1);
    const r = await tool.execute({ action: "set_master", content: tooLong });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exceeds/);
  });
});

// ── reset ──────────────────────────────────────────────────────────────────────

describe("remember — reset", () => {
  it("reset with confirm:true clears all entries", async () => {
    const { tool } = await makeTool();
    await tool.execute({ action: "add", content: "Entry 1" });
    await tool.execute({ action: "add", content: "Entry 2" });

    const resetR = await tool.execute({ action: "reset", confirm: true });
    expect(resetR.isError).toBe(false);
    expect(resetR.content).toMatch(/Reset complete/);

    const listR = await tool.execute({ action: "list" });
    expect(listR.content).toMatch(/No memories stored yet/);
  });
});

// ── inspect ────────────────────────────────────────────────────────────────────

describe("remember — inspect", () => {
  it("inspect returns a formatted memory stats report", async () => {
    const { tool } = await makeTool();
    await tool.execute({ action: "add", content: "A fact to count" });
    const r = await tool.execute({ action: "inspect" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Layer 1");
    expect(r.content).toContain("Layer 2");
    expect(r.content).toContain("Layer 3");
    expect(r.content).toContain("entries");
  });
});
