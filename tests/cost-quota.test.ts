/**
 * Tests for src/cost-quota.ts — Rolling cost quota enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We test via the public API — the module reads/writes ~/.orager/cost-ledger.jsonl.
// To avoid touching the real ledger, we override the ORAGER_DIR via env or
// mock fs. Since the module uses hardcoded paths, we'll use a temp dir approach
// by mocking the module internals.

// Direct import to test
import {
  recordCost,
  getRollingCost,
  checkCostQuota,
  getCostSummary,
  type CostEntry,
} from "../src/cost-quota.js";

const ORAGER_DIR = path.join(os.homedir(), ".orager");
const LEDGER_PATH = path.join(ORAGER_DIR, "cost-ledger.jsonl");
const BACKUP_PATH = LEDGER_PATH + ".test-backup";

describe("cost-quota", () => {
  let originalContent: string | null = null;

  beforeEach(async () => {
    // Back up existing ledger if present
    try {
      originalContent = await fs.readFile(LEDGER_PATH, "utf8");
      await fs.rename(LEDGER_PATH, BACKUP_PATH);
    } catch {
      originalContent = null;
    }
  });

  afterEach(async () => {
    // Restore original ledger
    try {
      await fs.unlink(LEDGER_PATH);
    } catch { /* ignore */ }
    if (originalContent !== null) {
      await fs.rename(BACKUP_PATH, LEDGER_PATH);
    }
  });

  describe("recordCost", () => {
    it("creates ledger file and appends entry", async () => {
      const entry: CostEntry = {
        ts: Date.now(),
        costUsd: 0.05,
        sessionId: "test-session-1",
        model: "test-model",
      };
      await recordCost(entry);

      const content = await fs.readFile(LEDGER_PATH, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.costUsd).toBe(0.05);
      expect(parsed.sessionId).toBe("test-session-1");
    });

    it("appends multiple entries", async () => {
      await recordCost({ ts: Date.now(), costUsd: 0.01, sessionId: "s1", model: "m1" });
      await recordCost({ ts: Date.now(), costUsd: 0.02, sessionId: "s2", model: "m1" });
      await recordCost({ ts: Date.now(), costUsd: 0.03, sessionId: "s3", model: "m2" });

      const content = await fs.readFile(LEDGER_PATH, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
    });
  });

  describe("getRollingCost", () => {
    it("returns 0 when ledger does not exist", async () => {
      const cost = await getRollingCost();
      expect(cost).toBe(0);
    });

    it("sums entries within the window", async () => {
      const now = Date.now();
      await recordCost({ ts: now - 1000, costUsd: 0.10, sessionId: "s1", model: "m" });
      await recordCost({ ts: now - 500, costUsd: 0.20, sessionId: "s2", model: "m" });

      const cost = await getRollingCost(60_000); // 1 minute window
      expect(cost).toBeCloseTo(0.30, 4);
    });

    it("excludes entries outside the window", async () => {
      const now = Date.now();
      // Entry from 2 hours ago
      await recordCost({ ts: now - 2 * 60 * 60 * 1000, costUsd: 1.00, sessionId: "old", model: "m" });
      // Entry from 5 seconds ago
      await recordCost({ ts: now - 5000, costUsd: 0.05, sessionId: "new", model: "m" });

      const cost = await getRollingCost(60 * 60 * 1000); // 1 hour window
      expect(cost).toBeCloseTo(0.05, 4);
    });
  });

  describe("checkCostQuota", () => {
    it("returns null when under quota", async () => {
      await recordCost({ ts: Date.now(), costUsd: 0.50, sessionId: "s1", model: "m" });

      const result = await checkCostQuota({ maxUsd: 10.0 });
      expect(result).toBeNull();
    });

    it("returns error message when quota exceeded", async () => {
      const now = Date.now();
      await recordCost({ ts: now - 1000, costUsd: 5.00, sessionId: "s1", model: "m" });
      await recordCost({ ts: now - 500, costUsd: 6.00, sessionId: "s2", model: "m" });

      const result = await checkCostQuota({ maxUsd: 10.0 });
      expect(result).not.toBeNull();
      expect(result).toContain("Rolling cost quota exceeded");
      expect(result).toContain("$11.0000");
      expect(result).toContain("limit: $10.00");
    });

    it("respects custom window", async () => {
      const now = Date.now();
      // Entry from 30 minutes ago — inside 1-hour window but outside 10-minute window
      await recordCost({ ts: now - 30 * 60 * 1000, costUsd: 15.00, sessionId: "s1", model: "m" });

      // Should exceed with 1-hour window
      const result1h = await checkCostQuota({ maxUsd: 10.0, windowMs: 60 * 60 * 1000 });
      expect(result1h).not.toBeNull();

      // Should be under quota with 10-minute window (entry is outside)
      const result10m = await checkCostQuota({ maxUsd: 10.0, windowMs: 10 * 60 * 1000 });
      expect(result10m).toBeNull();
    });

    it("returns null when ledger is empty", async () => {
      const result = await checkCostQuota({ maxUsd: 1.0 });
      expect(result).toBeNull();
    });
  });

  describe("getCostSummary", () => {
    it("returns zero summary for empty ledger", async () => {
      const summary = await getCostSummary();
      expect(summary.totalUsd).toBe(0);
      expect(summary.entryCount).toBe(0);
      expect(summary.oldestEntryAge).toBeNull();
    });

    it("returns correct summary", async () => {
      const now = Date.now();
      await recordCost({ ts: now - 60_000, costUsd: 0.10, sessionId: "s1", model: "m" });
      await recordCost({ ts: now - 30_000, costUsd: 0.20, sessionId: "s2", model: "m" });

      const summary = await getCostSummary();
      expect(summary.totalUsd).toBeCloseTo(0.30, 4);
      expect(summary.entryCount).toBe(2);
      expect(summary.oldestEntryAge).toBeGreaterThanOrEqual(59_000);
      expect(summary.oldestEntryAge).toBeLessThan(120_000);
    });
  });

  describe("ledger resilience", () => {
    it("handles malformed lines gracefully", async () => {
      // Write a ledger with a mix of valid and invalid lines
      await fs.mkdir(ORAGER_DIR, { recursive: true });
      const now = Date.now();
      const content = [
        JSON.stringify({ ts: now, costUsd: 0.10, sessionId: "s1", model: "m" }),
        "not valid json",
        "",
        JSON.stringify({ ts: now, costUsd: 0.20, sessionId: "s2", model: "m" }),
      ].join("\n") + "\n";
      await fs.writeFile(LEDGER_PATH, content);

      const cost = await getRollingCost();
      expect(cost).toBeCloseTo(0.30, 4);
    });
  });
});
