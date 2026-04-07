/**
 * Tests for importSeedSkill() — SkillBank direct-seed API (test sprint item #3).
 *
 * importSeedSkill() bypasses LLM extraction and inserts a skill directly.
 * Key behaviors:
 *   - Returns "error"    for text < 20 chars (too short)
 *   - Returns "inserted" for valid text; persists to DB
 *   - Returns "duplicate" when cosine similarity ≥ deduplicationThreshold
 *   - Returns "inserted" for semantically different text
 *   - Respects initialSuccessRate override (default 0.5, rules use 0.85)
 *   - Returns "error" when maxSkills cap is reached
 *   - Falls back gracefully when local embeddings are unavailable (returns "inserted")
 *
 * Setup mirrors skillbank-vec.test.ts: per-test temp DB path, deterministic
 * fake embeddings (no Transformers.js required), real cosineSimilarity impl.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  importSeedSkill,
  listSkills,
  _resetSkillsDbForTesting,
  DEFAULT_SKILLBANK_CONFIG,
} from "../src/skillbank.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const DIM = 128;

/** Deterministic unit-normalised fake embedding. */
function fakeEmbedding(text: string): number[] {
  const vec = new Array(DIM).fill(0) as number[];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const base = (code * 31 + i * 7) % DIM;
    vec[base]! += code / 500;
    vec[(base + 37) % DIM]! += (code * 0.3) / 500;
    vec[(base + 73) % DIM]! -= (code * 0.15) / 500;
  }
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  return vec.map((v: number) => v / (norm || 1));
}

