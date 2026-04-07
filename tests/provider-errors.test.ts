/**
 * Provider error handling tests (test sprint item #2).
 *
 * Covers the three direct provider adapters (OpenAI, DeepSeek, Gemini) for:
 *   - Missing API key   → isError: true, content = "KEY is not set"
 *   - HTTP 4xx / 5xx   → isError: true, content = "Provider API error STATUS: ..."
 *   - Network failure   → isError: true, content = "Provider fetch error: ..."
 *   - No response body  → isError: true, content = "Provider: no response body"
 *   - Stream error      → isError: true, content = error message
 *   - Rate-limit headers → updateRateLimitState called on 429 (OpenAI, DeepSeek)
 *
 * Gemini does NOT call updateRateLimitState (no rate-limit-tracker import).
 * Ollama delegates to callOllama which is tested in provider-chat.test.ts.
 *
 * Bun isolation notes:
 *   - vi.mock() factories must declare ALL exports (Bun static linker requirement)
 *   - vi.stubGlobal used for fetch (restored in afterEach via vi.unstubAllGlobals)
 *   - No vi.mocked() — use mocked() from tests/mock-helpers.ts
 *   - No importOriginal — manual mock factories only
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mocked } from "./mock-helpers.js";

// ── Mock @opentelemetry/api ───────────────────────────────────────────────────
// The direct providers wrap calls in tracer.startActiveSpan(). Mock it to be
// a transparent pass-through so tests exercise the actual provider logic.

vi.mock("@opentelemetry/api", () => {
  const span = {
    setAttribute: vi.fn(),
    end: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn((_name: string, fn: (s: typeof span) => unknown) => fn(span)),
  };
  const meter = {
    createCounter:   vi.fn(() => ({ add: vi.fn() })),
    createHistogram: vi.fn(() => ({ record: vi.fn() })),
  };
  return {
    trace:         { getTracer: vi.fn(() => tracer) },
    metrics:       { getMeter: vi.fn(() => meter) },
    context:       { with: vi.fn((_ctx: unknown, fn: () => unknown) => fn()) },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  };
});

// ── Mock rate-limit-tracker ───────────────────────────────────────────────────

vi.mock("../src/rate-limit-tracker.js", () => ({
  _resetRateLimitTrackerForTesting: vi.fn(),
  updateRateLimitState: vi.fn(),
  getRateLimitState: vi.fn().mockReturnValue(null),
  isNearRateLimit: vi.fn().mockReturnValue(false),
  rateLimitSummary: vi.fn().mockReturnValue(""),
  RateLimitTracker: class {},
}));

import { updateRateLimitState } from "../src/rate-limit-tracker.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const BASE_OPTS = {
  apiKey:   "sk-test-key",
  model:    "test/model",
  messages: [{ role: "user" as const, content: "Hello" }],
};

/** Build a mock fetch Response with the given status and body text. */
function mockResponse(status: number, body = "", headers: Record<string, string> = {}): Response {
  const headersObj = new Headers(headers);
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: headersObj,
    text:    () => Promise.resolve(body),
    body:    null,
  } as unknown as Response;
}

/** Build a streaming Response whose body emits the given SSE lines. */
function mockStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
  return {
    ok:      true,
    status:  200,
    headers: new Headers(),
    body:    stream,
  } as unknown as Response;
}

/** Build a streaming Response whose reader throws on the first read. */
function mockErrorStreamResponse(errorMessage: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error(errorMessage));
    },
  });
  return {
    ok:      true,
    status:  200,
    headers: new Headers(),
    body:    stream,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── OpenAI Direct provider ────────────────────────────────────────────────────

describe("callOpenAIDirect — missing API key", () => {
  it("returns isError:true when apiKey is absent and env var unset", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
      const result = await callOpenAIDirect({ ...BASE_OPTS, apiKey: undefined as unknown as string });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("OPENAI_API_KEY is not set");
      expect(result.toolCalls).toHaveLength(0);
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

describe("callOpenAIDirect — HTTP error responses", () => {
  it("returns isError:true on HTTP 401 Unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(401, "Unauthorized")));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("401");
  });

  it("returns isError:true on HTTP 429 and calls updateRateLimitState", async () => {
    const h = { "x-ratelimit-remaining-requests": "0", "retry-after": "1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(429, "Too Many Requests", h)));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("429");
    expect(mocked(updateRateLimitState)).toHaveBeenCalledOnce();
  });

  it("returns isError:true on HTTP 500 Internal Server Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(500, "Internal Server Error")));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("500");
  });

  it("includes response body text in error content", async () => {
    const body = JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(404, body)));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("model not found");
  });
});

describe("callOpenAIDirect — network failure", () => {
  it("returns isError:true when fetch throws (connection refused)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("OpenAI fetch error");
    expect(result.content).toContain("ECONNREFUSED");
  });

  it("returns isError:true when fetch throws a non-Error object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("timeout"));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("OpenAI fetch error");
  });
});

