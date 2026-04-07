/**
 * knowledge-wiki.ts — Self-maintaining Knowledge Wiki (Phase 1).
 *
 * Replaces raw RAG with structured topic pages, backlinks, quality gates,
 * and LLM-driven compilation. Topic pages are stored in a dedicated SQLite
 * database and injected into the agent's system prompt between Layer 2
 * (retrieved memory) and auto-memory.
 *
 * Core operations:
 *   ingestRaw(topic, content)  — insert or append raw knowledge snippets
 *   compile(apiKey, model)     — LLM clusters raw entries into topic pages
 *   lint()                     — consistency checks (broken backlinks, staleness)
 *   qualityGate()              — score each page, flag low-quality for recompile
 *   getWikiBlock(query)        — retrieve relevant topic pages for injection
 *   seedFromProjectMap(cwd)    — bootstrap topics from project structure
 *
 * Storage: ~/.orager/wiki/wiki.sqlite (single DB for all wiki data)
 */

import { openDb } from "./native-sqlite.js";
import { BM25Index, tokenize as bm25Tokenize } from "./bm25.js";
import { localEmbedBatch, localEmbedWithTimeout, cosineSimilarity } from "./local-embeddings.js";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "./embedding-cache.js";
import type { SqliteDatabase } from "./native-sqlite.js";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── Path resolution ─────────────────────────────────────────────────────────

/** Resolve the wiki SQLite DB path. Override with ORAGER_WIKI_DB_PATH. */
export function resolveWikiDbPath(): string {
  return (
    process.env["ORAGER_WIKI_DB_PATH"] ??
    path.join(os.homedir(), ".orager", "wiki", "wiki.sqlite")
  );
}

// ── Schema ──────────────────────────────────────────────────────────────────

const WIKI_SCHEMA = `
CREATE TABLE IF NOT EXISTS wiki_pages (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL UNIQUE,
  content       TEXT NOT NULL DEFAULT '',
  backlinks     TEXT NOT NULL DEFAULT '[]',
  quality_score REAL NOT NULL DEFAULT 0.0,
  last_compiled TEXT,
  last_linted   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wiki_topic ON wiki_pages(topic);
CREATE INDEX IF NOT EXISTS idx_wiki_quality ON wiki_pages(quality_score);

CREATE TABLE IF NOT EXISTS wiki_raw (
  id         TEXT PRIMARY KEY,
  topic      TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wiki_raw_topic ON wiki_raw(topic);
`;

// ── DB singleton ────────────────────────────────────────────────────────────

let _db: SqliteDatabase | null = null;

async function getWikiDb(): Promise<SqliteDatabase> {
  if (_db) return _db;
  const dbPath = resolveWikiDbPath();
  const db = await openDb(dbPath);
  db.exec(WIKI_SCHEMA);
  _db = db;
  return db;
}

/** Close the wiki DB connection. Call before process exit. */
export function closeWikiDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

