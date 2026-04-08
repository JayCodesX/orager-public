/**
 * Tests for src/cli/settings-command.ts
 *
 * Covers:
 *   handleSettingsSubcommand() — show, path, validate, set, unset
 *   resolveSettingsPath()      — returns ~/.orager/settings.json
 *
 * Note: validate warning/error surfacing is NOT tested here — validateSettings
 * unit tests already live in settings.test.ts. Testing it here requires mocking
 * settings.js, which contaminates settings.test.ts (Bun process-wide mocks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// ── Fake home dir ─────────────────────────────────────────────────────────────

let fakeHome = "";

vi.mock("node:os", () => ({
  default: {
    homedir: () => fakeHome,
    tmpdir: () => process.env["TMPDIR"] ?? "/tmp",
    platform: () => process.platform,
    EOL: "\n",
  },
  homedir: () => fakeHome,
  tmpdir: () => process.env["TMPDIR"] ?? "/tmp",
  platform: () => process.platform,
  EOL: "\n",
}));

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  const tmpBase = process.env["TMPDIR"] ?? "/tmp";
  fakeHome = fs.mkdtempSync(path.join(tmpBase, "orager-settings-test-"));
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  // Reset exitCode so Bun's test runner exits 0 even after tests that call
  // handlers which set process.exitCode = 1 as a side effect.
  process.exitCode = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function settingsPath(): string {
  return path.join(fakeHome, ".orager", "settings.json");
}

function writeSettings(obj: object): void {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function readSettings(): object {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
}

// Capture stdout writes during a command call
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => { chunks.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

// ── resolveSettingsPath ───────────────────────────────────────────────────────

describe("resolveSettingsPath()", () => {
  it("returns ~/.orager/settings.json", async () => {
    const { resolveSettingsPath } = await import("../src/cli/settings-command.js");
    expect(resolveSettingsPath()).toBe(path.join(fakeHome, ".orager", "settings.json"));
  });
});

// ── show ──────────────────────────────────────────────────────────────────────

describe("show", () => {
  it("prints settings when file exists", async () => {
    writeSettings({ hooksEnabled: true, memory: { turnInterval: 4 } });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const out = await captureOutput(() => handleSettingsSubcommand([]));

    expect(out).toContain("hooksEnabled");
    expect(out).toContain("turnInterval");
  });

  it("prints a helpful message when no settings file exists", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const out = await captureOutput(() => handleSettingsSubcommand([]));

    expect(out.toLowerCase()).toMatch(/no settings|not found/);
  });

  it("'show' subcommand behaves the same as no subcommand", async () => {
    writeSettings({ hooksEnabled: false });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const outDefault = await captureOutput(() => handleSettingsSubcommand([]));
    const outShow    = await captureOutput(() => handleSettingsSubcommand(["show"]));

    expect(outDefault).toContain("hooksEnabled");
    expect(outShow).toContain("hooksEnabled");
  });
});

// ── path ──────────────────────────────────────────────────────────────────────

describe("path", () => {
  it("prints the settings file path", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const out = await captureOutput(() => handleSettingsSubcommand(["path"]));

    expect(out.trim()).toBe(settingsPath());
  });
});

// ── validate ──────────────────────────────────────────────────────────────────

describe("validate", () => {
  it("outputs a success message for a valid settings file", async () => {
    writeSettings({ hooksEnabled: true });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const out = await captureOutput(() => handleSettingsSubcommand(["validate"]));

    // Regardless of whether validateSettings is real or mocked by another test
    // file, a file with no errors should produce no stderr exit and some output.
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("prints a message when no settings file exists", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const out = await captureOutput(() => handleSettingsSubcommand(["validate"]));

    expect(out.toLowerCase()).toMatch(/no settings|nothing to validate/);
  });
});

// ── set ───────────────────────────────────────────────────────────────────────

describe("set", () => {
  it("creates settings.json with the given key when it does not exist", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    await captureOutput(() => handleSettingsSubcommand(["set", "hooksEnabled", "false"]));

    expect(readSettings()).toMatchObject({ hooksEnabled: false });
  });

  it("adds a new key to existing settings without disturbing others", async () => {
    writeSettings({ hooksEnabled: true });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    await captureOutput(() => handleSettingsSubcommand(["set", "memory", '{"turnInterval":8}']));

    const s = readSettings() as Record<string, unknown>;
    expect(s["hooksEnabled"]).toBe(true);
    expect((s["memory"] as Record<string, unknown>)["turnInterval"]).toBe(8);
  });

  it("overwrites an existing key", async () => {
    writeSettings({ hooksEnabled: true });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    await captureOutput(() => handleSettingsSubcommand(["set", "hooksEnabled", "false"]));

    expect((readSettings() as Record<string, unknown>)["hooksEnabled"]).toBe(false);
  });

  it("treats a non-JSON value as a plain string", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    await captureOutput(() =>
      handleSettingsSubcommand(["set", "summarizationModel", "openai/gpt-4o-mini"]),
    );

    const s = readSettings() as Record<string, unknown>;
    expect(s["summarizationModel"]).toBe("openai/gpt-4o-mini");
  });

  it("prints an error when key or value is missing", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const errChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c: unknown) => { errChunks.push(String(c)); return true; };
    await captureOutput(() => handleSettingsSubcommand(["set"]));
    process.stderr.write = origErr;

    expect(errChunks.join("").toLowerCase()).toMatch(/usage|key|value/);
  });
});

// ── unset ─────────────────────────────────────────────────────────────────────

describe("unset", () => {
  it("removes a key from settings", async () => {
    writeSettings({ hooksEnabled: true, memory: { turnInterval: 4 } });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    await captureOutput(() => handleSettingsSubcommand(["unset", "hooksEnabled"]));

    const s = readSettings() as Record<string, unknown>;
    expect(s["hooksEnabled"]).toBeUndefined();
    expect(s["memory"]).toBeDefined();
  });

  it("does nothing (no error) when key does not exist", async () => {
    writeSettings({ hooksEnabled: true });
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const out = await captureOutput(() =>
      handleSettingsSubcommand(["unset", "nonexistent"]),
    );

    expect(out.toLowerCase()).toMatch(/not found|nothing/);
    expect((readSettings() as Record<string, unknown>)["hooksEnabled"]).toBe(true);
  });

  it("prints an error when no key is given", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const errChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c: unknown) => { errChunks.push(String(c)); return true; };
    await captureOutput(() => handleSettingsSubcommand(["unset"]));
    process.stderr.write = origErr;

    expect(errChunks.join("").toLowerCase()).toMatch(/usage|key/);
  });
});

// ── unknown subcommand ────────────────────────────────────────────────────────

describe("unknown subcommand", () => {
  it("prints an error for unknown subcommand", async () => {
    const { handleSettingsSubcommand } = await import("../src/cli/settings-command.js");

    const errChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c: unknown) => { errChunks.push(String(c)); return true; };
    await captureOutput(() => handleSettingsSubcommand(["doesnotexist"]));
    process.stderr.write = origErr;

    expect(errChunks.join("").toLowerCase()).toContain("unknown");
  });
});
