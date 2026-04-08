import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock openrouter — must include all 5 exports
vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn().mockResolvedValue({
    content: JSON.stringify({
      what: "Deployed to production on a Friday",
      why: "Fridays are risky — no one is around to fix issues over the weekend",
      fix: "Never deploy to production on Fridays. Schedule for Monday-Thursday only.",
      pattern: "When scheduling deployments, prefer early-week slots (Mon-Wed) to allow buffer time for hotfixes.",
    }),
  }),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  callEmbeddings: vi.fn().mockResolvedValue(null),
  fetchGenerationMeta: vi.fn(),
}));

import { detectCorrection, extractLesson, processCorrection } from "../src/correction-detector.js";
import { createIdentity, loadIdentity, deleteIdentity } from "../src/agent-identity.js";

const RUN_ID = Date.now().toString(36);

describe("detectCorrection", () => {
  it("detects direct negation", () => {
    expect(detectCorrection("No, don't deploy on Fridays")).not.toBeNull();
    expect(detectCorrection("No, never push to main directly")).not.toBeNull();
    expect(detectCorrection("That's wrong, use the staging DB")).not.toBeNull();
  });

  it("detects redirection", () => {
    expect(detectCorrection("Instead, use the backup server for this")).not.toBeNull();
    expect(detectCorrection("Use postgres instead")).not.toBeNull();
    expect(detectCorrection("You should have used the staging environment")).not.toBeNull();
  });

  it("detects explicit correction signals", () => {
    expect(detectCorrection("Actually, you need to run migrations first")).not.toBeNull();
    expect(detectCorrection("From now on, always run tests before deploy")).not.toBeNull();
    expect(detectCorrection("Remember to backup before migrations")).not.toBeNull();
    expect(detectCorrection("Next time, check the logs first")).not.toBeNull();
  });

  it("detects permanent rules", () => {
    expect(detectCorrection("Always use pg_dump before any migration")).not.toBeNull();
    expect(detectCorrection("Never again skip the test suite")).not.toBeNull();
  });

  it("returns null for non-corrections", () => {
    expect(detectCorrection("Hello")).toBeNull();
    expect(detectCorrection("How does the deploy pipeline work?")).toBeNull();
    expect(detectCorrection("Can you show me the logs?")).toBeNull();
    expect(detectCorrection("Thanks")).toBeNull();
    expect(detectCorrection("yes")).toBeNull(); // too short
  });

  it("returns null for short messages", () => {
    expect(detectCorrection("no")).toBeNull();
    expect(detectCorrection("stop")).toBeNull();
  });

  it("handles questions that contain corrections", () => {
    expect(detectCorrection("Why did you do that? Don't deploy on Fridays!")).not.toBeNull();
  });
});

describe("extractLesson", () => {
  it("extracts a structured lesson from LLM response", async () => {
    const result = await extractLesson(
      "test-key",
      "openai/gpt-4o-mini",
      "No, don't deploy on Fridays",
      "I've deployed the new version to production.",
    );

    expect(result).not.toBeNull();
    expect(result!.lesson.what).toContain("Friday");
    expect(result!.lesson.fix).toContain("Never deploy");
    expect(result!.lesson.neverCompress).toBe(true);
    expect(result!.pattern).not.toBeNull();
  });
});

describe("processCorrection", () => {
  const agentId = `test-corrector-${RUN_ID}`;

  beforeEach(async () => {
    // Create a real identity dir for testing
    try { deleteIdentity(agentId); } catch { /* ignore */ }
    await createIdentity(agentId, { soul: `# ${agentId}\nTest agent for correction detection.` });
  });

  afterEach(() => {
    try { deleteIdentity(agentId); } catch { /* ignore */ }
  });

  it("detects correction, extracts lesson, and saves to identity files", async () => {
    const saved = await processCorrection(
      agentId,
      "test-key",
      "openai/gpt-4o-mini",
      "No, don't deploy on Fridays! Always schedule for Monday-Thursday.",
      "I've scheduled the deployment for this Friday at 5pm.",
    );

    expect(saved).toBe(true);

    // Verify lesson was appended
    const identity = loadIdentity(agentId);
    expect(identity).not.toBeNull();
    expect(identity!.lessons.length).toBeGreaterThan(0);
    expect(identity!.lessons[0]!.fix).toContain("Never deploy");
    expect(identity!.lessons[0]!.neverCompress).toBe(true);

    // Verify pattern was appended
    expect(identity!.patterns).toContain("deployment");
  });

  it("returns false for non-correction messages", async () => {
    const saved = await processCorrection(
      agentId,
      "test-key",
      "openai/gpt-4o-mini",
      "Thanks, looks good!",
      "I've completed the task.",
    );

    expect(saved).toBe(false);
  });
});