/** Reset singleton — for testing only. */
export function _resetWikiDbForTesting(): void {
  closeWikiDb();
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface WikiPage {
  id: string;
  topic: string;
  content: string;
  backlinks: string[];
  qualityScore: number;
  lastCompiled: string | null;
  lastLinted: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiRawEntry {
  id: string;
  topic: string;
  content: string;
  source: string | null;
  createdAt: string;
}

export interface LintResult {
  brokenBacklinks: Array<{ page: string; target: string }>;
  stalePagesCount: number;
  orphanPagesCount: number;
}

export interface QualityReport {
  totalPages: number;
  avgScore: number;
  lowQualityPages: Array<{ topic: string; score: number }>;
  highQualityPages: Array<{ topic: string; score: number }>;
}

// ── Row mapping ─────────────────────────────────────────────────────────────

function rowToPage(row: Record<string, unknown>): WikiPage {
  return {
    id: row["id"] as string,
    topic: row["topic"] as string,
    content: row["content"] as string,
    backlinks: JSON.parse((row["backlinks"] as string) || "[]"),
    qualityScore: row["quality_score"] as number,
    lastCompiled: (row["last_compiled"] as string) ?? null,
    lastLinted: (row["last_linted"] as string) ?? null,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

function rowToRawEntry(row: Record<string, unknown>): WikiRawEntry {
  return {
    id: row["id"] as string,
    topic: row["topic"] as string,
    content: row["content"] as string,
    source: (row["source"] as string) ?? null,
    createdAt: row["created_at"] as string,
  };
}

// ── CRUD operations ─────────────────────────────────────────────────────────

/**
 * Ingest a raw knowledge snippet for a topic.
 * Raw entries accumulate until compile() merges them into a topic page.
 */
export async function ingestRaw(
  topic: string,
  content: string,
  source?: string,
): Promise<WikiRawEntry> {
  const db = await getWikiDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO wiki_raw (id, topic, content, source) VALUES (?, ?, ?, ?)",
  ).run(id, topic.toLowerCase().trim(), content, source ?? null);
  return { id, topic: topic.toLowerCase().trim(), content, source: source ?? null, createdAt: new Date().toISOString() };
}

/**
 * Get or create a wiki page for a topic.
 */
export async function getOrCreatePage(topic: string): Promise<WikiPage> {
  const db = await getWikiDb();
  const normalized = topic.toLowerCase().trim();
  const existing = db.prepare("SELECT * FROM wiki_pages WHERE topic = ?").get(normalized);
  if (existing) return rowToPage(existing);

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO wiki_pages (id, topic) VALUES (?, ?)",
  ).run(id, normalized);
  return {
    id,
    topic: normalized,
    content: "",
    backlinks: [],
    qualityScore: 0,
    lastCompiled: null,
    lastLinted: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update a wiki page's content and backlinks.
 */
export async function updatePage(
  topic: string,
  content: string,
  backlinks: string[],
  qualityScore?: number,
): Promise<void> {
  const db = await getWikiDb();
  const normalized = topic.toLowerCase().trim();
  await getOrCreatePage(normalized); // ensure exists
  const score = qualityScore ?? 0;
  db.prepare(
    `UPDATE wiki_pages
     SET content = ?, backlinks = ?, quality_score = ?,
         updated_at = datetime('now'), last_compiled = datetime('now')
     WHERE topic = ?`,
  ).run(content, JSON.stringify(backlinks), score, normalized);
}

/** Get a page by topic, or null if it doesn't exist. */
export async function getPage(topic: string): Promise<WikiPage | null> {
  const db = await getWikiDb();
  const row = db.prepare("SELECT * FROM wiki_pages WHERE topic = ?").get(topic.toLowerCase().trim());
  return row ? rowToPage(row) : null;
}

/** List all wiki pages, ordered by quality score descending. */
export async function listPages(): Promise<WikiPage[]> {
  const db = await getWikiDb();
  const rows = db.prepare("SELECT * FROM wiki_pages ORDER BY quality_score DESC").all();
  return rows.map(rowToPage);
}

/** Delete a wiki page and its raw entries. */
export async function deletePage(topic: string): Promise<boolean> {
  const db = await getWikiDb();
  const normalized = topic.toLowerCase().trim();
  db.prepare("DELETE FROM wiki_raw WHERE topic = ?").run(normalized);
  const result = db.prepare("DELETE FROM wiki_pages WHERE topic = ?").run(normalized);
  return result.changes > 0;
}

/** Get all raw entries for a topic. */
export async function getRawEntries(topic: string): Promise<WikiRawEntry[]> {
  const db = await getWikiDb();
  const rows = db.prepare(
    "SELECT * FROM wiki_raw WHERE topic = ? ORDER BY created_at ASC",
  ).all(topic.toLowerCase().trim());
  return rows.map(rowToRawEntry);
}

/** Count raw entries pending compilation for a topic. */
export async function countPendingRaw(topic?: string): Promise<number> {
  const db = await getWikiDb();
  if (topic) {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM wiki_raw WHERE topic = ?").get(topic.toLowerCase().trim());
    return (row as { cnt: number })?.cnt ?? 0;
  }
  const row = db.prepare("SELECT COUNT(*) as cnt FROM wiki_raw").get();
  return (row as { cnt: number })?.cnt ?? 0;
}

// ── Compile ─────────────────────────────────────────────────────────────────

/**
 * Compile raw entries into a structured topic page using LLM.
 *
 * Groups raw entries by topic, sends each batch to the LLM with instructions
 * to produce a clean, cross-referenced wiki page, then updates the page.
 *
 * @param callLlm - function to call the LLM (injected to avoid tight coupling)
 * @param topics  - specific topics to compile, or undefined for all with pending raw entries
 */
export async function compile(
  callLlm: (systemPrompt: string, userPrompt: string) => Promise<string>,
  topics?: string[],
): Promise<{ compiled: number; errors: string[] }> {
  const db = await getWikiDb();
  const errors: string[] = [];
  let compiled = 0;

  // Find topics with pending raw entries
  const targetTopics = topics ?? (() => {
    const rows = db.prepare(
      "SELECT DISTINCT topic FROM wiki_raw ORDER BY topic",
    ).all();
    return rows.map((r) => (r as { topic: string }).topic);
  })();

  for (const topic of targetTopics) {
    const rawEntries = await getRawEntries(topic);
    if (rawEntries.length === 0) continue;

    const existingPage = await getPage(topic);
    const existingContent = existingPage?.content ?? "";

    const systemPrompt = `You are a technical wiki curator. Your task is to maintain a knowledge base topic page.
Given existing page content (if any) and new raw entries, produce an updated wiki page that:
1. Integrates new information with existing content
2. Organizes into clear sections with markdown headers
3. Includes [[backlinks]] to related topics (use [[topic-name]] syntax)
4. Removes redundant or contradictory information (prefer newer entries)
5. Keeps the page concise — aim for 200-500 words
6. Assigns a quality score (0.0-1.0) based on completeness and clarity

Respond in this exact format:
QUALITY: <score>
BACKLINKS: <comma-separated topic names, or NONE>
---
<page content in markdown>`;

    const rawBlock = rawEntries
      .map((e, i) => `[Entry ${i + 1}${e.source ? ` (source: ${e.source})` : ""}]\n${e.content}`)
      .join("\n\n");

    const userPrompt = `Topic: ${topic}

${existingContent ? `Existing page content:\n${existingContent}\n\n` : ""}New raw entries to integrate:\n${rawBlock}`;

    try {
      const response = await callLlm(systemPrompt, userPrompt);
      const parsed = parseCompileResponse(response);
      await updatePage(topic, parsed.content, parsed.backlinks, parsed.qualityScore);

      // Clear compiled raw entries
      db.prepare("DELETE FROM wiki_raw WHERE topic = ?").run(topic);
      compiled++;
    } catch (err) {
      errors.push(`${topic}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { compiled, errors };
}

/** Parse the LLM's compile response into structured fields. */
function parseCompileResponse(response: string): {
  content: string;
  backlinks: string[];
  qualityScore: number;
} {
  const lines = response.split("\n");
  let qualityScore = 0.5;
  let backlinks: string[] = [];
  let contentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("QUALITY:")) {
      const score = parseFloat(line.slice(8).trim());
      if (!isNaN(score) && score >= 0 && score <= 1) qualityScore = score;
    } else if (line.startsWith("BACKLINKS:")) {
      const bl = line.slice(10).trim();
      if (bl !== "NONE" && bl !== "") {
        backlinks = bl.split(",").map((b) => b.trim().toLowerCase()).filter(Boolean);
      }
    } else if (line === "---") {
      contentStart = i + 1;
      break;
    }
  }

  const content = lines.slice(contentStart).join("\n").trim();
  return { content: content || response.trim(), backlinks, qualityScore };
}

// ── Lint ─────────────────────────────────────────────────────────────────────

/**
 * Check wiki consistency:
 * - Broken backlinks (pointing to non-existent pages)
 * - Stale pages (not compiled in 30+ days)
 * - Orphan pages (no backlinks pointing to them and no raw entries)
 */
export async function lint(): Promise<LintResult> {
  const db = await getWikiDb();
  const pages = await listPages();
  const topicSet = new Set(pages.map((p) => p.topic));
  const referencedTopics = new Set<string>();

  const brokenBacklinks: Array<{ page: string; target: string }> = [];

  for (const page of pages) {
    for (const bl of page.backlinks) {
      referencedTopics.add(bl);
      if (!topicSet.has(bl)) {
        brokenBacklinks.push({ page: page.topic, target: bl });
      }
    }
  }

  // Stale: not compiled in 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleRows = db.prepare(
    "SELECT COUNT(*) as cnt FROM wiki_pages WHERE last_compiled IS NULL OR last_compiled < ?",
  ).get(thirtyDaysAgo);
  const stalePagesCount = (staleRows as { cnt: number })?.cnt ?? 0;

  // Orphans: not referenced by any backlink and no pending raw entries
  let orphanPagesCount = 0;
  for (const page of pages) {
    if (!referencedTopics.has(page.topic)) {
      const rawCount = await countPendingRaw(page.topic);
      if (rawCount === 0 && page.content === "") orphanPagesCount++;
    }
  }

  // Update lint timestamp
  db.prepare("UPDATE wiki_pages SET last_linted = datetime('now')").run();

  return { brokenBacklinks, stalePagesCount, orphanPagesCount };
}

// ── Quality Gate ────────────────────────────────────────────────────────────

/**
 * Score and classify all wiki pages by quality.
 * Returns a report with average score and lists of low/high quality pages.
 */
export async function qualityGate(threshold = 0.4): Promise<QualityReport> {
  const pages = await listPages();
  if (pages.length === 0) {
    return { totalPages: 0, avgScore: 0, lowQualityPages: [], highQualityPages: [] };
  }

  const avgScore = pages.reduce((sum, p) => sum + p.qualityScore, 0) / pages.length;
  const lowQualityPages = pages
    .filter((p) => p.qualityScore < threshold)
    .map((p) => ({ topic: p.topic, score: p.qualityScore }));
  const highQualityPages = pages
    .filter((p) => p.qualityScore >= 0.7)
    .map((p) => ({ topic: p.topic, score: p.qualityScore }));

  return { totalPages: pages.length, avgScore, lowQualityPages, highQualityPages };
}

// ── Retrieval for system prompt injection ───────────────────────────────────

/** Maximum characters for wiki injection into system prompt. */
export const WIKI_MAX_CHARS = 8_000; // ~2000 tokens

/**
 * Retrieve the most relevant wiki pages for a query.
 * Uses simple keyword matching against topic names and content.
 * Returns rendered markdown block ready for system prompt injection.
 */
export async function getWikiBlock(query: string, maxChars = WIKI_MAX_CHARS): Promise<string> {
  const db = await getWikiDb();
  const pages = db.prepare(
    "SELECT * FROM wiki_pages WHERE content != '' ORDER BY quality_score DESC",
  ).all().map(rowToPage);

  if (pages.length === 0) return "";

  // Score pages using BM25 with quality boost
  const queryTokens = bm25Tokenize(query);

  const idx = new BM25Index();
  for (const page of pages) {
    // Combine topic and content as document text for BM25
    idx.addDocument(page.topic, `${page.topic} ${page.content}`);
  }

  const scored = pages.map((page) => {
    const bm25 = queryTokens.length > 0 ? idx.score(queryTokens, page.topic) : 0;
    // Quality acts as a boost, not the base score
    const score = bm25 * (1 + page.qualityScore * 0.3);
    return { page, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Stage 2: Vector re-rank BM25 candidates for semantic precision
  const bm25Candidates = scored.filter(s => s.score > 0).slice(0, 20);
  if (bm25Candidates.length > 1) {
    try {
      let queryVec = getCachedQueryEmbedding("local", query);
      if (!queryVec) {
        queryVec = await localEmbedWithTimeout(query, 300);
        if (queryVec) setCachedQueryEmbedding("local", query, queryVec);
      }
      if (queryVec) {
        const texts = bm25Candidates.map(s => `${s.page.topic} ${s.page.content.slice(0, 500)}`);
        const vecs = await localEmbedBatch(texts);
        if (vecs) {
          for (let i = 0; i < bm25Candidates.length; i++) {
            const sim = cosineSimilarity(queryVec, vecs[i]!);
            // Blend: 40% BM25 (normalized) + 60% semantic similarity
            const maxBm25 = bm25Candidates[0]!.score || 1;
            bm25Candidates[i]!.score = 0.4 * (bm25Candidates[i]!.score / maxBm25) + 0.6 * sim;
          }
          bm25Candidates.sort((a, b) => b.score - a.score);
        }
      }
    } catch { /* embedding unavailable — keep BM25 order */ }
    // Replace scored with re-ranked candidates
    scored.length = 0;
    scored.push(...bm25Candidates);
  }

  // Render top pages within budget
  const parts: string[] = [];
  let chars = 0;
  for (const { page, score } of scored) {
    if (score <= 0) break; // no relevance
    const block = `### ${page.topic}\n${page.content}`;
    if (chars + block.length > maxChars) break;
    parts.push(block);
    chars += block.length;
  }

  return parts.join("\n\n");
}

// ── Seed from project map ───────────────────────────────────────────────────

/**
 * Bootstrap wiki topics from project structure.
 * Creates raw entries for each cluster and key file from the project map.
 */
export async function seedFromProjectMap(cwd: string): Promise<number> {
  // Dynamic import to avoid circular dependency
  const { getProjectMap } = await import("./project-index.js");
  const projectMap = await getProjectMap(cwd);
  if (!projectMap) return 0;

  let seeded = 0;

  // Create topic for each cluster
  for (const cluster of projectMap.clusters) {
    const topic = `project-${cluster.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const content = [
      `## ${cluster.name}`,
      `Files: ${cluster.files.slice(0, 10).join(", ")}${cluster.files.length > 10 ? ` (+${cluster.files.length - 10} more)` : ""}`,
      cluster.files.length > 0 ? `Primary directory pattern for project component.` : "",
    ].filter(Boolean).join("\n");
    await ingestRaw(topic, content, "project-map-seed");
    seeded++;
  }

  // Create topics for hot files
  if (projectMap.hotFiles.length > 0) {
    const hotContent = projectMap.hotFiles
      .map((f) => `- ${f}`)
      .join("\n");
    await ingestRaw("project-hot-files", `## High-Impact Files\n${hotContent}`, "project-map-seed");
    seeded++;
  }

  // Create topics for entry points
  if (projectMap.entryPoints.length > 0) {
    const epContent = projectMap.entryPoints.map((f) => `- ${f}`).join("\n");
    await ingestRaw("project-entry-points", `## Entry Points\n${epContent}`, "project-map-seed");
    seeded++;
  }

  return seeded;
}

// ── Stats ───────────────────────────────────────────────────────────────────

export interface WikiStats {
  totalPages: number;
  totalRawEntries: number;
  avgQualityScore: number;
  topTopics: Array<{ topic: string; score: number }>;
}

export async function getWikiStats(): Promise<WikiStats> {
  const db = await getWikiDb();
  const pageCount = (db.prepare("SELECT COUNT(*) as cnt FROM wiki_pages WHERE content != ''").get() as { cnt: number })?.cnt ?? 0;
  const rawCount = (db.prepare("SELECT COUNT(*) as cnt FROM wiki_raw").get() as { cnt: number })?.cnt ?? 0;
  const avgRow = db.prepare("SELECT AVG(quality_score) as avg FROM wiki_pages WHERE content != ''").get() as { avg: number | null } | undefined;
  const avgScore = avgRow?.avg ?? 0;
  const topRows = db.prepare(
    "SELECT topic, quality_score FROM wiki_pages WHERE content != '' ORDER BY quality_score DESC LIMIT 5",
  ).all();
  const topTopics = topRows.map((r) => ({
    topic: (r as { topic: string }).topic,
    score: (r as { quality_score: number }).quality_score,
  }));

  return { totalPages: pageCount, totalRawEntries: rawCount, avgQualityScore: avgScore, topTopics };
}
