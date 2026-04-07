/**
 * Project Index — native code intelligence for orager agents.
 *
 * v2 improvements over the initial implementation:
 *   Phase 1 — Relevance filtering: keyword-scored cluster selection so agents
 *              only receive clusters relevant to the current prompt.
 *   Phase 2 — Persistent project doc: writes .orager/project-structure.md on
 *              fresh indexes; project-instructions.ts picks it up automatically.
 *   Phase 3 — Connectivity-based clustering: Union-Find replaces directory
 *              grouping so tightly-coupled files cluster together regardless of
 *              which folder they live in.
 *   Phase 4 — Active hooks: checkFileIntent() lets loop-executor warn agents
 *              before they edit hot files or create files in the wrong cluster.
 *
 * Inspired by GitNexus's knowledge-graph approach, implemented from scratch
 * in plain TypeScript with no external dependencies.
 *
 * Storage: ~/.orager/project-index/<project-id>.sqlite
 * Cache key: git HEAD commit hash — re-indexes only when the tree changes.
 * File limit: skips projects with >2000 source files to avoid runaway scans.
 */

import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "./native-sqlite.js";
import type { SqliteDatabase } from "./native-sqlite.js";
import { sanitizeKeyForFilename, resolveProjectIndexDir } from "./db.js";
import { buildCallGraph, selectRelevantChains } from "./call-graph.js";
import { localEmbedWithTimeout, cosineSimilarity } from "./local-embeddings.js";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "./embedding-cache.js";
import { BM25Index, tokenize as bm25Tokenize } from "./bm25.js";

const execAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILES            = 2000;
const INDEX_TIMEOUT        = 8000;   // ms — hard abort on runaway projects
const TOP_HOT_FILES        = 8;
const TOP_ENTRY_POINTS     = 5;
const MAX_CLUSTER_FILES_SHOWN = 6;
const HOT_FILE_IN_DEGREE_MIN  = 5;   // warn when editing a file with ≥ this many importers

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".claude", ".orager", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", ".output", "vendor",
]);

// ── Public types ──────────────────────────────────────────────────────────────

export interface FileCluster {
  /** Display name: dominant directory of the connected component. */
  name: string;
  /** Relative file paths (from project root) within this cluster. */
  files: string[];
  /** Imports flowing into this cluster from other clusters. */
  crossClusterImports: number;
}

export interface ProjectMap {
  clusters: FileCluster[];
  /** Relative paths of the most-imported files, descending by in-degree. */
  hotFiles: string[];
  /** Relative paths of files with out-degree > 0 and in-degree == 0. */
  entryPoints: string[];
  /** Raw in-degree counts keyed by relative path (for hot-file checks). */
  inDegreeMap: Record<string, number>;
  /** Pre-traced call chains, e.g. ["runAgentLoop → executeOne → callOpenRouter"]. */
  callChains?: string[];
  totalFiles: number;
  indexedAt: string;
  /** True when returned from the SQLite cache (no re-index occurred). */
  fromCache?: boolean;
}

// ── Path resolver ─────────────────────────────────────────────────────────────

function resolveIndexDbPath(cwd: string): string {
  const dir = resolveProjectIndexDir();
  const key = sanitizeKeyForFilename(cwd);
  return path.join(dir, `${key}.sqlite`);
}

// ── SQLite schema ─────────────────────────────────────────────────────────────

function ensureSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_cache (
      commit_hash TEXT PRIMARY KEY,
      map_json    TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);
}

function loadCached(db: SqliteDatabase, commitHash: string): ProjectMap | null {
  try {
    const row = db.prepare(
      "SELECT map_json FROM index_cache WHERE commit_hash = ?"
    ).get(commitHash) as { map_json: string } | undefined;
    if (!row) return null;
    const map = JSON.parse(row.map_json) as ProjectMap;
    map.fromCache = true;
    return map;
  } catch {
    return null;
  }
}

