/**
 * Cross-session persistent memory for orager agents.
 *
 * Entries are stored per-agent at:
 *   ~/.orager/memory/<sanitizedMemoryKey>.json
 *
 * The memoryKey is typically the Paperclip agent ID (passed via config) or,
 * for standalone use, derived from the working directory. This keeps memories
 * stable across session resets, summarizations, and new orager invocations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  isSqliteMemoryEnabled,
  loadMemoryStoreSqlite,
  saveMemoryStoreSqlite,
} from "./memory-sqlite.js";
import {
  tokenize as bm25Tokenize,
  STOP_WORDS,
  computeCorpusStats,
  bm25Score,
  hybridScore,
  type CorpusStats,
} from "./bm25.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryStore {
  memoryKey: string;
  entries: MemoryEntry[];
  updatedAt: string; // ISO
}

/** Valid type values agents may emit in <memory_update> blocks. */
export const MEMORY_ENTRY_TYPES = [
  "insight",
  "fact",
  "competitor",
  "decision",
  "risk",
  "open_question",
] as const;
export type MemoryEntryType = typeof MEMORY_ENTRY_TYPES[number] | "master_context" | "session_summary";

export interface MemoryEntry {
  id: string;           // crypto.randomUUID()
  content: string;      // freeform text, agent-authored
  tags?: string[];      // optional: ["bug", "auth", "user-pref"]
  createdAt: string;    // ISO
  expiresAt?: string;   // ISO — undefined means never expires
  runId?: string;       // orager session ID that created it
  importance: 1 | 2 | 3; // 1=low, 2=normal, 3=high (affects sort order)
  type?: MemoryEntryType; // categorises the entry for retrieval and distillation
  _embedding?: number[];    // cached embedding vector
  _embeddingModel?: string; // model used to generate it
}

// ── Storage path ──────────────────────────────────────────────────────────────

export const MEMORY_DIR =
  process.env["ORAGER_MEMORY_DIR"] ??
  path.join(os.homedir(), ".orager", "memory");

