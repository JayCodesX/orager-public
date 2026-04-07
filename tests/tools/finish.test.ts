/**
 * Tests for src/tools/finish.ts
 *
 * The finish tool is intentionally minimal — it echoes its result argument
 * back as the tool result so the agent loop can use it as the final output.
 */

import { describe, it, expect } from "vitest";
import { finishTool, FINISH_TOOL_NAME } from "../../src/tools/finish.js";

describe("finishTool — definition", () => {
  it("has the correct tool name", () => {
    expect(finishTool.definition.function.name).toBe(FINISH_TOOL_NAME);
    expect(FINISH_TOOL_NAME).toBe("finish");
  });

  it("requires a result parameter", () => {
    const params = finishTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).toContain("result");
  });

  it("has a non-empty description", () => {
    expect(finishTool.definition.function.description?.length).toBeGreaterThan(0);
  });
});

describe("finishTool — execute", () => {
  it("returns the result string as content", async () => {
    const r = await finishTool.execute({ result: "Task complete." }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toBe("Task complete.");
  });

  it("returns a multi-line result unchanged", async () => {
    const multiline = "Line 1\nLine 2\nLine 3";
    const r = await finishTool.execute({ result: multiline }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toBe(multiline);
  });

  it("returns fallback message when result is missing", async () => {
    const r = await finishTool.execute({}, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toBe("(no result provided)");
  });

  it("returns fallback message when result is not a string", async () => {
    const r = await finishTool.execute({ result: 42 }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toBe("(no result provided)");
  });

  it("returns empty string result unchanged (valid input)", async () => {
    const r = await finishTool.execute({ result: "" }, "/tmp");
    // Empty string is a string, so it's returned as-is
    expect(r.isError).toBe(false);
    expect(r.content).toBe("");
  });

  it("never returns isError=true", async () => {
    for (const input of [{}, { result: null }, { result: 123 }, { result: "ok" }]) {
      const r = await finishTool.execute(input, "/tmp");
      expect(r.isError).toBe(false);
    }
  });
});
