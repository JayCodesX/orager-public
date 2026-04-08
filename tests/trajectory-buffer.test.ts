/**
 * Tests for the OMLS trajectory buffer (src/omls/trajectory-buffer.ts).
 *
 * Tests directory scanning, batch packaging, and trained-marker logic
 * using a real temp directory on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We test the pure/filesystem functions by mocking the dependency that
// provides directory paths, so tests use temp dirs instead of ~/.orager.

let tmpDir: string;
let trajDir: string;

// These will be set by the dynamic import after mocking
let scanDistillableBuffer: typeof import("../src/omls/trajectory-buffer.js")["scanDistillableBuffer"];
let countDistillableBuffer: typeof import("../src/omls/trajectory-buffer.js")["countDistillableBuffer"];
let packageBatch: typeof import("../src/omls/trajectory-buffer.js")["packageBatch"];
let markBatchTrained: typeof import("../src/omls/trajectory-buffer.js")["markBatchTrained"];
let getTrainingDir: typeof import("../src/omls/trajectory-buffer.js")["getTrainingDir"];
let getTrainedTagPath: typeof import("../src/omls/trajectory-buffer.js")["getTrainedTagPath"];

import { vi } from "bun:test";

vi.mock("../src/skillbank.js", () => {
  const _tmpDir = path.join(os.tmpdir(), `orager-traj-test-${Date.now()}`);
  const _trajDir = path.join(_tmpDir, "trajectories");
  return {
    getTrajectoriesDir: () => _trajDir,
    trajectoryPath: (sessionId: string) => path.join(_trajDir, `${sessionId}.jsonl`),
    _testTmpDir: _tmpDir,
    _testTrajDir: _trajDir,
  };
});

// Dynamic import after mock setup
const mod = await import("../src/omls/trajectory-buffer.js");
scanDistillableBuffer = mod.scanDistillableBuffer;
countDistillableBuffer = mod.countDistillableBuffer;
packageBatch = mod.packageBatch;
markBatchTrained = mod.markBatchTrained;
getTrainingDir = mod.getTrainingDir;
getTrainedTagPath = mod.getTrainedTagPath;

const skillbankMock = await import("../src/skillbank.js") as unknown as {
  _testTmpDir: string;
  _testTrajDir: string;
};
tmpDir = skillbankMock._testTmpDir;
trajDir = skillbankMock._testTrajDir;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMeta(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: "test-session",
    teacherModel: "deepseek/deepseek-r1",
    routerSignal: "confidence_token",
    distillable: true,
    skillGeneration: 1,
    finishedAt: new Date().toISOString(),
    subtype: "chat",
    ...overrides,
  });
}

async function writeTrajectory(sessionId: string, metaOverrides: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(trajDir, { recursive: true });
  const meta = makeMeta({ sessionId, ...metaOverrides });
  await fs.writeFile(path.join(trajDir, `${sessionId}.meta.json`), meta, "utf8");
  await fs.writeFile(path.join(trajDir, `${sessionId}.jsonl`), '{"role":"user","content":"test"}\n', "utf8");
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  // Ensure clean state
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(trajDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── scanDistillableBuffer ───────────────────────────────────────────────────

describe("scanDistillableBuffer", () => {
  it("returns empty array when no trajectories exist", async () => {
    const entries = await scanDistillableBuffer();
    expect(entries).toEqual([]);
  });

  it("returns distillable trajectories", async () => {
    await writeTrajectory("session-1");
    const entries = await scanDistillableBuffer();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("session-1");
  });

  it("skips non-distillable trajectories", async () => {
    await writeTrajectory("session-2", { distillable: false });
    const entries = await scanDistillableBuffer();
    expect(entries).toHaveLength(0);
  });

  it("skips already-trained trajectories", async () => {
    await writeTrajectory("session-3");
    // Create .trained marker
    await fs.writeFile(getTrainedTagPath("session-3"), new Date().toISOString(), "utf8");
    const entries = await scanDistillableBuffer();
    expect(entries).toHaveLength(0);
  });

  it("filters by minimum skill generation", async () => {
    await writeTrajectory("old-session", { skillGeneration: 1 });
    await writeTrajectory("new-session", { skillGeneration: 3 });
    const entries = await scanDistillableBuffer(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("new-session");
  });

  it("includes all generations when minSkillGeneration is 0", async () => {
    await writeTrajectory("s1", { skillGeneration: 0 });
    await writeTrajectory("s2", { skillGeneration: 5 });
    const entries = await scanDistillableBuffer(0);
    expect(entries).toHaveLength(2);
  });

  it("skips entries with missing .jsonl file", async () => {
    await fs.mkdir(trajDir, { recursive: true });
    // Only write meta, no jsonl
    await fs.writeFile(
      path.join(trajDir, "no-jsonl.meta.json"),
      makeMeta({ sessionId: "no-jsonl" }),
      "utf8",
    );
    const entries = await scanDistillableBuffer();
    expect(entries).toHaveLength(0);
  });

  it("skips malformed meta files", async () => {
    await fs.mkdir(trajDir, { recursive: true });
    await fs.writeFile(path.join(trajDir, "bad.meta.json"), "not valid json{{{", "utf8");
    await fs.writeFile(path.join(trajDir, "bad.jsonl"), "data\n", "utf8");
    const entries = await scanDistillableBuffer();
    expect(entries).toHaveLength(0);
  });
});

// ── countDistillableBuffer ──────────────────────────────────────────────────

describe("countDistillableBuffer", () => {
  it("returns 0 for empty directory", async () => {
    expect(await countDistillableBuffer()).toBe(0);
  });

  it("returns correct count", async () => {
    await writeTrajectory("a");
    await writeTrajectory("b");
    await writeTrajectory("c", { distillable: false });
    expect(await countDistillableBuffer()).toBe(2);
  });
});

// ── packageBatch ────────────────────────────────────────────────────────────

describe("packageBatch", () => {
  it("packages entries into a batch directory", async () => {
    await writeTrajectory("p1");
    await writeTrajectory("p2");
    const entries = await scanDistillableBuffer();
    const batch = await packageBatch(entries);

    expect(batch.batchId).toMatch(/^batch-\d+-[0-9a-f]+$/);
    expect(batch.entries).toHaveLength(2);

    // Verify manifest exists
    const manifest = JSON.parse(await fs.readFile(batch.manifestPath, "utf8"));
    expect(manifest.count).toBe(2);
    expect(manifest.batchId).toBe(batch.batchId);

    // Verify trajectory files were copied
    const trajFiles = await fs.readdir(path.join(batch.batchDir, "trajectories"));
    expect(trajFiles).toHaveLength(4); // 2 jsonl + 2 meta.json

    // Cleanup
    await fs.rm(batch.batchDir, { recursive: true, force: true });
  });

  it("respects maxBatchSize", async () => {
    await writeTrajectory("x1", { finishedAt: "2026-01-01T00:00:00Z" });
    await writeTrajectory("x2", { finishedAt: "2026-01-02T00:00:00Z" });
    await writeTrajectory("x3", { finishedAt: "2026-01-03T00:00:00Z" });
    const entries = await scanDistillableBuffer();
    const batch = await packageBatch(entries, 2);

    expect(batch.entries).toHaveLength(2);
    // Should pick the two newest
    const sessionIds = batch.entries.map((e) => e.sessionId);
    expect(sessionIds).toContain("x3");
    expect(sessionIds).toContain("x2");

    await fs.rm(batch.batchDir, { recursive: true, force: true });
  });

  it("deduplicates teacher models in manifest", async () => {
    await writeTrajectory("d1", { teacherModel: "model-a" });
    await writeTrajectory("d2", { teacherModel: "model-a" });
    await writeTrajectory("d3", { teacherModel: "model-b" });
    const entries = await scanDistillableBuffer();
    const batch = await packageBatch(entries);

    const manifest = JSON.parse(await fs.readFile(batch.manifestPath, "utf8"));
    expect(manifest.teacherModels).toHaveLength(2);
    expect(manifest.teacherModels).toContain("model-a");
    expect(manifest.teacherModels).toContain("model-b");

    await fs.rm(batch.batchDir, { recursive: true, force: true });
  });
});

// ── markBatchTrained ────────────────────────────────────────────────────────

describe("markBatchTrained", () => {
  it("creates .trained markers for all batch entries", async () => {
    await writeTrajectory("t1");
    await writeTrajectory("t2");
    const entries = await scanDistillableBuffer();
    const batch = await packageBatch(entries);

    await markBatchTrained(batch);

    // Verify trained markers exist
    for (const entry of batch.entries) {
      const tagPath = getTrainedTagPath(entry.sessionId);
      const stat = await fs.stat(tagPath);
      expect(stat.isFile()).toBe(true);
    }

    // Re-scanning should now return empty
    const remaining = await scanDistillableBuffer();
    expect(remaining).toHaveLength(0);

    await fs.rm(batch.batchDir, { recursive: true, force: true });
  });
});

// ── getTrainingDir / getTrainedTagPath ───────────────────────────────────────

describe("directory helpers", () => {
  it("getTrainingDir returns a path under home", () => {
    const dir = getTrainingDir();
    expect(dir).toContain(".orager");
    expect(dir).toContain("training");
  });

  it("getTrainedTagPath includes session ID", () => {
    const p = getTrainedTagPath("my-session");
    expect(p).toContain("my-session.trained");
  });
});
