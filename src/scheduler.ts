/**
 * scheduler.ts — In-process cron scheduler using Croner.
 *
 * Same pattern as Claude Code Desktop's scheduler:
 *  - Croner registers in-process cron jobs
 *  - On fire: spawns `orager run --agent <id> --channel <id> "<prompt>"`
 *  - Missed-run catch-up on startup (most recent missed fire, up to 7 days)
 *  - No OS-level cron, no platform-specific code
 *
 * Lifecycle:
 *  - Desktop: sidecar starts → loadAndStartAll() → runs until sidecar dies
 *  - CLI: `orager schedule daemon` → loadAndStartAll() → long-running process
 *  - On shutdown: stopAll() cleanly stops Croner jobs
 */

import { Cron } from "croner";
import {
  getEnabledSchedules, setLastFiredAt, createRun, completeRun,
  type Schedule,
} from "./scheduler-db.js";
import { postMessage } from "./channel.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ScheduleExecutor = (schedule: Schedule, isCatchup: boolean) => Promise<{
  status: "success" | "error" | "timeout";
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  sessionId?: string;
  result?: string;
}>;

// ── State ────────────────────────────────────────────────────────────────────

const _jobs = new Map<string, Cron>();
let _executor: ScheduleExecutor | null = null;
let _running = false;

/**
 * Register the executor function that runs scheduled tasks.
 * The executor is responsible for spawning the agent/user run
 * and returning the result.
 */
export function setExecutor(executor: ScheduleExecutor): void {
  _executor = executor;
}

/**
 * Check if the scheduler is currently running.
 */
export function isRunning(): boolean {
  return _running;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Load all enabled schedules from DB and register Croner jobs.
 * Also runs missed-run catch-up for any schedules that missed fires.
 */
export async function loadAndStartAll(): Promise<{ loaded: number; catchups: number }> {
  if (_running) {
    stopAll();
  }

  const schedules = await getEnabledSchedules();
  let catchups = 0;

  for (const schedule of schedules) {
    registerJob(schedule);

    // Missed-run catch-up: check if we missed the most recent fire
    const missed = getMostRecentMissedFire(schedule);
    if (missed) {
      catchups++;
      // Fire catch-up asynchronously (don't block startup)
      executeSchedule(schedule, true).catch((err) => {
        process.stderr.write(`[scheduler] catch-up failed for ${schedule.id}: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  }

  _running = true;
  return { loaded: schedules.length, catchups };
}

/**
 * Stop all Croner jobs cleanly.
 */
export function stopAll(): void {
  for (const [id, job] of _jobs) {
    job.stop();
  }
  _jobs.clear();
  _running = false;
}

/**
 * Register a single schedule as a Croner job.
 */
export function registerJob(schedule: Schedule): void {
  // Stop existing job if re-registering
  const existing = _jobs.get(schedule.id);
  if (existing) existing.stop();

  try {
    const job = new Cron(schedule.cron, {
      name: schedule.id,
      timezone: undefined, // Use local timezone
    }, () => {
      executeSchedule(schedule, false).catch((err) => {
        process.stderr.write(`[scheduler] execution failed for ${schedule.id}: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    });

    _jobs.set(schedule.id, job);
  } catch (err) {
    process.stderr.write(`[scheduler] invalid cron "${schedule.cron}" for ${schedule.id}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Unregister a schedule's Croner job.
 */
export function unregisterJob(scheduleId: string): void {
  const job = _jobs.get(scheduleId);
  if (job) {
    job.stop();
    _jobs.delete(scheduleId);
  }
}

/**
 * Get the number of active Croner jobs.
 */
export function activeJobCount(): number {
  return _jobs.size;
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Execute a scheduled task: create a run record, call the executor,
 * post output to the channel, and update the run record.
 */
async function executeSchedule(schedule: Schedule, isCatchup: boolean): Promise<void> {
  if (!_executor) {
    process.stderr.write(`[scheduler] no executor registered — skipping ${schedule.id}\n`);
    return;
  }

  const run = await createRun(schedule.id, isCatchup);
  const startTime = Date.now();

  try {
    const result = await _executor(schedule, isCatchup);
    const durationMs = Date.now() - startTime;

    await completeRun(run.id, {
      status: result.status,
      costUsd: result.costUsd,
      durationMs: result.durationMs ?? durationMs,
      errorMessage: result.errorMessage,
      sessionId: result.sessionId,
    });

    await setLastFiredAt(schedule.id, new Date().toISOString());

    // Post result to the schedule's channel
    if (result.result || result.errorMessage) {
      const prefix = isCatchup ? "[Catch-up] " : "";
      const ownerLabel = schedule.ownerType === "agent" ? `@${schedule.ownerId}` : "user";
      const statusEmoji = result.status === "success" ? "✅" : "❌";

      const content = [
        `${statusEmoji} ${prefix}**Scheduled task** (${ownerLabel})`,
        `> ${schedule.prompt}`,
        "",
        result.result ?? result.errorMessage ?? "",
        "",
        result.costUsd ? `_Cost: $${result.costUsd.toFixed(4)}_` : "",
      ].filter(Boolean).join("\n");

      try {
        await postMessage(schedule.channelId, schedule.ownerId, content, {
          metadata: {
            scheduleId: schedule.id,
            runId: run.id,
            isCatchup,
            status: result.status,
          },
        });
      } catch {
        // Non-fatal — don't fail the run if channel posting fails
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    await completeRun(run.id, {
      status: "error",
      durationMs,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Missed-run detection ─────────────────────────────────────────────────────

/**
 * Check if a schedule missed its most recent fire time.
 * Returns the missed fire time, or null if no catch-up needed.
 *
 * Only considers misses within the last 7 days.
 */
function getMostRecentMissedFire(schedule: Schedule): Date | null {
  if (!schedule.lastFiredAt) return null; // Never fired — don't catch up on first run

  const lastFired = new Date(schedule.lastFiredAt);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Don't look back further than 7 days
  const lookbackStart = lastFired > sevenDaysAgo ? lastFired : sevenDaysAgo;

  try {
    // Use Croner to find what the next fire time would have been after lastFiredAt
    const cron = new Cron(schedule.cron);
    const nextAfterLast = cron.nextRun(lookbackStart);

    if (nextAfterLast && nextAfterLast < now) {
      // We missed at least one fire — return the most recent one before now
      // Walk forward to find the latest missed fire
      let latest = nextAfterLast;
      let next = cron.nextRun(latest);
      while (next && next < now) {
        latest = next;
        next = cron.nextRun(latest);
      }
      return latest;
    }
  } catch {
    // Invalid cron — skip
  }

  return null;
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetForTesting(): void {
  stopAll();
  _executor = null;
}
