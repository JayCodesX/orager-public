/**
 * Tests for validateSummary() in src/session-summarizer.ts
 *
 * Covers: minimum length check, entity coverage threshold, edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  validateSummary,
  parseMemoryUpdates,
  MEMORY_UPDATE_MAX_CHARS,
} from "../src/session-summarizer.js";
import type { Message } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

// ── validateSummary ─────────────────────────────────────────────────────────

describe("validateSummary", () => {
  describe("minimum length check", () => {
    it("rejects empty summary", () => {
      const result = validateSummary("", [userMsg("Hello World")]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/too short/);
      }
    });

    it("rejects summary shorter than 100 characters", () => {
      const result = validateSummary("Short summary.", [userMsg("Hello World")]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/too short/);
      }
    });

    it("accepts summary at exactly 100 characters", () => {
      const summary = "A".repeat(100);
      // Source with no extractable entities — skips coverage check
      const result = validateSummary(summary, [userMsg("hello world")]);
      expect(result.valid).toBe(true);
    });
  });

  describe("entity coverage check", () => {
    it("accepts summary with good entity coverage (>=30%)", () => {
      const source: Message[] = [
        userMsg("The Pricing module in DeepSeek costs about 42 cents per request"),
        assistantMsg("I updated the Pricing module for DeepSeek."),
      ];
      // Summary mentions most key entities: Pricing, DeepSeek, 42
      const summary =
        "The assistant updated the Pricing module for DeepSeek. " +
        "The cost is approximately 42 cents per request. Changes were committed successfully.";
      const result = validateSummary(summary, source);
      expect(result.valid).toBe(true);
    });

    it("rejects summary with low entity coverage (<30%)", () => {
      const source: Message[] = [
        userMsg("Kubernetes Grafana Prometheus Redis PostgreSQL 100 200 300 400 500"),
        assistantMsg("Deployed Kubernetes with Grafana monitoring and Prometheus alerts for Redis and PostgreSQL."),
      ];
      // Summary mentions none of the key entities from source
      const summary =
        "some work was done on the backend systems and various changes were applied " +
        "to improve the overall performance of the application stack and its configuration.";
      const result = validateSummary(summary, source);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/entity coverage/);
      }
    });

    it("returns valid when source has no extractable entities", () => {
      const source: Message[] = [userMsg("hello world, no caps or numbers here")];
      const summary = "a".repeat(120); // meets length requirement
      const result = validateSummary(summary, source);
      expect(result.valid).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty source messages array", () => {
      const summary = "a".repeat(120);
      const result = validateSummary(summary, []);
      expect(result.valid).toBe(true);
    });

    it("handles multipart user message content", () => {
      const source: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Check the Pricing for DeepSeek model" },
          ],
        },
      ];
      const summary =
        "The assistant checked the Pricing for the DeepSeek model and found the relevant configuration settings.";
      const result = validateSummary(summary, source);
      expect(result.valid).toBe(true);
    });

    it("entity matching is case-insensitive", () => {
      const source: Message[] = [userMsg("The DeepSeek model is fast")];
      // summary has "deepseek" lowercase
      const summary =
        "The assistant confirmed that the deepseek model is fast and performs well across all benchmark tests conducted.";
      const result = validateSummary(summary, source);
      expect(result.valid).toBe(true);
    });
  });
});

// ── parseMemoryUpdates ────────────────────────────────────────────────────────

describe("parseMemoryUpdates — extraction", () => {
  it("returns empty array when no tags are present", () => {
    expect(parseMemoryUpdates("No memory updates here.")).toEqual([]);
  });

  it("parses a single well-formed block", () => {
    const text = `Some text\n<memory_update>{"content":"Project uses Bun not Node","importance":2,"tags":["toolchain"]}</memory_update>`;
    const results = parseMemoryUpdates(text);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Project uses Bun not Node");
    expect(results[0].importance).toBe(2);
    expect(results[0].tags).toEqual(["toolchain"]);
  });

  it("parses multiple blocks from one response", () => {
    const text = `
      <memory_update>{"content":"First fact","importance":1,"tags":[]}</memory_update>
      Some text in between.
      <memory_update>{"content":"Second fact","importance":3,"tags":["important"]}</memory_update>
    `;
    const results = parseMemoryUpdates(text);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("First fact");
    expect(results[1].content).toBe("Second fact");
  });

  it("skips blocks with invalid JSON", () => {
    const text = `<memory_update>not-valid-json</memory_update>`;
    expect(parseMemoryUpdates(text)).toHaveLength(0);
  });

  it("skips blocks with missing content field", () => {
    const text = `<memory_update>{"importance":2,"tags":[]}</memory_update>`;
    expect(parseMemoryUpdates(text)).toHaveLength(0);
  });

  it("skips blocks with empty content string", () => {
    const text = `<memory_update>{"content":"  ","importance":2,"tags":[]}</memory_update>`;
    expect(parseMemoryUpdates(text)).toHaveLength(0);
  });
});

describe("parseMemoryUpdates — importance clamping", () => {
  it("preserves valid importance values (1, 2, 3)", () => {
    for (const imp of [1, 2, 3] as const) {
      const text = `<memory_update>{"content":"fact","importance":${imp},"tags":[]}</memory_update>`;
      const [r] = parseMemoryUpdates(text);
      expect(r.importance).toBe(imp);
    }
  });

  it("defaults to 2 when importance is out of range (e.g. 5)", () => {
    const text = `<memory_update>{"content":"fact","importance":5,"tags":[]}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.importance).toBe(2);
  });

  it("defaults to 2 when importance is missing", () => {
    const text = `<memory_update>{"content":"fact","tags":[]}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.importance).toBe(2);
  });
});

describe("parseMemoryUpdates — content truncation", () => {
  it(`truncates content to ${MEMORY_UPDATE_MAX_CHARS} chars`, () => {
    const longContent = "a".repeat(MEMORY_UPDATE_MAX_CHARS + 100);
    const text = `<memory_update>{"content":"${longContent}","importance":2,"tags":[]}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.content.length).toBe(MEMORY_UPDATE_MAX_CHARS);
  });
});

describe("parseMemoryUpdates — tags normalisation", () => {
  it("caps tags at 10 entries", () => {
    const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const text = `<memory_update>{"content":"fact","importance":2,"tags":${JSON.stringify(tags)}}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.tags).toHaveLength(10);
  });

  it("returns empty tags array when tags field is absent", () => {
    const text = `<memory_update>{"content":"fact","importance":2}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.tags).toEqual([]);
  });
});

describe("parseMemoryUpdates — type field", () => {
  it("accepts all valid agent-emittable types", () => {
    const types = ["insight", "fact", "competitor", "decision", "risk", "open_question"] as const;
    for (const t of types) {
      const text = `<memory_update>{"content":"x","importance":2,"tags":[],"type":"${t}"}</memory_update>`;
      const [r] = parseMemoryUpdates(text);
      expect(r.type).toBe(t);
    }
  });

  it("defaults to 'insight' for unknown type values", () => {
    const text = `<memory_update>{"content":"fact","importance":2,"tags":[],"type":"unknown_type"}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.type).toBe("insight");
  });

  it("defaults to 'insight' when type is absent", () => {
    const text = `<memory_update>{"content":"fact","importance":2,"tags":[]}</memory_update>`;
    const [r] = parseMemoryUpdates(text);
    expect(r.type).toBe("insight");
  });
});