function sanitizeKey(memoryKey: string): string {
  return memoryKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

function memoryFilePath(memoryKey: string): string {
  return path.join(MEMORY_DIR, `${sanitizeKey(memoryKey)}.json`);
}

// ── Storage ───────────────────────────────────────────────────────────────────

export async function loadMemoryStore(memoryKey: string): Promise<MemoryStore> {
  const filePath = memoryFilePath(memoryKey);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    // ENOENT — file doesn't exist yet, return empty store silently
    return { memoryKey, entries: [], updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(raw) as MemoryStore;
  } catch (err) {
    // Corrupted memory file (partial write, encoding error) — log a warning so
    // operators can diagnose silent data loss, then return empty store
    process.stderr.write(
      `[orager] WARNING: memory file "${filePath}" contains invalid JSON — starting with empty store. ` +
      `(${err instanceof Error ? err.message : String(err)})\n`
    );
    return { memoryKey, entries: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveMemoryStore(memoryKey: string, store: MemoryStore): Promise<void> {
  const filePath = memoryFilePath(memoryKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns live entries sorted by importance desc, createdAt desc.
 * Truncates to maxChars to stay within token budget.
 *
 * Format (one entry per line):
 *   [1] (id: abc123, importance: 3, tags: auth) Auth tokens expire after 1h
 *   [2] (id: def456, importance: 2) User prefers TypeScript for new files
 */
export function renderMemoryBlock(store: MemoryStore, maxChars = 6000): string {
  if (store.entries.length === 0) return "";

  const sorted = [...store.entries].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const tagPart = e.tags && e.tags.length > 0 ? `, tags: ${e.tags.join(", ")}` : "";
    lines.push(`[${i + 1}] (id: ${e.id}, importance: ${e.importance}${tagPart}) ${e.content}`);
  }

  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  // Truncate at maxChars without leaking a partial entry
  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : "";
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

// Re-export STOP_WORDS for backward compatibility (canonical source: bm25.ts)
export { STOP_WORDS } from "./bm25.js";

/**
 * Lowercases, splits on whitespace and punctuation, removes stop words,
 * and returns unique tokens with length >= 3.
 * Delegates to the shared tokenizer in bm25.ts.
 */
export function buildQuery(text: string): string[] {
  return bm25Tokenize(text);
}

/**
 * Tokenize text preserving duplicates (needed for BM25 term frequency).
 */
function tokenizeRaw(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u);
  return tokens.filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok));
}

/**
 * Scores a memory entry against query tokens using BM25.
 * Combines BM25 text relevance with importance weight and recency decay.
 *
 * When corpusStats is provided, uses proper BM25 with IDF and length
 * normalization. Falls back to basic term overlap when stats are unavailable.
 */
export function scoreEntry(
  entry: MemoryEntry,
  queryTokens: string[],
  corpusStats?: CorpusStats,
): number {
  const importanceWeight = entry.importance === 3 ? 1.5 : entry.importance === 2 ? 1.0 : 0.6;
  const days = (Date.now() - Date.parse(entry.createdAt)) / 86400000;
  const recencyDecay = 1 / (1 + days / 30);

  if (queryTokens.length === 0) {
    return importanceWeight * recencyDecay;
  }

  let textScore: number;
  if (corpusStats) {
    const docTokens = tokenizeRaw(entry.content);
    textScore = bm25Score(queryTokens, docTokens, corpusStats);
  } else {
    // Fallback: simple term overlap (backward compatible)
    const contentLower = entry.content.toLowerCase();
    const matchCount = queryTokens.filter((tok) => contentLower.includes(tok)).length;
    textScore = matchCount / Math.max(queryTokens.length, 1);
  }

  return textScore * importanceWeight * recencyDecay;
}

/**
 * Retrieves the most relevant entries for a query.
 * Falls back to importance+recency sort when queryTokens is empty.
 */
export function retrieveEntries(
  store: MemoryStore,
  query: string,
  opts?: { topK?: number; minScore?: number },
): MemoryEntry[] {
  const topK = opts?.topK ?? 12;
  const minScore = opts?.minScore ?? 0.0;
  const queryTokens = buildQuery(query);

  if (queryTokens.length === 0) {
    // Fall back to importance+recency sort
    return [...store.entries]
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, topK);
  }

  // Pre-compute corpus stats for BM25 scoring
  const corpusDocs = store.entries.map((e) => tokenizeRaw(e.content));
  const corpusStats = computeCorpusStats(corpusDocs);

  return store.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens, corpusStats) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ entry }) => entry);
}

/**
 * Same format as renderMemoryBlock but operates on a pre-filtered list.
 * Re-numbers entries [1], [2], ...
 *
 * @param sort
 *   "score"         — preserve caller-supplied order (default; highest-relevance first)
 *   "deterministic" — sort by [type ?? "", id] so the output is identical for the
 *                     same entry set regardless of retrieval order.  Use this for the
 *                     frozen system-prompt prefix so repeated runs produce the same
 *                     cached prefix and the Anthropic prompt-cache hit rate stays high.
 */
export function renderRetrievedBlock(
  entries: MemoryEntry[],
  maxChars = 6000,
  sort: "score" | "deterministic" = "score",
): string {
  if (entries.length === 0) return "";

  const ordered =
    sort === "deterministic"
      ? [...entries].sort((a, b) => {
          const ta = a.type ?? "";
          const tb = b.type ?? "";
          if (ta !== tb) return ta.localeCompare(tb);
          return a.id.localeCompare(b.id);
        })
      : entries;

  const lines: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const tagPart = e.tags && e.tags.length > 0 ? `, tags: ${e.tags.join(", ")}` : "";
    lines.push(`[${i + 1}] (id: ${e.id}, importance: ${e.importance}${tagPart}) ${e.content}`);
  }

  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : "";
}

// ── Embedding-based retrieval (Phase 2) ───────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Returns a new MemoryEntry with _embedding and _embeddingModel set.
 * Pure — no side effects.
 */
