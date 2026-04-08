/**
 * Tests for src/session-recovery.ts — Crash recovery manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import {
  writeRecoveryEntry,
  clearRecoveryEntry,
  readManifest,
  getRecoverableSessions,
  dismissRecovery,
  _RECOVERY_PATH,
  type RecoveryEntry,
} from "../src/session-recovery.js";

const BACKUP_PATH = _RECOVERY_PATH + ".test-backup";

describe("session-recovery", () => {
  let originalContent: string | null = null;

  beforeEach(async () => {
    // Back up existing manifest if present
    try {
      originalContent = await fs.readFile(_RECOVERY_PATH, "utf8");
      await fs.rename(_RECOVERY_PATH, BACKUP_PATH);
    } catch {
      originalContent = null;
    }
  });

  afterEach(async () => {
    // Restore original manifest
    try { await fs.unlink(_RECOVERY_PATH); } catch { /* ignore */ }
    if (originalContent !== null) {
      await fs.rename(BACKUP_PATH, _RECOVERY_PATH);
    }
  });

  const makeEntry = (overrides: Partial<RecoveryEntry> = {}): RecoveryEntry => ({
    sessionId: "test-session-" + Math.random().toString(36).slice(2, 8),
    model: "test-model",
    cwd: "/tmp/test",
    turn: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    ...overrides,
  });

  describe("writeRecoveryEntry", () => {
    it("creates manifest with single entry", async () => {
      const entry = makeEntry({ sessionId: "s1" });
      await writeRecoveryEntry(entry);

      const manifest = await readManifest();
      expect(manifest.version).toBe(1);
      expect(manifest.runs).toHaveLength(1);
      expect(manifest.runs[0].sessionId).toBe("s1");
    });

    it("appends multiple entries", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "s1" }));
      await writeRecoveryEntry(makeEntry({ sessionId: "s2" }));

      const manifest = await readManifest();
      expect(manifest.runs).toHaveLength(2);
    });

    it("updates existing entry by sessionId", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "s1", turn: 0 }));
      await writeRecoveryEntry(makeEntry({ sessionId: "s1", turn: 5 }));

      const manifest = await readManifest();
      expect(manifest.runs).toHaveLength(1);
      expect(manifest.runs[0].turn).toBe(5);
    });
  });

  describe("clearRecoveryEntry", () => {
    it("removes entry by sessionId", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "s1" }));
      await writeRecoveryEntry(makeEntry({ sessionId: "s2" }));

      await clearRecoveryEntry("s1");

      const manifest = await readManifest();
      expect(manifest.runs).toHaveLength(1);
      expect(manifest.runs[0].sessionId).toBe("s2");
    });

    it("deletes file when last entry is removed", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "s1" }));
      await clearRecoveryEntry("s1");

      let exists = true;
      try { await fs.access(_RECOVERY_PATH); } catch { exists = false; }
      expect(exists).toBe(false);
    });

    it("is no-op when sessionId not found", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "s1" }));
      await clearRecoveryEntry("nonexistent");

      const manifest = await readManifest();
      expect(manifest.runs).toHaveLength(1);
    });
  });

  describe("readManifest", () => {
    it("returns empty manifest when file does not exist", async () => {
      const manifest = await readManifest();
      expect(manifest.version).toBe(1);
      expect(manifest.runs).toHaveLength(0);
    });

    it("returns empty manifest for corrupt file", async () => {
      const dir = _RECOVERY_PATH.replace(/\/[^/]+$/, "");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(_RECOVERY_PATH, "not valid json");

      const manifest = await readManifest();
      expect(manifest.version).toBe(1);
      expect(manifest.runs).toHaveLength(0);
    });
  });

  describe("getRecoverableSessions", () => {
    it("returns entries for dead PIDs", async () => {
      // PID 99999999 should not exist
      await writeRecoveryEntry(makeEntry({ sessionId: "dead", pid: 99999999 }));

      const sessions = await getRecoverableSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("dead");
    });

    it("excludes entries for live PIDs", async () => {
      // Current process PID is alive
      await writeRecoveryEntry(makeEntry({ sessionId: "alive", pid: process.pid }));

      const sessions = await getRecoverableSessions();
      expect(sessions).toHaveLength(0);
    });

    it("handles mixed alive/dead entries", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "alive", pid: process.pid }));
      await writeRecoveryEntry(makeEntry({ sessionId: "dead", pid: 99999999 }));

      const sessions = await getRecoverableSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("dead");
    });
  });

  describe("dismissRecovery", () => {
    it("removes dead PID entries, keeps alive ones", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "alive", pid: process.pid }));
      await writeRecoveryEntry(makeEntry({ sessionId: "dead", pid: 99999999 }));

      await dismissRecovery();

      const manifest = await readManifest();
      expect(manifest.runs).toHaveLength(1);
      expect(manifest.runs[0].sessionId).toBe("alive");
    });

    it("deletes file when no alive entries remain", async () => {
      await writeRecoveryEntry(makeEntry({ sessionId: "dead", pid: 99999999 }));

      await dismissRecovery();

      let exists = true;
      try { await fs.access(_RECOVERY_PATH); } catch { exists = false; }
      expect(exists).toBe(false);
    });
  });

  describe("prompt truncation", () => {
    it("stores prompt field", async () => {
      await writeRecoveryEntry(makeEntry({
        sessionId: "with-prompt",
        prompt: "Write a hello world script in Python",
      }));

      const manifest = await readManifest();
      expect(manifest.runs[0].prompt).toBe("Write a hello world script in Python");
    });
  });
});
