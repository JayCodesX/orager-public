/**
 * Tests for AgentWorkflow / AgentConfig / runAgentWorkflow (Ticket 1).
 *
 * runAgentLoop is mocked — these tests verify orchestration logic only:
 *   - steps run in order
 *   - each step receives the correct merged AgentLoopOptions
 *   - default handoff passes previous step output as next prompt
 *   - custom handoff function is called with stepIndex + output
 *   - empty steps list is a no-op
 *   - per-step overrides (model, temperature, memoryKey, maxTurns, maxCostUsd) are applied
 *   - base fields not overridden by a step are preserved
 *   - multi-context memoryKey array is forwarded correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLoopOptions, EmitEvent } from "../src/types.js";
import type { AgentConfig, AgentWorkflow, ParallelGroup } from "../src/types.js";
import { runAgentWorkflow } from "../src/workflow.js";
import { mocked } from "./mock-helpers.js";

// ── Mock runAgentLoop ────────────────────────────────────────────────────────

vi.mock("../src/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

import { runAgentLoop } from "../src/loop.js";
const mockRunAgentLoop = mocked(runAgentLoop);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBaseConfig(): Omit<AgentLoopOptions, "prompt" | "model"> {
  return {
    apiKey: "test-key",
    sessionId: null,
    addDirs: [],
    maxTurns: 10,
    cwd: "/tmp",
    dangerouslySkipPermissions: false,
    verbose: false,
    onEmit: vi.fn(),
  };
}

/** Make runAgentLoop emit an assistant text event so output can be captured. */
function stubOutput(text: string) {
  mockRunAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
    opts.onEmit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    } as EmitEvent);
  });
}

beforeEach(() => {
  mockRunAgentLoop.mockReset();
  // Default stub: no output
  mockRunAgentLoop.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAgentWorkflow", () => {
  it("is a no-op for empty steps", async () => {
    const workflow: AgentWorkflow = { base: makeBaseConfig(), steps: [] };
    await runAgentWorkflow(workflow, "hello");
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  it("runs a single step with the initial prompt", async () => {
    const base = makeBaseConfig();
    const workflow: AgentWorkflow = {
      base,
      steps: [{ role: "researcher", model: "deepseek/deepseek-r1" }],
    };
    await runAgentWorkflow(workflow, "research this");
    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    const opts = mockRunAgentLoop.mock.calls[0]![0];
    expect(opts.prompt).toBe("research this");
    expect(opts.model).toBe("deepseek/deepseek-r1");
  });

  it("runs steps in order", async () => {
    const order: string[] = [];
    mockRunAgentLoop.mockImplementation(async (opts: AgentLoopOptions) => {
      order.push(opts.siteName ?? "");
    });

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { role: "researcher", model: "deepseek/deepseek-r1" },
        { role: "synthesizer", model: "anthropic/claude-sonnet-4-6" },
      ],
    };
    await runAgentWorkflow(workflow, "start");
    expect(order).toEqual(["researcher", "synthesizer"]);
  });

  it("default handoff passes previous step output as next prompt", async () => {
    stubOutput("research findings");
    mockRunAgentLoop.mockResolvedValueOnce(undefined); // second step — no output needed

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { role: "researcher", model: "deepseek/deepseek-r1" },
        { role: "synthesizer", model: "anthropic/claude-sonnet-4-6" },
      ],
    };
    await runAgentWorkflow(workflow, "initial");

    const secondCallOpts = mockRunAgentLoop.mock.calls[1]![0];
    expect(secondCallOpts.prompt).toBe("research findings");
  });

  it("custom handoff receives stepIndex and output, returns next prompt", async () => {
    stubOutput("raw output");
    mockRunAgentLoop.mockResolvedValueOnce(undefined);

    const handoff = vi.fn((idx: number, out: string) => `step ${idx} done: ${out}`);
    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { role: "a", model: "model-a" },
        { role: "b", model: "model-b" },
      ],
      handoff,
    };
    await runAgentWorkflow(workflow, "go");

    expect(handoff).toHaveBeenCalledWith(0, "raw output");
    const secondPrompt = mockRunAgentLoop.mock.calls[1]![0].prompt;
    expect(secondPrompt).toBe("step 0 done: raw output");
  });

  it("per-step overrides replace base values", async () => {
    const base = makeBaseConfig();
    const workflow: AgentWorkflow = {
      base: { ...base, maxTurns: 5, temperature: 0.5 },
      steps: [{
        role: "agent",
        model: "override-model",
        temperature: 0.1,
        maxTurns: 2,
        maxCostUsd: 1.50,
        appendSystemPrompt: "Be concise.",
      }],
    };
    await runAgentWorkflow(workflow, "go");
    const opts = mockRunAgentLoop.mock.calls[0]![0];
    expect(opts.model).toBe("override-model");
    expect(opts.temperature).toBe(0.1);
    expect(opts.maxTurns).toBe(2);
    expect(opts.maxCostUsd).toBe(1.50);
    expect(opts.appendSystemPrompt).toBe("Be concise.");
  });

  it("base fields not overridden by step are preserved", async () => {
    const base = makeBaseConfig();
    const workflow: AgentWorkflow = {
      base: { ...base, maxTurns: 20, apiKey: "my-key" },
      steps: [{ role: "agent", model: "some-model" }],
    };
    await runAgentWorkflow(workflow, "go");
    const opts = mockRunAgentLoop.mock.calls[0]![0];
    expect(opts.maxTurns).toBe(20);
    expect(opts.apiKey).toBe("my-key");
  });

  it("forwards multi-context memoryKey array to the step", async () => {
    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [{
        role: "agent",
        model: "m",
        memoryKey: ["primary-ns", "shared-ns"],
      }],
    };
    await runAgentWorkflow(workflow, "go");
    const opts = mockRunAgentLoop.mock.calls[0]![0];
    expect(opts.memoryKey).toEqual(["primary-ns", "shared-ns"]);
  });

  it("step without memoryKey inherits base memoryKey", async () => {
    const workflow: AgentWorkflow = {
      base: { ...makeBaseConfig(), memoryKey: "base-ns" },
      steps: [{ role: "agent", model: "m" }],
    };
    await runAgentWorkflow(workflow, "go");
    const opts = mockRunAgentLoop.mock.calls[0]![0];
    expect(opts.memoryKey).toBe("base-ns");
  });

  it("forwards all emitted events to the caller onEmit", async () => {
    const callerOnEmit = vi.fn();
    mockRunAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
      opts.onEmit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } as EmitEvent);
      opts.onEmit({ type: "system", subtype: "max_turns" } as unknown as EmitEvent);
    });

    const workflow: AgentWorkflow = {
      base: { ...makeBaseConfig(), onEmit: callerOnEmit },
      steps: [{ role: "agent", model: "m" }],
    };
    await runAgentWorkflow(workflow, "go");
    expect(callerOnEmit).toHaveBeenCalledTimes(2);
  });

  it("handoff is not called after the last step", async () => {
    const handoff = vi.fn((idx: number, out: string) => out);
    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [{ role: "only", model: "m" }],
      handoff,
    };
    await runAgentWorkflow(workflow, "go");
    expect(handoff).not.toHaveBeenCalled();
  });
});

