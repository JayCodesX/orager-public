/**
 * agent-identity-index.ts — FTS5 + sqlite-vec search index over agent identity files.
 *
 * Maintains a single SQLite database at ~/.orager/agents/identity-index.sqlite
 * that indexes all identity files (soul, operating-manual, memory, lessons, patterns)
 * for every identity-backed agent.
 *
 * Provides:
 *  - Full-text keyword search (FTS5 with BM25 ranking)
 *  - Semantic vector search (sqlite-vec ANN, with JS cosine fallback)
 *  - Combined hybrid search (FTS5 candidates → vector re-ranking)
 *
 * Used by agents to search each other's knowledge:
 *   "What does Mercury know about deployments?"
 */

import { openDb, isSqliteVecAvailable } from "./native-sqlite.js";
import type { SqliteDatabase } from "./native-sqlite.js";
import { runMigrations, type Migration } from "./db-migrations.js";
import { loadIdentity, listIdentities } from "./agent-identity.js";
import { callEmbeddings } from "./openrouter.js";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "./embedding-cache.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Constants ────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

/** Identity file types that get indexed. */
const INDEXABLE_FILES = [
  "soul",
  "operating-manual",
  "memory",
  "lessons",
  "patterns",
] as const;

type IndexableFileType = (typeof INDEXABLE_FILES)[number];

// ── DB singleton ─────────────────────────────────────────────────────────────

let _db: SqliteDatabase | null = null;
let _customDbPath: string | null = null;

function resolveIndexDbPath(): string {
  if (_customDbPath) return _customDbPath;
  return path.join(os.homedir(), ".orager", "agents", "identity-index.sqlite");
}

async function getDb(): Promise<SqliteDatabase> {
  if (_db) return _db;

  const dbPath = resolveIndexDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = await openDb(dbPath);
  _migrate(_db);
  return _db;
}

/** Close the DB connection (for testing / shutdown). */
export function closeIdentityIndex(): void {
  if (_db) {
    try { _db.exec("PRAGMA optimize"); } catch { /* ignore */ }
    _db = null;
  }
}

/** Reset singleton — for testing only. */
export function _resetForTesting(customDbPath?: string): void {
  closeIdentityIndex();
  _customDbPath = customDbPath ?? null;
}

// ── Migrations ───────────────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_identity_chunks",
    sql: `
      CREATE TABLE IF NOT EXISTS identity_chunks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id      TEXT NOT NULL,
        file_type     TEXT NOT NULL,
        content       TEXT NOT NULL,
        embedding     BLOB,
        embedding_model TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_agent ON identity_chunks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_agent_file ON identity_chunks(agent_id, file_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS identity_chunks_fts USING fts5(
        content,
        content='identity_chunks',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS identity_chunks_ai AFTER INSERT ON identity_chunks BEGIN
        INSERT INTO identity_chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS identity_chunks_ad AFTER DELETE ON identity_chunks BEGIN
        INSERT INTO identity_chunks_fts(identity_chunks_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS identity_chunks_au AFTER UPDATE ON identity_chunks BEGIN
        INSERT INTO identity_chunks_fts(identity_chunks_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        INSERT INTO identity_chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `,
  },
];

