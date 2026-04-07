/**
 * Tests for mcp-presets.ts, mcp-command.ts, and init-command.ts
 * (test sprint item #4).
 *
 * mcp-presets.ts — pure data/logic layer, no FS; tested directly.
 * mcp-command.ts — reads/writes CONFIG_PATH (~/.orager/config.json).
 *   Strategy: mock node:fs/promises to intercept reads/writes with an
 *   in-memory store. Also capture stdout/stderr via vi.stubGlobal.
 * init-command.ts — uses fetch + fs + process.cwd().
 *   Strategy: mock fetch for --template path; use a real temp dir for
 *   default-init tests by stubbing process.cwd().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { listPresetNames, getPreset, getRequiredEnvVars, MCP_PRESETS } from "../src/mcp-presets.js";

// ══════════════════════════════════════════════════════════════════════════════
// mcp-presets.ts — pure logic, no mocking needed
// ══════════════════════════════════════════════════════════════════════════════

describe("listPresetNames()", () => {
  it("returns a non-empty array of preset names", () => {
    const names = listPresetNames();
    expect(names.length).toBeGreaterThan(0);
  });

  it("includes the standard curated presets", () => {
    const names = listPresetNames();
    expect(names).toContain("recommended");
    expect(names).toContain("fullstack");
    expect(names).toContain("frontend");
    expect(names).toContain("devops");
    expect(names).toContain("data-science");
    expect(names).toContain("research");
  });

  it("returns names that are all strings", () => {
    for (const name of listPresetNames()) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("getPreset()", () => {
  it("returns the preset object for a known name", () => {
    const preset = getPreset("recommended");
    expect(preset).toBeDefined();
    expect(preset!.name).toBe("recommended");
    expect(typeof preset!.description).toBe("string");
    expect(typeof preset!.servers).toBe("object");
  });

  it("returns undefined for an unknown preset name", () => {
    expect(getPreset("nonexistent-preset-xyz")).toBeUndefined();
  });

  it("every listed preset is retrievable", () => {
    for (const name of listPresetNames()) {
      const preset = getPreset(name);
      expect(preset).toBeDefined();
    }
  });

  it("recommended preset has expected servers", () => {
    const preset = getPreset("recommended")!;
    expect(Object.keys(preset.servers)).toContain("filesystem");
    expect(Object.keys(preset.servers)).toContain("github");
  });
});

describe("getRequiredEnvVars()", () => {
  it("returns a Map", () => {
    const preset = getPreset("recommended")!;
    const envVars = getRequiredEnvVars(preset);
    expect(envVars instanceof Map).toBe(true);
  });

  it("detects placeholder env vars for recommended preset", () => {
    const preset = getPreset("recommended")!;
    const envVars = getRequiredEnvVars(preset);
    // github server requires GITHUB_PERSONAL_ACCESS_TOKEN placeholder
    let found = false;
    for (const [, vars] of envVars) {
      if (vars.some((v) => v.includes("GITHUB"))) found = true;
    }
    expect(found).toBe(true);
  });

  it("returns empty map for a preset with no placeholders", () => {
    // Build a synthetic preset with no placeholder env vars
    const plainPreset = {
      name: "plain",
      description: "plain preset",
      servers: {
        myserver: { command: "npx", args: ["-y", "some-server"] },
      },
    };
    const envVars = getRequiredEnvVars(plainPreset);
    expect(envVars.size).toBe(0);
  });

  it("identifies <...> angle-bracket placeholders as required", () => {
    const preset = getPreset("devops")!;
    const envVars = getRequiredEnvVars(preset);
    // devops has sentry: SENTRY_AUTH_TOKEN: "<your-sentry-token>"
    let sentryFound = false;
    for (const [serverName, vars] of envVars) {
      if (serverName === "sentry" && vars.includes("SENTRY_AUTH_TOKEN")) sentryFound = true;
    }
    expect(sentryFound).toBe(true);
  });

  it("returns one entry per server that has placeholders", () => {
    const preset = getPreset("fullstack")!;
    const envVars = getRequiredEnvVars(preset);
    // fullstack: github (GITHUB_PERSONAL_ACCESS_TOKEN) + postgres (POSTGRES_CONNECTION_STRING)
    expect(envVars.size).toBeGreaterThanOrEqual(2);
  });
});

describe("MCP_PRESETS data integrity", () => {
  it("every preset has name, description, and at least one server", () => {
    for (const [key, preset] of Object.entries(MCP_PRESETS)) {
      expect(preset.name).toBe(key);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(Object.keys(preset.servers).length).toBeGreaterThan(0);
    }
  });

  it("every server entry has a command", () => {
    for (const preset of Object.values(MCP_PRESETS)) {
      for (const [, server] of Object.entries(preset.servers)) {
        expect(typeof server.command).toBe("string");
        expect(server.command.length).toBeGreaterThan(0);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// mcp-command.ts — tests using real temp config file
// ══════════════════════════════════════════════════════════════════════════════

describe("handleMcpSubcommand — list", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let capturedOut: string;
  let capturedErr: string;

  beforeEach(async () => {
    // Redirect home dir so config goes to temp path
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "orager-mcp-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;

    // Capture stdout/stderr
    capturedOut = "";
    capturedErr = "";
    vi.stubGlobal("process", {
      ...process,
      stdout: { write: (s: string) => { capturedOut += s; } },
      stderr: { write: (s: string) => { capturedErr += s; } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origHome !== undefined) process.env["HOME"] = origHome;
    else delete process.env["HOME"];
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("shows 'no servers' message when config is missing", async () => {
    const { handleMcpSubcommand } = await import("../src/cli/mcp-command.js");
    await handleMcpSubcommand(["list"]);
    expect(capturedOut).toContain("No MCP servers configured");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// init-command.ts — --template flag with mocked fetch
// ══════════════════════════════════════════════════════════════════════════════

describe("handleInitCommand — --template flag", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-init-test-"));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fetches and writes CLAUDE.md from the 'minimal' template", async () => {
    const templateBody = "# My Project\n\nThis is a minimal CLAUDE.md template for testing.\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(templateBody),
    }));

    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand(["--template", "minimal"]);

    const written = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8");
    expect(written).toBe(templateBody);
  });

  it("strips frontmatter before writing CLAUDE.md", async () => {
    const rawWithFrontmatter = "---\ntitle: Test Template\nauthor: Test\n---\n# Actual Content\n\nThis is the real body.\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(rawWithFrontmatter),
    }));

    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand(["--template", "fullstack"]);

    const written = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8");
    expect(written).not.toContain("---");
    expect(written).not.toContain("title: Test Template");
    expect(written).toContain("# Actual Content");
    expect(written).toContain("This is the real body.");
  });

  it("fetches the correct URL for the given template name", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Standard Template Content\n"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand(["--template", "standard"]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("rohitg00/awesome-claude-code-toolkit");
    expect(calledUrl).toContain("standard.md");
  });

  it("supports -t shorthand for --template", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Enterprise Template\n"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand(["-t", "enterprise"]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("enterprise.md");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// init-command.ts — default scaffold (no --template flag)
// ══════════════════════════════════════════════════════════════════════════════

describe("handleInitCommand — default scaffold", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-init-default-"));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .orager/ORAGER.md", async () => {
    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand([]);
    expect(fs.existsSync(path.join(tmpDir, ".orager", "ORAGER.md"))).toBe(true);
  });

  it("creates .orager/settings.json with valid JSON", async () => {
    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand([]);
    const settingsPath = path.join(tmpDir, ".orager", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings).toHaveProperty("memory");
    expect(settings).toHaveProperty("providers");
  });

  it("creates .orager/skills/.gitkeep", async () => {
    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand([]);
    expect(fs.existsSync(path.join(tmpDir, ".orager", "skills", ".gitkeep"))).toBe(true);
  });

  it("ORAGER.md contains expected template sections", async () => {
    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand([]);
    const content = fs.readFileSync(path.join(tmpDir, ".orager", "ORAGER.md"), "utf8");
    expect(content).toContain("# Project Instructions");
    expect(content).toContain("## Stack");
    expect(content).toContain("## Testing");
  });

  it("settings.json includes provider stubs for openrouter, anthropic, ollama", async () => {
    const { handleInitCommand } = await import("../src/commands/init-command.js");
    await handleInitCommand([]);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, ".orager", "settings.json"), "utf8"));
    expect(settings.providers).toHaveProperty("openrouter");
    expect(settings.providers).toHaveProperty("anthropic");
    expect(settings.providers).toHaveProperty("ollama");
  });
});
