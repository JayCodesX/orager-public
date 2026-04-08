import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock openrouter (required by channel.ts → postMessage)
vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  callEmbeddings: vi.fn().mockResolvedValue(null),
  fetchGenerationMeta: vi.fn(),
}));

import {
  createSchedule, getSchedule, listSchedules, updateSchedule,
  deleteSchedule, getRunHistory, createRun, completeRun,
  _resetForTesting as resetDb,
} from "../src/scheduler-db.js";
import {
  setExecutor, loadAndStartAll, stopAll, registerJob,
  unregisterJob, activeJobCount, isRunning,
  _resetForTesting as resetScheduler,
} from "../src/scheduler.js";

const TEST_ROOT = path.join(os.tmpdir(), `orager-sched-test-${Date.now()}`);

describe("scheduler-db", () => {
  const dbPath = path.join(TEST_ROOT, "schedules.sqlite");

  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    resetDb(dbPath);
  });

  afterEach(() => {
    resetDb();
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates and retrieves a schedule", async () => {
    const sched = await createSchedule({
      ownerType: "agent", ownerId: "mercury",
      channelId: "ch-1", cron: "*/30 * * * *",
      prompt: "Check system health",
    });
    expect(sched.id).toBeTruthy();
    expect(sched.cron).toBe("*/30 * * * *");
    expect(sched.enabled).toBe(true);

    const retrieved = await getSchedule(sched.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.prompt).toBe("Check system health");
  });

  it("lists schedules with filters", async () => {
    await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "0 9 * * *", prompt: "Morning check" });
    await createSchedule({ ownerType: "user", ownerId: "user", channelId: "ch-1", cron: "0 8 * * 1", prompt: "Weekly report" });

    const all = await listSchedules();
    expect(all.length).toBe(2);

    const agentOnly = await listSchedules({ ownerType: "agent" });
    expect(agentOnly.length).toBe(1);
    expect(agentOnly[0]!.ownerId).toBe("mercury");
  });

  it("updates a schedule", async () => {
    const sched = await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "0 9 * * *", prompt: "Old prompt" });
    await updateSchedule(sched.id, { prompt: "New prompt", enabled: false });

    const updated = await getSchedule(sched.id);
    expect(updated!.prompt).toBe("New prompt");
    expect(updated!.enabled).toBe(false);
  });

  it("deletes a schedule", async () => {
    const sched = await createSchedule({ ownerType: "user", ownerId: "user", channelId: "ch-1", cron: "0 9 * * *", prompt: "Delete me" });
    const deleted = await deleteSchedule(sched.id);
    expect(deleted).toBe(true);
    expect(await getSchedule(sched.id)).toBeNull();
  });

  it("tracks run history", async () => {
    const sched = await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "*/5 * * * *", prompt: "Health check" });

    const run = await createRun(sched.id);
    expect(run.status).toBe("running");

    await completeRun(run.id, { status: "success", costUsd: 0.05, durationMs: 1200 });

    const history = await getRunHistory(sched.id);
    expect(history.length).toBe(1);
    expect(history[0]!.status).toBe("success");
    expect(history[0]!.costUsd).toBe(0.05);
  });

  it("cascades deletes to runs", async () => {
    const sched = await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "*/5 * * * *", prompt: "Test" });
    await createRun(sched.id);
    await deleteSchedule(sched.id);

    const history = await getRunHistory(sched.id);
    expect(history.length).toBe(0);
  });
});

describe("scheduler engine", () => {
  const dbPath = path.join(TEST_ROOT, "sched-engine.sqlite");

  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    resetDb(dbPath);
    resetScheduler();
  });

  afterEach(() => {
    resetScheduler();
    resetDb();
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("registers and unregisters Croner jobs", async () => {
    const sched = await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "0 9 * * *", prompt: "Morning" });

    registerJob(sched);
    expect(activeJobCount()).toBe(1);

    unregisterJob(sched.id);
    expect(activeJobCount()).toBe(0);
  });

  it("loadAndStartAll loads enabled schedules", async () => {
    await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "0 9 * * *", prompt: "Active" });
    const disabled = await createSchedule({ ownerType: "agent", ownerId: "venus", channelId: "ch-1", cron: "0 10 * * *", prompt: "Disabled" });
    await updateSchedule(disabled.id, { enabled: false });

    setExecutor(async () => ({ status: "success" as const }));
    const result = await loadAndStartAll();
    expect(result.loaded).toBe(1); // only enabled
    expect(isRunning()).toBe(true);
    expect(activeJobCount()).toBe(1);
  });

  it("stopAll clears all jobs", async () => {
    await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "0 9 * * *", prompt: "Test" });
    setExecutor(async () => ({ status: "success" as const }));
    await loadAndStartAll();

    stopAll();
    expect(isRunning()).toBe(false);
    expect(activeJobCount()).toBe(0);
  });

  it("rejects invalid cron expressions gracefully", async () => {
    const sched = await createSchedule({ ownerType: "agent", ownerId: "mercury", channelId: "ch-1", cron: "invalid cron", prompt: "Bad" });
    // Should not throw
    registerJob(sched);
    expect(activeJobCount()).toBe(0); // invalid cron not registered
  });
});
