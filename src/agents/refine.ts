/**
 * Prompt refinement — variant generation and A/B feedback loop.
 *
 * Generates templated prompt mutations for a given agent's seed prompt,
 * assigns variants for scoring, and promotes winners back into the live
 * agent registry once sufficient evidence is collected.
 *
 * All string transforms are PURE (no LLM calls). Only `getBestVariant` and
 * `promoteBestVariant` touch the database.
 */

import type { SqliteDatabase } from "../native-sqlite.js";
import { getVariantStats, getVariantJudgeStats } from "./score.js";
import { upsertAgent } from "./registry.js";
import type { AgentDefinition } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type VariantStrategy =
  | "original"
  | "concise"
  | "chain_of_thought"
  | "role_emphasis"
  | "output_format"
  | "constraint_relax"
  | "examples"
  // Research-backed additions (EmotionPrompt, OPRO, Anthropic, Wang et al.)
  | "emotional_stimulus"
  | "opro_trigger"
  | "xml_structure"
  | "self_consistency"
  | "numbered_constraints";

export interface PromptVariant {
  variantId: string;
  agentId: string;
  prompt: string;
  strategy: VariantStrategy;
  parentVariantId: string | null; // null = derived from seed
}

// ── Strategy implementations ──────────────────────────────────────────────────

function applyOriginal(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v0-original`,
    agentId,
    prompt,
    strategy: "original",
    parentVariantId: null,
  };
}

function applyConcise(agentId: string, prompt: string): PromptVariant {
  // Remove sentences containing common filler openers
  const fillerSentencePatterns = [
    /[^.!?]*\bPlease\s[^.!?]*[.!?]/g,
    /[^.!?]*\bNote that\b[^.!?]*[.!?]/g,
    /[^.!?]*\bAlways remember\b[^.!?]*[.!?]/g,
  ];
  let result = prompt;
  for (const pattern of fillerSentencePatterns) {
    result = result.replace(pattern, "");
  }

  // Strip leading filler phrases from each line
  const fillerPhrases = [
    /^Your job is to\s+/i,
    /^It is your responsibility to\s+/i,
  ];
  const lines = result.split("\n").map((line) => {
    let l = line;
    for (const phrase of fillerPhrases) {
      l = l.replace(phrase, "");
    }
    return l;
  });
  result = lines.join("\n");

  // Trim to first 80% of content (by character count)
  const cutoff = Math.ceil(result.length * 0.8);
  result = result.slice(0, cutoff).trimEnd();

  return {
    variantId: `${agentId}-v1-concise`,
    agentId,
    prompt: result,
    strategy: "concise",
    parentVariantId: null,
  };
}

function applyChainOfThought(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v2-cot`,
    agentId,
    prompt: `Before responding, think through the problem step by step.\n\n${prompt}`,
    strategy: "chain_of_thought",
    parentVariantId: null,
  };
}

function applyRoleEmphasis(agentId: string, prompt: string): PromptVariant {
  // Replace the first sentence (up to first ".") with a strengthened version
  const firstDot = prompt.indexOf(".");
  if (firstDot === -1) {
    // No sentence boundary found — prepend the phrase to the whole prompt
    return {
      variantId: `${agentId}-v3-role`,
      agentId,
      prompt: `You are a world-class expert ${prompt}`,
      strategy: "role_emphasis",
      parentVariantId: null,
    };
  }
  const firstSentence = prompt.slice(0, firstDot + 1);
  const rest = prompt.slice(firstDot + 1);
  return {
    variantId: `${agentId}-v3-role`,
    agentId,
    prompt: `You are a world-class expert ${firstSentence}${rest}`,
    strategy: "role_emphasis",
    parentVariantId: null,
  };
}