// ── Parallel workflow tests ──────────────────────────────────────────────────

describe("runAgentWorkflow — parallel groups", () => {
  it("runs agents in a ParallelGroup concurrently", async () => {
    const startTimes: number[] = [];
    mockRunAgentLoop.mockImplementation(async (opts: AgentLoopOptions) => {
      startTimes.push(Date.now());
      // Emit some output per agent
      opts.onEmit({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `output-${opts.siteName}` }] },
      } as EmitEvent);
      // Small delay to verify concurrency
      await new Promise((r) => setTimeout(r, 20));
    });

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { parallel: [
          { role: "agent-a", model: "model-a" },
          { role: "agent-b", model: "model-b" },
          { role: "agent-c", model: "model-c" },
        ] } satisfies ParallelGroup,
      ],
    };
    await runAgentWorkflow(workflow, "go parallel");

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(3);
    // All three should have started within a few ms of each other (concurrent)
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(15); // well under the 20ms delay
  });

  it("parallel group agents all receive the same prompt", async () => {
    mockRunAgentLoop.mockResolvedValue(undefined);

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { parallel: [
          { role: "a", model: "m1" },
          { role: "b", model: "m2" },
        ] } satisfies ParallelGroup,
      ],
    };
    await runAgentWorkflow(workflow, "shared prompt");

    expect(mockRunAgentLoop.mock.calls[0]![0].prompt).toBe("shared prompt");
    expect(mockRunAgentLoop.mock.calls[1]![0].prompt).toBe("shared prompt");
  });

  it("parallel outputs are joined with separator before handoff to next step", async () => {
    // Parallel step: two agents output different text
    mockRunAgentLoop
      .mockImplementationOnce(async (opts: AgentLoopOptions) => {
        opts.onEmit({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "alpha" }] },
        } as EmitEvent);
      })
      .mockImplementationOnce(async (opts: AgentLoopOptions) => {
        opts.onEmit({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "beta" }] },
        } as EmitEvent);
      })
      // Sequential step after: capture prompt
      .mockResolvedValueOnce(undefined);

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { parallel: [
          { role: "a", model: "m" },
          { role: "b", model: "m" },
        ] } satisfies ParallelGroup,
        { role: "synthesizer", model: "m" },
      ],
    };
    await runAgentWorkflow(workflow, "start");

    const synthesizerPrompt = mockRunAgentLoop.mock.calls[2]![0].prompt;
    expect(synthesizerPrompt).toBe("alpha\n---\nbeta");
  });

  it("mixed sequential and parallel steps work together", async () => {
    const order: string[] = [];
    mockRunAgentLoop.mockImplementation(async (opts: AgentLoopOptions) => {
      order.push(opts.siteName ?? "unknown");
      opts.onEmit({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `out-${opts.siteName}` }] },
      } as EmitEvent);
    });

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { role: "researcher", model: "m" },
        { parallel: [
          { role: "reviewer-a", model: "m" },
          { role: "reviewer-b", model: "m" },
        ] } satisfies ParallelGroup,
        { role: "synthesizer", model: "m" },
      ],
    };
    await runAgentWorkflow(workflow, "initial");

    // researcher runs first, then two reviewers (parallel), then synthesizer
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(4);
    expect(order[0]).toBe("researcher");
    // reviewers can be in any order (parallel)
    expect(order.slice(1, 3).sort()).toEqual(["reviewer-a", "reviewer-b"]);
    expect(order[3]).toBe("synthesizer");
  });

  it("error in one parallel agent propagates with role info", async () => {
    mockRunAgentLoop
      .mockResolvedValueOnce(undefined) // agent-a succeeds
      .mockRejectedValueOnce(new Error("model overloaded")); // agent-b fails

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { parallel: [
          { role: "agent-a", model: "m" },
          { role: "agent-b", model: "m" },
        ] } satisfies ParallelGroup,
      ],
    };

    await expect(runAgentWorkflow(workflow, "go")).rejects.toThrow(/agent-b.*model overloaded/);
  });

  it("empty parallel group produces empty output", async () => {
    mockRunAgentLoop.mockResolvedValue(undefined);

    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { parallel: [] } satisfies ParallelGroup,
        { role: "next", model: "m" },
      ],
    };
    await runAgentWorkflow(workflow, "start");

    // The "next" step should receive empty string as prompt
    const nextPrompt = mockRunAgentLoop.mock.calls[0]![0].prompt;
    expect(nextPrompt).toBe("");
  });

  it("per-step overrides apply within parallel agents", async () => {
    mockRunAgentLoop.mockResolvedValue(undefined);

    const workflow: AgentWorkflow = {
      base: { ...makeBaseConfig(), maxTurns: 10 },
      steps: [
        { parallel: [
          { role: "fast", model: "fast-model", maxTurns: 3, temperature: 0.1 },
          { role: "deep", model: "deep-model", maxTurns: 20, maxCostUsd: 5.0 },
        ] } satisfies ParallelGroup,
      ],
    };
    await runAgentWorkflow(workflow, "go");

    const fastOpts = mockRunAgentLoop.mock.calls.find((c) => c[0].siteName === "fast")![0];
    const deepOpts = mockRunAgentLoop.mock.calls.find((c) => c[0].siteName === "deep")![0];

    expect(fastOpts.model).toBe("fast-model");
    expect(fastOpts.maxTurns).toBe(3);
    expect(fastOpts.temperature).toBe(0.1);

    expect(deepOpts.model).toBe("deep-model");
    expect(deepOpts.maxTurns).toBe(20);
    expect(deepOpts.maxCostUsd).toBe(5.0);
  });

  it("custom handoff works after a parallel step", async () => {
    mockRunAgentLoop
      .mockImplementationOnce(async (opts: AgentLoopOptions) => {
        opts.onEmit({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "result-a" }] },
        } as EmitEvent);
      })
      .mockImplementationOnce(async (opts: AgentLoopOptions) => {
        opts.onEmit({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "result-b" }] },
        } as EmitEvent);
      })
      .mockResolvedValueOnce(undefined);

    const handoff = vi.fn((idx: number, out: string) => `[summary] ${out}`);
    const workflow: AgentWorkflow = {
      base: makeBaseConfig(),
      steps: [
        { parallel: [
          { role: "a", model: "m" },
          { role: "b", model: "m" },
        ] } satisfies ParallelGroup,
        { role: "final", model: "m" },
      ],
      handoff,
    };
    await runAgentWorkflow(workflow, "start");

    expect(handoff).toHaveBeenCalledWith(0, "result-a\n---\nresult-b");
    const finalPrompt = mockRunAgentLoop.mock.calls[2]![0].prompt;
    expect(finalPrompt).toBe("[summary] result-a\n---\nresult-b");
  });
});