export function embedEntryIfNeeded(
  entry: MemoryEntry,
  embedding: number[],
  model: string,
): MemoryEntry {
  return { ...entry, _embedding: embedding, _embeddingModel: model };
}

/**
 * Retrieve entries ranked by embedding cosine similarity combined with
 * importance weight and recency decay.
 *
 * When queryText is provided, uses hybrid scoring (BM25 + cosine) for
 * entries with embeddings, improving retrieval for domain-specific terms.
 * Entries without a cached _embedding fall back to BM25-only scoring.
 */
export function retrieveEntriesWithEmbeddings(
  store: MemoryStore,
  queryEmbedding: number[],
  opts?: { topK?: number; minScore?: number; queryText?: string },
): MemoryEntry[] {
  const topK = opts?.topK ?? 12;
  const minScore = opts?.minScore ?? 0.0;
  const queryTokens = opts?.queryText ? buildQuery(opts.queryText) : [];

  // Pre-compute corpus stats for BM25 when query text is available
  let corpusStats: CorpusStats | undefined;
  if (queryTokens.length > 0) {
    const corpusDocs = store.entries.map((e) => tokenizeRaw(e.content));
    corpusStats = computeCorpusStats(corpusDocs);
  }

  const scored = store.entries.map((entry) => {
    const importanceWeight = entry.importance === 3 ? 1.5 : entry.importance === 2 ? 1.0 : 0.6;
    const days = (Date.now() - Date.parse(entry.createdAt)) / 86400000;
    const recencyDecay = 1 / (1 + days / 30);

    let score: number;
    if (entry._embedding && entry._embedding.length > 0) {
      const sim = cosineSimilarity(entry._embedding, queryEmbedding);
      if (queryTokens.length > 0 && corpusStats) {
        // Hybrid: blend BM25 keyword signal with embedding cosine similarity
        const docTokens = tokenizeRaw(entry.content);
        const bm25Raw = bm25Score(queryTokens, docTokens, corpusStats);
        score = hybridScore(bm25Raw, sim) * importanceWeight * recencyDecay;
      } else {
        score = sim * importanceWeight * recencyDecay;
      }
    } else {
      // No embedding — fall back to BM25-only (or importance+recency if no query)
      score = scoreEntry(entry, queryTokens, corpusStats);
    }

    return { entry, score };
  });

  return scored
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ entry }) => entry);
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Hard cap on memory entries per agent to prevent unbounded growth. */
const MAX_MEMORY_ENTRIES = 1000;

/** Adds an entry. Returns a new store — original is unchanged.
 *
 * When the store exceeds MAX_MEMORY_ENTRIES, the lowest-importance (then
 * oldest) entry is evicted to make room. (audit E-16)
 */
export function addMemoryEntry(
  store: MemoryStore,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): MemoryStore {
  const now = new Date().toISOString();
  const newEntry: MemoryEntry = {
    ...entry,
    importance: entry.importance ?? 2,
    id: crypto.randomUUID(),
    createdAt: now,
  };
  let entries = [...store.entries, newEntry];
  // Evict lowest-importance, oldest entries when over cap.
  while (entries.length > MAX_MEMORY_ENTRIES) {
    let victimIdx = 0;
    for (let i = 1; i < entries.length; i++) {
      const v = entries[victimIdx]!;
      const c = entries[i]!;
      if (c.importance < v.importance || (c.importance === v.importance && c.createdAt < v.createdAt)) {
        victimIdx = i;
      }
    }
    entries.splice(victimIdx, 1);
  }
  return {
    ...store,
    entries,
    updatedAt: now,
  };
}

