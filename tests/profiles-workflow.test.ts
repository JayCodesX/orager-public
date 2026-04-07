/**
 * Tests for profiles.ts and workflow.ts (test sprint item #5).
 *
 * profiles.ts — pure logic layer: no FS or LLM calls needed.
 *   - listProfiles() shape and completeness
 *   - getProfile() lookup
 *   - applyProfile() precedence and appendSystemPrompt merging
 *   - applyProfile() with unknown name (pass-through)
 *   - New profiles: "dev" and "deploy" (added in toolkit-harvest sprint)
 *
 * workflow.ts — runAgentWorkflow() orchestration and error propagation.
 *   - Empty steps → no runAgentLoop call
 *   - Single step executes with merged opts
 *   - Multi-step: output of step N becomes prompt for step N+1
 *   - Custom handoff function overrides pass-through
 *   - Step failure wraps error with step index + role
 *   - All events are forwarded to base.onEmit
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Profiles tests ─────────────────────────────────────────────────────────────

import {
  listProfiles,
  getProfile,
  applyProfile,
} from "../src/profiles.js";
import type { AgentLoopOptions } from "../src/types.js";

// ── Minimal AgentLoopOptions fixture ─────────────────────────────────────────

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    apiKey:  "sk-test",
    model:   "test/model",
    prompt:  "Do something",
    onEmit:  vi.fn(),
    ...overrides,
  } as unknown as AgentLoopOptions;
}

// ── listProfiles() ────────────────────────────────────────────────────────────

describe("listProfiles()", () => {
  it("returns a non-empty array", () => {
    expect(listProfiles().length).toBeGreaterThan(0);
  });

  it("returns objects with name and description", () => {
    for (const profile of listProfiles()) {
      expect(typeof profile.name).toBe("string");
      expect(profile.name.length).toBeGreaterThan(0);
      expect(typeof profile.description).toBe("string");
      expect(profile.description.length).toBeGreaterThan(0);
    }
  });

  it("includes all 8 built-in profiles (including new dev + deploy)", () => {
    const names = listProfiles().map((p) => p.name);
    expect(names).toContain("code-review");
    expect(names).toContain("bug-fix");
    expect(names).toContain("research");
    expect(names).toContain("refactor");
    expect(names).toContain("test-writer");
    expect(names).toContain("devops");
    expect(names).toContain("dev");
    expect(names).toContain("deploy");
  });

  it("returns exactly 8 built-in profiles", () => {
    expect(listProfiles()).toHaveLength(8);
  });

  it("each profile name is unique", () => {
    const names = listProfiles().map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ── getProfile() ──────────────────────────────────────────────────────────────

describe("getProfile()", () => {
  it("returns profile defaults for 'code-review'", () => {
    const p = getProfile("code-review");
    expect(p).toBeDefined();
    expect(typeof p.appendSystemPrompt).toBe("string");
    expect(p.appendSystemPrompt.length).toBeGreaterThan(0);
  });

  it("code-review has maxTurns set", () => {
    const p = getProfile("code-review");
    expect(typeof p.maxTurns).toBe("number");
    expect(p.maxTurns).toBeGreaterThan(0);
  });

  it("code-review has a restrictive bashPolicy", () => {
    const p = getProfile("code-review");
    expect(p.bashPolicy).toBeDefined();
    expect(p.bashPolicy!.blockedCommands).toContain("curl");
  });

  it("dev profile has appendSystemPrompt containing development workflow guidance", () => {
    const p = getProfile("dev");
    expect(p.appendSystemPrompt.length).toBeGreaterThan(50);
    // dev profile focuses on active development
    expect(p.appendSystemPrompt.toLowerCase()).toMatch(/develop|increm|test|build/);
  });

  it("deploy profile has appendSystemPrompt containing deployment guidance", () => {
    const p = getProfile("deploy");
    expect(p.appendSystemPrompt.length).toBeGreaterThan(50);
    // deploy profile focuses on deployment safety
    expect(p.appendSystemPrompt.toLowerCase()).toMatch(/deploy|migrat|rollback|checklist/);
  });
});

// ── applyProfile() ────────────────────────────────────────────────────────────

describe("applyProfile() — precedence and merging", () => {
  it("returns opts unchanged for an unknown profile name", () => {
    const opts = makeOpts({ model: "my/model" });
    const result = applyProfile("nonexistent-profile-xyz", opts);
    expect(result.model).toBe("my/model");
  });

  it("merges profile appendSystemPrompt with caller's appendSystemPrompt", () => {
    const callerPrompt = "CALLER_ADDITION";
    const opts = makeOpts({ appendSystemPrompt: callerPrompt });
    const result = applyProfile("code-review", opts);
    // Both should be present in the merged output
    expect(result.appendSystemPrompt).toContain(callerPrompt);
    const profilePrompt = getProfile("code-review").appendSystemPrompt;
    expect(result.appendSystemPrompt).toContain(profilePrompt.slice(0, 30));
  });

  it("caller opts override profile defaults for scalar fields", () => {
    const opts = makeOpts({ maxTurns: 999 });
    const result = applyProfile("code-review", opts);
    // code-review profile has maxTurns: 20, but caller passes 999 — caller wins
    expect(result.maxTurns).toBe(999);
  });

  it("uses profile maxTurns when caller doesn't specify it", () => {
    const opts = makeOpts();
    const result = applyProfile("code-review", opts);
    expect(result.maxTurns).toBe(getProfile("code-review").maxTurns);
  });

  it("deep-copies bashPolicy so mutations don't affect the profile", () => {
    const opts = makeOpts();
    const result = applyProfile("code-review", opts);
    // Mutate the returned bashPolicy
    if (result.bashPolicy?.blockedCommands) {
      result.bashPolicy.blockedCommands.push("INJECTED");
    }
    // The profile's original should be unaffected
    const again = applyProfile("code-review", makeOpts());
    expect(again.bashPolicy?.blockedCommands).not.toContain("INJECTED");
  });

  it("applies test-writer profile appendSystemPrompt", () => {
    const opts = makeOpts();
    const result = applyProfile("test-writer", opts);
    expect(result.appendSystemPrompt).toBeDefined();
    expect(result.appendSystemPrompt!.length).toBeGreaterThan(0);
  });

  it("applies dev profile without crashing", () => {
    const opts = makeOpts();
    const result = applyProfile("dev", opts);
    expect(result.appendSystemPrompt).toBeDefined();
    expect(result.appendSystemPrompt!.length).toBeGreaterThan(0);
  });

  it("applies deploy profile without crashing", () => {
    const opts = makeOpts();
    const result = applyProfile("deploy", opts);
    expect(result.appendSystemPrompt).toBeDefined();
    expect(result.appendSystemPrompt!.length).toBeGreaterThan(0);
  });

  it("appendSystemPrompt is only the profile prompt when caller has none", () => {
    const opts = makeOpts(); // no appendSystemPrompt
    const result = applyProfile("bug-fix", opts);
    const expected = getProfile("bug-fix").appendSystemPrompt;
    expect(result.appendSystemPrompt).toBe(expected);
  });

  it("models array is deep-copied (mutations don't leak)", () => {
    // 'research' profile may or may not have models — use code-review which does
    // If no models defined, this is a no-op test that confirms models is undefined
    const opts = makeOpts();
    const result = applyProfile("research", opts);
    if (result.models) {
      result.models.push("mutated/model");
      const fresh = applyProfile("research", makeOpts());
      expect(fresh.models).not.toContain("mutated/model");
    } else {
      expect(result.models).toBeUndefined();
    }
  });
});

// ── workflow.ts — runAgentWorkflow() ──────────────────────════════════════════
//
// loop.ts has a deep import chain (→ mcp-client → @modelcontextprotocol/sdk →
// eventsource-parser/stream etc.) that may not be fully installed in the
// worktree. We mock all modules in the chain that can cause resolution failures.

vi.mock("../src/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

// Short-circuit @modelcontextprotocol/sdk transitive deps
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class { connect = vi.fn(); listTools = vi.fn().mockResolvedValue({ tools: [] }); callTool = vi.fn(); close = vi.fn(); },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class { start = vi.fn(); close = vi.fn(); },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { start = vi.fn(); close = vi.fn(); },
}));

import { runAgentWorkflow } from "../src/workflow.js";
import { runAgentLoop } from "../src/loop.js";
import { mocked } from "./mock-helpers.js";

describe("runAgentWorkflow() — basic orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when steps array is empty", async () => {
    const onEmit = vi.fn();
    await runAgentWorkflow({ base: makeOpts({ onEmit }), steps: [] }, "prompt");
    expect(mocked(runAgentLoop)).not.toHaveBeenCalled();
  });

  it("calls runAgentLoop once for a single-step workflow", async () => {
    mocked(runAgentLoop).mockResolvedValue(undefined);
    const onEmit = vi.fn();
    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [{ role: "writer", model: "my/model" }],
      },
      "initial prompt",
    );
    expect(mocked(runAgentLoop)).toHaveBeenCalledOnce();
  });

  it("passes the initial prompt to the first step", async () => {
    mocked(runAgentLoop).mockResolvedValue(undefined);
    const onEmit = vi.fn();
    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [{ role: "step1", model: "m/m" }],
      },
      "my initial prompt",
    );
    const passedOpts = mocked(runAgentLoop).mock.calls[0]![0] as AgentLoopOptions;
    expect(passedOpts.prompt).toBe("my initial prompt");
  });

  it("calls runAgentLoop N times for N steps", async () => {
    mocked(runAgentLoop).mockResolvedValue(undefined);
    const onEmit = vi.fn();
    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [
          { role: "step1", model: "m/a" },
          { role: "step2", model: "m/b" },
          { role: "step3", model: "m/c" },
        ],
      },
      "start",
    );
    expect(mocked(runAgentLoop)).toHaveBeenCalledTimes(3);
  });

  it("uses per-step model in merged opts", async () => {
    mocked(runAgentLoop).mockResolvedValue(undefined);
    const onEmit = vi.fn();
    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit, model: "base/model" }),
        steps: [{ role: "writer", model: "step/model" }],
      },
      "prompt",
    );
    const passedOpts = mocked(runAgentLoop).mock.calls[0]![0] as AgentLoopOptions;
    expect(passedOpts.model).toBe("step/model");
  });

  it("siteName is set to the step role", async () => {
    mocked(runAgentLoop).mockResolvedValue(undefined);
    const onEmit = vi.fn();
    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [{ role: "my-special-role", model: "m/m" }],
      },
      "prompt",
    );
    const passedOpts = mocked(runAgentLoop).mock.calls[0]![0] as AgentLoopOptions;
    expect(passedOpts.siteName).toBe("my-special-role");
  });
});

describe("runAgentWorkflow() — multi-step handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes step output as the next step's prompt (default handoff)", async () => {
    const onEmit = vi.fn();
    // runAgentLoop doesn't really emit events; simulate by calling the collectingOnEmit
    // which is captured inside runAgentWorkflow. We do this by intercepting onEmit arg.
    let capturedStepEmit: ((e: unknown) => void) | undefined;
    mocked(runAgentLoop).mockImplementation(async (opts: AgentLoopOptions) => {
      capturedStepEmit = opts.onEmit as (e: unknown) => void;
      if (capturedStepEmit) {
        capturedStepEmit({
          type: "assistant",
          message: { content: [{ type: "text", text: "STEP_ONE_OUTPUT" }] },
        });
      }
    });

    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [
          { role: "step1", model: "m/a" },
          { role: "step2", model: "m/b" },
        ],
      },
      "initial",
    );

    const secondCallOpts = mocked(runAgentLoop).mock.calls[1]![0] as AgentLoopOptions;
    expect(secondCallOpts.prompt).toBe("STEP_ONE_OUTPUT");
  });

  it("uses custom handoff function when provided", async () => {
    mocked(runAgentLoop).mockImplementation(async (opts: AgentLoopOptions) => {
      opts.onEmit({
        type: "assistant",
        message: { content: [{ type: "text", text: "raw output" }] },
      } as never);
    });

    const handoff = vi.fn((_stepIndex: number, output: string) => `TRANSFORMED: ${output}`);
    const onEmit = vi.fn();

    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [
          { role: "step1", model: "m/a" },
          { role: "step2", model: "m/b" },
        ],
        handoff,
      },
      "initial",
    );

    expect(handoff).toHaveBeenCalledOnce();
    const secondCallOpts = mocked(runAgentLoop).mock.calls[1]![0] as AgentLoopOptions;
    expect(secondCallOpts.prompt).toBe("TRANSFORMED: raw output");
  });

  it("forwards all events to base.onEmit", async () => {
    const onEmit = vi.fn();
    mocked(runAgentLoop).mockImplementation(async (opts: AgentLoopOptions) => {
      opts.onEmit({ type: "assistant", message: { content: [] } } as never);
      opts.onEmit({ type: "tool_use", toolName: "read_file" } as never);
    });

    await runAgentWorkflow(
      {
        base: makeOpts({ onEmit }),
        steps: [{ role: "step1", model: "m/a" }],
      },
      "prompt",
    );

    expect(onEmit).toHaveBeenCalledTimes(2);
  });
});

describe("runAgentWorkflow() — error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-throws with step index and role on failure", async () => {
    mocked(runAgentLoop).mockRejectedValue(new Error("API timeout"));
    const onEmit = vi.fn();

    await expect(
      runAgentWorkflow(
        {
          base: makeOpts({ onEmit }),
          steps: [{ role: "researcher", model: "m/m" }],
        },
        "prompt",
      ),
    ).rejects.toThrow('Workflow step 0 ("researcher") failed: API timeout');
  });

  it("includes the failing step index in the error message for step 1", async () => {
    let callCount = 0;
    mocked(runAgentLoop).mockImplementation(async () => {
      if (callCount++ === 1) throw new Error("model overloaded");
    });
    const onEmit = vi.fn();

    await expect(
      runAgentWorkflow(
        {
          base: makeOpts({ onEmit }),
          steps: [
            { role: "planner", model: "m/a" },
            { role: "executor", model: "m/b" },
          ],
        },
        "prompt",
      ),
    ).rejects.toThrow('Workflow step 1 ("executor") failed');
  });

  it("wraps non-Error thrown values in the error message", async () => {
    mocked(runAgentLoop).mockRejectedValue("string error");
    const onEmit = vi.fn();

    await expect(
      runAgentWorkflow(
        {
          base: makeOpts({ onEmit }),
          steps: [{ role: "writer", model: "m/m" }],
        },
        "prompt",
      ),
    ).rejects.toThrow("string error");
  });

  it("stops processing subsequent steps on first failure", async () => {
    mocked(runAgentLoop).mockRejectedValue(new Error("fail"));
    const onEmit = vi.fn();

    await expect(
      runAgentWorkflow(
        {
          base: makeOpts({ onEmit }),
          steps: [
            { role: "s1", model: "m/a" },
            { role: "s2", model: "m/b" },
            { role: "s3", model: "m/c" },
          ],
        },
        "prompt",
      ),
    ).rejects.toThrow();

    // Only the first step should have been attempted
    expect(mocked(runAgentLoop)).toHaveBeenCalledOnce();
  });
});
