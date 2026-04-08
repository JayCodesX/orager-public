/**
 * Tests for the secret-scanner integration inside loop-executor.ts.
 *
 * executeOne() intercepts write_file and edit_file tool calls and runs
 * checkContentForSecrets() before the tool executes. If a secret is detected,
 * the call returns isError:true with the scanner error message and the real
 * tool executor is never called.
 *
 * Tested behaviours:
 *  - write_file with a secret → isError:true, tool executor NOT called
 *  - write_file with clean content → executor called, result returned
 *  - edit_file with a secret in one edit → isError:true, executor NOT called
 *  - edit_file with multiple edits, first clean/second dirty → blocked on second
 *  - edit_file with all-clean edits → executor called
 *  - write_file to an exempt path (.env.example) → executor called (no block)
 *  - Non-write_file tool → executor called (scanner not invoked)
 *  - Unknown tool → isError:true "Unknown tool"
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeOne } from "../src/loop-executor.js";
import type { ToolExecCtx } from "../src/loop-executor.js";
import type { ToolCall } from "../src/types.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../src/secret-scanner.js", () => ({
  checkContentForSecrets: vi.fn(),
  scanForSecrets:         vi.fn().mockReturnValue([]),
}));

vi.mock("../src/audit.js", () => ({
  auditApproval:       vi.fn(),
  logToolCall:         vi.fn(),
  logSandboxViolation: vi.fn(),
}));

vi.mock("../src/approval.js", () => ({
  promptApproval: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/telemetry.js", () => ({
  withSpan: vi.fn(async (_name: string, _attrs: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../src/metrics.js", () => ({
  recordToolCall: vi.fn(),
  recordTokens:   vi.fn(),
  recordSession:  vi.fn(),
}));

vi.mock("../src/hooks.js", () => ({
  fireHooks: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../src/tools/plan.js", () => ({
  PLAN_MODE_TOOL_NAME: "exit_plan_mode",
  exitPlanModeTool:    { definition: { function: { name: "exit_plan_mode" }, readonly: true }, execute: vi.fn() },
}));

import { checkContentForSecrets } from "../src/secret-scanner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id:       `tc_${name}`,
    type:     "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeExecutor(name: string, execFn = vi.fn().mockResolvedValue({ content: "ok", isError: false })) {
  return {
    definition: { function: { name }, readonly: false },
    execute:    execFn,
  };
}

function makeCtx(tools: ReturnType<typeof makeExecutor>[] = []): ToolExecCtx {
  return {
    allTools:              tools as never,
    opts:                  { hooks: {} } as never,
    effectiveOpts:         { hooks: {} } as never,
    cwd:                   "/tmp/sandbox",
    sessionId:             "test-session",
    filesChanged:          new Set(),
    toolResultCache:       new Map(),
    setCached:             vi.fn(),
    toolMetrics:           new Map(),
    _hookOpts:             {},
    _effectiveToolTimeout: () => undefined,
    onLog:                 undefined,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeOne — write_file secret detection", () => {
  it("returns isError:true when checkContentForSecrets detects a secret", async () => {
    const errMsg = "Secret scanner blocked this write — potential secret(s) detected:\n  • AWS Access Key: AKIA***le\n\nRemove the secret(s)…";
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(errMsg);

    const exec = makeExecutor("write_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("write_file", { path: "/tmp/config.ts", content: "AKIAIOSFODNN7EXAMPLE" });

    const result = await executeOne(tc, ctx, false);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Secret scanner blocked");
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("calls checkContentForSecrets with content AND filePath", async () => {
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("write_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("write_file", { path: "/tmp/src/config.ts", content: "const x = 1;" });

    await executeOne(tc, ctx, false);

    expect(checkContentForSecrets).toHaveBeenCalledWith("const x = 1;", "/tmp/src/config.ts");
  });

  it("calls executor when checkContentForSecrets returns null (clean content)", async () => {
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("write_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("write_file", { path: "/tmp/file.ts", content: "const x = 1;" });

    const result = await executeOne(tc, ctx, false);

    expect(exec.execute).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  it("passes filePath as undefined when path arg is missing", async () => {
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("write_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("write_file", { content: "const x = 1;" });

    await executeOne(tc, ctx, false);

    expect(checkContentForSecrets).toHaveBeenCalledWith("const x = 1;", undefined);
  });

  it("does NOT call checkContentForSecrets when content is not a string", async () => {
    const exec = makeExecutor("write_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("write_file", { path: "/tmp/file.ts", content: 42 });

    await executeOne(tc, ctx, false);

    expect(checkContentForSecrets).not.toHaveBeenCalled();
  });

  it("allows write to exempt path (.env.example) even if scanner would detect", async () => {
    // When filePath ends with .env.example, checkContentForSecrets returns null
    // because the real scanner exempts it — we simulate that here.
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("write_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("write_file", { path: "/project/.env.example", content: "AKIAIOSFODNN7EXAMPLE" });

    const result = await executeOne(tc, ctx, false);

    expect(result.isError).toBe(false);
    expect(exec.execute).toHaveBeenCalledOnce();
  });
});

describe("executeOne — edit_file secret detection", () => {
  it("returns isError:true when any edit's new_string contains a secret", async () => {
    const errMsg = "Secret scanner blocked this write — Private key detected";
    (checkContentForSecrets as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(null)        // first edit: clean
      .mockReturnValueOnce(errMsg);     // second edit: dirty

    const exec = makeExecutor("edit_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("edit_file", {
      path:  "/tmp/src/keys.ts",
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 2;" },
        { old_string: "// key",       new_string: "-----BEGIN RSA PRIVATE KEY-----" },
      ],
    });

    const result = await executeOne(tc, ctx, false);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Secret scanner blocked");
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("calls checkContentForSecrets for each edit's new_string", async () => {
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("edit_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("edit_file", {
      path:  "/tmp/f.ts",
      edits: [
        { old_string: "a", new_string: "clean one" },
        { old_string: "b", new_string: "clean two" },
      ],
    });

    await executeOne(tc, ctx, false);

    expect(checkContentForSecrets).toHaveBeenCalledTimes(2);
    expect(checkContentForSecrets).toHaveBeenCalledWith("clean one", "/tmp/f.ts");
    expect(checkContentForSecrets).toHaveBeenCalledWith("clean two", "/tmp/f.ts");
  });

  it("calls executor when all edits are clean", async () => {
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("edit_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("edit_file", {
      path:  "/tmp/f.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    });

    const result = await executeOne(tc, ctx, false);

    expect(exec.execute).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
  });

  it("skips edits that have no new_string (string type guard)", async () => {
    (checkContentForSecrets as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const exec = makeExecutor("edit_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("edit_file", {
      path:  "/tmp/f.ts",
      edits: [{ old_string: "a" }, { old_string: "b", new_string: "clean" }],
    });

    await executeOne(tc, ctx, false);

    // Only one edit has new_string, so scanner called once
    expect(checkContentForSecrets).toHaveBeenCalledTimes(1);
  });
});

describe("executeOne — non-write tools skip the scanner", () => {
  it("does not call checkContentForSecrets for read_file", async () => {
    const exec = makeExecutor("read_file");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("read_file", { path: "/tmp/f.ts" });

    await executeOne(tc, ctx, false);

    expect(checkContentForSecrets).not.toHaveBeenCalled();
  });

  it("does not call checkContentForSecrets for bash", async () => {
    const exec = makeExecutor("bash");
    const ctx  = makeCtx([exec]);
    const tc   = makeToolCall("bash", { command: "echo hello" });

    await executeOne(tc, ctx, false);

    expect(checkContentForSecrets).not.toHaveBeenCalled();
  });
});

describe("executeOne — unknown tool", () => {
  it("returns isError:true for an unknown tool name", async () => {
    const ctx = makeCtx([]);
    const tc  = makeToolCall("nonexistent_tool", {});

    const result = await executeOne(tc, ctx, false);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});
