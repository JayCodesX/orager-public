/**
 * cost-quota.ts — Rolling cost quota enforcement.
 *
 * Tracks cumulative spend across multiple agent runs within a configurable
 * rolling window (default: 24 hours). Prevents runaway cost when many runs
 * execute in quick succession without per-run limits catching the aggregate.
 *
 * Storage: append-only JSON log at ~/.orager/cost-ledger.jsonl
 * Each line: { "ts": <epoch-ms>, "costUsd": <number>, "sessionId": "<id>", "model": "<id>" }
 *
 * The ledger is pruned on read — entries older than the window are dropped.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ORAGER_DIR = path.join(os.homedir(), ".orager");
const LEDGER_PATH = path.join(ORAGER_DIR, "cost-ledger.jsonl");

export interface CostEntry {
  ts: number;
  costUsd: number;
  sessionId: string;
  model: string;
}

export interface CostQuotaConfig {
  /** Maximum spend in USD within the rolling window. */
  maxUsd: number;
  /** Rolling window duration in milliseconds. Default: 24 hours. */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Ledger I/O ───────────────────────────────────────────────────────────────

async function readLedger(windowMs: number): Promise<CostEntry[]> {
  const cutoff = Date.now() - windowMs;
  let raw: string;
  try {
    raw = await fs.readFile(LEDGER_PATH, "utf8");
  } catch {
    return []; // file doesn't exist yet
  }
  const entries: CostEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CostEntry;
      if (entry.ts >= cutoff) entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * Prune old entries and rewrite the ledger. Called periodically to prevent
 * unbounded growth. Non-fatal — a failed prune just means the file grows
 * until the next successful prune.
 */
async function pruneLedger(entries: CostEntry[]): Promise<void> {
  try {
    await fs.mkdir(ORAGER_DIR, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmp = LEDGER_PATH + ".tmp." + process.pid;
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, LEDGER_PATH);
  } catch {
    // non-fatal — ledger will grow until next successful prune
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a cost entry in the ledger. Called at the end of each agent run.
 */
export async function recordCost(entry: CostEntry): Promise<void> {
  try {
    await fs.mkdir(ORAGER_DIR, { recursive: true });
    await fs.appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `[orager] WARNING: failed to record cost entry: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Get the total spend within the rolling window.
 */
export async function getRollingCost(windowMs = DEFAULT_WINDOW_MS): Promise<number> {
  const entries = await readLedger(windowMs);
  return entries.reduce((sum, e) => sum + e.costUsd, 0);
}

/**
 * Check whether starting a new run would exceed the rolling cost quota.
 * Returns null if the quota is not exceeded, or an error message if it is.
 *
 * When the ledger has grown beyond 1000 entries, triggers a background prune.
 */
export async function checkCostQuota(config: CostQuotaConfig): Promise<string | null> {
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const entries = await readLedger(windowMs);
  const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0);

  // Prune if ledger is large (non-blocking)
  if (entries.length > 1000) {
    pruneLedger(entries).catch(() => {});
  }

  if (totalCost >= config.maxUsd) {
    const windowHours = (windowMs / (60 * 60 * 1000)).toFixed(1);
    return (
      `Rolling cost quota exceeded: $${totalCost.toFixed(4)} spent in the last ${windowHours}h ` +
      `(limit: $${config.maxUsd.toFixed(2)}). ` +
      `Wait for older entries to expire or increase the quota.`
    );
  }
  return null;
}

/**
 * Get a summary of recent spending for display.
 */
export async function getCostSummary(windowMs = DEFAULT_WINDOW_MS): Promise<{
  totalUsd: number;
  entryCount: number;
  windowMs: number;
  oldestEntryAge: number | null;
}> {
  const entries = await readLedger(windowMs);
  const now = Date.now();
  return {
    totalUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
    entryCount: entries.length,
    windowMs,
    oldestEntryAge: entries.length > 0 ? now - Math.min(...entries.map((e) => e.ts)) : null,
  };
}
