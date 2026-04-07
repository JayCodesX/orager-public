/**
 * Call-graph builder — function-level intelligence for orager agents.
 *
 * Extracts exported functions from each source file, resolves cross-file
 * call sites using the import graph, and builds a directed function call
 * graph. Surfaces the result as human-readable call chains injected into
 * the agent's context alongside the file-level cluster map.
 *
 * Example output injected into prompt:
 *   Key call chains:
 *     runAgentLoop → executeOne → callOpenRouter
 *     runAgentLoop → retrieveEntries → searchMemoryFts
 *     runAgentWorkflow → runAgentLoop
 *
 * Implementation strategy:
 *   Primary  — TypeScript compiler API (accurate, full AST resolution).
 *   Fallback — regex-based extraction (fast, zero extra deps, ~80% coverage).
 *
 * Both paths produce the same output shape. All operations are non-fatal.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { localEmbedWithTimeout, cosineSimilarity } from "./local-embeddings.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A reference to a named function/const in a specific file (relative path). */
export interface FnRef {
  file: string; // relative to cwd
  name: string;
}

/** Serialisable call graph stored alongside the ProjectMap in SQLite. */
export interface CallGraph {
  /**
   * Exported symbol names keyed by relative file path.
   * e.g. { "src/loop.ts": ["runAgentLoop", "computeToolTimeout"] }
   */
  exports: Record<string, string[]>;
  /**
   * Call edges encoded as "file::fn" → ["file::fn", ...].
   * Only cross-file calls and same-file calls to named exports are tracked.
   */
  edges: Record<string, string[]>;
  /** Top call chains, each formatted as "A → B → C". */
  chains: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CALL_GRAPH_TIMEOUT = 6000; // ms
const MAX_CHAIN_DEPTH    = 4;
const MAX_CHAINS         = 8;
const MAX_CHAIN_FILES    = 300; // skip call graph on very large projects

// Regex patterns for the fallback parser
const EXPORT_FN_RE      = /export\s+(?:async\s+)?function\s+(\w+)/g;
const EXPORT_CONST_FN_RE =
  /export\s+const\s+(\w+)\s*(?::\s*(?:[^=<>]|<[^>]*>)*?)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=>{]*?)?\s*=>/g;
const NAMED_IMPORT_RE   = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
const DEFAULT_IMPORT_RE = /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
const CALL_SITE_RE      = /\b(\w+)\s*\(/g;

// Common built-ins / keywords to ignore as call sites
const IGNORE_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof",
  "new", "await", "async", "function", "class", "const", "let", "var",
  "import", "export", "require", "Promise", "Array", "Object", "String",
  "Number", "Boolean", "Math", "Date", "Error", "Map", "Set", "console",
  "process", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "parseInt", "parseFloat", "JSON", "Symbol", "BigInt", "Buffer",
  "describe", "it", "test", "expect", "beforeEach", "afterEach",
  "beforeAll", "afterAll", "vi", "jest",
]);

// ── Regex-based parser ────────────────────────────────────────────────────────

function extractExportsRegex(content: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;

  EXPORT_FN_RE.lastIndex = 0;
  while ((m = EXPORT_FN_RE.exec(content)) !== null) {
    if (m[1]) names.push(m[1]);
  }

  EXPORT_CONST_FN_RE.lastIndex = 0;
  while ((m = EXPORT_CONST_FN_RE.exec(content)) !== null) {
    if (m[1]) names.push(m[1]);
  }

  return [...new Set(names)];
}

/**
 * Returns a map of localName → { relFile, exportedName } for named imports,
 * resolving .js → .ts extension swaps for TypeScript ESM.
 */
