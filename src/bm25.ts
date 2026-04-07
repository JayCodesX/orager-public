/**
 * BM25 scoring utilities for orager's text-based retrieval paths.
 *
 * Provides:
 * - Unified tokenizer (consolidates divergent tokenizers across the codebase)
 * - BM25Index class for corpus-aware scoring
 * - Standalone bm25Score() for one-off scoring
 * - hybridScore() for blending BM25 + embedding cosine similarity
 *
 * Pure TypeScript, zero dependencies.
 */

// ── Stop words ───────────────────────────────────────────────────────────────

export const STOP_WORDS = new Set([
  "the","a","an","is","it","to","of","and","or","in","on","at","for","with",
  "this","that","was","are","be","by","as","from","but","not","has","have",
  "had","do","did","will","would","could","should","can","may","might",
]);

// ── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Unified tokenizer for BM25 scoring.
 * Lowercases, splits on whitespace and Unicode punctuation, removes stop words,
 * deduplicates, and filters tokens shorter than 3 characters.
 *
 * Returns tokens in order of first appearance (deduplicated).
 */
export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tok of tokens) {
    if (tok.length >= 3 && !STOP_WORDS.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      result.push(tok);
    }
  }
  return result;
}

/**
 * Tokenize without deduplication — returns raw term frequencies.
 * Used internally for building term frequency maps.
 */
function tokenizeRaw(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u);
  return tokens.filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok));
}

// ── Corpus statistics ────────────────────────────────────────────────────────

export interface CorpusStats {
  /** Total number of documents in the corpus. */
  docCount: number;
  /** Average document length (in tokens). */
  avgDocLength: number;
  /** Number of documents containing each term. */
  docFreqs: Map<string, number>;
}

/**
 * Compute corpus statistics from a set of pre-tokenized documents.
 * Each entry in `docs` should be the raw token list (with duplicates) for one document.
 */
export function computeCorpusStats(docs: string[][]): CorpusStats {
  const docCount = docs.length;
  const docFreqs = new Map<string, number>();
  let totalLength = 0;

  for (const docTokens of docs) {
    totalLength += docTokens.length;
    const uniqueTerms = new Set(docTokens);
    for (const term of uniqueTerms) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  return {
    docCount,
    avgDocLength: docCount > 0 ? totalLength / docCount : 0,
    docFreqs,
  };
}

// ── BM25 scoring ─────────────────────────────────────────────────────────────

/**
 * Compute IDF for a term using the BM25 variant:
 *   IDF(q) = ln((N - n(q) + 0.5) / (n(q) + 0.5) + 1)
 *
 * where N = total docs, n(q) = docs containing term q.
 * Returns 0 for terms not in the corpus (conservative — unknown terms get no weight).
 */
function idf(term: string, stats: CorpusStats): number {
  const n = stats.docFreqs.get(term) ?? 0;
  if (n === 0) return 0;
  return Math.log((stats.docCount - n + 0.5) / (n + 0.5) + 1);
}

/**
 * Standalone BM25 score for a single document against a query.
 *
 * @param queryTokens Deduplicated query terms.
 * @param docTokens Raw document tokens (with duplicates — needed for TF).
 * @param stats Pre-computed corpus statistics.
 * @param k1 Term frequency saturation parameter (default 1.2).
 * @param b Length normalization parameter (default 0.75).
 */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  stats: CorpusStats,
  k1 = 1.2,
  b = 0.75,
): number {
  if (queryTokens.length === 0 || docTokens.length === 0 || stats.docCount === 0) return 0;

  // Build term frequency map for this document
  const tf = new Map<string, number>();
  for (const tok of docTokens) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }

  const docLen = docTokens.length;
  const avgdl = stats.avgDocLength;
  let score = 0;

  for (const q of queryTokens) {
    const termFreq = tf.get(q) ?? 0;
    if (termFreq === 0) continue;

    const termIdf = idf(q, stats);
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLen / avgdl));
    score += termIdf * (numerator / denominator);
  }

  return score;
}

// ── BM25 Index (for repeated scoring against a corpus) ───────────────────────

interface DocEntry {
  tokens: string[];
  length: number;
}

