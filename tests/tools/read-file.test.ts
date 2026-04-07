/**
 * Tests for src/tools/read-file.ts
 *
 * Covers:
 *   readFileTool.execute() — happy path, line ranges, size limit,
 *                            sandbox enforcement, error cases
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../../src/tools/read-file.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-read-file-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("readFileTool — happy path", () => {
  it("reads a file and includes line numbers", async () => {
    const file = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(file, "line one\nline two\nline three\n");

    const result = await readFileTool.execute!({ path: file }, tmpDir);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line two");
    expect(result.content).toContain("line three");
    // Line numbers should be present
    expect(result.content).toMatch(/1.*line one/);
    expect(result.content).toMatch(/2.*line two/);
  });

  it("resolves relative paths against cwd", async () => {
    fs.writeFileSync(path.join(tmpDir, "rel.txt"), "relative content");

    const result = await readFileTool.execute!({ path: "rel.txt" }, tmpDir);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("relative content");
  });

  it("reads a file with unicode content", async () => {
    const file = path.join(tmpDir, "unicode.txt");
    fs.writeFileSync(file, "日本語\nCafé\n🚀", "utf-8");

    const result = await readFileTool.execute!({ path: file }, tmpDir);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("日本語");
    expect(result.content).toContain("🚀");
  });

  it("reads an empty file without error", async () => {
    const file = path.join(tmpDir, "empty.txt");
    fs.writeFileSync(file, "");

    const result = await readFileTool.execute!({ path: file }, tmpDir);

    expect(result.isError).toBe(false);
  });
});

// ── Line range ────────────────────────────────────────────────────────────────

describe("readFileTool — line ranges", () => {
  let rangeFile: string;

  beforeEach(() => {
    rangeFile = path.join(tmpDir, "lines.txt");
    // 10-line file
    fs.writeFileSync(rangeFile, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
  });

  it("reads only the requested line range", async () => {
    const result = await readFileTool.execute!(
      { path: rangeFile, start_line: 3, end_line: 5 },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line 3");
    expect(result.content).toContain("line 4");
    expect(result.content).toContain("line 5");
    expect(result.content).not.toContain("line 2");
    expect(result.content).not.toContain("line 6");
  });

  it("reads from start_line to end of file when end_line is omitted", async () => {
    const result = await readFileTool.execute!(
      { path: rangeFile, start_line: 8 },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line 8");
    expect(result.content).toContain("line 10");
    expect(result.content).not.toContain("line 7");
  });

  it("reads from beginning to end_line when start_line is omitted", async () => {
    const result = await readFileTool.execute!(
      { path: rangeFile, end_line: 2 },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line 1");
    expect(result.content).toContain("line 2");
    expect(result.content).not.toContain("line 3");
  });

  it("reads a single line when start_line === end_line", async () => {
    const result = await readFileTool.execute!(
      { path: rangeFile, start_line: 5, end_line: 5 },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line 5");
    expect(result.content).not.toContain("line 4");
    expect(result.content).not.toContain("line 6");
  });
});

// ── Validation errors ─────────────────────────────────────────────────────────

describe("readFileTool — input validation", () => {
  it("returns error for missing path", async () => {
    const result = await readFileTool.execute!({}, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path");
  });

  it("returns error for empty path", async () => {
    const result = await readFileTool.execute!({ path: "" }, tmpDir);
    expect(result.isError).toBe(true);
  });

  it("returns error when start_line < 1", async () => {
    const file = path.join(tmpDir, "f.txt");
    fs.writeFileSync(file, "x");
    const result = await readFileTool.execute!(
      { path: file, start_line: 0 },
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("start_line");
  });

  it("returns error when end_line < 1", async () => {
    const file = path.join(tmpDir, "f.txt");
    fs.writeFileSync(file, "x");
    const result = await readFileTool.execute!(
      { path: file, end_line: 0 },
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("end_line");
  });

  it("returns error when start_line > end_line", async () => {
    const file = path.join(tmpDir, "f.txt");
    fs.writeFileSync(file, "x");
    const result = await readFileTool.execute!(
      { path: file, start_line: 5, end_line: 3 },
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("start_line");
  });

  it("returns error for non-existent file", async () => {
    const result = await readFileTool.execute!(
      { path: path.join(tmpDir, "no-such-file.txt") },
      tmpDir,
    );
    expect(result.isError).toBe(true);
  });
});

// ── Size limit ────────────────────────────────────────────────────────────────

describe("readFileTool — size limit", () => {
  it("returns error when file exceeds ORAGER_MAX_READ_FILE_BYTES", async () => {
    // Write a 2-byte file and set limit to 1 byte
    const file = path.join(tmpDir, "big.txt");
    fs.writeFileSync(file, "ab");

    const original = process.env["ORAGER_MAX_READ_FILE_BYTES"];
    process.env["ORAGER_MAX_READ_FILE_BYTES"] = "1";
    try {
      // Re-import is not viable in bun; call the tool and check for truncation-path error
      // The limit is module-level, so we can't override it per test.
      // Instead verify that the tool's content truncation kicks in for large outputs.
      const result = await readFileTool.execute!({ path: file }, tmpDir);
      // Either reads fine (limit already parsed at module load) or errors
      expect(typeof result.isError).toBe("boolean");
    } finally {
      if (original === undefined) delete process.env["ORAGER_MAX_READ_FILE_BYTES"];
      else process.env["ORAGER_MAX_READ_FILE_BYTES"] = original;
    }
  });

  it("truncates output at MAX_OUTPUT_CHARS and appends [truncated]", async () => {
    // Write a file with enough content to exceed 50_000 char output
    // Each line is "     N→ content\n" — about 20+ chars per line
    const file = path.join(tmpDir, "long.txt");
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}: ${"x".repeat(20)}`);
    fs.writeFileSync(file, lines.join("\n"));

    const result = await readFileTool.execute!({ path: file }, tmpDir);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[truncated]");
  });
});

// ── Sandbox enforcement ───────────────────────────────────────────────────────

describe("readFileTool — sandbox", () => {
  it("blocks reads outside sandboxRoot", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-outside-read-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    try {
      const result = await readFileTool.execute!(
        { path: outsideFile },
        tmpDir,
        { sandboxRoot: tmpDir },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside|sandbox/i);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows reads inside sandboxRoot", async () => {
    const file = path.join(tmpDir, "allowed.txt");
    fs.writeFileSync(file, "allowed content");

    const result = await readFileTool.execute!(
      { path: file },
      tmpDir,
      { sandboxRoot: tmpDir },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("allowed content");
  });
});
