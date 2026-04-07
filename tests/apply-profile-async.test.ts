/**
 * Tests for applyProfileAsync() — the async variant of applyProfile() that
 * also searches custom profiles from ~/.orager/profiles/ (or ORAGER_PROFILES_DIR).
 *
 * Tested behaviours:
 *  - Built-in profile name → delegates synchronously (no loadCustomProfiles call)
 *  - Unknown name + custom profile exists → applies custom profile
 *  - Unknown name + no custom profile → returns opts unchanged, warns on stderr
 *  - Custom profile merges appendSystemPrompt with caller's
 *  - Caller opts override custom profile scalar fields
 *  - Built-in takes precedence over custom (same name)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentLoopOptions } from "../src/types.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock profile-loader so we never hit the real filesystem
vi.mock("../src/profile-loader.js", () => ({
  getProfilesDir:    vi.fn(() => "/fake/profiles"),
  loadCustomProfiles: vi.fn().mockResolvedValue({}),
}));

import { loadCustomProfiles } from "../src/profile-loader.js";
import { applyProfileAsync, listProfiles } from "../src/profiles.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    apiKey:  "sk-test",
    model:   "test/model",
    prompt:  "Do something",
    onEmit:  vi.fn(),
    ...overrides,
  } as unknown as AgentLoopOptions;
}

const CUSTOM_PROFILE = {
  description:        "Custom test profile",
  appendSystemPrompt: "CUSTOM_SYSTEM_PROMPT",
  maxTurns:           42,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyProfileAsync() — built-in profile name", () => {
  it("returns opts with built-in profile applied for 'code-review'", async () => {
    const opts   = makeOpts();
    const result = await applyProfileAsync("code-review", opts);

    expect(result.appendSystemPrompt).toBeDefined();
    expect(result.appendSystemPrompt!.length).toBeGreaterThan(0);
    // Built-in code-review has maxTurns
    expect(typeof result.maxTurns).toBe("number");
  });

  it("does NOT call loadCustomProfiles for a built-in profile name", async () => {
    await applyProfileAsync("bug-fix", makeOpts());
    expect(loadCustomProfiles).not.toHaveBeenCalled();
  });

  it("does NOT call loadCustomProfiles for 'dev' profile", async () => {
    await applyProfileAsync("dev", makeOpts());
    expect(loadCustomProfiles).not.toHaveBeenCalled();
  });

  it("does NOT call loadCustomProfiles for 'deploy' profile", async () => {
    await applyProfileAsync("deploy", makeOpts());
    expect(loadCustomProfiles).not.toHaveBeenCalled();
  });

  it("caller opts override built-in defaults via applyProfileAsync", async () => {
    const opts   = makeOpts({ maxTurns: 999 });
    const result = await applyProfileAsync("code-review", opts);
    expect(result.maxTurns).toBe(999);
  });
});

describe("applyProfileAsync() — custom profile", () => {
  it("applies a custom profile when name is not built-in", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      "my-custom": CUSTOM_PROFILE,
    });

    const opts   = makeOpts();
    const result = await applyProfileAsync("my-custom", opts);

    expect(result.appendSystemPrompt).toContain("CUSTOM_SYSTEM_PROMPT");
    expect(result.maxTurns).toBe(42);
  });

  it("calls loadCustomProfiles for an unknown profile name", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await applyProfileAsync("unknown-profile", makeOpts());

    expect(loadCustomProfiles).toHaveBeenCalledOnce();
  });

  it("merges custom appendSystemPrompt with caller's", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      "custom-merge": { ...CUSTOM_PROFILE, appendSystemPrompt: "CUSTOM_PART" },
    });

    const opts   = makeOpts({ appendSystemPrompt: "CALLER_PART" });
    const result = await applyProfileAsync("custom-merge", opts);

    expect(result.appendSystemPrompt).toContain("CUSTOM_PART");
    expect(result.appendSystemPrompt).toContain("CALLER_PART");
  });

  it("caller opts override custom profile maxTurns", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      "custom-override": { ...CUSTOM_PROFILE, maxTurns: 10 },
    });

    const opts   = makeOpts({ maxTurns: 77 });
    const result = await applyProfileAsync("custom-override", opts);

    expect(result.maxTurns).toBe(77);
  });

  it("uses custom maxTurns when caller doesn't specify one", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      "custom-turns": { description: "t", appendSystemPrompt: "t", maxTurns: 15 },
    });

    const opts   = makeOpts();
    const result = await applyProfileAsync("custom-turns", opts);

    expect(result.maxTurns).toBe(15);
  });
});

describe("applyProfileAsync() — unknown profile (not built-in, not custom)", () => {
  it("returns opts unchanged when profile not found anywhere", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const opts   = makeOpts({ model: "specific/model", maxTurns: 5 });
    const result = await applyProfileAsync("totally-unknown-profile", opts);

    expect(result.model).toBe("specific/model");
    expect(result.maxTurns).toBe(5);
  });

  it("logs a warning to stderr when profile is not found", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const errs: string[] = [];
    vi.stubGlobal("process", { ...process, stderr: { write: (s: string) => errs.push(s) } });

    await applyProfileAsync("totally-unknown", makeOpts());

    vi.unstubAllGlobals();
    expect(errs.join("")).toContain("unknown profile");
  });
});

describe("applyProfileAsync() — built-in takes precedence over custom", () => {
  it("uses built-in even when custom profile with same name exists", async () => {
    (loadCustomProfiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      "code-review": { description: "custom override", appendSystemPrompt: "CUSTOM_OVERRIDE", maxTurns: 1 },
    });

    const opts   = makeOpts();
    const result = await applyProfileAsync("code-review", opts);

    // Should use built-in code-review (maxTurns is 20, not 1)
    expect(result.maxTurns).toBe(20); // built-in value
    // loadCustomProfiles should NOT have been called
    expect(loadCustomProfiles).not.toHaveBeenCalled();
  });
});

describe("applyProfileAsync() — all built-in profiles work asynchronously", () => {
  for (const { name } of listProfiles()) {
    it(`applies '${name}' via applyProfileAsync without error`, async () => {
      const result = await applyProfileAsync(name, makeOpts());
      expect(result.appendSystemPrompt).toBeDefined();
      expect(result.appendSystemPrompt!.length).toBeGreaterThan(0);
    });
  }
});
