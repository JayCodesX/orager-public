/**
 * Unit tests for LLM-as-judge (src/agents/judge.ts).
 *
 * All network calls are mocked — no real API key required.
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { judgeOutput, judgeOutputBatch, formatJudgeResult } from "../src/agents/judge.js";
import type { JudgeConfig } from "../src/agents/judge.js";

// ── Mock fetch ────────────────────────────────────────────────────────────────

const DEFAULT_RAW = {
  task_completion: 8,
  accuracy: 9,
  helpfulness: 7,
  pass: true,
  score: 0.8,
  reason: "The agent correctly identified all exported functions.",
};

function makeOkResponse(body: object): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeErrorResponse(status: number, body = "error"): Response {
  return new Response(body, { status });
}

const JUDGE_CONFIG: JudgeConfig = {
  apiKey: "sk-test",
  model: "test-model",
  temperature: 0,
  doubleCheck: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── judgeOutput ───────────────────────────────────────────────────────────────

describe("judgeOutput", () => {
  it("returns a well-formed JudgeResult on a passing response", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(makeOkResponse(DEFAULT_RAW)));

    const result = await judgeOutput(
      "List all exported functions",
      "Should list recordAgentScore, getAgentStats, getAllAgentStats",
      "The file exports recordAgentScore, getAgentStats, and getAllAgentStats.",
      JUDGE_CONFIG,
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.confident).toBe(true);
    expect(typeof result.reason).toBe("string");
    expect(result.dimensions.taskCompletion).toBe(8);
    expect(result.dimensions.accuracy).toBe(9);
    expect(result.dimensions.helpfulness).toBe(7);
  });

  it("clamps score to [0, 1] even if model returns out-of-range value", async () => {
    const raw = { ...DEFAULT_RAW, score: 1.5 };
    vi.stubGlobal("fetch", () => Promise.resolve(makeOkResponse(raw)));

    const result = await judgeOutput("task", "criteria", "output", JUDGE_CONFIG);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("falls back to dimension average when model omits score field", async () => {
    const { score: _score, ...rawNoScore } = DEFAULT_RAW;
    vi.stubGlobal("fetch", () => Promise.resolve(makeOkResponse(rawNoScore)));

    const result = await judgeOutput("task", "criteria", "output", JUDGE_CONFIG);
    // avg(8, 9, 7) / 30 = 24/30 ≈ 0.8
    expect(result.score).toBeCloseTo(0.8, 1);
  });

  it("returns pass=false for a failing response", async () => {
    const raw = { ...DEFAULT_RAW, pass: false, score: 0.3 };
    vi.stubGlobal("fetch", () => Promise.resolve(makeOkResponse(raw)));

    const result = await judgeOutput("task", "criteria", "output", JUDGE_CONFIG);
    expect(result.pass).toBe(false);
  });

  it("strips markdown code fences from the model response", async () => {
    const fenced = "```json\n" + JSON.stringify(DEFAULT_RAW) + "\n```";
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: fenced } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await judgeOutput("task", "criteria", "output", JUDGE_CONFIG);
    expect(result.pass).toBe(true);
  });

  it("throws when the model returns invalid JSON", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json!!" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      judgeOutput("task", "criteria", "output", JUDGE_CONFIG),
    ).rejects.toThrow("invalid JSON");
  });

  it("throws when the API returns a non-OK status", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(makeErrorResponse(429, "rate limited")),
    );

    await expect(
      judgeOutput("task", "criteria", "output", JUDGE_CONFIG),
    ).rejects.toThrow("429");
  });
});

// ── doubleCheck ───────────────────────────────────────────────────────────────

describe("judgeOutput doubleCheck", () => {
  it("sets confident=true when both calls agree on pass=true", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(makeOkResponse(DEFAULT_RAW)));

    const result = await judgeOutput("task", "criteria", "output", {
      ...JUDGE_CONFIG,
      doubleCheck: true,
    });

    expect(result.confident).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("sets confident=false when calls disagree on pass", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", () => {
      callCount++;
      const raw = callCount === 1
        ? { ...DEFAULT_RAW, pass: true }
        : { ...DEFAULT_RAW, pass: false };
      return Promise.resolve(makeOkResponse(raw));
    });

    const result = await judgeOutput("task", "criteria", "output", {
      ...JUDGE_CONFIG,
      doubleCheck: true,
    });

    expect(result.confident).toBe(false);
    expect(callCount).toBe(2);
  });

  it("sets confident=false when the second call fails", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", () => {
      callCount++;
      if (callCount === 1) return Promise.resolve(makeOkResponse(DEFAULT_RAW));
      return Promise.resolve(makeErrorResponse(500));
    });

    const result = await judgeOutput("task", "criteria", "output", {
      ...JUDGE_CONFIG,
      doubleCheck: true,
    });

    expect(result.confident).toBe(false);
  });
});

// ── judgeOutputBatch ──────────────────────────────────────────────────────────

describe("judgeOutputBatch", () => {
  it("returns results for all items in order", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(makeOkResponse(DEFAULT_RAW)));

    const items = [
      { taskId: "t1", taskPrompt: "p1", successCriteria: "c1", agentOutput: "o1" },
      { taskId: "t2", taskPrompt: "p2", successCriteria: "c2", agentOutput: "o2" },
    ];

    const results = await judgeOutputBatch(items, JUDGE_CONFIG);

    expect(results).toHaveLength(2);
    expect(results[0].taskId).toBe("t1");
    expect(results[1].taskId).toBe("t2");
    expect(results[0].result).not.toBeNull();
    expect(results[1].result).not.toBeNull();
  });

  it("returns null for failed items without throwing", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", () => {
      callCount++;
      if (callCount === 1) return Promise.resolve(makeOkResponse(DEFAULT_RAW));
      return Promise.resolve(makeErrorResponse(500));
    });

    const items = [
      { taskId: "t1", taskPrompt: "p1", successCriteria: "c1", agentOutput: "o1" },
      { taskId: "t2", taskPrompt: "p2", successCriteria: "c2", agentOutput: "o2" },
    ];

    const results = await judgeOutputBatch(items, JUDGE_CONFIG);

    expect(results[0].result).not.toBeNull();
    expect(results[1].result).toBeNull();
  });
});

// ── formatJudgeResult ─────────────────────────────────────────────────────────

describe("formatJudgeResult", () => {
  it("includes taskId, pass, score, and reason in output", () => {
    const r = {
      pass: true,
      score: 0.87,
      reason: "Very good.",
      confident: true,
      dimensions: { taskCompletion: 9, accuracy: 8, helpfulness: 9 },
    };

    const out = formatJudgeResult("explorer-1", r);

    expect(out).toContain("explorer-1");
    expect(out).toContain("pass=true");
    expect(out).toContain("0.87");
    expect(out).toContain("Very good.");
  });

  it("appends ⚠️ low confidence marker when not confident", () => {
    const r = {
      pass: false,
      score: 0.45,
      reason: "Partial answer.",
      confident: false,
      dimensions: { taskCompletion: 4, accuracy: 5, helpfulness: 4 },
    };

    const out = formatJudgeResult("planner-2", r);
    expect(out).toContain("low confidence");
  });
});
