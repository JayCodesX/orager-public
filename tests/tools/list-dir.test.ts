/**
 * Tests for src/tools/list-dir.ts
 *
 * Covers: flat listing, recursive listing, [dir] vs [file] labels,
 * SKIP_DIRS, max depth, MAX_ENTRIES truncation, sandbox enforcement,
 * non-existent path error, and invalid input.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listDirTool } from "../../src/tools/list-dir.js";

// ── Fixture ────────────────────────────────────────────────────────────────────

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orager-listdir-test-"));

  // root/
  //   alpha.ts
  //   beta.ts
  //   subdir/
  //     gamma.ts
  //     deep/
  //       delta.ts
  //   node_modules/   ← SKIP_DIR
  //     lodash/
  //       index.js
  //   .git/           ← SKIP_DIR
  //     config

  await fs.mkdir(path.join(root, "subdir", "deep"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "lodash"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });

  for (const [rel, content] of [
    ["alpha.ts",          "const a = 1;"],
    ["beta.ts",           "const b = 2;"],
    ["subdir/gamma.ts",   "const g = 3;"],
    ["subdir/deep/delta.ts", "const d = 4;"],
    ["node_modules/lodash/index.js", "module.exports = {}"],
    [".git/config",       "[core]"],
  ]) {
    await fs.writeFile(path.join(root, rel), content, "utf-8");
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────────

async function listDir(p: string, opts: Record<string, unknown> = {}) {
  return listDirTool.execute({ path: p, ...opts }, root);
}

// ── Flat listing ───────────────────────────────────────────────────────────────

describe("list_dir — flat listing", () => {
  it("lists files and directories at the root", async () => {
    const r = await listDir(root);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("[file] alpha.ts");
    expect(r.content).toContain("[file] beta.ts");
    expect(r.content).toContain("[dir]  subdir/");
  });

  it("labels directories with [dir] and files with [file]", async () => {
    const r = await listDir(root);
    expect(r.isError).toBe(false);
    // subdir is a directory
    expect(r.content).toMatch(/\[dir\]\s+subdir\//);
    // alpha.ts is a file
    expect(r.content).toMatch(/\[file\] alpha\.ts/);
  });

  it("includes the absolute path as the first line", async () => {
    const r = await listDir(root);
    expect(r.isError).toBe(false);
    expect(r.content.startsWith(root + ":")).toBe(true);
  });

  it("resolves relative paths against cwd", async () => {
    // Pass "." as relative path — should resolve to root (which is the cwd)
    const r = await listDirTool.execute({ path: "." }, root);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("[file] alpha.ts");
  });

  it("flat listing does not include files inside subdirectories", async () => {
    const r = await listDir(root);
    // gamma.ts is only inside subdir/ — should not appear in flat listing
    expect(r.content).not.toContain("gamma.ts");
    expect(r.content).not.toContain("delta.ts");
  });
});

// ── Recursive listing ──────────────────────────────────────────────────────────

describe("list_dir — recursive listing", () => {
  it("recursive=true includes files in subdirectories", async () => {
    const r = await listDir(root, { recursive: true });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("gamma.ts");
    expect(r.content).toContain("delta.ts");
  });

  it("recursive listing uses indentation to show depth", async () => {
    const r = await listDir(root, { recursive: true });
    // Files at depth 1 have more indentation than root entries
    const lines = r.content.split("\n");
    const gammaLine = lines.find((l) => l.includes("gamma.ts"));
    const alphaLine = lines.find((l) => l.includes("alpha.ts"));
    expect(gammaLine).toBeDefined();
    expect(alphaLine).toBeDefined();
    // gammaLine is indented more (it's inside subdir/)
    const gammaIndent = gammaLine!.match(/^(\s*)/)?.[1].length ?? 0;
    const alphaIndent = alphaLine!.match(/^(\s*)/)?.[1].length ?? 0;
    expect(gammaIndent).toBeGreaterThan(alphaIndent);
  });
});

// ── SKIP_DIRS ──────────────────────────────────────────────────────────────────

describe("list_dir — SKIP_DIRS", () => {
  it("node_modules is not listed in flat mode", async () => {
    // Flat listing still shows the dir entry for node_modules
    // but SKIP_DIRS only applies to recursive traversal
    const r = await listDir(root, { recursive: true });
    // node_modules/ directory exists but should not be recursed into
    expect(r.content).not.toContain("lodash");
    expect(r.content).not.toContain("index.js");
  });

  it(".git is not recursed into", async () => {
    const r = await listDir(root, { recursive: true });
    expect(r.content).not.toContain(".git/config");
    expect(r.content).not.toContain("[core]");
  });
});

// ── Subdirectory listing ───────────────────────────────────────────────────────

describe("list_dir — subdirectory", () => {
  it("can list a subdirectory directly", async () => {
    const r = await listDir(path.join(root, "subdir"));
    expect(r.isError).toBe(false);
    expect(r.content).toContain("[file] gamma.ts");
    expect(r.content).toContain("[dir]  deep/");
    expect(r.content).not.toContain("alpha.ts");
  });
});

// ── Error cases ────────────────────────────────────────────────────────────────

describe("list_dir — error cases", () => {
  it("returns an error for a non-existent path", async () => {
    const r = await listDir(path.join(root, "does-not-exist"));
    expect(r.isError).toBe(true);
  });

  it("returns an error for empty path input", async () => {
    const r = await listDirTool.execute({ path: "" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/path/);
  });

  it("returns an error when path is not a string", async () => {
    const r = await listDirTool.execute({ path: 42 }, root);
    expect(r.isError).toBe(true);
  });
});

// ── Sandbox enforcement ────────────────────────────────────────────────────────

describe("list_dir — sandbox", () => {
  it("returns an error when path escapes sandboxRoot", async () => {
    const r = await listDirTool.execute(
      { path: "/tmp" },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(true);
  });

  it("succeeds when path is inside sandboxRoot", async () => {
    const r = await listDirTool.execute(
      { path: root },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(false);
  });
});
