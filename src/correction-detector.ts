/**
 * correction-detector.ts — Detects user corrections and extracts lessons.
 *
 * When a user corrects an agent ("no, do X instead", "don't do Y",
 * "that's wrong"), this module:
 *  1. Detects the correction using heuristic pattern matching
 *  2. Extracts a structured lesson via an LLM call
 *  3. Appends the lesson to the agent's lessons.md
 *  4. Optionally adds a decision pattern to patterns.md
 *
 * Integrated into the agent loop: after each user message, if an
 * identityId is set and the message looks like a correction, this
 * fires asynchronously (non-blocking).
 */

import { appendLesson, loadIdentity, updateIdentityFile } from "./agent-identity.js";
import { callOpenRouter } from "./openrouter.js";
import type { AgentLesson } from "./agent-identity.js";
import type { OpenRouterCallResult } from "./types.js";

// ── Correction detection (heuristics) ────────────────────────────────────────

/**
 * Correction signal patterns — phrases that indicate the user is
 * correcting the agent's behavior or output.
 */
const CORRECTION_PATTERNS = [
  // Direct negation
  /\bno[,.]?\s+(don'?t|do not|never|stop|wrong|incorrect)/i,
  /\bthat'?s?\s+(wrong|incorrect|not right|not what)/i,
  /\byou\s+(shouldn'?t|should not|should never)/i,
  /\bdon'?t\s+(do|use|run|deploy|delete|drop|send|push|merge)/i,
  /\bnever\s+(do|use|run|deploy|delete|drop|send|push|merge)/i,
  /\bstop\s+(doing|using|running)/i,

  // Redirection
  /\binstead[,.]?\s+(use|do|run|try)/i,
  /\buse\s+\S+\s+instead/i,
  /\bnot\s+\S+[,.]?\s+(use|do|try)\s/i,
  /\bshould\s+(have|be)\s+(used|done|run)/i,

  // Explicit correction
  /\bactually[,.]?\s+(you|it|we|the)/i,
  /\bcorrect(ion|ed)?:/i,
  /\bfix(ed)?:\s/i,
  /\bwrong\s+(approach|way|method|file|command)/i,

  // Learning signals
  /\balways\s+(use|do|run|check|verify|test|backup)/i,
  /\bnever\s+(again|ever|push|deploy|delete|skip)/i,
  /\bremember\s+(to|that|this)/i,
  /\bfrom\s+now\s+on/i,
  /\bin\s+the\s+future/i,
  /\bnext\s+time/i,
];

/**
 * Check if a user message likely contains a correction.
 * Uses heuristic pattern matching — fast, no API call needed.
 *
 * Returns the matching pattern description for logging, or null if no match.
 */
export function detectCorrection(userMessage: string): string | null {
  // Skip very short messages (unlikely to be meaningful corrections)
  if (userMessage.length < 15) return null;

  // Skip messages that are clearly questions, not corrections
  if (/^\s*(what|how|when|where|why|can|could|would|is|are|do|does)\s/i.test(userMessage)) {
    // Questions CAN contain corrections ("why did you do X? Don't do that")
    // Only skip if the message is purely a question (no correction patterns)
    const hasCorrection = CORRECTION_PATTERNS.some((p) => p.test(userMessage));
    if (!hasCorrection) return null;
  }

  for (const pattern of CORRECTION_PATTERNS) {
    const match = userMessage.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

// ── Lesson extraction (LLM) ─────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a conversation where a user corrected an AI agent's behavior. Extract a structured lesson from the correction.

Given the user's correction message and the agent's prior message that was corrected, extract:

1. **What**: What the agent did wrong (1 sentence)
2. **Why**: Why it was wrong (1 sentence)
3. **Fix**: A permanent rule for the agent to follow (imperative, 1 sentence)
4. **Pattern** (optional): If this implies a broader decision framework, describe it (1 sentence). Otherwise return "none".

Respond in exactly this JSON format:
{"what": "...", "why": "...", "fix": "...", "pattern": "..."}

Do NOT include any text outside the JSON object.`;

export interface ExtractionResult {
  lesson: Omit<AgentLesson, "date">;
  pattern: string | null;
}

/**
 * Use an LLM to extract a structured lesson from a correction.
 */
export async function extractLesson(
  apiKey: string,
  model: string,
  userMessage: string,
  assistantMessage: string,
): Promise<ExtractionResult | null> {
  try {
    const response: OpenRouterCallResult = await callOpenRouter({
      apiKey,
      model,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        {
          role: "user",
          content: `Agent's prior message:\n${assistantMessage.slice(0, 1000)}\n\nUser's correction:\n${userMessage.slice(0, 1000)}`,
        },
      ],
      max_completion_tokens: 300,
      temperature: 0,
    });

    // Parse the response — expect JSON
    const content = typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
      ? (response.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";

    // Extract JSON from response (may have markdown fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      what?: string;
      why?: string;
      fix?: string;
      pattern?: string;
    };

    if (!parsed.what || !parsed.fix) return null;

    return {
      lesson: {
        what: parsed.what,
        why: parsed.why ?? "",
        fix: parsed.fix,
        neverCompress: true, // Lessons always survive summarization
      },
      pattern: parsed.pattern && parsed.pattern !== "none" ? parsed.pattern : null,
    };
  } catch {
    return null;
  }
}

// ── Full pipeline ────────────────────────────────────────────────────────────

/**
 * Process a potential correction: detect, extract, and persist.
 *
 * Call this after each user message in the agent loop when identityId is set.
 * Runs asynchronously — does not block the turn.
 *
 * @returns true if a lesson was extracted and saved
 */
export async function processCorrection(
  identityId: string,
  apiKey: string,
  model: string,
  userMessage: string,
  lastAssistantMessage: string,
): Promise<boolean> {
  // Step 1: Heuristic detection
  const signal = detectCorrection(userMessage);
  if (!signal) return false;

  // Step 2: LLM extraction
  const result = await extractLesson(apiKey, model, userMessage, lastAssistantMessage);
  if (!result) return false;

  // Step 3: Append lesson to lessons.md
  try {
    appendLesson(identityId, result.lesson);
  } catch {
    return false;
  }

  // Step 4: Append pattern to patterns.md (if extracted)
  if (result.pattern) {
    try {
      const identity = loadIdentity(identityId);
      if (identity) {
        const existingPatterns = identity.patterns.trim();
        const date = new Date().toISOString().slice(0, 10);
        const newEntry = `\n## ${date} — ${result.lesson.what.slice(0, 60)}\n${result.pattern}\n`;
        const updatedPatterns = existingPatterns
          ? existingPatterns + "\n" + newEntry
          : newEntry.trim();
        updateIdentityFile(identityId, "patterns.md", updatedPatterns + "\n");
      }
    } catch {
      // Non-fatal — lesson was already saved
    }
  }

  return true;
}