/** Removes an entry by id. No-ops when id doesn't exist. Returns a new store. */
export function removeMemoryEntry(store: MemoryStore, id: string): MemoryStore {
  const entries = store.entries.filter((e) => e.id !== id);
  if (entries.length === store.entries.length) return store;
  return { ...store, entries, updatedAt: new Date().toISOString() };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

/** Removes expired entries. Returns a new store — original is unchanged. */
export function pruneExpired(store: MemoryStore): MemoryStore {
  const now = new Date().toISOString();
  const entries = store.entries.filter((e) => !e.expiresAt || e.expiresAt > now);
  if (entries.length === store.entries.length) return store;
  return { ...store, entries, updatedAt: new Date().toISOString() };
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a stable memory key from a working directory path for standalone use.
 * Produces a short hash so the filename stays readable on all platforms.
 */
export function memoryKeyFromCwd(cwd: string): string {
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  const label = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return `${label}_${hash}`;
}

/**
 * Convert a repo URL into a short filesystem-safe slug.
 * Strips the scheme, replaces non-alphanumeric chars with underscores,
 * collapses runs, trims edges, and truncates to 64 chars.
 */
export function repoSlug(repoUrl: string): string {
  return repoUrl
    .replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

/**
 * Build a memory key from an agent ID and optional repository URL.
 * Falls back to agentId alone when repoUrl is null or empty.
 * Otherwise returns `${agentId}_${repoSlug(repoUrl)}` truncated to 128 chars.
 */
export function buildMemoryKeyFromRepo(agentId: string, repoUrl: string | null): string {
  if (!repoUrl) return agentId;
  const slug = repoSlug(repoUrl);
  if (!slug) return agentId;
  return `${agentId}_${slug}`.slice(0, 128);
}

// ── Per-key write lock ────────────────────────────────────────────────────────
//
// Prevents concurrent writes from silently dropping entries via last-write-wins.
// Uses a promise-chaining mutex pattern: each lock operation chains on the
// previous one for the same key so writes are always serialised.

const _memoryWriteLocks = new Map<string, Promise<void>>();

/**
 * Acquire a per-key advisory lock, run fn(), then release.
 * Concurrent callers with the same key are queued in order.
 * Exported for testing; _clearMemoryLocksForTesting() resets state.
 */
export async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _memoryWriteLocks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((res) => { resolve = res; });
  // Store a non-rejecting sentinel so failures don't block subsequent waiters.
  // Keep a reference to this exact Promise so we can compare it in the finally
  // block — _memoryWriteLocks.get(key) === sentinel only when no newer waiter
  // has replaced us, in which case we clean up the map entry.
  const sentinel = next.catch(() => {});
  _memoryWriteLocks.set(key, sentinel);

  await prev.catch(() => {}); // wait for any in-flight operation on this key
  try {
    return await fn();
  } finally {
    resolve();
    // Clean up map entry if no newer waiter has replaced it
    if (_memoryWriteLocks.get(key) === sentinel) {
      _memoryWriteLocks.delete(key);
    }
  }
}

/** Reset lock state — for testing only. */
export function _clearMemoryLocksForTesting(): void {
  _memoryWriteLocks.clear();
}

/** Returns the current size of the lock Map — for testing only. */
export function _getMemoryLocksMapSizeForTesting(): number {
  return _memoryWriteLocks.size;
}

// ── Storage router ────────────────────────────────────────────────────────────

/**
 * Returns true when SQLite is enabled and the retrieval mode is "local" (Phase 1).
 * In this case, searchMemoryFts should be used instead of in-memory scoring.
 */
export function shouldUseFtsRetrieval(memoryRetrieval?: string): boolean {
  return isSqliteMemoryEnabled() && (memoryRetrieval === "local" || memoryRetrieval === undefined);
}

/**
 * Load memory store from SQLite when ORAGER_DB_PATH is set, otherwise from JSON file.
 */
export async function loadMemoryStoreAny(memoryKey: string): Promise<MemoryStore> {
  if (isSqliteMemoryEnabled()) return loadMemoryStoreSqlite(memoryKey);
  return loadMemoryStore(memoryKey);
}

/**
 * Save memory store to SQLite when ORAGER_DB_PATH is set, otherwise to JSON file.
 */
export async function saveMemoryStoreAny(memoryKey: string, store: MemoryStore): Promise<void> {
  if (isSqliteMemoryEnabled()) { await saveMemoryStoreSqlite(memoryKey, store); return; }
  await saveMemoryStore(memoryKey, store);
}
