/**
 * Tests for keychain.ts — OS keychain integration.
 *
 * Tests the pure/deterministic functions and the resolution chain logic.
 * Subprocess-based keychain calls are mocked to avoid real OS keychain access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";

// Mock child_process.spawn to avoid real OS keychain calls
vi.mock("node:child_process", () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

import { spawn } from "node:child_process";
import {
  isKeychainSupported,
  getEnvKey,
  getKeychainKey,
  setKeychainKey,
  deleteKeychainKey,
  resolveProviderKey,
  getAuthStatus,
  type KeychainProvider,
} from "../src/keychain.js";
import { mocked } from "./mock-helpers.js";

// ── Spawn mock helper ───────────────────────────────────────────────────────

function mockSpawnResult(stdout: string, code: number, stderr = ""): void {
  const mockProc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
  };

  // Capture callbacks to fire them
  mockProc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
    if (event === "data" && stdout) {
      setTimeout(() => cb(Buffer.from(stdout)), 1);
    }
  });
  mockProc.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
    if (event === "data" && stderr) {
      setTimeout(() => cb(Buffer.from(stderr)), 1);
    }
  });
  mockProc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === "close") {
      setTimeout(() => cb(code), 5);
    }
  });

  mocked(spawn).mockReturnValue(mockProc as never);
}

// ── Environment management ──────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};
const envVarsToManage = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

beforeEach(() => {
  for (const key of envVarsToManage) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of envVarsToManage) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// ── isKeychainSupported ─────────────────────────────────────────────────────

describe("isKeychainSupported", () => {
  it("returns a boolean", () => {
    const result = isKeychainSupported();
    expect(typeof result).toBe("boolean");
  });

  // On macOS/Linux/Windows this should be true
  it("returns true on supported platforms", () => {
    const platform = process.platform;
    if (platform === "darwin" || platform === "linux" || platform === "win32") {
      expect(isKeychainSupported()).toBe(true);
    }
  });
});

// ── getEnvKey ───────────────────────────────────────────────────────────────

describe("getEnvKey", () => {
  it("returns null when no env var is set", () => {
    expect(getEnvKey("openrouter")).toBeNull();
  });

  it("returns the env var value when set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-123";
    expect(getEnvKey("openrouter")).toBe("sk-or-test-123");
  });

  it("checks ANTHROPIC_API_KEY for anthropic provider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getEnvKey("anthropic")).toBe("sk-ant-test");
  });

  it("checks OPENAI_API_KEY for openai provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    expect(getEnvKey("openai")).toBe("sk-openai-test");
  });

  it("checks DEEPSEEK_API_KEY for deepseek provider", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-test";
    expect(getEnvKey("deepseek")).toBe("sk-ds-test");
  });

  it("checks GEMINI_API_KEY for gemini provider", () => {
    process.env.GEMINI_API_KEY = "gm-test";
    expect(getEnvKey("gemini")).toBe("gm-test");
  });

  it("falls back to GOOGLE_API_KEY for gemini provider", () => {
    process.env.GOOGLE_API_KEY = "google-test";
    expect(getEnvKey("gemini")).toBe("google-test");
  });

  it("prefers GEMINI_API_KEY over GOOGLE_API_KEY", () => {
    process.env.GEMINI_API_KEY = "gemini-primary";
    process.env.GOOGLE_API_KEY = "google-fallback";
    expect(getEnvKey("gemini")).toBe("gemini-primary");
  });
});

// ── getKeychainKey ──────────────────────────────────────────────────────────

describe("getKeychainKey", () => {
  it("returns the key on success", async () => {
    mockSpawnResult("sk-test-key-from-keychain\n", 0);
    const key = await getKeychainKey("openrouter");
    expect(key).toBe("sk-test-key-from-keychain");
  });

  it("returns null on non-zero exit code", async () => {
    mockSpawnResult("", 1, "not found");
    const key = await getKeychainKey("openrouter");
    expect(key).toBeNull();
  });

  it("returns null for empty output", async () => {
    mockSpawnResult("", 0);
    const key = await getKeychainKey("openrouter");
    expect(key).toBeNull();
  });
});

// ── setKeychainKey ──────────────────────────────────────────────────────────

describe("setKeychainKey", () => {
  it("throws on failure", async () => {
    mockSpawnResult("", 1, "access denied");
    await expect(setKeychainKey("openrouter", "my-key")).rejects.toThrow();
  });
});

// ── deleteKeychainKey ───────────────────────────────────────────────────────

describe("deleteKeychainKey", () => {
  it("does not throw on failure", async () => {
    mockSpawnResult("", 1, "not found");
    // Should not throw — deleteKeychainKey is fire-and-forget
    await expect(deleteKeychainKey("openrouter")).resolves.toBeUndefined();
  });
});

// ── resolveProviderKey ──────────────────────────────────────────────────────

describe("resolveProviderKey", () => {
  it("returns env var when set (priority 1)", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const key = await resolveProviderKey("openrouter");
    expect(key).toBe("env-key");
    // Should not have called spawn (no keychain needed)
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns keychain key when env is not set (priority 2)", async () => {
    mockSpawnResult("keychain-key\n", 0);
    const key = await resolveProviderKey("openrouter");
    expect(key).toBe("keychain-key");
    // Should have injected into env
    expect(process.env.OPENROUTER_API_KEY).toBe("keychain-key");
  });

  it("returns null when neither env nor keychain has key", async () => {
    mockSpawnResult("", 1);
    const key = await resolveProviderKey("openrouter");
    expect(key).toBeNull();
  });
});

// ── getAuthStatus ───────────────────────────────────────────────────────────

describe("getAuthStatus", () => {
  it("reports env source when env var is set", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const status = await getAuthStatus();
    expect(status.openrouter.configured).toBe(true);
    expect(status.openrouter.source).toBe("env");
  });

  it("reports none when nothing is configured", async () => {
    mockSpawnResult("", 1);
    const status = await getAuthStatus();
    expect(status.openrouter.configured).toBe(false);
    expect(status.openrouter.source).toBe("none");
  });

  it("returns status for all 5 providers", async () => {
    mockSpawnResult("", 1); // all keychain lookups fail
    const status = await getAuthStatus();
    const providers: KeychainProvider[] = ["openrouter", "anthropic", "openai", "deepseek", "gemini"];
    for (const p of providers) {
      expect(status[p]).toBeDefined();
      expect(typeof status[p].configured).toBe("boolean");
      expect(["env", "keychain", "none"]).toContain(status[p].source);
    }
  });
});
