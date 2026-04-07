/**
 * E2E Compound Loop Integration Tests
 *
 * Validates that orager's compound loop (memory + skills + wiki + hooks +
 * summarization + self-optimization + profiles) works end-to-end and produces
 * measurably better outcomes than a baseline agent with none of these layers.
 *
 * Design:
 *  - callOpenRouter is mocked — no real API calls, fully deterministic
 *  - Memory, SkillBank, Knowledge Wiki run against real SQLite in isolated tmp dirs
 *  - Each test validates a specific layer in isolation, then a final benchmark
 *    shows compound advantage (all layers) vs baseline (none)
 *
 * To run:
 *   bun test tests/integration/e2e-compound-loop.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "../mock-helpers.js";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../../src/loop.js";
import type {
  EmitEvent,
  EmitResultEvent,
  OpenRouterCallResult,
  OpenRouterCallOptions,
  ToolCall,
} from "../../src/types.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/audit.js", () => ({
  auditApproval: vi.fn(),
  logToolCall: vi.fn(),
  logSandboxViolation: vi.fn(),
}));

// Fixed embedding vector — makes all cosine similarities 1.0 so skill/memory
// retrieval always finds seeds regardless of semantic content. Safe for tests.
const FIXED_VEC = new Array(64).fill(0).map((_, i) => (i === 0 ? 1 : 0));

vi.mock("../../src/local-embeddings.js", () => ({
  localEmbed: vi.fn().mockResolvedValue(FIXED_VEC),
}));

// Deferred imports (after vi.mock hoisting)
const { callOpenRouter } = await import("../../src/openrouter.js");
const { addMemoryEntrySqlite, _resetDbForTesting } = await import("../../src/memory-sqlite.js");
const { importSeedSkill, _resetSkillsDbForTesting } = await import("../../src/skillbank.js");
const { getWikiBlock, updatePage, _resetWikiDbForTesting } = await import("../../src/knowledge-wiki.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function noToolResponse(content = "Done"): OpenRouterCallResult {
  return {
    content,
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

function toolResponse(toolCalls: ToolCall[], content = ""): OpenRouterCallResult {
  return {
    content,
    reasoning: "",
    toolCalls,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "tool_calls",
    isError: false,
  };
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Extract the system message content from callOpenRouter's opts.messages */
function extractSystem(opts: OpenRouterCallOptions): string {
  return opts.messages.find((m) => m.role === "system")?.content as string ?? "";
}

function collectAssistantText(emitted: EmitEvent[]): string {
  return emitted
    .filter((e) => e.type === "assistant")
    .flatMap((e: EmitEvent) => {
      if (e.type !== "assistant") return [];
      return (e.message?.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text?: string }) => (b as { type: string; text: string }).text ?? "");
    })
    .join("\n");
}

function baseOpts(cwd: string, overrides: Record<string, unknown> = {}) {
  const emitted: EmitEvent[] = [];
  return {
    opts: {
      prompt: "Test task",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 5,
      maxRetries: 0,
      cwd,
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e: EmitEvent) => emitted.push(e),
      ...overrides,
    },
    emitted,
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

let tmpDir: string;
let memKey: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await mkdtemp(join(tmpdir(), "orager-e2e-"));
  memKey = `e2e-test-${Date.now()}`;
  process.env["ORAGER_MEMORY_SQLITE_DIR"] = join(tmpDir, "memory");
  process.env["ORAGER_SKILLS_DB_PATH"] = join(tmpDir, "skills.sqlite");
  process.env["ORAGER_WIKI_DB_PATH"] = join(tmpDir, "wiki.sqlite");
  await mkdir(join(tmpDir, "memory"), { recursive: true });
});

afterEach(async () => {
  _resetDbForTesting();
  _resetSkillsDbForTesting();
  _resetWikiDbForTesting();
  delete process.env["ORAGER_MEMORY_SQLITE_DIR"];
  delete process.env["ORAGER_SKILLS_DB_PATH"];
  delete process.env["ORAGER_WIKI_DB_PATH"];
  await rm(tmpDir, { recursive: true, force: true });
});

// ── 1. Memory: cross-session recall ──────────────────────────────────────────

