/**
 * Tests for src/tools/todo.ts
 *
 * Covers: makeTodoTools factory, todo_write (persist + summary), todo_read
 * (list + empty), path traversal prevention, and invalid input.
 *
 * Todo files are written to a real temp directory to avoid polluting
 * ~/.orager/todos/.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeTodoTools } from "../../src/tools/todo.js";
import type { TodoItem } from "../../src/tools/todo.js";

// ── Redirect todo storage to a temp directory ─────────────────────────────────
// The tool writes to os.homedir()/.orager/todos/<sessionId>.json.
// We redirect os.homedir() via the HOME env var so tests stay isolated.

let tempHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "orager-todo-test-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tempHome;
});

afterEach(async () => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
  else delete process.env["HOME"];
  await fs.rm(tempHome, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTools(sessionId = "test-session") {
  const tools = makeTodoTools(sessionId);
  const write = tools.find((t) => t.definition.function.name === "todo_write")!;
  const read  = tools.find((t) => t.definition.function.name === "todo_read")!;
  return { write, read };
}

const SAMPLE: TodoItem[] = [
  { id: "1", content: "Set up database", status: "completed", priority: "high" },
  { id: "2", content: "Write tests",     status: "in_progress", priority: "high" },
  { id: "3", content: "Update docs",     status: "pending",     priority: "low"  },
];

// ── makeTodoTools factory ──────────────────────────────────────────────────────

describe("makeTodoTools", () => {
  it("returns exactly two tools", () => {
    const tools = makeTodoTools("sess");
    expect(tools).toHaveLength(2);
  });

  it("tool names are todo_write and todo_read", () => {
    const tools = makeTodoTools("sess");
    const names = tools.map((t) => t.definition.function.name).sort();
    expect(names).toEqual(["todo_read", "todo_write"]);
  });

  it("todo_read is marked readonly", () => {
    const tools = makeTodoTools("sess");
    const read = tools.find((t) => t.definition.function.name === "todo_read")!;
    expect(read.definition.readonly).toBe(true);
  });
});

// ── todo_write ─────────────────────────────────────────────────────────────────

describe("todo_write", () => {
  it("returns a summary with correct counts", async () => {
    const { write } = makeTools();
    const r = await write.execute({ todos: SAMPLE }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("3 total");
    expect(r.content).toContain("1 pending");
    expect(r.content).toContain("1 in progress");
    expect(r.content).toContain("1 completed");
  });

  it("persists todos that can be read back", async () => {
    const { write, read } = makeTools();
    await write.execute({ todos: SAMPLE }, "/tmp");
    const r = await read.execute({}, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Set up database");
    expect(r.content).toContain("Write tests");
    expect(r.content).toContain("Update docs");
  });

  it("overwrites the previous list on a second write", async () => {
    const { write, read } = makeTools();
    await write.execute({ todos: SAMPLE }, "/tmp");

    const updated: TodoItem[] = [
      { id: "1", content: "New task only", status: "pending", priority: "medium" },
    ];
    await write.execute({ todos: updated }, "/tmp");

    const r = await read.execute({}, "/tmp");
    expect(r.content).toContain("New task only");
    expect(r.content).not.toContain("Set up database");
  });

  it("writes an empty list successfully", async () => {
    const { write } = makeTools();
    const r = await write.execute({ todos: [] }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("0 total");
  });

  it("returns an error when todos is not an array", async () => {
    const { write } = makeTools();
    const r = await write.execute({ todos: "not-an-array" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/todos must be an array/);
  });

  it("returns an error when todos is missing", async () => {
    const { write } = makeTools();
    const r = await write.execute({}, "/tmp");
    expect(r.isError).toBe(true);
  });
});

// ── todo_read ──────────────────────────────────────────────────────────────────

describe("todo_read", () => {
  it("returns 'No todos yet.' when no todos have been written", async () => {
    const { read } = makeTools("fresh-session-" + Date.now());
    const r = await read.execute({}, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toBe("No todos yet.");
  });

  it("formats each todo as [status] (priority) id: content", async () => {
    const { write, read } = makeTools();
    await write.execute({
      todos: [
        { id: "task-1", content: "Do the thing", status: "in_progress", priority: "high" },
      ],
    }, "/tmp");
    const r = await read.execute({}, "/tmp");
    expect(r.content).toContain("[in_progress]");
    expect(r.content).toContain("(high)");
    expect(r.content).toContain("task-1");
    expect(r.content).toContain("Do the thing");
  });

  it("lists all todos on separate lines", async () => {
    const { write, read } = makeTools();
    await write.execute({ todos: SAMPLE }, "/tmp");
    const r = await read.execute({}, "/tmp");
    const lines = r.content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
  });
});

// ── Session isolation ──────────────────────────────────────────────────────────

describe("todo session isolation", () => {
  it("different session IDs have independent todo lists", async () => {
    const { write: writeA, read: readA } = makeTools("session-a");
    const { write: writeB, read: readB } = makeTools("session-b");

    await writeA.execute({
      todos: [{ id: "1", content: "Task A", status: "pending", priority: "high" }],
    }, "/tmp");
    await writeB.execute({
      todos: [{ id: "1", content: "Task B", status: "pending", priority: "low" }],
    }, "/tmp");

    const rA = await readA.execute({}, "/tmp");
    const rB = await readB.execute({}, "/tmp");

    expect(rA.content).toContain("Task A");
    expect(rA.content).not.toContain("Task B");
    expect(rB.content).toContain("Task B");
    expect(rB.content).not.toContain("Task A");
  });
});

// ── Path traversal protection ──────────────────────────────────────────────────

describe("todo path traversal protection", () => {
  it("sanitises ../../etc/passwd to just 'passwd' (path.basename stripping)", async () => {
    // makeTodoTools does NOT throw — it uses path.basename to strip traversal.
    // The stored file will be <home>/.orager/todos/passwd.json, not /etc/passwd.
    const tools = makeTodoTools("../../etc/passwd");
    const write = tools.find((t) => t.definition.function.name === "todo_write")!;
    // Should succeed without escaping the todos directory
    const r = await write.execute({ todos: [] }, "/tmp");
    expect(r.isError).toBe(false); // sanitised, not blocked
  });

  it("throws at execute time for sessionId '.'", async () => {
    const tools = makeTodoTools(".");
    const write = tools.find((t) => t.definition.function.name === "todo_write")!;
    await expect(write.execute({ todos: [] }, "/tmp")).rejects.toThrow(/Invalid session ID/);
  });

  it("throws at execute time for sessionId '..'", async () => {
    const tools = makeTodoTools("..");
    const write = tools.find((t) => t.definition.function.name === "todo_write")!;
    await expect(write.execute({ todos: [] }, "/tmp")).rejects.toThrow(/Invalid session ID/);
  });

  it("factory accepts a normal session ID", () => {
    expect(() => makeTodoTools("abc-123_def")).not.toThrow();
  });
});