describe("callOpenAIDirect — stream errors", () => {
  it("returns isError:true when response body is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), body: null,
    }));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no response body");
  });

  it("returns isError:true when stream reader throws mid-stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockErrorStreamResponse("stream interrupted"),
    ));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("stream interrupted");
  });

  it("parses a minimal SSE stream and returns isError:false", async () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null, index: 0 }], model: "gpt-4o", usage: null })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: "gpt-4o", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}`,
      "data: [DONE]",
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockStreamResponse(lines)));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Hi");
    expect(result.finishReason).toBe("stop");
  });
});

// ── DeepSeek Direct provider ──────────────────────────────────────────────────

describe("callDeepSeekDirect — missing API key", () => {
  it("returns isError:true when DEEPSEEK_API_KEY is not set", async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
      const result = await callDeepSeekDirect({ ...BASE_OPTS, apiKey: undefined as unknown as string });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("DEEPSEEK_API_KEY is not set");
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});

describe("callDeepSeekDirect — HTTP error responses", () => {
  it("returns isError:true on HTTP 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(401, "Unauthorized")));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("401");
  });

  it("returns isError:true on HTTP 429 and calls updateRateLimitState", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(429, "Too Many Requests")));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("429");
    expect(mocked(updateRateLimitState)).toHaveBeenCalledOnce();
  });

  it("returns isError:true on HTTP 503 with body text in content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(503, "Service Unavailable")));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("503");
    expect(result.content).toContain("Service Unavailable");
  });
});

describe("callDeepSeekDirect — network failure", () => {
  it("returns isError:true when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.deepseek.com")));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("DeepSeek fetch error");
    expect(result.content).toContain("ENOTFOUND");
  });
});

describe("callDeepSeekDirect — stream errors", () => {
  it("returns isError:true when response body is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), body: null,
    }));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no response body");
  });

  it("returns isError:true when stream reader throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockErrorStreamResponse("connection reset"),
    ));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("connection reset");
  });

  it("parses DeepSeek-R1 reasoning_content from stream", async () => {
    const lines = [
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "Let me think..." }, finish_reason: null, index: 0 }],
        model: "deepseek-reasoner",
        usage: null,
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "Answer here." }, finish_reason: "stop", index: 0 }],
        model: "deepseek-reasoner",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}`,
      "data: [DONE]",
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockStreamResponse(lines)));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Answer here.");
    expect(result.reasoning).toBe("Let me think...");
  });
});

// ── Gemini Direct provider ────────────────────────────────────────────────────

describe("callGeminiDirect — missing API key", () => {
  it("returns isError:true when GEMINI_API_KEY and GOOGLE_API_KEY are both absent", async () => {
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
      const result = await callGeminiDirect({ ...BASE_OPTS, apiKey: undefined as unknown as string });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("GEMINI_API_KEY");
      expect(result.content).toContain("not set");
    } finally {
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
    }
  });

  it("uses GOOGLE_API_KEY as fallback when GEMINI_API_KEY is absent", async () => {
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "google-key-123";
    // Mock fetch to return 200 with an empty stream so we don't hit real API
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockStreamResponse([])));
    try {
      const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
      const result = await callGeminiDirect({ ...BASE_OPTS, apiKey: undefined as unknown as string });
      // Should not get a "key not set" error — fetch was called
      expect(result.content).not.toContain("not set");
    } finally {
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
      else delete process.env.GEMINI_API_KEY;
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
      else delete process.env.GOOGLE_API_KEY;
    }
  });
});

describe("callGeminiDirect — HTTP error responses", () => {
  it("returns isError:true on HTTP 400 Bad Request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(400, "Bad Request")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("400");
  });

  it("returns isError:true on HTTP 403 Forbidden", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(403, "API key invalid")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("403");
    expect(result.content).toContain("API key invalid");
  });

  it("returns isError:true on HTTP 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(429, "Quota exceeded")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("429");
  });

  it("does NOT call updateRateLimitState (Gemini has no rate-limit-tracker integration)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(429, "Quota exceeded")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    await callGeminiDirect(BASE_OPTS as never);
    // Gemini provider does not import rate-limit-tracker — must NOT be called
    expect(mocked(updateRateLimitState)).not.toHaveBeenCalled();
  });

  it("returns isError:true on HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(500, "Internal Error")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("500");
  });
});

describe("callGeminiDirect — network failure", () => {
  it("returns isError:true when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Gemini fetch error");
    expect(result.content).toContain("ECONNREFUSED");
  });
});

describe("callGeminiDirect — stream errors", () => {
  it("returns isError:true when response body is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), body: null,
    }));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no response body");
  });

  it("returns isError:true when stream reader throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockErrorStreamResponse("network error"),
    ));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("network error");
  });

  it("returns isError:true when a stream chunk contains an error field", async () => {
    const lines = [
      `data: ${JSON.stringify({ error: { message: "model overloaded", code: 503 } })}`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockStreamResponse(lines)));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("model overloaded");
  });

  it("parses a minimal Gemini SSE stream and returns isError:false", async () => {
    const lines = [
      `data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Hello!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      })}`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockStreamResponse(lines)));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect({ ...BASE_OPTS, model: "gemini/gemini-2.0-flash" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Hello!");
    expect(result.usage.prompt_tokens).toBe(5);
    expect(result.usage.completion_tokens).toBe(3);
  });
});

// ── Error result shape invariants (all providers) ─────────────────────────────

describe("provider error result shape", () => {
  it("OpenAI error result has expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    const { callOpenAIDirect } = await import("../src/providers/openai-provider.js");
    const result = await callOpenAIDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.toolCalls).toEqual([]);
    expect(result.reasoning).toBe("");
    expect(result.usage).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(result.cachedTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("openai/unknown");
  });

  it("DeepSeek error result has expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    const { callDeepSeekDirect } = await import("../src/providers/deepseek-provider.js");
    const result = await callDeepSeekDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.toolCalls).toEqual([]);
    expect(result.model).toBe("deepseek/unknown");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("Gemini error result has expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    const { callGeminiDirect } = await import("../src/providers/gemini-provider.js");
    const result = await callGeminiDirect(BASE_OPTS as never);
    expect(result.isError).toBe(true);
    expect(result.toolCalls).toEqual([]);
    expect(result.model).toBe("gemini/unknown");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});
