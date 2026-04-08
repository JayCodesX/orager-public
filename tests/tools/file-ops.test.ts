/**
 * Tests for src/tools/file-ops.ts
 *
 * Covers deleteFileTool, moveFileTool, and createDirTool.
 * Uses a real temp directory — no mocks needed.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteFileTool, moveFileTool, createDirTool } from "../../src/tools/file-ops.js";

// ── Fixture ────────────────────────────────────────────────────────────────────

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orager-fileops-test-"));
  // Seed a few files for each test to work with
  await fs.mkdir(path.join(root, "subdir"), { recursive: true });
  await fs.writeFile(path.join(root, "target.ts"), "const x = 1;", "utf-8");
  await fs.writeFile(path.join(root, "subdir", "nested.ts"), "const y = 2;", "utf-8");
});

afterAll(async () => {
  // best-effort cleanup
  if (root) await fs.rm(root, { recursive: true, force: true });
});

// ── deleteFileTool ─────────────────────────────────────────────────────────────

describe("delete_file", () => {
  it("deletes an existing file", async () => {
    const filePath = path.join(root, "target.ts");
    const r = await deleteFileTool.execute({ path: filePath }, root);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Deleted");
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("uses relative path resolved against cwd", async () => {
    const r = await deleteFileTool.execute({ path: "target.ts" }, root);
    expect(r.isError).toBe(false);
    await expect(fs.access(path.join(root, "target.ts"))).rejects.toThrow();
  });

  it("returns an error when file does not exist", async () => {
    const r = await deleteFileTool.execute({ path: path.join(root, "nonexistent.ts") }, root);
    expect(r.isError).toBe(true);
  });

  it("returns an error for empty path", async () => {
    const r = await deleteFileTool.execute({ path: "" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/path/);
  });

  it("sandbox: blocks deletion outside sandboxRoot", async () => {
    const r = await deleteFileTool.execute(
      { path: "/tmp/some-file.ts" },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(true);
  });

  it("sandbox: allows deletion inside sandboxRoot", async () => {
    const filePath = path.join(root, "target.ts");
    const r = await deleteFileTool.execute(
      { path: filePath },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(false);
  });
});

// ── moveFileTool ───────────────────────────────────────────────────────────────

describe("move_file", () => {
  it("renames a file within the same directory", async () => {
    const src = path.join(root, "target.ts");
    const dst = path.join(root, "renamed.ts");
    const r = await moveFileTool.execute({ source: src, destination: dst }, root);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("→");
    expect((await fs.stat(dst)).isFile()).toBe(true);
    await expect(fs.stat(src)).rejects.toThrow();
  });

  it("moves a file into a subdirectory", async () => {
    const src = path.join(root, "target.ts");
    const dst = path.join(root, "subdir", "target.ts");
    const r = await moveFileTool.execute({ source: src, destination: dst }, root);
    expect(r.isError).toBe(false);
    expect((await fs.stat(dst)).isFile()).toBe(true);
  });

  it("creates destination parent directory if it does not exist", async () => {
    const src = path.join(root, "target.ts");
    const dst = path.join(root, "new", "dir", "target.ts");
    const r = await moveFileTool.execute({ source: src, destination: dst }, root);
    expect(r.isError).toBe(false);
    expect((await fs.stat(dst)).isFile()).toBe(true);
  });

  it("uses relative paths resolved against cwd", async () => {
    const r = await moveFileTool.execute(
      { source: "target.ts", destination: "renamed.ts" },
      root,
    );
    expect(r.isError).toBe(false);
    expect((await fs.stat(path.join(root, "renamed.ts"))).isFile()).toBe(true);
  });

  it("returns an error when source does not exist", async () => {
    const r = await moveFileTool.execute(
      { source: path.join(root, "ghost.ts"), destination: path.join(root, "dst.ts") },
      root,
    );
    expect(r.isError).toBe(true);
  });

  it("returns an error for empty source", async () => {
    const r = await moveFileTool.execute({ source: "", destination: "dst.ts" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/source/);
  });

  it("returns an error for empty destination", async () => {
    const r = await moveFileTool.execute({ source: "target.ts", destination: "" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/destination/);
  });

  it("sandbox: blocks move where source is outside sandboxRoot", async () => {
    const r = await moveFileTool.execute(
      { source: "/tmp/external.ts", destination: path.join(root, "dst.ts") },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(true);
  });

  it("sandbox: blocks move where destination is outside sandboxRoot", async () => {
    const r = await moveFileTool.execute(
      { source: path.join(root, "target.ts"), destination: "/tmp/dst.ts" },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(true);
  });
});

// ── createDirTool ──────────────────────────────────────────────────────────────

describe("create_dir", () => {
  it("creates a new directory", async () => {
    const newDir = path.join(root, "newdir");
    const r = await createDirTool.execute({ path: newDir }, root);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Directory ready");
    const stat = await fs.stat(newDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates nested directories (mkdir -p behavior)", async () => {
    const nested = path.join(root, "a", "b", "c");
    const r = await createDirTool.execute({ path: nested }, root);
    expect(r.isError).toBe(false);
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it("is idempotent — succeeds when directory already exists", async () => {
    const existing = path.join(root, "subdir");
    const r = await createDirTool.execute({ path: existing }, root);
    expect(r.isError).toBe(false);
  });

  it("uses relative path resolved against cwd", async () => {
    const r = await createDirTool.execute({ path: "reldir" }, root);
    expect(r.isError).toBe(false);
    const stat = await fs.stat(path.join(root, "reldir"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("returns an error for empty path", async () => {
    const r = await createDirTool.execute({ path: "" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/path/);
  });

  it("sandbox: blocks creation outside sandboxRoot", async () => {
    const r = await createDirTool.execute(
      { path: "/tmp/orager-sandbox-escape" },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(true);
  });

  it("sandbox: allows creation inside sandboxRoot", async () => {
    const r = await createDirTool.execute(
      { path: path.join(root, "sandbox-ok") },
      root,
      { sandboxRoot: root },
    );
    expect(r.isError).toBe(false);
  });
});
