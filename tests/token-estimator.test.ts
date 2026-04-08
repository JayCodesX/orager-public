/**
 * Tests for src/token-estimator.ts
 *
 * Covers bpeEncoderFamily(), getCharsPerToken(), and the char-ratio fallback
 * path of estimateTokens(). The BPE path is exercised only when tiktoken loads
 * successfully; the fallback is always deterministic and is the primary target.
 */

import { describe, it, expect } from "vitest";
import {
  bpeEncoderFamily,
  getCharsPerToken,
  estimateTokens,
} from "../src/token-estimator.js";
import type { Message } from "../src/types.js";

// ── bpeEncoderFamily ─────────────────────────────────────────────────────────

describe("bpeEncoderFamily", () => {
  it.each([
    ["gpt-4o",                   "o200k"],
    ["gpt-4o-mini",              "o200k"],
    ["openai/gpt-4o",            "o200k"],
    ["gpt-4",                    "cl100k"],
    ["gpt-4-turbo",              "cl100k"],
    ["anthropic/claude-3-5-sonnet-20241022", "cl100k"],
    ["claude-3-opus",            "cl100k"],
    ["openai/o1-mini",           "cl100k"],
    ["openai/o3",                "cl100k"],
    ["google/gemini-pro",        null],
    ["qwen/qwen2.5-72b",         null],
    ["meta-llama/llama-3.1-8b",  null],
    ["mistralai/mistral-7b",     null],
    ["deepseek/deepseek-r1",     null],
  ] as const)("bpeEncoderFamily(%s) → %s", (model, expected) => {
    expect(bpeEncoderFamily(model)).toBe(expected);
  });
});

// ── getCharsPerToken ─────────────────────────────────────────────────────────

describe("getCharsPerToken", () => {
  it("returns 3.5 for gemini models", () => {
    expect(getCharsPerToken("google/gemini-pro")).toBe(3.5);
  });

  it("returns 3.2 for qwen models", () => {
    expect(getCharsPerToken("qwen/qwen2.5-72b")).toBe(3.2);
  });

  it("returns 3.8 for llama models", () => {
    expect(getCharsPerToken("meta-llama/llama-3.1-8b")).toBe(3.8);
  });

  it("returns 3.8 for mistral/mixtral models", () => {
    expect(getCharsPerToken("mistralai/mixtral-8x7b")).toBe(3.8);
  });

  it("returns 4.0 for anthropic/claude models", () => {
    expect(getCharsPerToken("anthropic/claude-3-5-sonnet-20241022")).toBe(4.0);
  });

  it("returns 4.0 for gpt-4 models", () => {
    expect(getCharsPerToken("gpt-4-turbo")).toBe(4.0);
  });

  it("returns 4.0 for unknown models (safe default)", () => {
    expect(getCharsPerToken("some-unknown-model")).toBe(4.0);
  });
});

// ── estimateTokens — fallback path ───────────────────────────────────────────
// Uses an unknown model (no tiktoken family) so the char/token ratio path
// fires deterministically — no dependency on tiktoken availability.

const UNKNOWN_MODEL = "hypothetical/unknown-model-xyz";

function sys(content: string): Message {
  return { role: "system", content };
}
function user(content: string): Message {
  return { role: "user", content };
}
function assistant(content: string): Message {
  return { role: "assistant", content };
}

describe("estimateTokens — fallback (char/token ratio)", () => {
  it("returns 0 for an empty message list", async () => {
    expect(await estimateTokens([], UNKNOWN_MODEL)).toBe(0);
  });

  it("returns a positive number for a non-empty message", async () => {
    const count = await estimateTokens([sys("hello world")], UNKNOWN_MODEL);
    expect(count).toBeGreaterThan(0);
  });

  it("longer messages produce higher token counts than shorter ones", async () => {
    const short = await estimateTokens([user("hi")], UNKNOWN_MODEL);
    const long  = await estimateTokens([user("a".repeat(400))], UNKNOWN_MODEL);
    expect(long).toBeGreaterThan(short);
  });

  it("multiple messages add up to more than one message", async () => {
    const single   = await estimateTokens([sys("system message")], UNKNOWN_MODEL);
    const multiple = await estimateTokens(
      [sys("system message"), user("user message"), assistant("assistant reply")],
      UNKNOWN_MODEL,
    );
    expect(multiple).toBeGreaterThan(single);
  });

  it("tool messages count slightly more than equivalent user messages (1.1× multiplier)", async () => {
    const text = "x".repeat(100);
    const userCount = await estimateTokens(
      [{ role: "user", content: text }],
      UNKNOWN_MODEL,
    );
    const toolCount = await estimateTokens(
      [{ role: "tool", content: text, tool_use_id: "t1" }],
      UNKNOWN_MODEL,
    );
    expect(toolCount).toBeGreaterThanOrEqual(userCount);
  });

  it("estimates are stable across calls (pure function)", async () => {
    const msgs: Message[] = [sys("You are an agent."), user("Do something.")];
    const a = await estimateTokens(msgs, UNKNOWN_MODEL);
    const b = await estimateTokens(msgs, UNKNOWN_MODEL);
    expect(a).toBe(b);
  });

  it("uses model-specific char/token ratio (gemini vs default)", async () => {
    const msgs: Message[] = [user("a".repeat(400))];
    const geminiTokens  = await estimateTokens(msgs, "google/gemini-pro");   // 3.5 chars/token
    const defaultTokens = await estimateTokens(msgs, UNKNOWN_MODEL);          // 4.0 chars/token
    // Lower chars/token → MORE tokens for the same text
    expect(geminiTokens).toBeGreaterThan(defaultTokens);
  });
});