function extractImportMap(
  content: string,
  fromFile: string,        // absolute
  knownRelFiles: Set<string>, // relative paths known to exist
  cwd: string,
): Map<string, { relFile: string; exportedName: string }> {
  const result = new Map<string, { relFile: string; exportedName: string }>();

  function resolveRel(importPath: string): string | null {
    if (!importPath.startsWith(".")) return null;
    const dir = path.dirname(fromFile);
    const base = path.resolve(dir, importPath);
    const baseRel = path.relative(cwd, base);
    // Try exact, then swap .js→.ts, then add extensions
    for (const candidate of [
      baseRel,
      baseRel.replace(/\.(js|mjs|cjs)$/, ".ts"),
      baseRel.replace(/\.(js|mjs|cjs)$/, ".tsx"),
      baseRel + ".ts",
      baseRel + ".tsx",
      baseRel + ".js",
    ]) {
      if (knownRelFiles.has(candidate)) return candidate;
    }
    return null;
  }

  let m: RegExpExecArray | null;

  NAMED_IMPORT_RE.lastIndex = 0;
  while ((m = NAMED_IMPORT_RE.exec(content)) !== null) {
    const names = m[1]!;
    const importPath = m[2]!;
    const relFile = resolveRel(importPath);
    if (!relFile) continue;
    for (const part of names.split(",")) {
      const [exportedName, alias] = part.trim().split(/\s+as\s+/);
      if (!exportedName) continue;
      const localName = (alias ?? exportedName).trim();
      const exportName = exportedName.trim();
      if (localName) result.set(localName, { relFile, exportedName: exportName });
    }
  }

  DEFAULT_IMPORT_RE.lastIndex = 0;
  while ((m = DEFAULT_IMPORT_RE.exec(content)) !== null) {
    const localName = m[1]!;
    const importPath = m[2]!;
    const relFile = resolveRel(importPath);
    if (!relFile) continue;
    result.set(localName, { relFile, exportedName: "default" });
  }

  return result;
}

/**
 * Extract call sites from a function body heuristic:
 * find `identifier(` patterns in a region of text following the function declaration.
 * Returns local names called (not yet resolved to files).
 */
function extractCallSitesRegex(content: string, fnName: string): string[] {
  // Find the function body: look for `function fnName` or `fnName = ...=>`
  // then extract a fixed window of text after it (up to the next top-level `export`)
  const fnStart = content.search(
    new RegExp(`(?:function\\s+${fnName}|\\b${fnName}\\s*(?::[^=]+)?\\s*=)`, "m"),
  );
  if (fnStart === -1) return [];

  // Extract up to 3000 chars from the function start to capture the body
  const body = content.slice(fnStart, fnStart + 3000);
  const calls: string[] = [];
  let m: RegExpExecArray | null;

  CALL_SITE_RE.lastIndex = 0;
  while ((m = CALL_SITE_RE.exec(body)) !== null) {
    const name = m[1]!;
    if (!IGNORE_CALLS.has(name) && name !== fnName && name.length > 2) {
      calls.push(name);
    }
  }

  return [...new Set(calls)];
}

// ── TypeScript compiler API parser (primary) ──────────────────────────────────

let _ts: typeof import("typescript") | null | false = null;

async function getTs(): Promise<typeof import("typescript") | null> {
  if (_ts === false) return null;
  if (_ts) return _ts;
  try {
    // Dynamic import — gracefully fails if typescript isn't installed
    const mod = await import("typescript");
    _ts = mod.default ?? (mod as unknown as typeof import("typescript"));
    return _ts;
  } catch {
    _ts = false;
    return null;
  }
}

async function extractExportsTs(
  content: string,
  filePath: string,
): Promise<string[]> {
  const tsApi = await getTs();
  if (!tsApi) return extractExportsRegex(content);
  const ts = tsApi; // narrowed non-nullable for closure capture

  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const names: string[] = [];

  function visit(node: import("typescript").Node): void {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.push(node.name.text);
    } else if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          // Only include if the initializer looks like a function
          if (
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer))
          ) {
            names.push(decl.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return [...new Set(names)];
}

async function extractCallSitesTs(
  content: string,
  filePath: string,
  fnName: string,
): Promise<string[]> {
  const tsApi = await getTs();
  if (!tsApi) return extractCallSitesRegex(content, fnName);
  const ts = tsApi; // narrowed non-nullable for closure capture

  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  let inTargetFn = false;
  let depth = 0;

  function visit(node: import("typescript").Node): void {
    const waIn = inTargetFn;

    // Enter the target function
    if (
      (ts.isFunctionDeclaration(node) && node.name?.text === fnName) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === fnName &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    ) {
      inTargetFn = true;
      depth++;
    }

    if (inTargetFn && ts.isCallExpression(node)) {
      const expr = node.expression;
      let name: string | null = null;
      if (ts.isIdentifier(expr)) {
        name = expr.text;
      } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
        name = expr.name.text;
      }
      if (name && !IGNORE_CALLS.has(name) && name !== fnName && name.length > 2) {
        calls.push(name);
      }
    }

    ts.forEachChild(node, visit);

    if (!waIn && inTargetFn) {
      depth--;
      if (depth === 0) inTargetFn = false;
    }
  }

  ts.forEachChild(sf, visit);
  return [...new Set(calls)];
}

