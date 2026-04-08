import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock callEmbeddings to avoid real API calls — must include all 5 exports
vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  callEmbeddings: vi.fn().mockResolvedValue(null),
  fetchGenerationMeta: vi.fn(),
}));

import {
  indexAgent,
  rebuildIndex,
  removeAgentFromIndex,
  searchIdentities,
  _resetForTesting,
} from "../src/agent-identity-index.js";

// We create real identity dirs in a temp location.
// agent-identity.ts reads from os.homedir()/.orager/agents/ so we need
// to place files there. But the INDEX DB path is overridden via _resetForTesting.
const TEST_ROOT = path.join(os.tmpdir(), `orager-idx-test-${Date.now()}`);
const AGENTS_DIR = path.join(os.homedir(), ".orager", "agents");

function setupTestAgent(id: string, soul: string, memory?: string): void {
  const agentDir = path.join(AGENTS_DIR, id);
  mkdirSync(path.join(agentDir, "daily-logs"), { recursive: true });
  writeFileSync(path.join(agentDir, "soul.md"), soul, "utf-8");
  writeFileSync(path.join(agentDir, "operating-manual.md"), "", "utf-8");
  writeFileSync(path.join(agentDir, "memory.md"), memory ?? "", "utf-8");
  writeFileSync(path.join(agentDir, "lessons.md"), "", "utf-8");
  writeFileSync(path.join(agentDir, "patterns.md"), "", "utf-8");
}

function cleanupTestAgent(id: string): void {
  try { rmSync(path.join(AGENTS_DIR, id), { recursive: true, force: true }); } catch { /* ignore */ }
}

// Use unique agent IDs per test run to avoid collisions
const RUN_ID = Date.now().toString(36);

describe("agent-identity-index", () => {
  const dbPath = path.join(TEST_ROOT, "identity-index.sqlite");

  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    _resetForTesting(dbPath);
  });

  afterEach(() => {
    _resetForTesting();
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("indexes an agent and finds it via FTS search", async () => {
    const id = `test-mercury-${RUN_ID}`;
    setupTestAgent(id, "# Mercury\n\nDeployment specialist. Handles CI/CD pipelines and Kubernetes clusters.");
    try {
      const result = await indexAgent(id);
      expect(result.chunksIndexed).toBeGreaterThan(0);

      const hits = await searchIdentities("deployment kubernetes");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.agentId).toBe(id);
      expect(hits[0]!.content).toContain("Deployment");
    } finally {
      cleanupTestAgent(id);
    }
  });

  it("returns empty results for non-matching query", async () => {
    const id = `test-mercury2-${RUN_ID}`;
    setupTestAgent(id, "# Mercury\n\nDeployment specialist.");
    try {
      await indexAgent(id);
      const hits = await searchIdentities("quantum physics entanglement");
      expect(hits).toEqual([]);
    } finally {
      cleanupTestAgent(id);
    }
  });

  it("filters by agentId", async () => {
    const id1 = `test-merc-${RUN_ID}`;
    const id2 = `test-venus-${RUN_ID}`;
    setupTestAgent(id1, "# Mercury\n\nDeployment specialist for cloud infrastructure.");
    setupTestAgent(id2, "# Venus\n\nDeployment reviewer for cloud systems.");
    try {
      await indexAgent(id1);
      await indexAgent(id2);

      const hits = await searchIdentities("deployment cloud", { agentIds: [id1] });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.agentId === id1)).toBe(true);
    } finally {
      cleanupTestAgent(id1);
      cleanupTestAgent(id2);
    }
  });

  it("filters by fileType", async () => {
    const id = `test-merc3-${RUN_ID}`;
    setupTestAgent(id, "# Mercury\n\nDeployment specialist.", "Knows about AWS ECS and Fargate services.");
    try {
      await indexAgent(id);

      const hits = await searchIdentities("AWS ECS Fargate", { fileTypes: ["memory"] });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.fileType === "memory")).toBe(true);
    } finally {
      cleanupTestAgent(id);
    }
  });

  it("removes agent from index", async () => {
    const id = `test-merc4-${RUN_ID}`;
    setupTestAgent(id, "# Mercury\n\nDeployment specialist with unique skills.");
    try {
      await indexAgent(id);

      let hits = await searchIdentities("unique skills");
      expect(hits.length).toBeGreaterThan(0);

      await removeAgentFromIndex(id);
      hits = await searchIdentities("unique skills");
      expect(hits).toEqual([]);
    } finally {
      cleanupTestAgent(id);
    }
  });

  it("returns zero chunks for non-existent agent", async () => {
    const result = await indexAgent("nonexistent-agent-xyz-" + RUN_ID);
    expect(result.chunksIndexed).toBe(0);
  });
});