// OpenTelemetry API — transparent pass-through (required by provider imports)
vi.mock("@opentelemetry/api", () => {
  const span = { setAttribute: vi.fn(), end: vi.fn(), setStatus: vi.fn(), recordException: vi.fn() };
  const tracer = {
    startActiveSpan: vi.fn((_n: string, fn: (s: typeof span) => unknown) => fn(span)),
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

vi.mock("../src/local-embeddings.js", () => ({
  localEmbed:                   vi.fn(async (text: string) => fakeEmbedding(text)),
  localEmbedBatch:              vi.fn(async (texts: string[]) => texts.map(fakeEmbedding)),
  isLocalEmbeddingAvailable:    vi.fn(() => true),
  LOCAL_EMBEDDING_DIM:          128,
  _resetLocalEmbeddingsForTesting: vi.fn(),
}));

// Minimal OpenRouter provider mock (importSeedSkill doesn't call LLM, but
// the module import chain may reference it).
vi.mock("../src/providers/index.js", () => ({
  getOpenRouterProvider: () => ({
    chat:           vi.fn(),
    callEmbeddings: vi.fn(async (_k: string, _m: string, texts: string[]) =>
      texts.map((t: string) => fakeEmbedding(t)),
    ),
  }),
}));

// Real cosineSimilarity implementation (skillbank imports from memory.js).
vi.mock("../src/memory.js", () => ({
  cosineSimilarity: (a: number[], b: number[]): number => {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot    += a[i]! * b[i]!;
      normA  += a[i]! * a[i]!;
      normB  += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  },
}));

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-seed-test-"));
  process.env["ORAGER_SKILLS_DB_PATH"] = path.join(tmpDir, "skills.sqlite");
  _resetSkillsDbForTesting();
  vi.clearAllMocks();
});

afterEach(async () => {
  _resetSkillsDbForTesting();
  delete process.env["ORAGER_SKILLS_DB_PATH"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe("importSeedSkill — input validation", () => {
  it("returns 'error' for an empty string", async () => {
    expect(await importSeedSkill("", "test-source")).toBe("error");
  });

  it("returns 'error' for text shorter than 20 characters", async () => {
    expect(await importSeedSkill("too short", "src")).toBe("error");
  });

  it("returns 'error' for text that is exactly 19 characters", async () => {
    expect(await importSeedSkill("1234567890123456789", "src")).toBe("error");
  });

  it("returns 'inserted' for text that is exactly 20 characters", async () => {
    // 20 non-whitespace characters → should pass
    const result = await importSeedSkill("12345678901234567890", "src");
    expect(result).toBe("inserted");
  });

  it("returns 'inserted' for text longer than 20 characters", async () => {
    const result = await importSeedSkill(
      "Always validate inputs before writing to disk to prevent path traversal attacks.",
      "security-rules",
    );
    expect(result).toBe("inserted");
  });

  it("returns 'error' for whitespace-only string", async () => {
    expect(await importSeedSkill("                        ", "src")).toBe("error");
  });
});

// ── Successful insertion ──────────────────────────────────────────────────────

describe("importSeedSkill — successful insertion", () => {
  const SKILL_TEXT = "When implementing retry logic, use exponential backoff with jitter to avoid thundering herd.";

  it("returns 'inserted' for valid skill text", async () => {
    expect(await importSeedSkill(SKILL_TEXT, "toolkit-rules")).toBe("inserted");
  });

  it("persists the skill to the DB (visible via listSkills)", async () => {
    await importSeedSkill(SKILL_TEXT, "toolkit-rules");
    const skills = await listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.text).toBe(SKILL_TEXT);
  });

  it("stores the source as sourceSession", async () => {
    await importSeedSkill(SKILL_TEXT, "my-source-123");
    const skills = await listSkills();
    expect(skills[0]!.sourceSession).toBe("my-source-123");
  });

  it("sets extractionModel to 'seed'", async () => {
    await importSeedSkill(SKILL_TEXT, "any-source");
    const skills = await listSkills();
    expect(skills[0]!.extractionModel).toBe("seed");
  });

  it("sets use_count to 0 on insertion", async () => {
    await importSeedSkill(SKILL_TEXT, "any-source");
    const skills = await listSkills();
    expect(skills[0]!.useCount).toBe(0);
  });

  it("assigns a unique id prefixed with sk_", async () => {
    await importSeedSkill(SKILL_TEXT, "any-source");
    const skills = await listSkills();
    expect(skills[0]!.id).toMatch(/^sk_[0-9a-f]{6}$/);
  });

  it("multiple distinct skills can be inserted", async () => {
    const textA = "Use database transactions for multi-step writes to ensure atomicity and consistency.";
    const textB = "Prefer declarative configuration over imperative scripts for infrastructure management.";
    expect(await importSeedSkill(textA, "src")).toBe("inserted");
    expect(await importSeedSkill(textB, "src")).toBe("inserted");
    const skills = await listSkills();
    expect(skills).toHaveLength(2);
  });
});

// ── initialSuccessRate ────────────────────────────────────────────────────────

describe("importSeedSkill — initialSuccessRate", () => {
  const TEXT = "Always write tests before refactoring to ensure correctness and catch regressions early.";

  it("defaults success_rate to 0.5 when not specified", async () => {
    await importSeedSkill(TEXT, "src");
    const skills = await listSkills();
    expect(skills[0]!.successRate).toBeCloseTo(0.5);
  });

  it("uses provided initialSuccessRate of 0.85 (rules convention)", async () => {
    await importSeedSkill(TEXT, "src", undefined, 0.85);
    const skills = await listSkills();
    expect(skills[0]!.successRate).toBeCloseTo(0.85);
  });

  it("accepts initialSuccessRate of 0.0", async () => {
    await importSeedSkill(TEXT, "src", undefined, 0.0);
    const skills = await listSkills();
    expect(skills[0]!.successRate).toBeCloseTo(0.0);
  });

  it("accepts initialSuccessRate of 1.0", async () => {
    await importSeedSkill(TEXT, "src", undefined, 1.0);
    const skills = await listSkills();
    expect(skills[0]!.successRate).toBeCloseTo(1.0);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe("importSeedSkill — deduplication", () => {
  it("returns 'duplicate' when the same text is inserted twice", async () => {
    const text = "Sanitize all user-provided filenames before using them in filesystem operations.";
    expect(await importSeedSkill(text, "src")).toBe("inserted");
    expect(await importSeedSkill(text, "src")).toBe("duplicate");
  });

  it("does not create a second DB row for a duplicate", async () => {
    const text = "Use parameterized queries to prevent SQL injection vulnerabilities in all DB calls.";
    await importSeedSkill(text, "src");
    await importSeedSkill(text, "src");
    const skills = await listSkills();
    expect(skills).toHaveLength(1);
  });

  it("returns 'inserted' for semantically different text", async () => {
    const textA = "Always escape HTML output to prevent cross-site scripting attacks in web pages.";
    const textB = "Configure connection pool limits to avoid resource exhaustion under concurrent load.";
    expect(await importSeedSkill(textA, "src")).toBe("inserted");
    expect(await importSeedSkill(textB, "src")).toBe("inserted");
    const skills = await listSkills();
    expect(skills).toHaveLength(2);
  });
});

// ── maxSkills cap ─────────────────────────────────────────────────────────────

describe("importSeedSkill — maxSkills cap", () => {
  it("returns 'error' when the skill cap is reached", async () => {
    const config = { ...DEFAULT_SKILLBANK_CONFIG, maxSkills: 2 };

    const textA = "Use circuit breakers to prevent cascading failures in distributed service calls.";
    const textB = "Cache API responses at the edge to reduce latency and upstream load significantly.";
    const textC = "Validate JWT signatures server-side; never trust client-provided token claims.";

    expect(await importSeedSkill(textA, "src", config)).toBe("inserted");
    expect(await importSeedSkill(textB, "src", config)).toBe("inserted");
    // Cap reached
    expect(await importSeedSkill(textC, "src", config)).toBe("error");
  });

  it("does not insert beyond cap", async () => {
    const config = { ...DEFAULT_SKILLBANK_CONFIG, maxSkills: 1 };
    const textA = "Always set timeouts on outbound HTTP requests to avoid connection hangs indefinitely.";
    const textB = "Use structured logging with correlation IDs for distributed system observability.";
    await importSeedSkill(textA, "src", config);
    await importSeedSkill(textB, "src", config);
    const skills = await listSkills();
    expect(skills).toHaveLength(1);
  });
});

// ── No local embeddings (graceful degradation) ────────────────────────────────

describe("importSeedSkill — no local embeddings", () => {
  it("returns 'inserted' when localEmbed returns null (skips dedup)", async () => {
    const { localEmbed } = await import("../src/local-embeddings.js");
    (localEmbed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const text = "When deploying to production, always run database migrations inside a transaction.";
    const result = await importSeedSkill(text, "src");
    expect(result).toBe("inserted");
  });

  it("returns 'inserted' when localEmbed throws (skips dedup, stores without embedding)", async () => {
    const { localEmbed } = await import("../src/local-embeddings.js");
    (localEmbed as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("WASM load failed"));

    const text = "Prefer feature flags over long-lived feature branches for continuous integration.";
    const result = await importSeedSkill(text, "src");
    expect(result).toBe("inserted");
  });
});