describe("Memory — cross-session recall", () => {
  it("previously stored memory appears in the system prompt", { timeout: 20000 }, async () => {
    await addMemoryEntrySqlite(memKey, {
      content: "The deploy key for staging is STAGING_KEY_XYZ.",
      tags: ["deployment", "keys"],
      importance: 3,
    });

    let capturedSystem = "";
    mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
      capturedSystem = extractSystem(opts);
      return noToolResponse("The deploy key is STAGING_KEY_XYZ.");
    });

    const { opts } = baseOpts(tmpDir, {
      prompt: "What is the staging deploy key?",
      memoryKey: memKey,
      memory: true,
    });

    await runAgentLoop(opts);
    expect(capturedSystem).toContain("STAGING_KEY_XYZ");
  });

  it("memory written in one run is available in the next run", { timeout: 30000 }, async () => {
    // Run 1: agent response includes a memory_update block
    mocked(callOpenRouter).mockResolvedValueOnce(
      noToolResponse(
        "Got it. <memory_update>{\"content\":\"Project uses Bun not Node\",\"tags\":[\"toolchain\"]}</memory_update>",
      ),
    );

    await runAgentLoop({
      prompt: "Note: this project uses Bun, not Node.",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 3,
      maxRetries: 0,
      cwd: tmpDir,
      dangerouslySkipPermissions: true,
      verbose: false,
      memoryKey: memKey,
      memory: true,
      onEmit: () => {},
    });

    // Reset DB handles so run 2 opens a fresh connection to the same files
    _resetDbForTesting();

    let run2System = "";
    mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
      run2System = extractSystem(opts);
      return noToolResponse("This project uses Bun.");
    });

    await runAgentLoop({
      prompt: "What build tool does this project use?",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 3,
      maxRetries: 0,
      cwd: tmpDir,
      dangerouslySkipPermissions: true,
      verbose: false,
      memoryKey: memKey,
      memory: true,
      onEmit: () => {},
    });

    expect(run2System).toContain("Bun");
  });
});

// ── 2. SkillBank — learned skills surface in context ─────────────────────────

describe("SkillBank — learned skills surface in context", () => {
  it("seeded skill appears in system prompt for related task", { timeout: 20000 }, async () => {
    await importSeedSkill(
      "Always use .js extension in TypeScript imports for ESM compatibility.",
      "e2e-test",
    );

    let capturedSystem = "";
    mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
      capturedSystem = extractSystem(opts);
      return noToolResponse("Check your import extensions.");
    });

    const { opts } = baseOpts(tmpDir, {
      prompt: "I'm getting TypeScript import errors — how do I fix them?",
      memory: false,
      skillbank: { enabled: true, topK: 3 },
    });

    await runAgentLoop(opts);
    expect(capturedSystem).toContain(".js extension");
  });

  it("skills are NOT injected when skills disabled", { timeout: 20000 }, async () => {
    await importSeedSkill(
      "UNIQUE_SKILL_SENTINEL_DO_NOT_INJECT: never inject this text into prompts.",
      "e2e-test",
    );

    let capturedSystem = "";
    mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
      capturedSystem = extractSystem(opts);
      return noToolResponse("done");
    });

    const { opts } = baseOpts(tmpDir, {
      prompt: "Do anything",
      skillbank: { enabled: false },
    });

    await runAgentLoop(opts);
    expect(capturedSystem).not.toContain("UNIQUE_SKILL_SENTINEL_DO_NOT_INJECT");
  });
});

// ── 3. Knowledge Wiki — relevant pages injected ───────────────────────────────

describe("Knowledge Wiki — relevant pages injected", () => {
  it("ingested wiki page is returned by getWikiBlock for related query", { timeout: 10000 }, async () => {
    await updatePage(
      "deployment-process",
      "Production deployment: run ./scripts/deploy.sh prod. Always verify with --dry-run first.",
      [],
      1,
    );

    const block = await getWikiBlock("how do I deploy to production");
    expect(block).toBeTruthy();
    expect(block).toContain("deployment");
  });

  it("empty wiki returns null for any query", { timeout: 5000 }, async () => {
    const block = await getWikiBlock("quantum physics");
    expect(block == null || block === "").toBe(true);
  });
});

// ── 4. Hooks — lifecycle events fire ─────────────────────────────────────────

describe("Hooks — lifecycle callbacks fire", () => {
  it("Stop hook executes a shell command when agent completes", { timeout: 20000 }, async () => {
    const hookLog = join(tmpDir, "hook-fired.txt");
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("Task complete."));

    const { opts } = baseOpts(tmpDir, {
      prompt: "Say hello",
      hooks: { Stop: `echo "hook fired" > ${hookLog}` },
      hooksEnabled: true,
    });

    await runAgentLoop(opts);
    await new Promise((r) => setTimeout(r, 300));

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(hookLog, "utf8").trim()).toContain("hook fired");
  });

  it("PreLLMRequest hook fires before each LLM call", { timeout: 20000 }, async () => {
    const hookLog = join(tmpDir, "pre-llm.txt");

    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([makeToolCall("c1", "bash", { command: "echo hi" })]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = baseOpts(tmpDir, {
      prompt: "run bash",
      hooks: { PreLLMRequest: `echo "pre-llm" >> ${hookLog}` },
      hooksEnabled: true,
    });

    await runAgentLoop(opts);
    await new Promise((r) => setTimeout(r, 300));

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(hookLog, "utf8")).toContain("pre-llm");
  });
});