// ── Graph builder ─────────────────────────────────────────────────────────────

export async function buildCallGraph(
  files: string[],  // absolute paths
  cwd: string,
): Promise<CallGraph | null> {
  if (files.length > MAX_CHAIN_FILES) return null;

  return Promise.race([
    _buildCallGraphImpl(files, cwd),
    new Promise<null>(resolve => setTimeout(() => resolve(null), CALL_GRAPH_TIMEOUT)),
  ]);
}

async function _buildCallGraphImpl(
  files: string[],
  cwd: string,
): Promise<CallGraph | null> {
  try {
    const relFiles = files.map(f => path.relative(cwd, f));
    const knownRelFiles = new Set(relFiles);

    // Step 1: extract exports from every file
    const exportsByFile = new Map<string, string[]>(); // relPath → names
    await Promise.all(files.map(async (absFile) => {
      const rel = path.relative(cwd, absFile);
      if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) return; // TS only for now
      let content: string;
      try { content = await fs.readFile(absFile, "utf8"); } catch { return; }
      const names = await extractExportsTs(content, absFile);
      if (names.length > 0) exportsByFile.set(rel, names);
    }));

    // Step 2: for each file, extract import map + call sites for each export
    const edges = new Map<string, Set<string>>(); // "file::fn" → Set<"file::fn">

    await Promise.all(files.map(async (absFile) => {
      const rel = path.relative(cwd, absFile);
      const myExports = exportsByFile.get(rel);
      if (!myExports || myExports.length === 0) return;

      let content: string;
      try { content = await fs.readFile(absFile, "utf8"); } catch { return; }

      // Build import map: localName → { relFile, exportedName }
      const importMap = extractImportMap(content, absFile, knownRelFiles, cwd);

      // For each exported function, find its call sites and resolve them
      for (const fnName of myExports) {
        const edgeKey = `${rel}::${fnName}`;
        const callSites = await extractCallSitesTs(content, absFile, fnName);

        for (const calledName of callSites) {
          const resolved = importMap.get(calledName);
          if (resolved) {
            // Cross-file call
            const targetExports = exportsByFile.get(resolved.relFile);
            const targetFn = targetExports?.find(e =>
              e === resolved.exportedName || resolved.exportedName === "default"
            ) ?? resolved.exportedName;
            const targetKey = `${resolved.relFile}::${targetFn}`;
            if (!edges.has(edgeKey)) edges.set(edgeKey, new Set());
            edges.get(edgeKey)!.add(targetKey);
          } else {
            // Same-file call — only if that name is an export of this file
            if (myExports.includes(calledName)) {
              const targetKey = `${rel}::${calledName}`;
              if (!edges.has(edgeKey)) edges.set(edgeKey, new Set());
              edges.get(edgeKey)!.add(targetKey);
            }
          }
        }
      }
    }));

    // Step 3: find entry-point functions (exported but never called from within project)
    const allTargets = new Set<string>();
    for (const targets of edges.values()) {
      for (const t of targets) allTargets.add(t);
    }
    const entryFns = [...edges.keys()].filter(k => !allTargets.has(k));

    // Step 4: trace chains from entry points (BFS, limited depth)
    const chains = traceTopChains(edges, entryFns, MAX_CHAIN_DEPTH, MAX_CHAINS);

    // Serialize
    const exportsOut: Record<string, string[]> = {};
    for (const [k, v] of exportsByFile) exportsOut[k] = v;

    const edgesOut: Record<string, string[]> = {};
    for (const [k, v] of edges) edgesOut[k] = [...v];

    return { exports: exportsOut, edges: edgesOut, chains };
  } catch {
    return null;
  }
}

