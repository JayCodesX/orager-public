/**
 * Tests for CLI argument bounds validation in parse-args.ts.
 *
 * Ensures sampling parameters reject out-of-range values
 * rather than silently passing invalid numbers to the API.
 */
import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli/parse-args.js";

describe("parseArgs — sampling parameter bounds", () => {
  const base = ["run", "test prompt"];

  it("temperature: accepts 0–2, rejects negative and >2", () => {
    expect(parseArgs([...base, "--temperature", "0"]).temperature).toBe(0);
    expect(parseArgs([...base, "--temperature", "1.5"]).temperature).toBe(1.5);
    expect(parseArgs([...base, "--temperature", "2"]).temperature).toBe(2);
    expect(parseArgs([...base, "--temperature", "-0.1"]).temperature).toBeUndefined();
    expect(parseArgs([...base, "--temperature", "2.1"]).temperature).toBeUndefined();
  });

  it("top_p: accepts 0–1, rejects negative and >1", () => {
    expect(parseArgs([...base, "--top-p", "0"]).top_p).toBe(0);
    expect(parseArgs([...base, "--top-p", "0.9"]).top_p).toBe(0.9);
    expect(parseArgs([...base, "--top-p", "1"]).top_p).toBe(1);
    expect(parseArgs([...base, "--top-p", "-0.1"]).top_p).toBeUndefined();
    expect(parseArgs([...base, "--top-p", "1.1"]).top_p).toBeUndefined();
  });

  it("top_k: accepts non-negative integers, rejects negative", () => {
    expect(parseArgs([...base, "--top-k", "0"]).top_k).toBe(0);
    expect(parseArgs([...base, "--top-k", "50"]).top_k).toBe(50);
    expect(parseArgs([...base, "--top-k", "-1"]).top_k).toBeUndefined();
  });

  it("frequency_penalty: accepts -2 to 2, rejects outside", () => {
    expect(parseArgs([...base, "--frequency-penalty", "-2"]).frequency_penalty).toBe(-2);
    expect(parseArgs([...base, "--frequency-penalty", "0"]).frequency_penalty).toBe(0);
    expect(parseArgs([...base, "--frequency-penalty", "2"]).frequency_penalty).toBe(2);
    expect(parseArgs([...base, "--frequency-penalty", "-2.1"]).frequency_penalty).toBeUndefined();
    expect(parseArgs([...base, "--frequency-penalty", "2.1"]).frequency_penalty).toBeUndefined();
  });

  it("presence_penalty: accepts -2 to 2, rejects outside", () => {
    expect(parseArgs([...base, "--presence-penalty", "-2"]).presence_penalty).toBe(-2);
    expect(parseArgs([...base, "--presence-penalty", "2"]).presence_penalty).toBe(2);
    expect(parseArgs([...base, "--presence-penalty", "3"]).presence_penalty).toBeUndefined();
  });

  it("repetition_penalty: accepts > 0, rejects zero and negative", () => {
    expect(parseArgs([...base, "--repetition-penalty", "0.5"]).repetition_penalty).toBe(0.5);
    expect(parseArgs([...base, "--repetition-penalty", "1.2"]).repetition_penalty).toBe(1.2);
    expect(parseArgs([...base, "--repetition-penalty", "0"]).repetition_penalty).toBeUndefined();
    expect(parseArgs([...base, "--repetition-penalty", "-1"]).repetition_penalty).toBeUndefined();
  });

  it("min_p: accepts 0–1, rejects outside", () => {
    expect(parseArgs([...base, "--min-p", "0"]).min_p).toBe(0);
    expect(parseArgs([...base, "--min-p", "0.1"]).min_p).toBe(0.1);
    expect(parseArgs([...base, "--min-p", "1"]).min_p).toBe(1);
    expect(parseArgs([...base, "--min-p", "-0.1"]).min_p).toBeUndefined();
    expect(parseArgs([...base, "--min-p", "1.1"]).min_p).toBeUndefined();
  });

  it("seed: accepts any finite integer, rejects NaN", () => {
    expect(parseArgs([...base, "--seed", "42"]).seed).toBe(42);
    expect(parseArgs([...base, "--seed", "0"]).seed).toBe(0);
    expect(parseArgs([...base, "--seed", "-1"]).seed).toBe(-1); // negative seeds are valid
    expect(parseArgs([...base, "--seed", "abc"]).seed).toBeUndefined();
  });
});
