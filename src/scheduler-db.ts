/**
 * scheduler-db.ts — SQLite CRUD for schedules and schedule_runs.
 *
 * Database: ~/.orager/schedules/schedules.sqlite
 *
 * Two tables:
 *   schedules      — Cron schedule definitions (owner, prompt, channel, enabled)
 *   schedule_runs  — Execution history (status, cost, duration, errors)
 */

import { openDb } from "./native-sqlite.js";
import type { SqliteDatabase } from "./native-sqlite.js";
import { runMigrations, type Migration } from "./db-migrations.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  ownerType: "agent" | "user";
  ownerId: string;
  channelId: string;
  cron: string;
  prompt: string;
  model: string | null;
  enabled: boolean;
  source: "manual" | "operating-manual" | "agent-created";
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "error" | "timeout";
  costUsd: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  sessionId: string | null;
  isCatchup: boolean;
}

export interface CreateScheduleParams {
  ownerType: "agent" | "user";
  ownerId: string;
  channelId: string;
  cron: string;
  prompt: string;
  model?: string;
  source?: "manual" | "operating-manual" | "agent-created";
}

export interface UpdateScheduleParams {
  cron?: string;
  prompt?: string;
  channelId?: string;
  model?: string | null;
  enabled?: boolean;
}

// ── DB singleton ─────────────────────────────────────────────────────────────

let _db: SqliteDatabase | null = null;
let _customDbPath: string | null = null;

function resolveScheduleDbPath(): string {
  if (_customDbPath) return _customDbPath;
  return path.join(os.homedir(), ".orager", "schedules", "schedules.sqlite");
}

async function getDb(): Promise<SqliteDatabase> {
  if (_db) return _db;

  const dbPath = resolveScheduleDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = await openDb(dbPath);
  _migrate(_db);
  return _db;
}

/** Close the DB connection. */
export function closeScheduleDb(): void {
  if (_db) {
    try { _db.exec("PRAGMA optimize"); } catch { /* ignore */ }
    _db = null;
  }
}

/** Reset singleton — for testing only. */
export function _resetForTesting(customDbPath?: string): void {
  closeScheduleDb();
  _customDbPath = customDbPath ?? null;
}

// ── Migrations ───────────────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_schedules_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id              TEXT PRIMARY KEY,
        owner_type      TEXT NOT NULL CHECK(owner_type IN ('agent', 'user')),
        owner_id        TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        cron            TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        model           TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        source          TEXT NOT NULL DEFAULT 'manual',
        last_fired_at   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id              TEXT PRIMARY KEY,
        schedule_id     TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        status          TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'timeout')),
        cost_usd        REAL,
        duration_ms     INTEGER,
        error_message   TEXT,
        session_id      TEXT,
        is_catchup      INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
    `,
  },
];

function _migrate(db: SqliteDatabase): void {
  runMigrations(db, MIGRATIONS);
}

// ── Schedule CRUD ────────────────────────────────────────────────────────────

export async function createSchedule(params: CreateScheduleParams): Promise<Schedule> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO schedules (id, owner_type, owner_id, channel_id, cron, prompt, model, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.ownerType, params.ownerId, params.channelId, params.cron, params.prompt, params.model ?? null, params.source ?? "manual", now, now);

  return {
    id, ownerType: params.ownerType, ownerId: params.ownerId,
    channelId: params.channelId, cron: params.cron, prompt: params.prompt,
    model: params.model ?? null, enabled: true,
    source: params.source ?? "manual", lastFiredAt: null,
    createdAt: now, updatedAt: now,
  };
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as any;
  if (!row) return null;
  return rowToSchedule(row);
}

export async function listSchedules(opts?: {
  ownerType?: "agent" | "user";
  ownerId?: string;
  enabledOnly?: boolean;
}): Promise<Schedule[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.ownerType) { conditions.push("owner_type = ?"); params.push(opts.ownerType); }
  if (opts?.ownerId) { conditions.push("owner_id = ?"); params.push(opts.ownerId); }
  if (opts?.enabledOnly) { conditions.push("enabled = 1"); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM schedules ${where} ORDER BY created_at DESC`).all(...params) as any[];
  return rows.map(rowToSchedule);
}

export async function updateSchedule(id: string, updates: UpdateScheduleParams): Promise<boolean> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.cron !== undefined) { sets.push("cron = ?"); params.push(updates.cron); }
  if (updates.prompt !== undefined) { sets.push("prompt = ?"); params.push(updates.prompt); }
  if (updates.channelId !== undefined) { sets.push("channel_id = ?"); params.push(updates.channelId); }
  if (updates.model !== undefined) { sets.push("model = ?"); params.push(updates.model); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }

  if (sets.length === 0) return false;

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const result = db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return (result as any)?.changes > 0;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const db = await getDb();
  const result = db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  return (result as any)?.changes > 0;
}

export async function setLastFiredAt(id: string, firedAt: string): Promise<void> {
  const db = await getDb();
  db.prepare("UPDATE schedules SET last_fired_at = ?, updated_at = ? WHERE id = ?").run(firedAt, new Date().toISOString(), id);
}

// ── Schedule Run CRUD ────────────────────────────────────────────────────────

export async function createRun(scheduleId: string, isCatchup: boolean = false): Promise<ScheduleRun> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO schedule_runs (id, schedule_id, started_at, status, is_catchup)
    VALUES (?, ?, ?, 'running', ?)
  `).run(id, scheduleId, now, isCatchup ? 1 : 0);

  return {
    id, scheduleId, startedAt: now, finishedAt: null,
    status: "running", costUsd: null, durationMs: null,
    errorMessage: null, sessionId: null, isCatchup,
  };
}

export async function completeRun(
  runId: string,
  result: { status: "success" | "error" | "timeout"; costUsd?: number; durationMs?: number; errorMessage?: string; sessionId?: string },
): Promise<void> {
  const db = await getDb();
  db.prepare(`
    UPDATE schedule_runs
    SET finished_at = ?, status = ?, cost_usd = ?, duration_ms = ?, error_message = ?, session_id = ?
    WHERE id = ?
  `).run(
    new Date().toISOString(), result.status,
    result.costUsd ?? null, result.durationMs ?? null,
    result.errorMessage ?? null, result.sessionId ?? null,
    runId,
  );
}

export async function getRunHistory(
  scheduleId: string,
  opts?: { limit?: number },
): Promise<ScheduleRun[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 20;
  const rows = db.prepare(
    "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?",
  ).all(scheduleId, limit) as any[];
  return rows.map(rowToRun);
}

// ── Missed-run detection ─────────────────────────────────────────────────────

/**
 * Get all enabled schedules that may have missed runs.
 * Returns schedules where lastFiredAt is older than expected.
 */
export async function getEnabledSchedules(): Promise<Schedule[]> {
  return listSchedules({ enabledOnly: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToSchedule(row: any): Schedule {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    channelId: row.channel_id,
    cron: row.cron,
    prompt: row.prompt,
    model: row.model,
    enabled: !!row.enabled,
    source: row.source,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: any): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    sessionId: row.session_id,
    isCatchup: !!row.is_catchup,
  };
}