function applyOutputFormat(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v4-format`,
    agentId,
    prompt: `${prompt}\n\nStructure your response with: 1) a one-line summary, 2) detailed findings, 3) a confidence level (high/medium/low).`,
    strategy: "output_format",
    parentVariantId: null,
  };
}

function applyConstraintRelax(agentId: string, prompt: string): PromptVariant {
  const lines = prompt.split("\n").map((line) => {
    if (/\bDo not\b/.test(line) || /\bOnly\b/.test(line)) {
      return line + " unless strictly necessary";
    }
    return line;
  });
  return {
    variantId: `${agentId}-v5-relax`,
    agentId,
    prompt: lines.join("\n"),
    strategy: "constraint_relax",
    parentVariantId: null,
  };
}

function applyExamples(agentId: string, prompt: string): PromptVariant {
  const exampleBlock =
    "\n\nExample of good output:\n[Task]: Find all exported functions in a file\n[Output]: Found 3 exports: recordAgentScore, getAgentStats, getAllAgentStats. Each is an async function.";
  return {
    variantId: `${agentId}-v6-examples`,
    agentId,
    prompt: `${prompt}${exampleBlock}`,
    strategy: "examples",
    parentVariantId: null,
  };
}

// ── Research-backed additions ──────────────────────────────────────────────────

/**
 * EmotionPrompt (CAS + Microsoft, 2023) — appending an emotional stimulus
 * improves instruction-following by up to 115% on BIG-Bench tasks.
 * "This is very important to my career." was the top-performing phrase.
 */
function applyEmotionalStimulus(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v7-emotion`,
    agentId,
    prompt: `${prompt}\n\nThis is very important to my career.`,
    strategy: "emotional_stimulus",
    parentVariantId: null,
  };
}

/**
 * OPRO trigger (Google DeepMind, 2023) — outperforms plain CoT.
 * Found to improve GSM8K by 8% and Big-Bench Hard by up to 50%.
 * Different from chain_of_thought which prepends; this appends a calming
 * step-by-step directive discovered by automated prompt optimisation.
 */
function applyOproTrigger(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v8-opro`,
    agentId,
    prompt: `${prompt}\n\nTake a deep breath and work on this step-by-step.`,
    strategy: "opro_trigger",
    parentVariantId: null,
  };
}

/**
 * XML structural wrapping (Anthropic best-practices) — segments prompt into
 * typed blocks, reducing misinterpretation of which text is which.
 */
function applyXmlStructure(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v9-xml`,
    agentId,
    prompt:
      `<instructions>\n${prompt}\n</instructions>\n\n` +
      `<output_format>Lead with the direct answer. Follow with supporting details. Be concise.</output_format>`,
    strategy: "xml_structure",
    parentVariantId: null,
  };
}

/**
 * Self-consistency suffix (Wang et al., 2022 + Anthropic) — asking the model
 * to verify its answer before responding reduces careless errors.
 */
