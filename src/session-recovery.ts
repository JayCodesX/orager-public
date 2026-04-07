/**
 * session-recovery.ts — Crash recovery manifest for in-flight sessions.
 *
 * Writes a lightweight manifest to ~/.orager/recovery.json whenever a session
 * is actively running. On clean exit the manifest is cleared. If the process
 * crashes (segfault, OOM, hard kill), the manifest survives on disk and can be
 * read on the next startup to inform the user about recoverable sessions.
 *
 * The manifest is atomically written (tmp + rename) to prevent partial reads.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ORAGER_DIR = path.join(os.homedir(), ".orager");
const RECOVERY_PATH = path.join(ORAGER_DIR, "recovery.json");

export interface RecoveryEntry {
  sessionId: string;
  model: string;
  cwd: string;
  turn: number;
  startedAt: string;
  updatedAt: string;
  pid: number;
  prompt?: string;
}

export interface RecoveryManifest {
  version: 1;
  runs: RecoveryEntry[];
}

/**
 * Register an in-flight session in the recovery manifest.
 * Called at loop start and periodically during long runs.
 * Merges with any existing entries (from other concurrent runs).
 */
export async function writeRecoveryEntry(entry: RecoveryEntry): Promise<void> {
  try {
    const manifest = await readManifest();
    // Replace existing entry for same sessionId, or append new
    const idx = manifest.runs.findIndex((r) => r.sessionId === entry.sessionId);
    if (idx >= 0) {
      manifest.runs[idx] = entry;
    } else {
      manifest.runs.push(entry);
    }
    await atomicWrite(manifest);
  } catch {
    // Non-fatal — recovery is best-effort
  }
}

/**
 * Remove a session from the recovery manifest.
 * Called on clean exit (normal completion, user cancel, etc.).
 */
export async function clearRecoveryEntry(sessionId: string): Promise<void> {
  try {
    const manifest = await readManifest();
    manifest.runs = manifest.runs.filter((r) => r.sessionId !== sessionId);
    if (manifest.runs.length === 0) {
      // No more entries — delete the file entirely
      await fs.unlink(RECOVERY_PATH).catch(() => {});
    } else {
      await atomicWrite(manifest);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Read the recovery manifest. Returns empty manifest if file doesn't exist.
 */
export async function readManifest(): Promise<RecoveryManifest> {
  try {
    const raw = await fs.readFile(RECOVERY_PATH, "utf8");
    const parsed = JSON.parse(raw) as RecoveryManifest;
    if (parsed.version === 1 && Array.isArray(parsed.runs)) {
      return parsed;
    }
  } catch {
    // File doesn't exist or is corrupt
  }
  return { version: 1, runs: [] };
}

/**
 * Get recoverable sessions — entries whose PID is no longer running.
 * Active entries (PID still alive) are filtered out since those sessions
 * are still in progress.
 */
export async function getRecoverableSessions(): Promise<RecoveryEntry[]> {
  const manifest = await readManifest();
  const recoverable: RecoveryEntry[] = [];
  const stillAlive: RecoveryEntry[] = [];

  for (const entry of manifest.runs) {
    if (isPidAlive(entry.pid)) {
      stillAlive.push(entry);
    } else {
      recoverable.push(entry);
    }
  }

  // Clean up stale entries from the manifest (keep only alive ones)
  if (recoverable.length > 0 && stillAlive.length !== manifest.runs.length) {
    // Don't remove recoverable entries yet — let the user decide to resume or dismiss
  }

  return recoverable;
}

/**
 * Dismiss all recovery entries (user chose not to resume).
 * Removes entries for dead PIDs; keeps entries for live PIDs.
 */
export async function dismissRecovery(): Promise<void> {
  try {
    const manifest = await readManifest();
    manifest.runs = manifest.runs.filter((r) => isPidAlive(r.pid));
    if (manifest.runs.length === 0) {
      await fs.unlink(RECOVERY_PATH).catch(() => {});
    } else {
      await atomicWrite(manifest);
    }
  } catch {
    // Non-fatal
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(manifest: RecoveryManifest): Promise<void> {
  await fs.mkdir(ORAGER_DIR, { recursive: true });
  const tmp = RECOVERY_PATH + ".tmp." + process.pid;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, RECOVERY_PATH);
}

/** Exported for tests. */
export const _RECOVERY_PATH = RECOVERY_PATH;