/**
 * BM25 index for efficient scoring of multiple queries against a fixed corpus.
 * Maintains pre-computed corpus statistics and per-document token data.
 */
export class BM25Index {
  private docs = new Map<string, DocEntry>();
  private docFreqs = new Map<string, number>();
  private totalLength = 0;
  private k1: number;
  private b: number;

  constructor(opts?: { k1?: number; b?: number }) {
    this.k1 = opts?.k1 ?? 1.2;
    this.b = opts?.b ?? 0.75;
  }

  get documentCount(): number {
    return this.docs.size;
  }

  get avgDocLength(): number {
    return this.docs.size > 0 ? this.totalLength / this.docs.size : 0;
  }

  /**
   * Add a document to the index.
   * @param id Unique document identifier.
   * @param text Raw text to tokenize and index, or pre-tokenized array.
   */
  addDocument(id: string, text: string | string[]): void {
    // Remove existing doc if re-adding
    if (this.docs.has(id)) this.removeDocument(id);

    const tokens = typeof text === "string" ? tokenizeRaw(text) : text;
    const entry: DocEntry = { tokens, length: tokens.length };
    this.docs.set(id, entry);
    this.totalLength += entry.length;

    // Update document frequencies
    const uniqueTerms = new Set(tokens);
    for (const term of uniqueTerms) {
      this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
    }
  }

  /** Remove a document from the index. */
  removeDocument(id: string): void {
    const entry = this.docs.get(id);
    if (!entry) return;

    this.totalLength -= entry.length;
    const uniqueTerms = new Set(entry.tokens);
    for (const term of uniqueTerms) {
      const count = (this.docFreqs.get(term) ?? 1) - 1;
      if (count <= 0) this.docFreqs.delete(term);
      else this.docFreqs.set(term, count);
    }
    this.docs.delete(id);
  }

  /** Score a single document against the query. */
  score(queryTokens: string[], docId: string): number {
    const entry = this.docs.get(docId);
    if (!entry) return 0;
    return this._scoreEntry(queryTokens, entry);
  }

  /** Score all documents and return a map of id -> score (only non-zero). */
  scoreAll(queryTokens: string[]): Map<string, number> {
    const results = new Map<string, number>();
    for (const [id, entry] of this.docs) {
      const s = this._scoreEntry(queryTokens, entry);
      if (s > 0) results.set(id, s);
    }
    return results;
  }

  private _scoreEntry(queryTokens: string[], entry: DocEntry): number {
    if (queryTokens.length === 0 || entry.length === 0) return 0;

    const tf = new Map<string, number>();
    for (const tok of entry.tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }

    const N = this.docs.size;
    const avgdl = this.avgDocLength;
    let score = 0;

    for (const q of queryTokens) {
      const termFreq = tf.get(q) ?? 0;
      if (termFreq === 0) continue;

      const n = this.docFreqs.get(q) ?? 0;
      const termIdf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      const numerator = termFreq * (this.k1 + 1);
      const denominator = termFreq + this.k1 * (1 - this.b + this.b * (entry.length / avgdl));
      score += termIdf * (numerator / denominator);
    }

    return score;
  }
}

// ── Hybrid scoring ───────────────────────────────────────────────────────────

/**
 * Normalize a raw BM25 score to [0, 1] using a sigmoid function.
 * The midpoint parameter controls where the sigmoid centers.
 * With default midpoint=3, a BM25 score of 3 maps to ~0.5.
 */
function sigmoidNormalize(score: number, midpoint = 3): number {
  return 1 / (1 + Math.exp(-(score - midpoint) / (midpoint * 0.5)));
}

/**
 * Blend BM25 and cosine similarity scores into a single score.
 *
 * @param bm25Raw Raw BM25 score (unbounded, will be sigmoid-normalized).
 * @param cosineSim Cosine similarity score, expected in [0, 1].
 * @param alpha Weight for BM25 component (default 0.4, embedding-heavy).
 * @returns Blended score in [0, 1].
 */
export function hybridScore(bm25Raw: number, cosineSim: number, alpha = 0.4): number {
  const normalizedBm25 = sigmoidNormalize(bm25Raw);
  return alpha * normalizedBm25 + (1 - alpha) * cosineSim;
}