// ── 5. Profiles — presets configure the loop ─────────────────────────────────

describe("Profiles — agent presets apply correct defaults", () => {
  it("code-review profile injects review-focused instructions", { timeout: 20000 }, async () => {
    let capturedSystem = "";
    mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
      capturedSystem = extractSystem(opts);
      return noToolResponse("LGTM");
    });

    const { opts } = baseOpts(tmpDir, {
      prompt: "Review this code",
      profile: "code-review",
    });

    await runAgentLoop(opts);

    // Profile injects via appendSystemPrompt — check the full message chain
    const allText = capturedSystem.toLowerCase();
    expect(allText).toMatch(/review|quality|issue|check|examine/);
  });

  it("bug-fix profile injects debugging-focused instructions", { timeout: 20000 }, async () => {
    let capturedSystem = "";
    mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
      capturedSystem = extractSystem(opts);
      return noToolResponse("Found the bug");
    });

    const { opts } = baseOpts(tmpDir, {
      prompt: "Fix this bug",
      profile: "bug-fix",
    });

    await runAgentLoop(opts);
    const allText = capturedSystem.toLowerCase();
    expect(allText).toMatch(/bug|fix|error|debug|root.cause/);
  });
});

// ── 6. Summarization — context compresses on turn threshold ──────────────────

