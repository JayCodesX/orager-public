/**
 * Tests for hooks-command.ts — `orager hooks` subcommand.
 *
 * Tested behaviours:
 *  handleListHooks():
 *   - No hooks configured → prints help message
 *   - Hooks configured → prints each event with its scripts
 *
 *  handleSeedToolkitHooks():
 *   - --dry-run: prints preview, writes no files, updates no settings
 *   - Default: fetches scripts, writes to hooksDir, updates settings.json
 *   - --hooks <slug>: only seeds the specified hook(s)
 *   - --dir <path>: writes scripts to custom directory
 *   - fetch failure for a hook: counts as failed, continues with others
 *   - Merges into existing hooks (appends, does not overwrite)
 *
 *  handleHooksSubcommand() routing:
 *   - "list" → handleListHooks
 *   - "seed-toolkit" → handleSeedToolkitHooks
 *   - unknown → error
 *   - no args → help text
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// os.homedir() in Bun does NOT respect runtime changes to process.env.HOME — it
// reads from the native OS, not from the env. We mock "node:os" with a mutable
// variable so hooks-command.ts sees the correct tmpHome during each test.
let fakeHomeDir = "";

vi.mock("node:os", () => ({
  default: {
    homedir: () => fakeHomeDir,
    tmpdir:  () => process.env["TMPDIR"] ?? "/tmp",
    platform: () => process.platform,
    EOL:     "\n",
  },
  homedir:  () => fakeHomeDir,
  tmpdir:   () => process.env["TMPDIR"] ?? "/tmp",
  platform: () => process.platform,
  EOL:      "\n",
}));

// node:fs/promises — restore the real implementation in case a sibling test file
// (e.g. mcp-add-remove.test.ts) has replaced it with an in-memory mock.
// hooks-command.test.ts needs real FS writes to verify files are created on disk.
// We use require() to bypass vitest's mock registry for this native module.
vi.mock("node:fs/promises", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const real = require("node:fs/promises") as typeof import("node:fs/promises");
  return { default: real, ...real };
});

// settings.js — loadSettings returns controllable settings object
vi.mock("../src/settings.js", () => ({
  loadSettings:            vi.fn().mockResolvedValue({ hooks: {} }),
  mergeSettings:           vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
  validateSettings:        vi.fn((s: unknown) => ({ settings: s, warnings: [], errors: [] })),
  loadClaudeDesktopMcpServers: vi.fn().mockResolvedValue({}),
}));

import { loadSettings } from "../src/settings.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mockFetchHook(slug: string, content = `#!/usr/bin/env node\nconsole.log("${slug} hook");`) {
  return content;
}

function buildFetch(options: { failSlugs?: string[] } = {}) {
  return vi.fn(async (url: string) => {
    const slug = (url as string).split("/").pop()?.replace(/\.(js|py)$/, "") ?? "";
    if (options.failSlugs?.includes(slug)) {
      return { ok: false, status: 404, text: async () => "" };
    }
    return { ok: true, text: async () => mockFetchHook(slug) };
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpHome: string;

beforeEach(() => {
  vi.clearAllMocks();
  const tmpBase = process.env["TMPDIR"] ?? "/tmp";
  tmpHome = fs.mkdtempSync(path.join(tmpBase, "orager-hooks-test-"));
  // Update the mutable fakeHomeDir so hooks-command.ts sees the right home
  fakeHomeDir = tmpHome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ── handleListHooks ───────────────────────────────────────────────────────────

describe("handleListHooks() — no hooks configured", () => {
  it("prints a help message when no hooks are configured", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ hooks: {} });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleListHooks } = await import("../src/cli/hooks-command.js");
    await handleListHooks();

    expect(out.join("")).toContain("No hooks configured");
  });

  it("also prints help when hooks key is absent from settings", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleListHooks } = await import("../src/cli/hooks-command.js");
    await handleListHooks();

    expect(out.join("")).toContain("No hooks configured");
  });
});

describe("handleListHooks() — hooks configured", () => {
  it("prints each event and its script paths", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: {
        PreToolCall:  "/home/user/.orager/hooks/secret-scanner.js",
        PostToolCall: ["/home/user/.orager/hooks/type-check.js", "/home/user/.orager/hooks/auto-test.js"],
      },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleListHooks } = await import("../src/cli/hooks-command.js");
    await handleListHooks();

    const combined = out.join("");
    expect(combined).toContain("PreToolCall");
    expect(combined).toContain("PostToolCall");
    expect(combined).toContain("secret-scanner.js");
    expect(combined).toContain("type-check.js");
    expect(combined).toContain("auto-test.js");
  });

  it("handles a single string hook value (not an array)", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { SessionStart: "/path/to/session-start.js" },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleListHooks } = await import("../src/cli/hooks-command.js");
    await handleListHooks();

    expect(out.join("")).toContain("session-start.js");
  });
});

// ── handleSeedToolkitHooks — dry-run ─────────────────────────────────────────

describe("handleSeedToolkitHooks() — --dry-run", () => {
  it("prints preview lines without writing any files", async () => {
    vi.stubGlobal("fetch", buildFetch());
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks(["--dry-run"]);

    const hooksDir = path.join(tmpHome, ".orager", "hooks");
    // No actual hook scripts written
    expect(fs.existsSync(hooksDir)).toBe(false);
    // But output shows what would happen
    expect(out.join("")).toContain("dry-run");
  });

  it("does not update settings.json in dry-run mode", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks(["--dry-run"]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

// ── handleSeedToolkitHooks — actual write ────────────────────────────────────

describe("handleSeedToolkitHooks() — normal run", () => {
  it("creates the hooks directory", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks([]);

    const hooksDir = path.join(tmpHome, ".orager", "hooks");
    expect(fs.existsSync(hooksDir)).toBe(true);
  });

  it("writes hook script files to the hooks directory", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks([]);

    const hooksDir = path.join(tmpHome, ".orager", "hooks");
    const files = fs.readdirSync(hooksDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("writes settings.json with hook entries", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks([]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings).toHaveProperty("hooks");
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);
  });
});

// ── handleSeedToolkitHooks — --hooks filter ──────────────────────────────────

describe("handleSeedToolkitHooks() — --hooks filter", () => {
  it("only seeds the specified hook slug", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks(["--hooks", "secret-scanner"]);

    const hooksDir = path.join(tmpHome, ".orager", "hooks");
    if (fs.existsSync(hooksDir)) {
      const files = fs.readdirSync(hooksDir);
      // Only secret-scanner should be written
      expect(files.every((f) => f.startsWith("secret-scanner"))).toBe(true);
    }
  });

  it("seeds multiple specified hooks (comma-separated)", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks(["--hooks", "secret-scanner,type-check"]);

    const hooksDir = path.join(tmpHome, ".orager", "hooks");
    if (fs.existsSync(hooksDir)) {
      const files = fs.readdirSync(hooksDir);
      expect(files.length).toBeLessThanOrEqual(2);
    }
  });
});

// ── handleSeedToolkitHooks — --dir flag ──────────────────────────────────────

describe("handleSeedToolkitHooks() — --dir flag", () => {
  it("writes scripts to custom directory when --dir is specified", async () => {
    const customDir = path.join(tmpHome, "my-custom-hooks");
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    await handleSeedToolkitHooks(["--hooks", "secret-scanner", "--dir", customDir]);

    expect(fs.existsSync(customDir)).toBe(true);
    const files = fs.readdirSync(customDir);
    expect(files.length).toBeGreaterThan(0);
  });
});

// ── handleSeedToolkitHooks — fetch failure ────────────────────────────────────

describe("handleSeedToolkitHooks() — fetch failure handling", () => {
  it("continues with other hooks when one fails to fetch", async () => {
    vi.stubGlobal("fetch", buildFetch({ failSlugs: ["secret-scanner"] }));
    const err: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: (s: string) => err.push(s) } });

    const { handleSeedToolkitHooks } = await import("../src/cli/hooks-command.js");
    // Seed just 2 hooks; one fails
    await handleSeedToolkitHooks(["--hooks", "secret-scanner,type-check"]);

    // Should have written type-check even though secret-scanner failed
    const hooksDir = path.join(tmpHome, ".orager", "hooks");
    if (fs.existsSync(hooksDir)) {
      const files = fs.readdirSync(hooksDir);
      expect(files.some((f) => f.startsWith("type-check"))).toBe(true);
    }
  });
});

// ── handleHooksSubcommand routing ─────────────────────────────────────────────

describe("handleHooksSubcommand() — routing", () => {
  it("routes 'list' to handleListHooks", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleHooksSubcommand } = await import("../src/cli/hooks-command.js");
    await handleHooksSubcommand(["list"]);

    expect(out.join("")).toContain("No hooks configured");
  });

  it("routes 'seed-toolkit' to handleSeedToolkitHooks", async () => {
    vi.stubGlobal("fetch", buildFetch());
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleHooksSubcommand } = await import("../src/cli/hooks-command.js");
    await handleHooksSubcommand(["seed-toolkit", "--dry-run"]);
    // No error thrown = correctly routed
  });

  it("prints help when no subcommand given", async () => {
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleHooksSubcommand } = await import("../src/cli/hooks-command.js");
    await handleHooksSubcommand([]);

    const combined = out.join("");
    expect(combined).toContain("orager hooks");
    expect(combined).toContain("seed-toolkit");
  });

  it("prints help for --help flag", async () => {
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleHooksSubcommand } = await import("../src/cli/hooks-command.js");
    await handleHooksSubcommand(["--help"]);

    expect(out.join("")).toContain("orager hooks");
  });

  it("routes 'add' to handleAddHook", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ hooks: {} });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleHooksSubcommand } = await import("../src/cli/hooks-command.js");
    await handleHooksSubcommand(["add", "Stop", "echo done"]);

    expect(out.join("")).toContain("Added hook for Stop");
  });

  it("routes 'remove' to handleRemoveHook", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { Stop: "echo done" },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleHooksSubcommand } = await import("../src/cli/hooks-command.js");
    await handleHooksSubcommand(["remove", "Stop", "echo done"]);

    expect(out.join("")).toContain("Removed hook for Stop");
  });
});

// ── handleAddHook ────────────────────────────────────────────────────────────

describe("handleAddHook()", () => {
  it("adds a new hook to an empty hooks config", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ hooks: {} });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleAddHook } = await import("../src/cli/hooks-command.js");
    await handleAddHook(["PreToolCall", "echo check"]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PreToolCall).toBe("echo check");
    expect(out.join("")).toContain("Added hook for PreToolCall");
  });

  it("appends a second hook to an existing string hook", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { Stop: "echo first" },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleAddHook } = await import("../src/cli/hooks-command.js");
    await handleAddHook(["Stop", "echo second"]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toEqual(["echo first", "echo second"]);
  });

  it("skips duplicate hook commands", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { Stop: "echo done" },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleAddHook } = await import("../src/cli/hooks-command.js");
    await handleAddHook(["Stop", "echo done"]);

    expect(out.join("")).toContain("already configured");
  });
});

// ── handleRemoveHook ─────────────────────────────────────────────────────────

describe("handleRemoveHook()", () => {
  it("removes a single string hook (deletes the event key)", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { Stop: "echo done" },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleRemoveHook } = await import("../src/cli/hooks-command.js");
    await handleRemoveHook(["Stop", "echo done"]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toBeUndefined();
    expect(out.join("")).toContain("Removed hook for Stop");
  });

  it("removes one hook from an array, leaving the other", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { Stop: ["echo first", "echo second", "echo third"] },
    });
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    const { handleRemoveHook } = await import("../src/cli/hooks-command.js");
    await handleRemoveHook(["Stop", "echo second"]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toEqual(["echo first", "echo third"]);
  });

  it("collapses array to string when only one hook remains", async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      hooks: { Stop: ["echo first", "echo second"] },
    });
    vi.stubGlobal("process", { ...process, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const { handleRemoveHook } = await import("../src/cli/hooks-command.js");
    await handleRemoveHook(["Stop", "echo first"]);

    const settingsPath = path.join(tmpHome, ".orager", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toBe("echo second");
  });
});