// ── Chain tracer ──────────────────────────────────────────────────────────────

function traceTopChains(
  edges: Map<string, Set<string>>,
  entryFns: string[],
  maxDepth: number,
  maxChains: number,
): string[] {
  const chains: string[] = [];
  const seen = new Set<string>();

  // Prefer entry points with the most outgoing edges (most interesting)
  const ranked = entryFns
    .map(fn => ({ fn, out: edges.get(fn)?.size ?? 0 }))
    .sort((a, b) => b.out - a.out);

  for (const { fn } of ranked) {
    if (chains.length >= maxChains) break;
    traceChain(edges, fn, [fn], maxDepth, seen, chains, maxChains);
  }

  return chains;
}

function traceChain(
  edges: Map<string, Set<string>>,
  current: string,
  path: string[],
  remaining: number,
  seen: Set<string>,
  out: string[],
  maxChains: number,
): void {
  if (out.length >= maxChains) return;

  const targets = edges.get(current);
  if (!targets || targets.size === 0 || remaining === 0) {
    if (path.length >= 2) {
      const chain = path.map(k => k.split("::")[1] ?? k).join(" → ");
      if (!seen.has(chain)) {
        seen.add(chain);
        out.push(chain);
      }
    }
    return;
  }

  // Follow the most-connected target first
  const sorted = [...targets].sort(
    (a, b) => (edges.get(b)?.size ?? 0) - (edges.get(a)?.size ?? 0)
  );
  for (const target of sorted.slice(0, 2)) {
    if (path.includes(target)) continue; // avoid cycles
    traceChain(edges, target, [...path, target], remaining - 1, seen, out, maxChains);
  }
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

/**
 * Filter call chains to those most relevant to a prompt using keyword scoring.
 * Used as the sync fallback path.
 */
function _selectRelevantChainsKeyword(
  chains: string[],
  prompt: string,
  topK: number,
): string[] {
  const promptTokens = new Set(
    prompt.toLowerCase()
      .split(/[\s/._\-(),[\]{}'"]+/)
      .map(t => t.replace(/[^a-z0-9]/g, ""))
      .filter(t => t.length > 2),
  );

  const scored = chains.map(chain => {
    const tokens = chain.toLowerCase().split(/[\s→]+/);
    const score = tokens.filter(t => promptTokens.has(t)).length;
    return { chain, score };
  });

  const relevant = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.chain);

  return relevant.length > 0 ? relevant : chains.slice(0, topK);
}

/**
 * Filter call chains to those most relevant to a prompt.
 * Primary: cosine similarity via localEmbed (300 ms timeout).
 * Fallback: keyword token overlap when embeddings are unavailable.
 */
export async function selectRelevantChains(
  chains: string[],
  prompt: string,
  topK = 4,
): Promise<string[]> {
  if (!prompt || chains.length <= topK) return chains.slice(0, topK);

  const promptVec = await localEmbedWithTimeout(prompt, 300);
  if (promptVec) {
    const chainVecs = await Promise.all(
      chains.map(c => localEmbedWithTimeout(c, 300)),
    );
    const scored = chains.map((chain, i) => {
      const vec = chainVecs[i];
      return { chain, score: vec ? cosineSimilarity(promptVec, vec) : -1 };
    });
    const relevant = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.chain);
    if (relevant.length > 0) return relevant;
  }

  return _selectRelevantChainsKeyword(chains, prompt, topK);
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/**
 * Format call chains for injection into the agent's context.
 * Returns empty string when no chains are available.
 */
export async function formatCallChains(graph: CallGraph, prompt?: string): Promise<string> {
  if (graph.chains.length === 0) return "";
  const chains = prompt
    ? await selectRelevantChains(graph.chains, prompt)
    : graph.chains.slice(0, 4);
  if (chains.length === 0) return "";
  return "Key call chains:\n" + chains.map(c => `  ${c}`).join("\n");
}