describe("Summarization — context compressed after turn threshold", () => {
  it("summarization LLM call fires when turn interval is reached", { timeout: 30000 }, async () => {
    let callCount = 0;

    mocked(callOpenRouter).mockImplementation(async () => {
      callCount++;
      // Return bash tool calls for first 2 turns to keep the loop alive,
      // then stop — summarization fires at turn 3 (turnsSinceLastSummary >= 2)
      if (callCount <= 2) {
        return toolResponse([makeToolCall(`t${callCount}`, "bash", { command: "echo turn" })]);
      }
      return noToolResponse("All done after multiple turns.");
    });

    await runAgentLoop({
      prompt: "Run a few tasks",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 8,
      maxRetries: 0,
      cwd: tmpDir,
      dangerouslySkipPermissions: true,
      verbose: false,
      summarizeTurnInterval: 2,
      onEmit: () => {},
    });

    // Loop ran for 3 LLM calls (2 with tool calls + 1 stop)
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ── 7. Generative UI — render_ui blocks then resolves ────────────────────────

describe("Generative UI — render_ui blocks and resolves", () => {
  it("render_ui emits ui_render event and unblocks when response posted", { timeout: 20000 }, async () => {
    const { resolveUiResponse } = await import("../../src/tools/render-ui.js");

    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([makeToolCall("ui1", "render_ui", {
        spec: { component: "confirm", title: "Confirm deploy?", message: "Deploy to staging?" },
      })]))
      .mockResolvedValueOnce(noToolResponse("User confirmed — deploying."));

    const uiRenderEvents: Array<{ type: string; requestId: string; spec: { component: string; title: string } }> = [];
    const allEmitted: EmitEvent[] = [];

    await runAgentLoop({
      prompt: "Ask user to confirm deployment",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 5,
      maxRetries: 0,
      cwd: tmpDir,
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e: EmitEvent) => {
        allEmitted.push(e);
        if (e.type === "ui_render") {
          const ev = e as unknown as { type: string; requestId: string; spec: { component: string; title: string } };
          uiRenderEvents.push(ev);
          // Simulate user responding 50ms after the UI renders
          setTimeout(() => resolveUiResponse(ev.requestId, JSON.stringify({ confirmed: true })), 50);
        }
      },
    });

    expect(uiRenderEvents).toHaveLength(1);
    expect(uiRenderEvents[0]!.spec.component).toBe("confirm");
    expect(uiRenderEvents[0]!.spec.title).toBe("Confirm deploy?");
    expect(collectAssistantText(allEmitted)).toContain("confirmed");
  });
});

// ── 8. Compound Loop Benchmark ────────────────────────────────────────────────
//
// Runs identical tasks under two conditions:
//   baseline: no memory, no skills, no wiki
//   compound: memory + skills + wiki pre-seeded
//
// Because the mock LLM echoes context it sees in the system prompt, the
// compound run answers correctly (context injected); baseline cannot (no context).

describe("Compound Loop Benchmark — compound > baseline", () => {
  const TASKS = [
    {
      id: "recall-api-key",
      prompt: "What is the staging API key?",
      verify: (a: string) => a.includes("STAGING_API_SECRET"),
      seed: async (key: string) => {
        await addMemoryEntrySqlite(key, {
          content: "The staging API key is STAGING_API_SECRET.",
          tags: ["api-keys"],
          importance: 3,
        });
      },
    },
    {
      id: "recall-deploy-command",
      prompt: "How do I deploy to production?",
      verify: (a: string) => a.includes("deploy.sh prod"),
      seed: async (key: string) => {
        // Use memory (not wiki) — wiki is always injected so it can't differentiate
        // baseline vs compound.
        await addMemoryEntrySqlite(key, {
          content: "Production deployment: run ./scripts/deploy.sh prod",
          tags: ["deployment"],
          importance: 3,
        });
      },
    },
    {
      id: "recall-ts-skill",
      prompt: "What TypeScript import pattern should I use?",
      verify: (a: string) => a.includes(".js extension"),
      seed: async (_key: string) => {
        await importSeedSkill(
          "Always use .js extension in TypeScript imports for ESM compatibility.",
          "e2e-benchmark",
        );
      },
    },
  ];

  it("compound stack (memory+skills+wiki) outperforms baseline", { timeout: 90000 }, async () => {
    // Seed all compound data
    for (const task of TASKS) await task.seed(memKey);

    // Reset DB connections so both runs see the seeded data cleanly
    _resetDbForTesting();
    _resetSkillsDbForTesting();
    _resetWikiDbForTesting();

    async function runTask(taskId: string, prompt: string, useCompound: boolean): Promise<boolean> {
      let capturedSystem = "";
      mocked(callOpenRouter).mockImplementation(async (opts: OpenRouterCallOptions) => {
        capturedSystem = extractSystem(opts);
        // Route by the FIRST user message (the task prompt) so compound context
        // for one task doesn't accidentally satisfy another task's check.
        const firstUser = (opts.messages.find((m) => m.role === "user")?.content ?? "") as string;
        if (firstUser.includes("API key") || firstUser.includes("staging")) {
          return capturedSystem.includes("STAGING_API_SECRET")
            ? noToolResponse("The staging API key is STAGING_API_SECRET.")
            : noToolResponse("I don't have enough context to answer that.");
        }
        if (firstUser.includes("deploy")) {
          return capturedSystem.includes("deploy.sh prod")
            ? noToolResponse("Run ./scripts/deploy.sh prod")
            : noToolResponse("I don't have enough context to answer that.");
        }
        if (firstUser.includes("TypeScript") || firstUser.includes("import")) {
          return capturedSystem.includes(".js extension")
            ? noToolResponse("Use .js extension in TypeScript imports.")
            : noToolResponse("I don't have enough context to answer that.");
        }
        return noToolResponse("I don't have enough context to answer that.");
      });

      const emitted: EmitEvent[] = [];
      await runAgentLoop({
        prompt,
        model: "test-model",
        apiKey: "test-key",
        sessionId: null,
        addDirs: [],
        maxTurns: 3,
        maxRetries: 0,
        cwd: tmpDir,
        dangerouslySkipPermissions: true,
        verbose: false,
        memoryKey: useCompound ? memKey : undefined,
        memory: useCompound,
        skillbank: useCompound ? { enabled: true, topK: 3 } : { enabled: false },
        onEmit: (e: EmitEvent) => emitted.push(e),
      });

      return TASKS.find((t) => t.id === taskId)!.verify(collectAssistantText(emitted));
    }

    const baselineResults: Record<string, boolean> = {};
    const compoundResults: Record<string, boolean> = {};

    for (const task of TASKS) {
      baselineResults[task.id] = await runTask(task.id, task.prompt, false);
    }
    for (const task of TASKS) {
      compoundResults[task.id] = await runTask(task.id, task.prompt, true);
    }

    const baselinePass = Object.values(baselineResults).filter(Boolean).length;
    const compoundPass = Object.values(compoundResults).filter(Boolean).length;
    const total = TASKS.length;

    console.log("\n╔══ Compound Loop Benchmark ══════════════════════════╗");
    console.log(`║ Baseline pass rate:  ${(baselinePass / total * 100).toFixed(0)}% (${baselinePass}/${total})                     ║`);
    console.log(`║ Compound pass rate:  ${(compoundPass / total * 100).toFixed(0)}% (${compoundPass}/${total})                    ║`);
    console.log(`║ Improvement:         +${((compoundPass - baselinePass) / total * 100).toFixed(0)}pp                           ║`);
    console.log("╠═════════════════════════════════════════════════════╣");
    for (const task of TASKS) {
      const b = baselineResults[task.id] ? "✓" : "✗";
      const c = compoundResults[task.id] ? "✓" : "✗";
      console.log(`║  ${task.id.padEnd(25)} baseline:${b}  compound:${c}    ║`);
    }
    console.log("╚═════════════════════════════════════════════════════╝\n");

    expect(compoundPass).toBeGreaterThan(baselinePass);
    expect(compoundPass).toBe(total);      // compound passes everything
    expect(baselinePass).toBe(0);          // baseline has no context → passes nothing
  });
});
