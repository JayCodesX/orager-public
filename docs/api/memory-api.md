# Memory API

orager uses a three-layer SQLite-backed memory system: master context (permanent), retrieved entries (FTS + vector search), and session checkpoints (episodic). Memory is scoped by namespace via `memoryKey`.

```ts
import type { MemoryStore, MemoryEntry, MemoryEntryType } from "@orager/core";
```

---

## MemoryStore

The top-level container for a memory namespace.

```ts
interface MemoryStore {
  memoryKey: string;
  entries: MemoryEntry[];
  updatedAt: string;  // ISO 8601
}
```

### Core Operations

#### loadMemoryStore(memoryKey: string): Promise\<MemoryStore>

Load the memory store for a namespace. Creates an empty store if none exists.

#### saveMemoryStore(store: MemoryStore): Promise\<void>

Persist a memory store to disk.

#### addMemoryEntry(store: MemoryStore, entry: MemoryEntry): MemoryStore

Add an entry to a store. Returns the updated store (immutable pattern).

#### retrieveEntries(store: MemoryStore, query: string, maxResults: number): MemoryEntry[]

Retrieve the most relevant entries for a query using BM25 scoring.

---

## MemoryEntry

A single memory record.

```ts
interface MemoryEntry {
  id: string;                  // crypto.randomUUID()
  content: string;             // freeform text, agent-authored
  tags?: string[];             // e.g. ["bug", "auth", "user-pref"]
  createdAt: string;           // ISO 8601
  expiresAt?: string;          // ISO 8601 (undefined = never expires)
  runId?: string;              // session ID that created this entry
  importance: 1 | 2 | 3;      // 1=low, 2=normal, 3=high
  type?: MemoryEntryType;      // categorizes the entry
  _embedding?: number[];       // cached embedding vector (internal)
  _embeddingModel?: string;    // model used for embedding (internal)
}
```

### MemoryEntryType

```ts
type MemoryEntryType =
  | "insight"
  | "fact"
  | "competitor"
  | "decision"
  | "risk"
  | "open_question"
  | "master_context"
  | "session_summary";
```

---

## Retrieval

orager supports multiple retrieval strategies, chosen automatically based on configuration and available data.

### FTS5 Full-Text Search

```ts
searchMemoryFtsMulti(
  memoryKeys: string[],
  query: string,
  limit?: number,
): Promise<MemoryEntry[]>
```

Uses SQLite FTS5 for full-text search across one or more namespaces. Best for keyword-based queries.

### ANN Vector Search

```ts
retrieveEntriesANNSqlite(
  memoryKey: string,
  queryEmbedding: number[],
  limit?: number,
  threshold?: number,
): Promise<MemoryEntry[]>
```

Uses `sqlite-vec` for approximate nearest neighbor search. Best for semantic similarity queries.

### Local Embeddings

Embeddings are generated locally using Transformers.js with the `all-MiniLM-L6-v2` model (384 dimensions). No external API calls are required for embedding generation.

```ts
import { localEmbed } from "@orager/core";

const vector: number[] = await localEmbed("search query text");
// Returns a 384-dimensional float32 vector
```

### BM25 Scoring

The `BM25Index` class provides tokenization and hybrid scoring:

```ts
import { BM25Index } from "@orager/core";

// Tokenization
BM25Index.tokenize(text: string): string[]       // lowercase + stop-word removal
BM25Index.tokenizeRaw(text: string): string[]     // lowercase only, no stop-word removal

// Hybrid scoring (combines BM25 + cosine similarity)
BM25Index.hybridScore(
  bm25Score: number,
  cosineScore: number,
  alpha?: number,          // weight for BM25 (default: 0.5)
): number
```

### Embedding Cache

Query embeddings are cached to avoid redundant computation:

```ts
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "@orager/core";

const cached = getCachedQueryEmbedding(query);
if (!cached) {
  const embedding = await localEmbed(query);
  setCachedQueryEmbedding(query, embedding);
}
```

---

## Storage

### File Layout

Memory is stored per-namespace as SQLite databases:

```
~/.orager/memory/
  <sanitized-key>.sqlite      # SQLite database with FTS5 + sqlite-vec
  <sanitized-key>.json         # Legacy JSON format (auto-migrated)
```

The storage directory can be overridden with the `ORAGER_MEMORY_DIR` environment variable.

### SQLite Schema

Each namespace database contains:

- **`entries` table** -- primary storage for `MemoryEntry` records
- **`entries_fts` virtual table** -- FTS5 index for full-text search
- **`entries_vec` virtual table** -- `sqlite-vec` index for vector similarity search (384 dimensions)

### Multi-Namespace Support

The `memoryKey` option supports multiple namespaces:

- **String form**: single namespace for both reads and writes
- **Array form** (in `AgentConfig`): index 0 is the write target, all elements are read sources

This allows agents to read from shared knowledge bases while writing to their own namespace:

```ts
{
  role: "analyst",
  model: "deepseek/deepseek-chat",
  memoryKey: ["analyst-notes", "shared-facts", "project-context"],
  // Writes go to "analyst-notes"
  // Reads search across all three namespaces
}
```