function saveCache(db: SqliteDatabase, commitHash: string, map: ProjectMap): void {
  try {
    const toStore = { ...map, fromCache: false }; // never persist the transient flag
    db.prepare(
      "INSERT OR REPLACE INTO index_cache (commit_hash, map_json, created_at) VALUES (?, ?, ?)"
    ).run(commitHash, JSON.stringify(toStore), new Date().toISOString());
    db.exec(
      "DELETE FROM index_cache WHERE commit_hash NOT IN " +
      "(SELECT commit_hash FROM index_cache ORDER BY created_at DESC LIMIT 3)"
    );
  } catch { /* non-fatal */ }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

async function getCommitHash(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── File scanner ──────────────────────────────────────────────────────────────

async function collectSourceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = await fs.readdir(dir, { encoding: "utf8" });
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (stat.isFile() && SOURCE_EXTENSIONS.has(path.extname(name))) {
        files.push(full);
      }
    }
  }

  await walk(cwd);
  return files;
}

// ── Import parser ─────────────────────────────────────────────────────────────

const TS_IMPORT_RE =
  /(?:(?:^|\n)\s*(?:import|export)\s+[^'"(]*from\s+|(?:^|\n)\s*(?:import|export)\s+)\s*['"]([^'"]+)['"]|(?:\bimport\s*\(\s*['"]([^'"]+)['"]\s*\))|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const PY_IMPORT_RE =
  /(?:^|\n)\s*(?:from\s+(\.[\w.]*)\s+import|import\s+([\w.]+))/gm;

function parseImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  if (ext === ".py") {
    let m: RegExpExecArray | null;
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(content)) !== null) {
      const p = m[1] ?? m[2] ?? "";
      if (p) imports.push(p);
    }
  } else {
    let m: RegExpExecArray | null;
    TS_IMPORT_RE.lastIndex = 0;
    while ((m = TS_IMPORT_RE.exec(content)) !== null) {
      const p = m[1] ?? m[2] ?? m[3] ?? "";
      if (p) imports.push(p);
    }
  }
  return imports;
}

function resolveImport(
  fromFile: string,
  importPath: string,
  knownFiles: Set<string>,
  ext: string,
): string | null {
  if (ext === ".py") {
    if (!importPath.startsWith(".")) return null;
    const parts = importPath.split(".");
    let dir = path.dirname(fromFile);
    let dots = 0;
    while (dots < parts.length && parts[dots] === "") dots++;
    for (let i = 1; i < dots; i++) dir = path.dirname(dir);
    const modParts = parts.slice(dots).filter(Boolean);
    if (modParts.length === 0) return null;
    const candidate = path.join(dir, ...modParts) + ".py";
    return knownFiles.has(candidate) ? candidate : null;
  }

  if (!importPath.startsWith(".")) return null;

  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, importPath);

  if (knownFiles.has(resolved)) return resolved;

  // TypeScript ESM: imports use .js but source files are .ts — try swapping
  const resolvedBase = resolved.replace(/\.(js|mjs|cjs)$/, "");
  const resolvedNoExt = resolvedBase !== resolved ? resolvedBase : resolved;

  for (const e of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    if (knownFiles.has(resolvedNoExt + e)) return resolvedNoExt + e;
  }
  // Try appending extensions to the original resolved path (no extension in import)
  if (resolvedNoExt === resolved) {
    for (const e of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      if (knownFiles.has(resolved + e)) return resolved + e;
    }
  }
  for (const e of [".ts", ".tsx", ".js", ".jsx"]) {
    const idx = path.join(resolvedNoExt, `index${e}`);
    if (knownFiles.has(idx)) return idx;
  }

  return null;
}

// ── Graph builder ─────────────────────────────────────────────────────────────

interface Graph {
  out: Map<string, Set<string>>;
  inDegree: Map<string, number>;
}

async function buildGraph(files: string[], knownFiles: Set<string>): Promise<Graph> {
  const out = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>(files.map(f => [f, 0]));

  await Promise.all(files.map(async (file) => {
    const ext = path.extname(file);
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    const targets = new Set<string>();
    for (const imp of parseImports(content, ext)) {
      const resolved = resolveImport(file, imp, knownFiles, ext);
      if (resolved && resolved !== file) targets.add(resolved);
    }
    out.set(file, targets);
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
    }
  }));

  return { out, inDegree };
}

// ── Phase 3: Improved clustering (directory-primary + intra-dir connectivity) ─

class UnionFind {
  private parent: Map<string, string>;

  constructor(nodes: string[]) {
    this.parent = new Map(nodes.map(n => [n, n]));
  }

  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }
}

