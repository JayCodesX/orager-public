/**
 * Critical-path tests for src/loop.ts: isPrivateIp edge cases, tool error
 * budget exhaustion, max turns enforcement, and session lock contention.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import type { AgentLoopOptions, EmitEvent, OpenRouterCallResult } from "../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

vi.mock("../src/openrouter-model-meta.js", () => ({
  fetchLiveModelMeta: vi.fn().mockResolvedValue(undefined),
  getLiveModelPricing: vi.fn().mockReturnValue(null),
  isLiveModelMetaCacheWarm: vi.fn().mockReturnValue(true),
  getLiveModelMeta: vi.fn().mockReturnValue(null),
  liveModelSupportsTools: vi.fn().mockReturnValue(null),
  liveModelSupportsVision: vi.fn().mockReturnValue(null),
  getCachedModelIds: vi.fn().mockReturnValue([]),
  getMetaCacheSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/loop-helpers.js", () => ({
  postWebhook: vi.fn().mockResolvedValue(null),
  estimateTokens: vi.fn().mockResolvedValue(0),
  fetchModelContextLengths: vi.fn().mockResolvedValue(undefined),
  getContextWindow: vi.fn().mockReturnValue(128_000),
  isModelContextCacheWarm: vi.fn().mockReturnValue(true),
  MAX_SESSION_MESSAGES: 500,
  summarizeSession: vi.fn().mockResolvedValue([]),
  SUMMARIZE_PROMPT: "",
  validateSummary: vi.fn().mockReturnValue(true),
  CACHE_TTL_MS: 30_000,
  runConcurrent: vi.fn().mockImplementation(
    async (items: unknown[], _max: number, fn: (item: unknown) => Promise<unknown>) => {
      const results = [];
      for (const item of items) results.push(await fn(item));
      return results;
    },
  ),
  MAX_PARALLEL_TOOLS: 10,
  evaluateTurnModelRules: vi.fn().mockReturnValue(null),
  defaultTimeoutForModel: vi.fn().mockReturnValue(120),
  loadCl100k: vi.fn().mockResolvedValue(null),
  loadO200k: vi.fn().mockResolvedValue(null),
  bpeEncoderFamily: vi.fn().mockReturnValue(null),
  getCharsPerToken: vi.fn().mockReturnValue(4),
  isReadOnlyTool: vi.fn().mockReturnValue(false),
  getContextWindowFromFallback: vi.fn().mockReturnValue(128_000),
  _resetModelCacheForTesting: vi.fn(),
  formatDiscordPayload: vi.fn().mockReturnValue({}),
  MEMORY_HEADER_MASTER: "## Persistent Product Context",
  MEMORY_HEADER_RETRIEVED: "## Your persistent memory",
  MEMORY_HEADER_AUTO: "# Persistent memory",
  MEMORY_HEADER_PRIOR_SESSION: "## Prior session context",
  SKILL_HEADER: "## Learned Skills",
  MEMORY_HEADER_WIKI: "## Knowledge Wiki",
  MEMORY_DYNAMIC_BUDGET_FRACTION: 0.15,
  MEMORY_UPDATE_MAX_CHARS: 500,
  MEMORY_UPDATE_INSTRUCTION: "",
  parseMemoryUpdates: vi.fn().mockReturnValue([]),
  distillMemoryEntries: vi.fn().mockResolvedValue([]),
  DISTILL_ENTRY_THRESHOLD: 200,
  DISTILL_BATCH_SIZE: 30,
  MEMORY_LAYER1_MASTER_MAX_CHARS: 8_000,
  MEMORY_LAYER2_RETRIEVED_MAX_CHARS: 16_384,
  MEMORY_LAYER3_CHECKPOINT_MAX_CHARS: 4_000,
}));

vi.mock("../src/retry.js", () => ({
  callWithRetry: vi.fn(),
}));

vi.mock("../src/session.js", () => ({
  CURRENT_SESSION_SCHEMA_VERSION: 1,
  loadSession: vi.fn().mockResolvedValue(null),
  loadSessionRaw: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn().mockReturnValue("test-session-id"),
  acquireSessionLock: vi.fn().mockResolvedValue(async () => {}),
  saveSessionCheckpoint: vi.fn().mockResolvedValue(undefined),
  loadLatestCheckpointByContextId: vi.fn().mockResolvedValue(null),
  loadSessionCheckpoint: vi.fn().mockResolvedValue(null),
  deleteCheckpointsByContextId: vi.fn().mockResolvedValue(0),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
  pruneOldSessions: vi.fn().mockResolvedValue({ deleted: 0, errors: [] }),
  deleteTrashedSessions: vi.fn().mockResolvedValue({ deleted: 0, errors: [] }),
  forkSession: vi.fn().mockResolvedValue(null),
  compactSession: vi.fn().mockResolvedValue(null),
  trashSession: vi.fn().mockResolvedValue(false),
  restoreSession: vi.fn().mockResolvedValue(false),
  searchSessions: vi.fn().mockResolvedValue([]),
  rollbackSession: vi.fn().mockResolvedValue(null),
  ensureSessionsDirPermissions: vi.fn().mockResolvedValue(undefined),
  migrateSession: vi.fn().mockImplementation((d: unknown) => d),
  getSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
  _resetStoreForTesting: vi.fn(),
  _refreshSessionMaxSize: vi.fn(),
}));

const { callWithRetry } = await import("../src/retry.js");
const { acquireSessionLock } = await import("../src/session.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<OpenRouterCallResult> = {}): OpenRouterCallResult {
  return {
    content: "done",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test/model",
    finishReason: "stop",
    isError: false,
    ...overrides,
  };
}

function toolCallResult(calls: Array<{ name: string; args: string }>): OpenRouterCallResult {
  return makeResult({
    content: "",
    toolCalls: calls.map((c, i) => ({
      id: `call_${i}`,
      type: "function" as const,
      function: { name: c.name, arguments: c.args },
    })),
  });
}

function loopOpts(overrides: Partial<AgentLoopOptions> = {}) {
  const emitted: EmitEvent[] = [];
  const logs: string[] = [];
  const opts: AgentLoopOptions = {
    prompt: "test prompt",
    apiKey: "test-key",
    model: "test/model",
    cwd: "/tmp",
    maxTurns: 5,
    sessionId: null,
    addDirs: [],
    dangerouslySkipPermissions: true,
    verbose: false,
    memory: false,
    onEmit: (e) => emitted.push(e),
    onLog: (_stream, chunk) => logs.push(chunk),
    ...overrides,
  };
  return { opts, emitted, logs };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(callWithRetry).mockResolvedValue(makeResult());
  mocked(acquireSessionLock).mockResolvedValue(async () => {});
});

// ── 1. isPrivateIp edge cases ────────────────────────────────────────────────

describe("isPrivateIp — IPv6 mapped and reserved ranges", () => {
  let isPrivateIp: (ip: string) => boolean;

  beforeEach(async () => {
    ({ isPrivateIp } = await import("../src/loop.js"));
  });

  it("detects IPv4-mapped IPv6 compressed (::ffff:127.0.0.1)", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("detects IPv4-mapped IPv6 hex (::ffff:7f00:1)", () => {
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
  });

  it("detects fully expanded 0:0:0:0:0:ffff:127.0.0.1", () => {
    expect(isPrivateIp("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
  });

  it("detects SIIT prefix ::ffff:0:127.0.0.1", () => {
    expect(isPrivateIp("::ffff:0:127.0.0.1")).toBe(true);
  });

  it("detects CGNAT range 100.64.0.1", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });

  it("detects reserved range 240.0.0.1", () => {
    expect(isPrivateIp("240.0.0.1")).toBe(true);
  });

  it("detects ULA IPv6 fd00::1", () => {
    expect(isPrivateIp("fd00::1")).toBe(true);
  });

  it("detects ULA IPv6 fc00::1", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
  });

  it("detects multicast IPv6 ff02::1", () => {
    expect(isPrivateIp("ff02::1")).toBe(true);
  });

  it("detects link-local IPv6 fe80::1", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });
});

// ── 2. Max turns enforcement ─────────────────────────────────────────────────

describe("runAgentLoop — max turns enforcement", () => {
  it("stops after maxTurns and emits error_max_turns", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    // Each turn returns a tool call so the loop continues
    mocked(callWithRetry).mockResolvedValue(
      toolCallResult([{ name: "nonexistent_tool", args: "{}" }]),
    );

    const { opts, emitted } = loopOpts({ maxTurns: 2 });
    await runAgentLoop(opts);

    const result = emitted.find((e) => e.type === "result") as Extract<EmitEvent, { type: "result" }>;
    expect(result).toBeDefined();
    expect(result.subtype).toBe("error_max_turns");
    expect(result.turnCount).toBe(2);
  }, { timeout: 15_000 });
});

// ── 3. Tool error budget exhaustion ──────────────────────────────────────────

describe("runAgentLoop — tool error budget", () => {
  it("stops when a tool fails 5 consecutive times with toolErrorBudgetHardStop", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    // Every turn calls a nonexistent tool which returns isError: true from the
    // executor. After 5 consecutive errors the budget is exceeded.
    mocked(callWithRetry).mockResolvedValue(
      toolCallResult([{ name: "nonexistent_tool_budget", args: "{}" }]),
    );

    const { opts, emitted } = loopOpts({
      maxTurns: 10,
      toolErrorBudgetHardStop: true,
    });
    await runAgentLoop(opts);

    const result = emitted.find((e) => e.type === "result") as Extract<EmitEvent, { type: "result" }>;
    expect(result).toBeDefined();
    expect(result.subtype).toBe("error_tool_budget");
    expect(result.result).toContain("consecutive-failure budget");
  }, { timeout: 15_000 });

  it("warns but continues without hard stop by default", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    // 6 turns of tool errors, then a final no-tool response
    let callCount = 0;
    mocked(callWithRetry).mockImplementation(async () => {
      callCount++;
      if (callCount <= 6) {
        return toolCallResult([{ name: "broken_tool", args: "{}" }]);
      }
      return makeResult({ content: "final" });
    });

    const { opts, emitted, logs } = loopOpts({ maxTurns: 10 });
    await runAgentLoop(opts);

    // Should warn in logs but not hard-stop
    const warningLog = logs.find((l) => l.includes("WARNING") && l.includes("broken_tool"));
    expect(warningLog).toBeDefined();

    const result = emitted.find((e) => e.type === "result") as Extract<EmitEvent, { type: "result" }>;
    expect(result).toBeDefined();
    // Should NOT be error_tool_budget since hard stop is off
    expect(result.subtype).not.toBe("error_tool_budget");
  }, { timeout: 15_000 });
});

// ── 4. Session lock contention ───────────────────────────────────────────────

describe("runAgentLoop — session lock contention", () => {
  it("emits error result when session lock fails with concurrent-run message", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    mocked(acquireSessionLock).mockRejectedValue(
      new Error("Cannot start concurrent runs on session test-session"),
    );

    const { opts, emitted } = loopOpts({ sessionId: "test-session" });
    await runAgentLoop(opts);

    const result = emitted.find((e) => e.type === "result") as Extract<EmitEvent, { type: "result" }>;
    expect(result).toBeDefined();
    expect(result.subtype).toBe("error");
    expect(result.result).toContain("Cannot start concurrent runs");
  }, { timeout: 15_000 });

  it("proceeds when lock fails with non-concurrent error", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    mocked(acquireSessionLock).mockRejectedValue(
      new Error("ENOENT: lock directory missing"),
    );

    const { opts, emitted } = loopOpts({ sessionId: "test-session-2" });
    await runAgentLoop(opts);

    // Should still produce a result (loop continues without lock)
    const result = emitted.find((e) => e.type === "result") as Extract<EmitEvent, { type: "result" }>;
    expect(result).toBeDefined();
    expect(result.subtype).not.toBe("error");
  }, { timeout: 15_000 });
});
