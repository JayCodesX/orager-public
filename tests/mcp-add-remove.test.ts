/**
 * Tests for `orager mcp add` and `orager mcp remove` subcommands.
 *
 * CONFIG_PATH is computed at mcp-command.ts module-load time from os.homedir(),
 * so we cannot redirect it via HOME env var after import. Instead, we mock
 * node:fs/promises with an in-memory store that intercepts readFile/writeFile
 * regardless of which path is used.
 *
 * Tested behaviours:
 *  mcp add --preset <name>:
 *   - Writes preset servers to config
 *   - Skips already-configured servers (without --force)
 *   - Overwrites already-configured servers with --force
 *   - Prints env-var placeholder warnings for servers that need them
 *   - --dry-run: prints preview without writing
 *
 *  mcp add <name> <command> [args]:
 *   - Adds a single custom server
 *   - Stores args array when extra args provided
 *   - --dry-run: prints preview without writing
 *   - Preserves existing servers
 *
 *  mcp remove <name>:
 *   - Removes named server; preserves others
 *   - Config remains valid JSON after removal
 *   - Supports 'rm' alias
 *
 *  mcp list:
 *   - Shows configured servers when config has entries
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";

// ── In-memory fs store ────────────────────────────────────────────────────────

// CONFIG_PATH in mcp-command.ts is computed at module-load time as:
//   path.join(os.homedir(), ".orager", "config.json")
// We pre-seed fileStore with that exact key so setStoredConfig/getStoredConfig
// always resolve to the same path that the module uses.
const REAL_CONFIG_PATH = path.join(os.homedir(), ".orager", "config.json");

const fileStore = new Map<string, string>();

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      fileStore.set(p, content);
    }),
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async (p: string) => {
      if (!fileStore.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  },
  readFile:  vi.fn(async (p: string) => {
    const v = fileStore.get(p);
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  }),
  writeFile: vi.fn(async (p: string, content: string) => {
    fileStore.set(p, content);
  }),
  mkdir:     vi.fn(async () => undefined),
  access:    vi.fn(async (p: string) => {
    if (!fileStore.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
}));

import { handleMcpSubcommand } from "../src/cli/mcp-command.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStoredConfig(): { mcpServers?: Record<string, unknown>; [k: string]: unknown } {
  // Find the config.json entry regardless of the home path
  for (const [key, val] of fileStore) {
    if (key.endsWith("config.json")) {
      return JSON.parse(val) as ReturnType<typeof getStoredConfig>;
    }
  }
  return {};
}

function setStoredConfig(data: Record<string, unknown>) {
  for (const [key] of fileStore) {
    if (key.endsWith("config.json")) {
      fileStore.set(key, JSON.stringify(data, null, 2) + "\n");
      return;
    }
  }
  // Not yet created — store with a sentinel key
  fileStore.set("__config.json", JSON.stringify(data, null, 2) + "\n");
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  fileStore.clear();
  vi.clearAllMocks();
  // Pre-seed with the real CONFIG_PATH so getStoredConfig/setStoredConfig
  // always hit the same key that mcp-command.ts reads/writes.
  fileStore.set(REAL_CONFIG_PATH, JSON.stringify({}) + "\n");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── mcp add --preset ──────────────────────────────────────────────────────────

describe("mcp add --preset", () => {
  it("writes preset servers to config", async () => {
    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toBeDefined();
    expect(Object.keys(cfg.mcpServers!).length).toBeGreaterThan(0);
  });

  it("includes expected servers from the recommended preset", async () => {
    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toHaveProperty("github");
    expect(cfg.mcpServers).toHaveProperty("filesystem");
  });

  it("skips already-configured servers without --force", async () => {
    setStoredConfig({ mcpServers: { github: { command: "existing-cmd" } } });

    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    const cfg = getStoredConfig();
    const gh = cfg.mcpServers!["github"] as { command: string };
    expect(gh.command).toBe("existing-cmd");
  });

  it("overwrites already-configured servers with --force", async () => {
    setStoredConfig({ mcpServers: { github: { command: "old-cmd" } } });

    await handleMcpSubcommand(["add", "--preset", "recommended", "--force"]);

    const cfg = getStoredConfig();
    const gh = cfg.mcpServers!["github"] as { command: string };
    expect(gh.command).toBe("npx");
  });

  it("merges preset servers with existing non-conflicting servers", async () => {
    setStoredConfig({ mcpServers: { "my-custom": { command: "my-tool" } } });

    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toHaveProperty("my-custom");
    expect(cfg.mcpServers).toHaveProperty("github");
  });

  it("--dry-run does not write config", async () => {
    await handleMcpSubcommand(["add", "--preset", "recommended", "--dry-run"]);

    // fileStore should have no config.json entries (nothing written)
    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toBeUndefined();
  });

  it("--dry-run prints [would add] lines for each server", async () => {
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    await handleMcpSubcommand(["add", "--preset", "recommended", "--dry-run"]);

    vi.unstubAllGlobals();
    expect(out.join("")).toContain("[would add]");
  });

  it("warns about env-var placeholders (GITHUB_PERSONAL_ACCESS_TOKEN)", async () => {
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    vi.unstubAllGlobals();
    expect(out.join("")).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  });

  it("reports added + skipped count in output", async () => {
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    vi.unstubAllGlobals();
    expect(out.join("")).toMatch(/\d+ added/);
  });

  it("strips description field from stored server entries", async () => {
    await handleMcpSubcommand(["add", "--preset", "recommended"]);

    const cfg = getStoredConfig();
    for (const server of Object.values(cfg.mcpServers ?? {})) {
      expect((server as Record<string, unknown>)["description"]).toBeUndefined();
    }
  });
});

// ── mcp add <name> <command> ──────────────────────────────────────────────────

describe("mcp add <name> <command>", () => {
  it("adds a single custom server", async () => {
    await handleMcpSubcommand(["add", "my-server", "npx", "-y", "my-tool"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toHaveProperty("my-server");
  });

  it("stores the command correctly", async () => {
    await handleMcpSubcommand(["add", "my-server", "python3"]);

    const cfg = getStoredConfig();
    const server = cfg.mcpServers!["my-server"] as { command: string; args?: string[] };
    expect(server.command).toBe("python3");
  });

  it("stores extra args in the args array", async () => {
    // Note: mcp-command strips --prefixed flags before collecting args
    // so "-y" and "my-tool" are kept but "--port" is stripped (leaving "3000")
    await handleMcpSubcommand(["add", "my-server", "npx", "-y", "my-tool", "--port", "3000"]);

    const cfg = getStoredConfig();
    const server = cfg.mcpServers!["my-server"] as { command: string; args?: string[] };
    expect(server.args).toEqual(["-y", "my-tool", "3000"]);
  });

  it("does not store args when command has none", async () => {
    await handleMcpSubcommand(["add", "minimal-server", "my-binary"]);

    const cfg = getStoredConfig();
    const server = cfg.mcpServers!["minimal-server"] as { command: string; args?: string[] };
    expect(server.command).toBe("my-binary");
    expect(server.args).toBeUndefined();
  });

  it("--dry-run prints preview without writing", async () => {
    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    await handleMcpSubcommand(["add", "my-server", "my-cmd", "--dry-run"]);

    vi.unstubAllGlobals();
    expect(out.join("")).toContain("[dry-run]");
    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toBeUndefined();
  });

  it("preserves existing servers when adding a new one", async () => {
    setStoredConfig({ mcpServers: { "existing": { command: "old" } } });

    await handleMcpSubcommand(["add", "new-server", "new-cmd"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toHaveProperty("existing");
    expect(cfg.mcpServers).toHaveProperty("new-server");
  });
});

// ── mcp remove ───────────────────────────────────────────────────────────────

describe("mcp remove", () => {
  it("removes the named server from config", async () => {
    setStoredConfig({
      mcpServers: {
        "server-a": { command: "cmd-a" },
        "server-b": { command: "cmd-b" },
      },
    });

    await handleMcpSubcommand(["remove", "server-a"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).not.toHaveProperty("server-a");
  });

  it("preserves other servers after removing one", async () => {
    setStoredConfig({
      mcpServers: {
        "keep-me":   { command: "cmd-a" },
        "remove-me": { command: "cmd-b" },
      },
    });

    await handleMcpSubcommand(["remove", "remove-me"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).toHaveProperty("keep-me");
    expect(cfg.mcpServers).not.toHaveProperty("remove-me");
  });

  it("config is valid JSON after removal", async () => {
    setStoredConfig({ mcpServers: { "to-remove": { command: "cmd" } } });

    await handleMcpSubcommand(["remove", "to-remove"]);

    expect(() => getStoredConfig()).not.toThrow();
  });

  it("supports 'rm' alias for 'remove'", async () => {
    setStoredConfig({ mcpServers: { "my-server": { command: "cmd" } } });

    await handleMcpSubcommand(["rm", "my-server"]);

    const cfg = getStoredConfig();
    expect(cfg.mcpServers).not.toHaveProperty("my-server");
  });
});

// ── mcp list with configured servers ──────────────────────────────────────────

describe("mcp list — with configured servers", () => {
  it("shows each configured server name", async () => {
    setStoredConfig({
      mcpServers: {
        "github":     { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        "filesystem": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    });

    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    await handleMcpSubcommand(["list"]);

    vi.unstubAllGlobals();
    const combined = out.join("");
    expect(combined).toContain("github");
    expect(combined).toContain("filesystem");
  });

  it("shows server count in the list header", async () => {
    setStoredConfig({
      mcpServers: {
        "s1": { command: "cmd1" },
        "s2": { command: "cmd2" },
      },
    });

    const out: string[] = [];
    vi.stubGlobal("process", { ...process, stdout: { write: (s: string) => out.push(s) }, stderr: { write: vi.fn() } });

    await handleMcpSubcommand(["list"]);

    vi.unstubAllGlobals();
    expect(out.join("")).toContain("2");
  });
});
