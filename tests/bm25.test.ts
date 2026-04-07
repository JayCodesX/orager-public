import { describe, it, expect } from "vitest";
import {
  tokenize,
  computeCorpusStats,
  bm25Score,
  BM25Index,
  hybridScore,
} from "../src/bm25.js";

// ── tokenize ─────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits on whitespace/punctuation", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
    expect(tokenize("user-facing API")).toEqual(["user", "facing", "api"]);
  });

  it("removes stop words", () => {
    const result = tokenize("this is a test of the system");
    expect(result).toEqual(["test", "system"]);
  });

  it("filters tokens shorter than 3 characters", () => {
    expect(tokenize("go to db ok")).toEqual([]);
  });

  it("deduplicates tokens", () => {
    expect(tokenize("test test test")).toEqual(["test"]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("handles Unicode punctuation", () => {
    const result = tokenize("session\u2019s data\u2014context");
    expect(result).toContain("session");
    expect(result).toContain("data");
    expect(result).toContain("context");
  });
});

// ── computeCorpusStats ───────────────────────────────────────────────────────

describe("computeCorpusStats", () => {
  it("computes correct averages and document frequencies", () => {
    const docs = [
      ["auth", "token", "expire"],
      ["auth", "session", "cookie", "expire", "refresh"],
      ["database", "query"],
    ];
    const stats = computeCorpusStats(docs);

    expect(stats.docCount).toBe(3);
    expect(stats.avgDocLength).toBeCloseTo(10 / 3);
    expect(stats.docFreqs.get("auth")).toBe(2);
    expect(stats.docFreqs.get("expire")).toBe(2);
    expect(stats.docFreqs.get("database")).toBe(1);
    expect(stats.docFreqs.get("session")).toBe(1);
  });

  it("handles empty corpus", () => {
    const stats = computeCorpusStats([]);
    expect(stats.docCount).toBe(0);
    expect(stats.avgDocLength).toBe(0);
    expect(stats.docFreqs.size).toBe(0);
  });
});

// ── bm25Score ────────────────────────────────────────────────────────────────

describe("bm25Score", () => {
  const docs = [
    ["auth", "token", "expire", "session"],
    ["auth", "login", "password", "hash", "salt"],
    ["database", "query", "index", "optimize"],
    ["auth", "oauth", "token", "refresh", "token", "grant"],
  ];
  const stats = computeCorpusStats(docs);

  it("scores higher for rare terms (IDF)", () => {
    // "database" appears in 1 doc, "auth" appears in 3 docs
    const scoreRare = bm25Score(["database"], ["database", "query", "index", "optimize"], stats);
    const scoreCommon = bm25Score(["auth"], ["auth", "token", "expire", "session"], stats);
    expect(scoreRare).toBeGreaterThan(scoreCommon);
  });

  it("demonstrates TF saturation", () => {
    // Doc with token appearing once vs three times — score increases but sublinearly
    const scoreTF1 = bm25Score(["token"], ["token", "other", "words", "here", "padding", "more"], stats);
    const scoreTF3 = bm25Score(["token"], ["token", "token", "token", "words", "here", "padding"], stats);
    expect(scoreTF3).toBeGreaterThan(scoreTF1);
    // TF saturation: 3x occurrences should NOT give 3x the score
    expect(scoreTF3).toBeLessThan(scoreTF1 * 3);
  });

  it("demonstrates length normalization", () => {
    // Same term count, shorter doc should score higher
    const shortDoc = ["auth", "token"];
    const longDoc = ["auth", "token", "extra", "padding", "words", "more", "stuff", "here"];
    const shortStats = computeCorpusStats([shortDoc, longDoc]);

    const scoreShort = bm25Score(["auth"], shortDoc, shortStats);
    const scoreLong = bm25Score(["auth"], longDoc, shortStats);
    expect(scoreShort).toBeGreaterThan(scoreLong);
  });

  it("returns 0 for empty query", () => {
    expect(bm25Score([], ["some", "tokens"], stats)).toBe(0);
  });

  it("returns 0 for empty document", () => {
    expect(bm25Score(["query"], [], stats)).toBe(0);
  });

  it("returns 0 for no matching terms", () => {
    expect(bm25Score(["zzzzz"], ["auth", "token"], stats)).toBe(0);
  });

  it("multi-term query accumulates score", () => {
    const singleTerm = bm25Score(["auth"], docs[0], stats);
    const multiTerm = bm25Score(["auth", "expire"], docs[0], stats);
    expect(multiTerm).toBeGreaterThan(singleTerm);
  });
});

// ── BM25Index ────────────────────────────────────────────────────────────────

describe("BM25Index", () => {
  it("indexes and scores documents", () => {
    const idx = new BM25Index();
    idx.addDocument("d1", "authentication tokens expire after one hour");
    idx.addDocument("d2", "database queries should use prepared statements");
    idx.addDocument("d3", "refresh tokens are used for authentication renewal");

    const query = tokenize("authentication token");
    const scores = idx.scoreAll(query);

    // d1 and d3 mention auth+token, d2 doesn't
    expect(scores.get("d1")).toBeGreaterThan(0);
    expect(scores.get("d3")).toBeGreaterThan(0);
    expect(scores.has("d2")).toBe(false);
  });

  it("tracks document count and avg length", () => {
    const idx = new BM25Index();
    expect(idx.documentCount).toBe(0);
    expect(idx.avgDocLength).toBe(0);

    idx.addDocument("d1", "one two three");
    expect(idx.documentCount).toBe(1);
    expect(idx.avgDocLength).toBeGreaterThan(0);
  });

  it("removes documents correctly", () => {
    const idx = new BM25Index();
    idx.addDocument("d1", "authentication tokens");
    idx.addDocument("d2", "database queries");

    idx.removeDocument("d1");
    expect(idx.documentCount).toBe(1);
    expect(idx.score(tokenize("authentication"), "d1")).toBe(0);
  });

  it("re-adding a document updates it", () => {
    const idx = new BM25Index();
    idx.addDocument("d1", "old content about authentication");
    idx.addDocument("d1", "new content about databases");

    expect(idx.documentCount).toBe(1);
    expect(idx.score(tokenize("authentication"), "d1")).toBe(0);
    expect(idx.score(tokenize("databases"), "d1")).toBeGreaterThan(0);
  });

  it("accepts pre-tokenized arrays", () => {
    const idx = new BM25Index();
    idx.addDocument("d1", ["auth", "token", "expire"]);
    idx.addDocument("d2", ["database", "query"]);

    expect(idx.score(["auth"], "d1")).toBeGreaterThan(0);
    expect(idx.score(["auth"], "d2")).toBe(0);
  });

  it("uses custom k1 and b parameters", () => {
    const idxDefault = new BM25Index();
    const idxCustom = new BM25Index({ k1: 2.0, b: 0.5 });

    // Need multiple docs with different lengths so b affects scoring
    idxDefault.addDocument("d1", "authentication token expire");
    idxDefault.addDocument("d2", "authentication token expire session refresh cookie header payload data");
    idxCustom.addDocument("d1", "authentication token expire");
    idxCustom.addDocument("d2", "authentication token expire session refresh cookie header payload data");

    const query = tokenize("authentication");
    const scoreDefault = idxDefault.score(query, "d1");
    const scoreCustom = idxCustom.score(query, "d1");

    // Different k1/b params with varying doc lengths should produce different scores
    expect(scoreDefault).not.toBeCloseTo(scoreCustom, 5);
  });
});

// ── hybridScore ──────────────────────────────────────────────────────────────

describe("hybridScore", () => {
  it("blends BM25 and cosine similarity", () => {
    const score = hybridScore(3, 0.8, 0.4);
    // BM25=3 is near sigmoid midpoint (~0.5), cosine=0.8
    // Result should be between 0 and 1
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns pure cosine when alpha=0", () => {
    expect(hybridScore(5, 0.7, 0)).toBeCloseTo(0.7);
  });

  it("returns pure BM25 when alpha=1", () => {
    const score = hybridScore(6, 0.1, 1);
    // Should be close to sigmoid(6) which is high
    expect(score).toBeGreaterThan(0.7);
  });

  it("handles zero BM25 score", () => {
    const score = hybridScore(0, 0.9, 0.4);
    // BM25 component small (sigmoid(0) is low), cosine dominates
    expect(score).toBeGreaterThan(0.4);
  });

  it("result is always in [0, 1]", () => {
    const cases = [
      [0, 0], [0, 1], [100, 1], [100, 0], [-5, 0.5],
    ];
    for (const [bm25, cos] of cases) {
      const s = hybridScore(bm25, cos);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