/**
 * Improved directory-based clustering.
 *
 * Primary grouping: files are grouped by their immediate parent directory —
 * the same proven approach from v1 that produces clean, named clusters.
 *
 * Phase 3 improvement: for directories with more than LARGE_DIR_THRESHOLD
 * files (e.g. a flat src/ with 60+ files), Union-Find is run *within* that
 * directory only to split it into tighter sub-clusters based on internal
 * import connectivity. Files that don't connect to any neighbour within the
 * directory stay as their own sub-cluster.
 *
 * Cross-directory imports (test→src, src→types) are intentionally ignored
 * for grouping decisions — they would collapse the entire codebase into one
 * giant component.
 */
const LARGE_DIR_THRESHOLD = 15;

function buildConnectivityClusters(
  files: string[],
  cwd: string,
  graph: Graph,
): FileCluster[] {
  // Step 1: group by immediate parent directory (relative to cwd)
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const rel  = path.relative(cwd, file);
    const dir  = path.dirname(rel);
    const key  = dir === "." ? "." : dir;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(file);
  }

  const resultClusters: FileCluster[] = [];

  for (const [dir, dirFiles] of byDir) {
    if (dirFiles.length <= LARGE_DIR_THRESHOLD) {
      // Small directory — keep as a single cluster
      resultClusters.push(_makeCluster(dir, dirFiles, cwd, graph, byDir));
    } else {
      // Large directory — run Union-Find on internal edges only to sub-cluster
      const dirSet = new Set(dirFiles);
      const uf = new UnionFind(dirFiles);

      for (const file of dirFiles) {
        for (const target of graph.out.get(file) ?? new Set()) {
          if (dirSet.has(target)) uf.union(file, target); // same-dir edge only
        }
      }

      // Group by component root
      const subComponents = new Map<string, string[]>();
      for (const file of dirFiles) {
        const root = uf.find(file);
        if (!subComponents.has(root)) subComponents.set(root, []);
        subComponents.get(root)!.push(file);
      }

      // Each sub-component becomes a cluster; label using the directory name
      // (sub-components within the same dir share the same name — that's fine,
      // the agent sees the file list which differentiates them)
      for (const [, subFiles] of subComponents) {
        resultClusters.push(_makeCluster(dir, subFiles, cwd, graph, byDir));
      }
    }
  }

  return resultClusters.sort((a, b) => b.files.length - a.files.length);
}

function _makeCluster(
  dir: string,
  absFiles: string[],
  cwd: string,
  graph: Graph,
  byDir: Map<string, string[]>,
): FileCluster {
  const clusterSet = new Set(absFiles);
  let crossClusterImports = 0;
  for (const f of absFiles) {
    for (const t of graph.out.get(f) ?? new Set()) {
      if (!clusterSet.has(t)) crossClusterImports++;
    }
  }
  return {
    name: dir === "." ? path.basename(cwd) : dir,
    files: absFiles.map(f => path.relative(cwd, f)).sort(),
    crossClusterImports,
  };
}

// ── Phase 1: Relevance filtering ──────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s/._\-(),[\]{}'"]+/)
      .map(t => t.replace(/[^a-z0-9]/g, ""))
      .filter(t => t.length > 2),
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build or return a cached ProjectMap for the given working directory.
 * Returns null on error, timeout, or when the project exceeds MAX_FILES.
 */
export async function getProjectMap(cwd: string): Promise<ProjectMap | null> {
  return Promise.race([
    _getProjectMapImpl(cwd),
    new Promise<null>(resolve => setTimeout(() => resolve(null), INDEX_TIMEOUT)),
  ]);
}

