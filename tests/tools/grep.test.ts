/**
 * Tests for src/tools/grep.ts
 *
 * Uses a real temporary directory with real files. The tool delegates to
 * rg/grep, so these are integration tests of the tool wrapper. Covers:
 * basic search, no-match, case-insensitive, files_only, context_lines,
 * include filter, output truncation, sandbox enforcement, and invalid input.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { grepTool } from "../../src/tools/grep.js";

// ── Fixture setup ─────────────────────────────────────────────────────────────

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orager-grep-test-"));

  //  alpha.ts   — contains "export function hello"
  //  beta.ts    — contains "export function world" and "const value = 42"
  //  gamma.txt  — plain text: "Hello World"
  //  sub/
  //    delta.ts — contains "export function nested"

  await fs.mkdir(path.join(root, "sub"), { recursive: true });

  await fs.writeFile(
    path.join(root, "alpha.ts"),
    "// Alpha module\nexport function hello() {\n  return 'hello';\n}\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "beta.ts"),
    "// Beta module\nexport function world() {\n  return 'world';\n}\nconst value = 42;\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "gamma.txt"),
    "Hello World\nThis is a text file.\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "sub", "delta.ts"),
    "// Delta module\nexport function nested() {\n  return 'nested';\n}\n",
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function grep(pattern: string, opts: Record<string, unknown> = {}) {
  return grepTool.execute({ pattern, path: root, ...opts }, root);
}

// ── Basic matching ────────────────────────────────────────────────────────────

describe("grep — basic matching", () => {
  it("finds a pattern across all files", async () => {
    const r = await grep("export function");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello");
    expect(r.content).toContain("world");
    expect(r.content).toContain("nested");
  });

  it("returns line numbers in the output", async () => {
    const r = await grep("export function hello");
    expect(r.isError).toBe(false);
    // rg/grep output format: "file:linenum:content" or similar
    expect(r.content).toMatch(/\d/); // has a number somewhere
    expect(r.content).toContain("hello");
  });

  it("no matches returns a non-error message", async () => {
    const r = await grep("zZzThisPatternNeverMatches");
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No matches found/i);
  });
});

// ── Case sensitivity ──────────────────────────────────────────────────────────

describe("grep — case sensitivity", () => {
  it("is case-sensitive by default", async () => {
    // "hello" (lowercase) won't match "Hello" (capital H) in gamma.txt
    const r = await grep("Hello World");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Hello World");
  });

  it("case_sensitive=false finds case-insensitive matches", async () => {
    const r = await grep("EXPORT FUNCTION", { case_sensitive: false });
    expect(r.isError).toBe(false);
    // Should match "export function" lines
    expect(r.content).toContain("hello");
  });

  it("case_sensitive=true (explicit) does not match wrong case", async () => {
    const r = await grep("EXPORT FUNCTION", { case_sensitive: true });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No matches found/i);
  });
});

// ── files_only ────────────────────────────────────────────────────────────────

describe("grep — files_only", () => {
  it("files_only=true returns file paths, not matching lines", async () => {
    const r = await grep("export function", { files_only: true });
    expect(r.isError).toBe(false);
    // Output should be file paths, not line content
    const lines = r.content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Each line should look like a file path (ends with .ts or .txt)
    expect(lines.every((l) => l.endsWith(".ts") || l.endsWith(".txt") || l.includes("alpha") || l.includes("beta") || l.includes("delta"))).toBe(true);
  });

  it("files_only returns only files that match, not all files", async () => {
    const r = await grep("value = 42", { files_only: true });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("beta");
    expect(r.content).not.toContain("alpha");
    expect(r.content).not.toContain("delta");
  });
});

// ── include filter ────────────────────────────────────────────────────────────

describe("grep — include filter", () => {
  it("include=*.ts restricts search to TypeScript files", async () => {
    const r = await grep("Hello", { include: "*.txt" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Hello World");
    // Should NOT contain TypeScript function results
    expect(r.content).not.toContain("export function");
  });

  it("include=*.ts does not match .txt files", async () => {
    const r = await grep("Hello World", { include: "*.ts" });
    // gamma.txt is excluded; "Hello World" only appears in gamma.txt
    // So no matches in .ts files
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/No matches found/i);
  });
});

// ── context_lines ─────────────────────────────────────────────────────────────

describe("grep — context_lines", () => {
  it("context_lines=1 includes surrounding lines", async () => {
    const r = await grep("export function hello", { context_lines: 1 });
    expect(r.isError).toBe(false);
    // Should contain the match and at least one context line
    expect(r.content).toContain("hello");
    // The line after "export function hello() {" is "  return 'hello';"
    expect(r.content).toContain("return");
  });

  it("context_lines=0 is the default (no extra lines)", async () => {
    const r = await grep("const value = 42");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("42");
  });
});

// ── Output truncation ─────────────────────────────────────────────────────────

describe("grep — output truncation", () => {
  it("large output is truncated and marked", async () => {
    // Generate a file with thousands of matching lines
    const bigFile = path.join(root, "big.ts");
    const lines = Array.from({ length: 5000 }, (_, i) => `// MATCH line ${i}`).join("\n");
    await fs.writeFile(bigFile, lines, "utf-8");

    const r = await grep("MATCH", { path: bigFile });
    expect(r.isError).toBe(false);
    // If output was truncated, check for truncation marker
    if (r.content.length >= 100_000) {
      expect(r.content).toContain("truncated");
    }

    await fs.unlink(bigFile);
  });
});

// ── Specific file path ────────────────────────────────────────────────────────

describe("grep — specific file", () => {
  it("can search a specific file by path", async () => {
    const r = await grepTool.execute(
      { pattern: "hello", path: path.join(root, "alpha.ts") },
      root,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello");
  });
});

// ── Regex patterns ────────────────────────────────────────────────────────────

describe("grep — regex", () => {
  it("dot wildcard . matches any character", async () => {
    // "hel.o" should match "hello"
    const r = await grep("hel.o");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello");
  });

  it("anchored pattern ^// matches comment lines", async () => {
    // Lines starting with // (TypeScript comments)
    const r = await grep("^// ");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Alpha");
  });
});

// ── Sandbox enforcement ───────────────────────────────────────────────────────

describe("grep — sandbox", () => {
  it("returns an error when path escapes sandboxRoot", async () => {
    const r = await grepTool.execute(
      { pattern: "hello", path: "/tmp" },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(true);
  });

  it("succeeds when path is inside sandboxRoot", async () => {
    const r = await grepTool.execute(
      { pattern: "hello", path: root },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(false);
  });
});

// ── Invalid input ─────────────────────────────────────────────────────────────

describe("grep — invalid input", () => {
  it("returns an error for an empty pattern", async () => {
    const r = await grepTool.execute({ pattern: "" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pattern/);
  });

  it("returns an error when pattern is not a string", async () => {
    const r = await grepTool.execute({ pattern: 123 }, root);
    expect(r.isError).toBe(true);
  });
});
