/**
 * Tests for src/tools/write-file.ts
 *
 * Covers:
 *   writeFileTool   — write/overwrite, parent dir creation, size limit, sandbox
 *   strReplaceTool  — unique match, not-found, ambiguous, sandbox, special chars
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileTool, strReplaceTool } from "../../src/tools/write-file.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-write-file-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── writeFileTool ─────────────────────────────────────────────────────────────

describe("writeFileTool — happy path", () => {
  it("creates a new file with the given content", async () => {
    const file = path.join(tmpDir, "new.txt");

    const result = await writeFileTool.execute!({ path: file, content: "hello world" }, tmpDir);

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("hello world");
  });

  it("overwrites an existing file", async () => {
    const file = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(file, "old content");

    const result = await writeFileTool.execute!({ path: file, content: "new content" }, tmpDir);

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("new content");
  });

  it("creates missing parent directories", async () => {
    const file = path.join(tmpDir, "deep", "nested", "dir", "file.txt");

    const result = await writeFileTool.execute!({ path: file, content: "nested" }, tmpDir);

    expect(result.isError).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("nested");
  });

  it("resolves relative paths against cwd", async () => {
    const result = await writeFileTool.execute!(
      { path: "relative.txt", content: "relative write" },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "relative.txt"), "utf-8")).toBe("relative write");
  });

  it("writes unicode content correctly", async () => {
    const file = path.join(tmpDir, "unicode.txt");
    const content = "日本語\nCafé\n🚀";

    const result = await writeFileTool.execute!({ path: file, content }, tmpDir);

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe(content);
  });

  it("writes empty content", async () => {
    const file = path.join(tmpDir, "empty.txt");

    const result = await writeFileTool.execute!({ path: file, content: "" }, tmpDir);

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("");
  });

  it("success message contains the file path", async () => {
    const file = path.join(tmpDir, "out.txt");

    const result = await writeFileTool.execute!({ path: file, content: "x" }, tmpDir);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(file);
  });
});

describe("writeFileTool — input validation", () => {
  it("returns error for missing path", async () => {
    const result = await writeFileTool.execute!({ content: "x" }, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path");
  });

  it("returns error for empty path", async () => {
    const result = await writeFileTool.execute!({ path: "", content: "x" }, tmpDir);
    expect(result.isError).toBe(true);
  });

  it("returns error for missing content", async () => {
    const result = await writeFileTool.execute!({ path: "f.txt" }, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
  });
});

describe("writeFileTool — sandbox", () => {
  it("blocks writes outside sandboxRoot", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-outside-write-"));
    const outsideFile = path.join(outsideDir, "escape.txt");
    try {
      const result = await writeFileTool.execute!(
        { path: outsideFile, content: "escape" },
        tmpDir,
        { sandboxRoot: tmpDir },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside|sandbox/i);
      expect(fs.existsSync(outsideFile)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows writes inside sandboxRoot", async () => {
    const file = path.join(tmpDir, "allowed.txt");

    const result = await writeFileTool.execute!(
      { path: file, content: "safe" },
      tmpDir,
      { sandboxRoot: tmpDir },
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("safe");
  });
});

// ── strReplaceTool ────────────────────────────────────────────────────────────

describe("strReplaceTool — happy path", () => {
  it("replaces a unique string in a file", async () => {
    const file = path.join(tmpDir, "code.ts");
    fs.writeFileSync(file, "function foo() { return 1; }\n");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "function foo()", new_str: "function bar()" },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    const updated = fs.readFileSync(file, "utf-8");
    expect(updated).toContain("function bar()");
    expect(updated).not.toContain("function foo()");
  });

  it("preserves surrounding content", async () => {
    const file = path.join(tmpDir, "preserve.ts");
    fs.writeFileSync(file, "line1\nTARGET\nline3\n");

    await strReplaceTool.execute!(
      { path: file, old_str: "TARGET", new_str: "REPLACED" },
      tmpDir,
    );

    const updated = fs.readFileSync(file, "utf-8");
    expect(updated).toBe("line1\nREPLACED\nline3\n");
  });

  it("handles newlines in old_str and new_str", async () => {
    const file = path.join(tmpDir, "multiline.ts");
    fs.writeFileSync(file, "a\nb\nc\n");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "a\nb", new_str: "x\ny" },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("x\ny\nc\n");
  });

  it("handles replacement strings with special regex characters safely", async () => {
    const file = path.join(tmpDir, "regex.ts");
    fs.writeFileSync(file, "price is $100");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "price is $100", new_str: "cost is $200 (was $100)" },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("cost is $200 (was $100)");
  });

  it("success message contains the file path", async () => {
    const file = path.join(tmpDir, "msg.txt");
    fs.writeFileSync(file, "hello world");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "hello", new_str: "goodbye" },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(file);
  });
});

describe("strReplaceTool — error cases", () => {
  it("returns error when old_str is not found", async () => {
    const file = path.join(tmpDir, "notfound.txt");
    fs.writeFileSync(file, "some content");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "nonexistent_xyz", new_str: "replacement" },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
    expect(fs.readFileSync(file, "utf-8")).toBe("some content");
  });

  it("returns error when old_str appears more than once", async () => {
    const file = path.join(tmpDir, "ambiguous.txt");
    fs.writeFileSync(file, "foo bar foo");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "foo", new_str: "baz" },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/2 times|unique/i);
    // File should be unchanged
    expect(fs.readFileSync(file, "utf-8")).toBe("foo bar foo");
  });

  it("returns error for non-existent file", async () => {
    const result = await strReplaceTool.execute!(
      { path: path.join(tmpDir, "no-such.txt"), old_str: "x", new_str: "y" },
      tmpDir,
    );
    expect(result.isError).toBe(true);
  });

  it("returns error for missing path", async () => {
    const result = await strReplaceTool.execute!(
      { old_str: "x", new_str: "y" },
      tmpDir,
    );
    expect(result.isError).toBe(true);
  });

  it("returns error for missing old_str", async () => {
    const file = path.join(tmpDir, "f.txt");
    fs.writeFileSync(file, "content");
    const result = await strReplaceTool.execute!(
      { path: file, new_str: "y" },
      tmpDir,
    );
    expect(result.isError).toBe(true);
  });

  it("returns error for missing new_str", async () => {
    const file = path.join(tmpDir, "f.txt");
    fs.writeFileSync(file, "content");
    const result = await strReplaceTool.execute!(
      { path: file, old_str: "content" },
      tmpDir,
    );
    expect(result.isError).toBe(true);
  });
});

describe("strReplaceTool — sandbox", () => {
  it("blocks replacements outside sandboxRoot", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-outside-str-"));
    const outsideFile = path.join(outsideDir, "target.txt");
    fs.writeFileSync(outsideFile, "target content");
    try {
      const result = await strReplaceTool.execute!(
        { path: outsideFile, old_str: "target content", new_str: "replaced" },
        tmpDir,
        { sandboxRoot: tmpDir },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside|sandbox/i);
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("target content");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows replacements inside sandboxRoot", async () => {
    const file = path.join(tmpDir, "safe.txt");
    fs.writeFileSync(file, "old value");

    const result = await strReplaceTool.execute!(
      { path: file, old_str: "old value", new_str: "new value" },
      tmpDir,
      { sandboxRoot: tmpDir },
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("new value");
  });
});