function _migrate(db: SqliteDatabase): void {
  runMigrations(db, MIGRATIONS);

  // Create sqlite-vec virtual table if available (non-fatal)
  if (isSqliteVecAvailable()) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS identity_chunk_vectors
        USING vec0(embedding float[${EMBEDDING_DIM}])
      `);
    } catch {
      // Non-fatal — fall back to JS cosine similarity
    }
  }
}

// ── Index operations ─────────────────────────────────────────────────────────

export interface IndexAgentOptions {
  /** Generate embeddings for vector search. Default: false (FTS-only is fast). */
  embeddings?: boolean;
  /** API key required when embeddings=true. */
  apiKey?: string;
}

/**
 * Index (or re-index) all identity files for a single agent.
 * Reads files from disk, chunks them, and upserts into the index.
 */
export async function indexAgent(
  agentId: string,
  opts?: IndexAgentOptions,
): Promise<{ chunksIndexed: number }> {
  const db = await getDb();
  const identity = loadIdentity(agentId);
  if (!identity) return { chunksIndexed: 0 };

  // Remove existing chunks for this agent
  db.prepare("DELETE FROM identity_chunks WHERE agent_id = ?").run(agentId);
  // Also clean vec table if it exists
  _deleteVecRows(db, agentId);

  const insert = db.prepare(
    "INSERT INTO identity_chunks (agent_id, file_type, content, embedding, embedding_model) VALUES (?, ?, ?, ?, ?)",
  );

  const fileContents: Array<{ type: IndexableFileType; content: string }> = [
    { type: "soul", content: identity.soul },
    { type: "operating-manual", content: identity.operatingManual },
    { type: "memory", content: identity.memory },
    { type: "lessons", content: identity.lessons.map((l) => `[${l.date}] ${l.what} — ${l.fix}`).join("\n") },
    { type: "patterns", content: identity.patterns },
  ];

  let chunksIndexed = 0;

  for (const { type, content } of fileContents) {
    if (!content.trim()) continue;

    // Split large files into ~500-word chunks for better retrieval granularity
    const chunks = chunkText(content, 500);

    for (const chunk of chunks) {
      let embedding: Uint8Array | null = null;
      let embeddingModel: string | null = null;

      if (opts?.embeddings && opts.apiKey) {
        try {
          const vec = await generateEmbedding(opts.apiKey, chunk);
          if (vec) {
            embedding = new Uint8Array(new Float32Array(vec).buffer);
            embeddingModel = EMBEDDING_MODEL;
          }
        } catch {
          // Non-fatal — index without embedding
        }
      }

      insert.run(agentId, type, chunk, embedding, embeddingModel);

      // Insert into vec table if we have an embedding and vec is available
      if (embedding && isSqliteVecAvailable()) {
        try {
          const lastId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
          db.prepare("INSERT INTO identity_chunk_vectors (rowid, embedding) VALUES (?, ?)").run(lastId, embedding);
        } catch {
          // Non-fatal
        }
      }

      chunksIndexed++;
    }
  }

  return { chunksIndexed };
}

/**
 * Re-index ALL identity-backed agents.
 */
export async function rebuildIndex(opts?: IndexAgentOptions): Promise<{ agentsIndexed: number; totalChunks: number }> {
  const agents = listIdentities();
  let totalChunks = 0;

  for (const agent of agents) {
    const result = await indexAgent(agent.id, opts);
    totalChunks += result.chunksIndexed;
  }

  return { agentsIndexed: agents.length, totalChunks };
}

/**
 * Remove an agent's entries from the index.
 */
export async function removeAgentFromIndex(agentId: string): Promise<void> {
  const db = await getDb();
  _deleteVecRows(db, agentId);
  db.prepare("DELETE FROM identity_chunks WHERE agent_id = ?").run(agentId);
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface IdentitySearchOptions {
  /** Filter to specific agent(s). */
  agentIds?: string[];
  /** Filter to specific file types. */
  fileTypes?: IndexableFileType[];
  /** Max results. Default: 10. */
  limit?: number;
  /** Use vector re-ranking (requires embeddings in index). Default: false. */
  semantic?: boolean;
  /** API key required when semantic=true. */
  apiKey?: string;
}

export interface IdentitySearchResult {
  agentId: string;
  fileType: string;
  content: string;
  score: number;
}

/**
 * Search agent identity knowledge using FTS5, with optional vector re-ranking.
 */
export async function searchIdentities(
  query: string,
  opts?: IdentitySearchOptions,
): Promise<IdentitySearchResult[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 10;

  // Sanitize query for FTS5
  const sanitized = query.replace(/[*^()\[\]{}":]/g, " ").trim();
  const words = sanitized.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");

  // Build WHERE clause for optional filters
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.agentIds?.length) {
    conditions.push(`c.agent_id IN (${opts.agentIds.map(() => "?").join(",")})`);
    params.push(...opts.agentIds);
  }
  if (opts?.fileTypes?.length) {
    conditions.push(`c.file_type IN (${opts.fileTypes.map(() => "?").join(",")})`);
    params.push(...opts.fileTypes);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  // Stage 1: FTS5 keyword search
  const candidateLimit = opts?.semantic ? limit * 3 : limit;
  const ftsRows = db.prepare(`
    SELECT c.id, c.agent_id, c.file_type, c.content, c.embedding,
           rank AS fts_score
    FROM identity_chunks_fts f
    JOIN identity_chunks c ON c.id = f.rowid
    WHERE identity_chunks_fts MATCH ?
      ${whereClause}
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, ...params, candidateLimit) as Array<{
    id: number;
    agent_id: string;
    file_type: string;
    content: string;
    embedding: Uint8Array | null;
    fts_score: number;
  }>;

  if (ftsRows.length === 0) return [];

  // Stage 2: Optional vector re-ranking
  if (opts?.semantic && opts.apiKey && ftsRows.some((r) => r.embedding)) {
    const queryVec = await generateEmbedding(opts.apiKey, query);
    if (queryVec) {
      const scored = ftsRows.map((row) => {
        let cosine = 0;
        if (row.embedding) {
          const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
          cosine = cosineSimilarity(queryVec, Array.from(stored));
        }
        // Blend: 40% BM25 (normalize FTS score), 60% cosine
        const normalizedFts = 1 / (1 + Math.abs(row.fts_score));
        const blended = 0.4 * normalizedFts + 0.6 * cosine;
        return { ...row, score: blended };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((r) => ({
        agentId: r.agent_id,
        fileType: r.file_type,
        content: r.content,
        score: r.score,
      }));
    }
  }

  // Return FTS-only results
  return ftsRows.slice(0, limit).map((r, i) => ({
    agentId: r.agent_id,
    fileType: r.file_type,
    content: r.content,
    score: 1 / (i + 1), // simple rank-based score
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split text into chunks of approximately `maxWords` words,
 * breaking at paragraph boundaries when possible.
 */
function chunkText(text: string, maxWords: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;

    if (currentWords + paraWords > maxWords && current.length > 0) {
      chunks.push(current.trim());
      current = "";
      currentWords = 0;
    }

    current += (current ? "\n\n" : "") + para;
    currentWords += paraWords;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text.trim()];
}

/**
 * Generate an embedding vector for text, using cache when available.
 */
async function generateEmbedding(apiKey: string, text: string): Promise<number[] | null> {
  const cached = getCachedQueryEmbedding(EMBEDDING_MODEL, text);
  if (cached) return cached;

  try {
    const vecs = await callEmbeddings(apiKey, EMBEDDING_MODEL, [text]);
    if (vecs?.length && vecs[0]?.length) {
      setCachedQueryEmbedding(EMBEDDING_MODEL, text, vecs[0]!);
      return vecs[0]!;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Delete vec rows for an agent (must get rowids first from identity_chunks).
 */
function _deleteVecRows(db: SqliteDatabase, agentId: string): void {
  if (!isSqliteVecAvailable()) return;
  try {
    const rows = db.prepare(
      "SELECT id FROM identity_chunks WHERE agent_id = ?",
    ).all(agentId) as Array<{ id: number }>;

    if (rows.length > 0) {
      const del = db.prepare("DELETE FROM identity_chunk_vectors WHERE rowid = ?");
      for (const row of rows) {
        try { del.run(row.id); } catch { /* ignore missing rows */ }
      }
    }
  } catch {
    // Vec table may not exist
  }
}
