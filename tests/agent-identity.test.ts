import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// The module reads from ~/.orager/agents/ — we'll use a temp dir and patch
const TEST_ROOT = path.join(os.tmpdir(), `orager-identity-test-${Date.now()}`);

// We need to test the functions directly, so import after setup
// Since the module uses os.homedir(), we test via the exported functions
// that accept an agentId and work relative to ~/.orager/agents/
import {
  parseLessons,
  formatLesson,
  buildIdentityBlock,
  type AgentLesson,
} from "../src/agent-identity.js";

describe("parseLessons", () => {
  it("parses empty string", () => {
    expect(parseLessons("")).toEqual([]);
  });

  it("parses a single lesson", () => {
    const md = `## 2026-04-07
**What:** Ran migration without backup
**Why:** No pre-migration checklist
**Fix:** Always run pg_dump before any migration
`;
    const lessons = parseLessons(md);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toEqual({
      date: "2026-04-07",
      what: "Ran migration without backup",
      why: "No pre-migration checklist",
      fix: "Always run pg_dump before any migration",
    });
  });

  it("parses multiple lessons", () => {
    const md = `## 2026-04-05
**What:** Deployed to prod without testing
**Why:** Rushed deadline
**Fix:** Always run test suite before deploy

## 2026-04-07
<!-- neverCompress -->
**What:** Deleted user data
**Why:** Wrong WHERE clause
**Fix:** Always use SELECT first, then convert to DELETE
`;
    const lessons = parseLessons(md);
    expect(lessons).toHaveLength(2);
    expect(lessons[0]!.date).toBe("2026-04-05");
    expect(lessons[1]!.date).toBe("2026-04-07");
    expect(lessons[1]!.neverCompress).toBe(true);
  });
});

describe("formatLesson", () => {
  it("formats a lesson to markdown", () => {
    const lesson: AgentLesson = {
      date: "2026-04-07",
      what: "Ran migration without backup",
      why: "No checklist",
      fix: "Always backup first",
    };
    const md = formatLesson(lesson);
    expect(md).toContain("## 2026-04-07");
    expect(md).toContain("**What:** Ran migration without backup");
    expect(md).toContain("**Fix:** Always backup first");
    expect(md).not.toContain("neverCompress");
  });

  it("includes neverCompress comment when set", () => {
    const lesson: AgentLesson = {
      date: "2026-04-07",
      what: "Critical error",
      why: "Bad logic",
      fix: "Fix the logic",
      neverCompress: true,
    };
    const md = formatLesson(lesson);
    expect(md).toContain("<!-- neverCompress -->");
  });
});

describe("buildIdentityBlock", () => {
  it("returns null for non-existent agent", () => {
    const block = buildIdentityBlock("nonexistent-agent-xyz-" + Date.now());
    expect(block).toBeNull();
  });
});