async function _getProjectMapImpl(cwd: string): Promise<ProjectMap | null> {
  try {
    const dbPath = resolveIndexDbPath(cwd);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = await openDb(dbPath);
    ensureSchema(db);

    const commitHash = await getCommitHash(cwd);
    if (commitHash) {
      const cached = loadCached(db, commitHash);
      if (cached) return cached;
    }

    const files = await collectSourceFiles(cwd);
    if (files.length === 0 || files.length > MAX_FILES) return null;

    const knownFiles = new Set(files);
    const graph = await buildGraph(files, knownFiles);

    const hotFiles = [...graph.inDegree.entries()]
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_HOT_FILES)
      .map(([f]) => path.relative(cwd, f));

    const entryPoints = files
      .filter(f => (graph.inDegree.get(f) ?? 0) === 0 && (graph.out.get(f)?.size ?? 0) > 0)
      .sort((a, b) => (graph.out.get(b)?.size ?? 0) - (graph.out.get(a)?.size ?? 0))
      .slice(0, TOP_ENTRY_POINTS)
      .map(f => path.relative(cwd, f));

    // Build in-degree map keyed by relative path (for Phase 4)
    const inDegreeMap: Record<string, number> = {};
    for (const [absPath, deg] of graph.inDegree) {
      if (deg > 0) inDegreeMap[path.relative(cwd, absPath)] = deg;
    }

    // Phase 3: connectivity-based clustering
    const clusters = buildConnectivityClusters(files, cwd, graph);

    // Build call graph (non-fatal, runs in parallel with no shared state)
    const callGraph = await buildCallGraph(files, cwd).catch(() => null);

    const map: ProjectMap = {
      clusters,
      hotFiles,
      entryPoints,
      inDegreeMap,
      callChains: callGraph?.chains ?? [],
      totalFiles: files.length,
      indexedAt: new Date().toISOString(),
      fromCache: false,
    };

    if (commitHash) saveCache(db, commitHash, map);
    return map;
  } catch {
    return null;
  }
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/**
 * Rank clusters by relevance to a prompt using cosine similarity.
 * Falls back to size-based ordering (clusters already sorted by file count)
 * when embeddings are unavailable within the timeout.
 */
export async function selectRelevantClusters(
  clusters: FileCluster[],
  prompt: string,
  topK = 8,
): Promise<FileCluster[]> {
  if (!prompt || clusters.length <= topK) return clusters.slice(0, topK);

  // Stage 1: BM25 keyword scoring to narrow candidates (cheap, fast)
  const queryTokens = bm25Tokenize(prompt);
  let candidates = clusters;

  if (queryTokens.length > 0 && clusters.length > topK * 3) {
    const idx = new BM25Index();
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const label = `${c.name} ${c.files.map(f => path.basename(f)).join(" ")}`;
      idx.addDocument(String(i), label);
    }
    const scores = idx.scoreAll(queryTokens);
    if (scores.size > 0) {
      const ranked = clusters
        .map((cluster, i) => ({ cluster, idx: i, score: scores.get(String(i)) ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 3);
      candidates = ranked.map(r => r.cluster);
    }
  }

  // Stage 2: Vector re-rank with 40/60 BM25/vector blending
  let promptVec = getCachedQueryEmbedding("local", prompt);
  if (!promptVec) {
    promptVec = await localEmbedWithTimeout(prompt, 300);
    if (promptVec) setCachedQueryEmbedding("local", prompt, promptVec);
  }

  if (promptVec) {
    const labels = candidates.map(c =>
      `${c.name} ${c.files.map(f => path.basename(f)).join(" ")}`,
    );
    const labelVecs = await Promise.all(
      labels.map(l => localEmbedWithTimeout(l, 300)),
    );

    // Build BM25 scores for blending (re-score candidates)
    const bm25Idx = new BM25Index();
    for (let i = 0; i < candidates.length; i++) {
      bm25Idx.addDocument(String(i), labels[i]!);
    }
    const bm25Scores = queryTokens.length > 0 ? bm25Idx.scoreAll(queryTokens) : new Map<string, number>();
    const maxBm25 = Math.max(...[...bm25Scores.values()], 1);

    const scored = candidates.map((cluster, i) => {
      const vec = labelVecs[i];
      const sim = vec ? cosineSimilarity(promptVec!, vec) : 0;
      const bm25Norm = (bm25Scores.get(String(i)) ?? 0) / maxBm25;
      return { cluster, score: 0.4 * bm25Norm + 0.6 * sim };
    });
    const relevant = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.cluster);
    if (relevant.length > 0) return relevant;
  }

  // Fallback: return BM25-ordered candidates (or size order if no BM25 matches)
  return candidates.slice(0, topK);
}

/**
 * Format a ProjectMap into a compact, human-readable string suitable for
 * injection into an agent's system prompt.
 *
 * Aims to stay under ~800 characters for the typical project.
 * When a prompt is provided, clusters and call chains are ranked by
 * semantic relevance (cosine similarity via local embeddings, keyword fallback).
 */
