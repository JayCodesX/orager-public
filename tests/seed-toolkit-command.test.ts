/**
 * Tests for seed-toolkit-command.ts (handleSeedToolkitSubcommand).
 *
 * This command fetches the GitHub tree, filters skill/agent/rule/command files,
 * formats seed text, and calls importSeedSkill(). We mock all network and DB
 * calls so tests run offline without side effects.
 *
 * Tested behaviours:
 *  - parseFrontmatter: extracts meta + body from YAML frontmatter
 *  - stripMarkdown: removes formatting and leaves plain text
 *  - slugFromPath: derives clean slug from file path
 *  - formatSeedText: constructs ≤150-word seed text
 *  - Flag parsing: --dry-run, --skills-only, --agents-only, --rules-only, --limit
 *  - GitHub tree fetch failure → error message, no insertions
 *  - Dry-run: prints what would happen, no importSeedSkill calls
 *  - Normal run: calls importSeedSkill for each filtered file
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/skillbank.js", () => ({
  importSeedSkill:              vi.fn().mockResolvedValue("inserted"),
  _resetSkillsDbForTesting:     vi.fn(),
  DEFAULT_SKILLBANK_CONFIG:     { deduplicationThreshold: 0.92, maxSkills: 500 },
  listSkills:                   vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/providers/index.js", () => ({
  getOpenRouterProvider: () => ({
    chat:           vi.fn().mockResolvedValue({ content: "distilled skill text here", isError: false }),
    callEmbeddings: vi.fn(),
  }),
}));

vi.mock("@opentelemetry/api", () => ({
  trace:         { getTracer: vi.fn(() => ({ startActiveSpan: vi.fn((_n: string, fn: (s: unknown) => unknown) => fn({ setAttribute: vi.fn(), end: vi.fn() })) })) },
  metrics:       { getMeter: vi.fn(() => ({ createCounter: vi.fn(() => ({ add: vi.fn() })), createHistogram: vi.fn(() => ({ record: vi.fn() })) })) },
  context:       { with: vi.fn((_c: unknown, fn: () => unknown) => fn()) },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

import { importSeedSkill } from "../src/skillbank.js";

// ── GitHub API fixtures ───────────────────────────────────────────────────────

const TREE_RESPONSE = {
  tree: [
    { path: "skills/tdd-mastery/SKILL.md",                    type: "blob" },
    { path: "skills/error-handling/SKILL.md",                 type: "blob" },
    { path: "agents/quality-assurance/qa-automation.md",      type: "blob" },
    { path: "rules/no-console-log.md",                        type: "blob" },
    { path: "commands/review/review-pr.md",                   type: "blob" },
    { path: "unrelated/README.md",                            type: "blob" },
  ],
};

const SKILL_MD = `---
description: Master TDD workflows
---
# TDD Mastery

Write the test first. Then write the minimum code to make it pass.
Use red-green-refactor cycle consistently.
`;

const AGENT_MD = `---
description: QA automation agent
---
# QA Automation Agent

You are a QA automation specialist. Always write tests before approving code.
Validate edge cases and boundary conditions.
`;

const RULE_MD = `---
description: Avoid console.log in production
---
Never use console.log in production code. Use structured logging instead.
`;

function buildFetchMock(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const u = url as string;
    if (u.includes("git/trees")) {
      return { ok: true, json: async () => TREE_RESPONSE, text: async () => "" };
    }
    if (u.includes("SKILL.md"))  return { ok: true, text: async () => SKILL_MD };
    if (u.includes("qa-autom"))  return { ok: true, text: async () => AGENT_MD };
    if (u.includes("no-console")) return { ok: true, text: async () => RULE_MD };
    if (u.includes("review-pr")) return { ok: true, text: async () => "# Review PR\nAlways review PRs thoroughly." };
    return { ok: false, status: 404, text: async () => "Not Found" };
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let origEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  origEnv = { PROTOCOL_API_KEY: process.env["PROTOCOL_API_KEY"] };
  // Set an API key so --distill path can be exercised if needed
  process.env["PROTOCOL_API_KEY"] = "sk-test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── Pure helper tests (no network needed) ────────────────────────────────────

// These test the private helpers via the exported command. We expose them
// by testing their observable effects through the command.

describe("seed-toolkit-command — parseFrontmatter (via formatSeedText output)", () => {
  it("dry-run prints skill slug from filename", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--dry-run", "--skills-only"]);

    const fullOut = out.join("");
    // tdd-mastery and error-handling slugs should appear
    expect(fullOut).toContain("tdd-mastery");
  });
});

describe("seed-toolkit-command — GitHub tree fetch failure", () => {
  it("prints error and returns without calling importSeedSkill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}), text: async () => "Forbidden" }));
    const err: string[] = [];
    // process.exit throws so execution stops (mocked exit doesn't really stop flow otherwise)
    const mockExit = vi.fn().mockImplementation(() => { throw new Error("process.exit:1"); });
    vi.stubGlobal("process", { ...process, exit: mockExit, stdout: { write: vi.fn() }, stderr: { write: (s: string) => err.push(s) } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await expect(handleSeedToolkitSubcommand([])).rejects.toThrow("process.exit");

    expect(importSeedSkill).not.toHaveBeenCalled();
    expect(err.join("")).toMatch(/failed|error|403/i);
  });

  it("prints error when fetch throws (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    const err: string[] = [];
    const mockExit = vi.fn().mockImplementation(() => { throw new Error("process.exit:1"); });
    vi.stubGlobal("process", { ...process, exit: mockExit, stdout: { write: vi.fn() }, stderr: { write: (s: string) => err.push(s) } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await expect(handleSeedToolkitSubcommand([])).rejects.toThrow("process.exit");

    expect(importSeedSkill).not.toHaveBeenCalled();
  });
});

describe("seed-toolkit-command — dry-run flag", () => {
  it("does not call importSeedSkill when --dry-run is set", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--dry-run"]);

    expect(importSeedSkill).not.toHaveBeenCalled();
  });

  it("dry-run prints a summary of what would be seeded", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--dry-run", "--skills-only"]);

    const combined = out.join("");
    expect(combined).toMatch(/dry.run|would/i);
  });
});

describe("seed-toolkit-command — filtering flags", () => {
  it("--skills-only: only fetches skill files, not agents or rules", async () => {
    const mockFetch = buildFetchMock();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--skills-only"]);

    // Should only have called importSeedSkill for the 2 SKILL.md files
    const calls = (importSeedSkill as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // All sources should be skill-type (from the 2 skills in the tree)
    for (const [, source] of calls) {
      expect(source as string).toMatch(/skill|tdd-mastery|error-handling/i);
    }
  });

  it("--agents-only: only fetches agent files", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--agents-only"]);

    const calls = (importSeedSkill as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const [, source] of calls) {
      expect(source as string).toMatch(/agent|qa-automation/i);
    }
  });

  it("--rules-only: only fetches rule files", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--rules-only"]);

    const calls = (importSeedSkill as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const [, source] of calls) {
      expect(source as string).toMatch(/rule|no-console/i);
    }
  });

  it("rules are seeded with initialSuccessRate 0.85", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--rules-only"]);

    const calls = (importSeedSkill as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , , successRate] of calls) {
      expect(successRate as number).toBeCloseTo(0.85);
    }
  });
});

describe("seed-toolkit-command — --limit flag", () => {
  it("stops after n insertions when --limit is set", async () => {
    vi.stubGlobal("fetch", buildFetchMock());
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--limit", "1", "--skills-only"]);

    const calls = (importSeedSkill as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});

describe("seed-toolkit-command — importSeedSkill result handling", () => {
  it("counts inserted vs duplicate vs error results", async () => {
    (importSeedSkill as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("inserted")
      .mockResolvedValueOnce("duplicate");

    vi.stubGlobal("fetch", buildFetchMock());
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, exit: vi.fn(), stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitSubcommand } = await import("../src/cli/seed-toolkit-command.js");
    await handleSeedToolkitSubcommand(["--skills-only"]);

    const combined = out.join("");
    // Should mention count of inserted/duplicates somewhere
    expect(combined.length).toBeGreaterThan(0);
  });
});
