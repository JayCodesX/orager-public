/**
 * Tests for src/loop-preflight.ts
 *
 * All external I/O is mocked (fetchModelContextLengths, fetchLiveModelMeta,
 * isOllamaRunning, isModelPulled). Tests verify the pure routing/warning
 * logic: deprecation warnings, capability warnings, vision model swap,
 * and Ollama backend checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPreflight } from "../src/loop-preflight.js";
import type { AgentLoopOptions } from "../src/types.js";
import { mocked } from "./mock-helpers.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/model-cache.js", () => ({
  fetchModelContextLengths: vi.fn().mockResolvedValue(undefined),
  isModelContextCacheWarm: vi.fn().mockReturnValue(true),
  getContextWindowFromFallback: vi.fn().mockReturnValue(128_000),
  getContextWindow: vi.fn().mockReturnValue(128_000),
  defaultTimeoutForModel: vi.fn().mockReturnValue(60_000),
  _resetModelCacheForTesting: vi.fn(),
  isModelCacheWarm: vi.fn().mockReturnValue(true),
}));

vi.mock("../src/openrouter-model-meta.js", () => ({
  fetchLiveModelMeta: vi.fn().mockResolvedValue(undefined),
  isLiveModelMetaCacheWarm: vi.fn().mockReturnValue(true),
  liveModelSupportsTools: vi.fn().mockReturnValue(true),
  liveModelSupportsVision: vi.fn().mockReturnValue(null), // "unknown"
  getLiveModelMeta: vi.fn().mockReturnValue(null),
  getLiveModelPricing: vi.fn().mockReturnValue(null),
  getCachedModelIds: vi.fn().mockReturnValue([]),
  getMetaCacheSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  callEmbeddings: vi.fn(),
  fetchGenerationMeta: vi.fn(),
}));

vi.mock("../src/ollama.js", () => ({
  isOllamaRunning: vi.fn().mockResolvedValue(true),
  isModelPulled: vi.fn().mockResolvedValue(true),
  resolveOllamaBaseUrl: vi.fn().mockReturnValue("http://localhost:11434"),
  toOllamaTag: vi.fn().mockReturnValue("llama3:latest"),
  shouldUseOllama: vi.fn().mockReturnValue(false),
  DEFAULT_OLLAMA_BASE_URL: "http://localhost:11434",
  OLLAMA_MODEL_MAP: {},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import * as modelMeta from "../src/openrouter-model-meta.js";
import * as openrouter from "../src/openrouter.js";
import * as ollama from "../src/ollama.js";

function makeOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    apiKey: "test-key",
    model: "openai/gpt-4o",
    prompt: "test",
    ...overrides,
  } as AgentLoopOptions;
}

function captureLog() {
  const logs: string[] = [];
  const onLog = (_stream: "stdout" | "stderr", chunk: string) => logs.push(chunk);
  return { logs, onLog };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caches warm so metadata fetches are skipped
  mocked(modelMeta.isLiveModelMetaCacheWarm).mockReturnValue(true);
  mocked(modelMeta.liveModelSupportsTools).mockReturnValue(true);
  mocked(modelMeta.liveModelSupportsVision).mockReturnValue(null);
  mocked(openrouter.shouldUseDirect).mockReturnValue(false);
  mocked(ollama.isOllamaRunning).mockResolvedValue(true);
  mocked(ollama.isModelPulled).mockResolvedValue(true);
  mocked(ollama.resolveOllamaBaseUrl).mockReturnValue("http://localhost:11434");
  mocked(ollama.toOllamaTag).mockReturnValue("llama3:latest");
});

// ── Deprecation warning ───────────────────────────────────────────────────────

describe("runPreflight — deprecation warning", () => {
  it("emits a deprecation warning for a known deprecated model", async () => {
    const { logs, onLog } = captureLog();
    await runPreflight("gpt-3.5-turbo", "key", makeOpts(), "sess-1", undefined, onLog);
    const warn = logs.find((l) => l.includes("deprecated"));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/gpt-3\.5-turbo/);
    expect(warn).toMatch(/gpt-4o-mini/);
  });

  it("does not emit a deprecation warning for a current model", async () => {
    const { logs, onLog } = captureLog();
    await runPreflight("openai/gpt-4o", "key", makeOpts(), "sess-1", undefined, onLog);
    expect(logs.some((l) => l.includes("deprecated"))).toBe(false);
  });
});

// ── Capability warning ────────────────────────────────────────────────────────

describe("runPreflight — capability warning", () => {
  it("emits a warning when a required capability is missing", async () => {
    const { logs, onLog } = captureLog();
    // A model without vision by static table
    await runPreflight(
      "openai/gpt-4",
      "key",
      makeOpts({ requiredCapabilities: ["vision"] }),
      "sess-1",
      undefined,
      onLog,
    );
    const warn = logs.find((l) => l.includes("may not support"));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/vision/);
  });

  it("does not emit a capability warning when all capabilities are present", async () => {
    const { logs, onLog } = captureLog();
    // gpt-4o supports vision by static table
    await runPreflight(
      "openai/gpt-4o",
      "key",
      makeOpts({ requiredCapabilities: ["vision", "toolUse"] }),
      "sess-1",
      undefined,
      onLog,
    );
    expect(logs.some((l) => l.includes("may not support"))).toBe(false);
  });
});

// ── Vision model routing ──────────────────────────────────────────────────────

describe("runPreflight — vision model swap", () => {
  it("swaps to visionModel when model does not support vision (liveModelSupportsVision=false)", async () => {
    mocked(modelMeta.liveModelSupportsVision).mockReturnValue(false);
    const { logs, onLog } = captureLog();
    const result = await runPreflight(
      "openai/gpt-4",
      "key",
      makeOpts({ visionModel: "openai/gpt-4o" }),
      "sess-1",
      [{ type: "image_url" }],
      onLog,
    );
    expect(result.model).toBe("openai/gpt-4o");
    expect(logs.some((l) => l.includes("switching to visionModel"))).toBe(true);
  });

  it("keeps original model when no image blocks in prompt", async () => {
    mocked(modelMeta.liveModelSupportsVision).mockReturnValue(false);
    const result = await runPreflight(
      "openai/gpt-4",
      "key",
      makeOpts({ visionModel: "openai/gpt-4o" }),
      "sess-1",
      [], // no images
    );
    expect(result.model).toBe("openai/gpt-4");
  });

  it("keeps original model when vision is confirmed supported", async () => {
    mocked(modelMeta.liveModelSupportsVision).mockReturnValue(true);
    const result = await runPreflight(
      "openai/gpt-4o",
      "key",
      makeOpts({ visionModel: "some/other-model" }),
      "sess-1",
      [{ type: "image_url" }],
    );
    expect(result.model).toBe("openai/gpt-4o");
  });

  it("emits a soft warning (not swap) when vision support is unknown (null)", async () => {
    mocked(modelMeta.liveModelSupportsVision).mockReturnValue(null);
    const { logs, onLog } = captureLog();
    const result = await runPreflight(
      "openai/gpt-4",
      "key",
      makeOpts({ visionModel: "openai/gpt-4o" }),
      "sess-1",
      [{ type: "image_url" }],
      onLog,
    );
    // Model NOT swapped — just a warning
    expect(result.model).toBe("openai/gpt-4");
    expect(logs.some((l) => l.includes("could not verify vision support"))).toBe(true);
  });

  it("warns (no swap) when images present but no visionModel configured", async () => {
    mocked(modelMeta.liveModelSupportsVision).mockReturnValue(false);
    const { logs, onLog } = captureLog();
    const result = await runPreflight(
      "openai/gpt-4",
      "key",
      makeOpts({ visionModel: undefined }),
      "sess-1",
      [{ type: "image_url" }],
      onLog,
    );
    // Model is not changed
    expect(result.model).toBe("openai/gpt-4");
    expect(logs.some((l) => l.includes("no visionModel is configured"))).toBe(true);
  });
});

// ── Ollama backend check ──────────────────────────────────────────────────────

describe("runPreflight — Ollama backend", () => {
  it("throws when Ollama is enabled but not running", async () => {
    mocked(ollama.isOllamaRunning).mockResolvedValue(false);
    await expect(
      runPreflight(
        "llama3",
        "key",
        makeOpts({ ollama: { enabled: true } }),
        "sess-1",
        undefined,
      ),
    ).rejects.toThrow(/Ollama not reachable/);
  });

  it("throws when model is not pulled", async () => {
    mocked(ollama.isOllamaRunning).mockResolvedValue(true);
    mocked(ollama.isModelPulled).mockResolvedValue(false);
    await expect(
      runPreflight(
        "llama3",
        "key",
        makeOpts({ ollama: { enabled: true } }),
        "sess-1",
        undefined,
      ),
    ).rejects.toThrow(/not pulled/);
  });

  it("succeeds and returns ollamaBaseUrl when Ollama is running with model pulled", async () => {
    mocked(ollama.isOllamaRunning).mockResolvedValue(true);
    mocked(ollama.isModelPulled).mockResolvedValue(true);
    const result = await runPreflight(
      "llama3",
      "key",
      makeOpts({ ollama: { enabled: true } }),
      "sess-1",
      undefined,
    );
    expect(result.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(result.model).toBe("llama3");
  });

  it("returns ollamaBaseUrl=undefined when Ollama is not enabled", async () => {
    const result = await runPreflight(
      "openai/gpt-4o",
      "key",
      makeOpts(),
      "sess-1",
      undefined,
    );
    expect(result.ollamaBaseUrl).toBeUndefined();
  });

  it("skips model-pulled check when checkModel=false", async () => {
    mocked(ollama.isOllamaRunning).mockResolvedValue(true);
    mocked(ollama.isModelPulled).mockResolvedValue(false); // would fail if checked
    const result = await runPreflight(
      "llama3",
      "key",
      makeOpts({ ollama: { enabled: true, checkModel: false } }),
      "sess-1",
      undefined,
    );
    expect(result.ollamaBaseUrl).toBeDefined();
  });
});

// ── Return value ──────────────────────────────────────────────────────────────

describe("runPreflight — return value", () => {
  it("returns the requested model unchanged when no swap needed", async () => {
    const result = await runPreflight(
      "openai/gpt-4o",
      "key",
      makeOpts(),
      "sess-1",
      undefined,
    );
    expect(result.model).toBe("openai/gpt-4o");
    expect(result.ollamaBaseUrl).toBeUndefined();
  });
});