export async function formatProjectMap(map: ProjectMap, cwd: string, prompt?: string): Promise<string> {
  const lines: string[] = [`Project structure (${map.totalFiles} files, ${map.clusters.length} clusters):`];

  // Show top clusters — ranked by relevance when a prompt is provided
  const topClusters = prompt
    ? await selectRelevantClusters(map.clusters, prompt, 8)
    : map.clusters.slice(0, 8);

  for (const cluster of topClusters) {
    const shown = cluster.files.slice(0, MAX_CLUSTER_FILES_SHOWN).map(f => path.basename(f));
    const more  = cluster.files.length > MAX_CLUSTER_FILES_SHOWN
      ? ` +${cluster.files.length - MAX_CLUSTER_FILES_SHOWN} more`
      : "";
    lines.push(`  ${cluster.name}: ${shown.join(", ")}${more}`);
  }

  if (map.hotFiles.length > 0) {
    lines.push(`Hot files (most imported): ${map.hotFiles.map(f => path.basename(f)).join(", ")}`);
  }
  if (map.entryPoints.length > 0) {
    lines.push(`Entry points: ${map.entryPoints.map(f => path.basename(f)).join(", ")}`);
  }

  if (map.callChains && map.callChains.length > 0) {
    const chains = prompt
      ? await selectRelevantChains(map.callChains, prompt)
      : map.callChains.slice(0, 4);
    if (chains.length > 0) {
      lines.push("Key call chains:\n" + chains.map(c => `  ${c}`).join("\n"));
    }
  }

  return lines.join("\n");
}

// ── Phase 2: Persistent project structure doc ─────────────────────────────────

/**
 * Write .orager/project-structure.md into the project root.
 * Picked up automatically by project-instructions.ts on every future run.
 * Only called on fresh indexes (fromCache === false).
 */
export async function writeProjectStructureDoc(
  map: ProjectMap,
  cwd: string,
): Promise<void> {
  try {
    const dir = path.join(cwd, ".orager");
    await fs.mkdir(dir, { recursive: true });
    const body = await formatProjectMap(map, cwd);
    const content =
      `# Project Structure\n\n` +
      `_Auto-generated by orager. Do not edit manually._\n\n` +
      `${body}\n\nIndexed: ${map.indexedAt}\n`;
    // CodeQL: [js/insecure-temporary-file] — false positive: writes to .orager/ project dir, not a temp file
    await fs.writeFile(path.join(dir, "project-structure.md"), content, "utf8");
  } catch { /* non-fatal */ }
}

// ── Phase 4: Active hook helpers ──────────────────────────────────────────────

/**
 * Returns an advisory string when writing to a hot file or a path in an
 * unrecognised cluster. Returns null when no advice is needed.
 */
export async function checkFileIntent(
  filePath: string,
  cwd: string,
  map: ProjectMap,
): Promise<string | null> {
  const rel = path.relative(cwd, filePath);
  if (rel.startsWith("..")) return null;

  const notes: string[] = [];

  const inDeg = (map.inDegreeMap ?? {})[rel] ?? 0;
  if (inDeg >= HOT_FILE_IN_DEGREE_MIN) {
    notes.push(
      `[orager] Hot file: ${rel} has ${inDeg} importers — changes here have wide blast radius.`,
    );
  }

  let fileExists = false;
  try { await fs.stat(filePath); fileExists = true; } catch { /* new file */ }

  if (!fileExists) {
    const fileDir = path.relative(cwd, path.dirname(filePath));
    const matchingCluster = map.clusters.find(c => {
      const cn = c.name === path.basename(cwd) ? "." : c.name;
      return cn === fileDir || fileDir.startsWith(cn + path.sep);
    });
    if (!matchingCluster && map.clusters.length > 0) {
      const suggestions = map.clusters.slice(0, 3).map(c => c.name).join(", ");
      notes.push(
        `[orager] New file in unrecognised cluster "${fileDir}". ` +
        `Existing clusters: ${suggestions}. Confirm placement is intentional.`,
      );
    }
  }

  return notes.length > 0 ? notes.join("\n") : null;
}
