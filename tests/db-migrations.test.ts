/**
 * Unit tests for src/db-migrations.ts — runMigrations()
 *
 * runMigrations() is used as a setup utility in many test files but its own
 * behaviour (idempotency, rollback on failure, version ordering, error messages)
 * has never been tested directly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/native-sqlite.js";
import { runMigrations } from "../src/db-migrations.js";
import type { Migration } from "../src/db-migrations.js";
import type { SqliteDatabase } from "../src/native-sqlite.js";

let db: SqliteDatabase;

beforeEach(async () => {
  db = await openDb(":memory:");
});

// ── Basic application ────────────────────────────────────────────────────────

describe("runMigrations — basic application", () => {
  it("creates the _schema_migrations tracking table", () => {
    runMigrations(db, []);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_migrations'",
    ).get();
    expect(row).toBeTruthy();
  });

  it("applies a single migration", () => {
    const migrations: Migration[] = [{
      version: 1,
      name: "create_items",
      sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)",
    }];

    runMigrations(db, migrations);

    // Table should exist
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='items'",
    ).get();
    expect(row).toBeTruthy();

    // Version recorded
    const applied = db.prepare("SELECT version FROM _schema_migrations").all() as { version: number }[];
    expect(applied.map((r) => r.version)).toContain(1);
  });

  it("applies multiple migrations in one call", () => {
    const migrations: Migration[] = [
      { version: 1, name: "create_a", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
      { version: 2, name: "create_b", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)" },
    ];

    runMigrations(db, migrations);

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')",
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(tables).toEqual(["a", "b"]);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("runMigrations — idempotency", () => {
  it("calling twice with the same migrations is a no-op on the second call", () => {
    const migrations: Migration[] = [{
      version: 1,
      name: "create_x",
      sql: "CREATE TABLE x (id INTEGER PRIMARY KEY)",
    }];

    runMigrations(db, migrations);
    // Second call must not throw (would fail with "table already exists" if not idempotent)
    expect(() => runMigrations(db, migrations)).not.toThrow();
  });

  it("only applies the missing migration when a new one is added", () => {
    const v1: Migration[] = [{ version: 1, name: "create_y", sql: "CREATE TABLE y (id INTEGER PRIMARY KEY)" }];
    runMigrations(db, v1);

    const v1v2: Migration[] = [
      ...v1,
      { version: 2, name: "add_col", sql: "ALTER TABLE y ADD COLUMN label TEXT" },
    ];
    runMigrations(db, v1v2);

    // Column should exist after second call
    db.prepare("INSERT INTO y (id, label) VALUES (1, 'hello')").run();
    const row = db.prepare("SELECT label FROM y WHERE id = 1").get() as { label: string };
    expect(row.label).toBe("hello");

    // Both versions recorded exactly once
    const versions = (db.prepare(
      "SELECT version FROM _schema_migrations ORDER BY version",
    ).all() as { version: number }[]).map((r) => r.version);
    expect(versions).toEqual([1, 2]);
  });
});

// ── Version ordering ─────────────────────────────────────────────────────────

describe("runMigrations — version ordering", () => {
  it("applies migrations in version order even when passed out of order", () => {
    const order: number[] = [];
    // Pass v3, v1, v2 — should execute 1 → 2 → 3
    const migrations: Migration[] = [
      { version: 3, name: "step_3", sql: "CREATE TABLE step3 (id INTEGER PRIMARY KEY)" },
      { version: 1, name: "step_1", sql: "CREATE TABLE step1 (id INTEGER PRIMARY KEY)" },
      { version: 2, name: "step_2", sql: "CREATE TABLE step2 (id INTEGER PRIMARY KEY)" },
    ];

    runMigrations(db, migrations);

    const versions = (db.prepare(
      "SELECT version FROM _schema_migrations ORDER BY version",
    ).all() as { version: number }[]).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3]);
  });

  it("skips already-applied versions even when re-ordered", () => {
    // Apply v1 first
    runMigrations(db, [{ version: 1, name: "base", sql: "CREATE TABLE base (id INTEGER PRIMARY KEY)" }]);

    // Now pass v3, v1, v2 — only v2 and v3 should run
    runMigrations(db, [
      { version: 3, name: "step_3", sql: "CREATE TABLE step3 (id INTEGER PRIMARY KEY)" },
      { version: 1, name: "base", sql: "CREATE TABLE base (id INTEGER PRIMARY KEY)" }, // already applied
      { version: 2, name: "step_2", sql: "CREATE TABLE step2 (id INTEGER PRIMARY KEY)" },
    ]);

    const versions = (db.prepare(
      "SELECT version FROM _schema_migrations ORDER BY version",
    ).all() as { version: number }[]).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3]);
  });
});

// ── Rollback on failure ───────────────────────────────────────────────────────

describe("runMigrations — rollback on failure", () => {
  it("throws a descriptive error when a migration contains invalid SQL", () => {
    const migrations: Migration[] = [{
      version: 1,
      name: "bad_sql",
      sql: "THIS IS NOT VALID SQL !!!",
    }];

    expect(() => runMigrations(db, migrations)).toThrow(/migration v1 "bad_sql" failed/);
  });

  it("does not record the failed migration version", () => {
    const migrations: Migration[] = [{
      version: 1,
      name: "will_fail",
      sql: "CREATE TABLE oops (col INVALID_TYPE_THAT_FAILS_CONSTRAINT CHECK(1=0) PRIMARY KEY NOT NULL DEFAULT(SELECT nonexistent()))",
    }];

    try { runMigrations(db, migrations); } catch { /* expected */ }

    // v1 must NOT be recorded since it failed
    const applied = db.prepare("SELECT version FROM _schema_migrations").all() as { version: number }[];
    expect(applied.map((r) => r.version)).not.toContain(1);
  });

  it("leaves DB in consistent state after failure — subsequent valid migration can apply", () => {
    // First call: bad SQL → throws
    try {
      runMigrations(db, [{ version: 1, name: "fail", sql: "NOT SQL" }]);
    } catch { /* expected */ }

    // Second call: good SQL at same version → still throws (v1 still pending) but DB is alive
    expect(() => runMigrations(db, [{ version: 1, name: "fail", sql: "NOT SQL" }])).toThrow();

    // Can still apply a completely fresh migration to the DB
    runMigrations(db, [{ version: 2, name: "recovery", sql: "CREATE TABLE recovery (id INTEGER PRIMARY KEY)" }]);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recovery'",
    ).get();
    expect(row).toBeTruthy();
  });

  it("error message includes version number and migration name", () => {
    expect(() =>
      runMigrations(db, [{ version: 42, name: "my_migration_name", sql: "GARBAGE" }]),
    ).toThrow(/v42.*my_migration_name|my_migration_name.*v42/);
  });
});