function applySelfConsistency(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v10-self_check`,
    agentId,
    prompt: `${prompt}\n\nBefore finalising your response, verify it is complete and directly answers what was asked.`,
    strategy: "self_consistency",
    parentVariantId: null,
  };
}

/**
 * Numbered constraints — converts implicit prose rules into an explicit
 * numbered list appended after the main instruction. Helps the model
 * attend to each constraint individually rather than treating them as
 * a single undifferentiated block.
 */
function applyNumberedConstraints(agentId: string, prompt: string): PromptVariant {
  return {
    variantId: `${agentId}-v11-numbered`,
    agentId,
    prompt:
      `${prompt}\n\nKey constraints:\n` +
      `1. Answer only what is asked — no unrequested commentary.\n` +
      `2. Be precise and specific in every claim.\n` +
      `3. If uncertain, say so explicitly rather than guessing.`,
    strategy: "numbered_constraints",
    parentVariantId: null,
  };
}

const STRATEGY_HANDLERS: Record<
  VariantStrategy,
  (agentId: string, prompt: string) => PromptVariant
> = {
  original: applyOriginal,
  concise: applyConcise,
  chain_of_thought: applyChainOfThought,
  role_emphasis: applyRoleEmphasis,
  output_format: applyOutputFormat,
  constraint_relax: applyConstraintRelax,
  examples: applyExamples,
  emotional_stimulus: applyEmotionalStimulus,
  opro_trigger: applyOproTrigger,
  xml_structure: applyXmlStructure,
  self_consistency: applySelfConsistency,
  numbered_constraints: applyNumberedConstraints,
};

const ALL_NON_ORIGINAL_STRATEGIES: VariantStrategy[] = [
  "concise",
  "chain_of_thought",
  "role_emphasis",
  "output_format",
  "constraint_relax",
  "examples",
  "emotional_stimulus",
  "opro_trigger",
  "xml_structure",
  "self_consistency",
  "numbered_constraints",
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate N+1 variants from a seed prompt (original + N strategy mutations).
 * "original" is always included as variant 0.
 * If `strategies` is not provided, uses all non-original strategies.
 */
export function generatePromptVariants(
  agentId: string,
  seedPrompt: string,
  strategies?: VariantStrategy[],
): PromptVariant[] {
  const effectiveStrategies = strategies ?? ALL_NON_ORIGINAL_STRATEGIES;

  const variants: PromptVariant[] = [
    applyOriginal(agentId, seedPrompt),
  ];

  for (const strategy of effectiveStrategies) {
    if (strategy === "original") continue; // original already included above
    const handler = STRATEGY_HANDLERS[strategy];
    variants.push(handler(agentId, seedPrompt));
  }

  return variants;
}

// ── Seeded RNG ────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Randomly assigns one variant from the list.
 * Uses a seeded RNG if provided (for reproducibility in tests), otherwise
 * falls back to Math.random.
 */
export function assignVariant(
  agentId: string,
  variants: PromptVariant[],
  rng?: () => number,
): PromptVariant {
  if (variants.length === 0) {
    throw new Error(`assignVariant: no variants provided for agent "${agentId}"`);
  }
  const rand = rng ?? Math.random;
  const idx = Math.floor(rand() * variants.length);
  return variants[idx];
}

/**
 * Create a seeded RNG using the mulberry32 algorithm.
 * Useful for deterministic tests.
 */
export function createSeededRng(seed: number): () => number {
  return mulberry32(seed);
}

// ── Confidence-weighted scoring (PR 8) ───────────────────────────────────────

/**
 * Wilson score lower bound for a binomial proportion (95% confidence interval).
 *
 * This gives a statistically principled score that shrinks toward 0 for
 * low-sample variants and converges to the raw success rate as n → ∞.
 * Using the lower bound instead of the raw rate means a variant needs more
 * evidence to displace the incumbent — preventing spurious promotions.
 *
 * Formula: (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
 * where z = 1.96 (95% CI), p̂ = observed success rate, n = total runs.
 *
 * @param successes  Number of successful runs
 * @param n          Total number of runs
 * @param z          z-score for desired confidence level (default 1.96 → 95%)
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;
  return Math.max(0, numerator / denominator);
}

/**
 * Composite confidence score blending the Wilson lower bound (binary success)
 * with the average LLM-as-judge score when available.
 *
 * Judge scores capture semantic quality not reflected in binary pass/fail —
 * e.g. a response can pass a keyword check but still be verbose or confusing.
 * Weighting: 70% Wilson bound + 30% judge average (when judge data exists).
 *
 * @param successes   Number of successful runs
 * @param n           Total runs
 * @param judgeAvg    Average LLM-as-judge score [0,1], or null if unavailable
 */
export function compositeScore(
  successes: number,
  n: number,
  judgeAvg: number | null,
): number {
  const wilson = wilsonLowerBound(successes, n);
  if (judgeAvg == null) return wilson;
  return 0.7 * wilson + 0.3 * judgeAvg;
}

// ── Promotion thresholds ──────────────────────────────────────────────────────

/** Minimum runs required before a variant is eligible for promotion. */
export const PROMOTION_MIN_RUNS = 5;

/**
 * Minimum composite-score margin above the original's composite score
 * required to trigger promotion. Using composite scores (Wilson + judge)
 * means the bar is expressed in the same confidence-adjusted units.
 */
export const PROMOTION_MARGIN = 0.05;

// ── Best variant selection ────────────────────────────────────────────────────

/**
 * Returns the best non-original variant for the given agent, or null if no
 * variant clears the confidence-weighted promotion threshold.
 *
 * Selection algorithm (PR 8):
 *  1. Compute each variant's composite score:
 *       compositeScore = 0.7 × Wilson95LowerBound + 0.3 × avgJudgeScore
 *     (judge weight drops to 0 when no judge data exists → pure Wilson)
 *  2. Require PROMOTION_MIN_RUNS (5) runs for both the candidate and the
 *     original before either is eligible. This prevents cold-start flukes.
 *  3. Promote the highest-scoring non-original variant only if its composite
 *     score exceeds the original's by at least PROMOTION_MARGIN (0.05).
 */
export async function getBestVariant(
  db: SqliteDatabase,
  agentId: string,
  variants: PromptVariant[],
): Promise<PromptVariant | null> {
  const stats = getVariantStats(db, agentId);
  if (stats.length === 0) return null;

  const judgeStats = getVariantJudgeStats(db, agentId);

  const originalId = `${agentId}-v0-original`;
  const originalStat = stats.find((s) => s.variantId === originalId);

  // Original needs enough runs to establish a reliable baseline
  if (!originalStat || originalStat.runs < PROMOTION_MIN_RUNS) return null;

  const originalSuccesses = Math.round(originalStat.successRate * originalStat.runs);
  const originalScore = compositeScore(
    originalSuccesses,
    originalStat.runs,
    judgeStats.get(originalId) ?? null,
  );

  let bestVariant: PromptVariant | null = null;
  let bestScore = -Infinity;

  for (const stat of stats) {
    if (stat.variantId === originalId) continue;
    if (stat.runs < PROMOTION_MIN_RUNS) continue;

    const successes = Math.round(stat.successRate * stat.runs);
    const score = compositeScore(
      successes,
      stat.runs,
      judgeStats.get(stat.variantId) ?? null,
    );

    if (score > bestScore) {
      bestScore = score;
      bestVariant = variants.find((v) => v.variantId === stat.variantId) ?? null;
    }
  }

  if (!bestVariant) return null;

  // Promote only if the candidate's confidence-adjusted score clears the margin
  if (bestScore > originalScore + PROMOTION_MARGIN) {
    return bestVariant;
  }

  return null;
}

// ── Promotion ─────────────────────────────────────────────────────────────────

export interface PromotionResult {
  promoted: boolean;
  variantId?: string;
  reason: string;
}

/**
 * Calls getBestVariant. If a winner is found, updates the live agent registry
 * with the winning prompt. Returns a result describing what happened.
 */
export async function promoteBestVariant(
  db: SqliteDatabase,
  agentId: string,
  variants: PromptVariant[],
  agents: Record<string, AgentDefinition>,
): Promise<PromotionResult> {
  const winner = await getBestVariant(db, agentId, variants);

  if (!winner) {
    const stats = getVariantStats(db, agentId);
    const hasEnoughData = stats.some((s) => s.runs >= PROMOTION_MIN_RUNS);
    return {
      promoted: false,
      reason: hasEnoughData
        ? `No variant beats original by >${(PROMOTION_MARGIN * 100).toFixed(0)}% (confidence-adjusted)`
        : `Insufficient data (need ≥${PROMOTION_MIN_RUNS} runs per variant)`,
    };
  }

  const currentDef = agents[agentId];
  if (!currentDef) {
    return {
      promoted: false,
      reason: `Agent "${agentId}" not found in registry`,
    };
  }

  await upsertAgent(agentId, { ...currentDef, prompt: winner.prompt });

  return {
    promoted: true,
    variantId: winner.variantId,
    reason: `Promoted variant "${winner.variantId}" with superior success rate`,
  };
}

// ── Serialization helpers ─────────────────────────────────────────────────────

/** Serialize a PromptVariant to a JSON string. */
export function serializeVariant(v: PromptVariant): string {
  return JSON.stringify(v);
}

/** Deserialize a PromptVariant from a JSON string. Throws on invalid input. */
export function deserializeVariant(s: string): PromptVariant {
  const parsed = JSON.parse(s) as Partial<PromptVariant>;
  if (
    typeof parsed.variantId !== "string" ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.prompt !== "string" ||
    typeof parsed.strategy !== "string"
  ) {
    throw new Error("deserializeVariant: missing required fields");
  }
  return {
    variantId: parsed.variantId,
    agentId: parsed.agentId,
    prompt: parsed.prompt,
    strategy: parsed.strategy as VariantStrategy,
    parentVariantId: parsed.parentVariantId ?? null,
  };
}
