/**
 * LLM-as-judge — Phase 3 of the prompt refinement pipeline.
 *
 * Scores agent outputs against a successCriteria string using a separate
 * LLM evaluator. Based on findings from:
 *   - MT-Bench (Zheng et al. 2023): GPT-4 judge achieves >80% human agreement
 *   - Promptfoo llm-rubric: {reason, score, pass} output schema
 *   - MT-Bench guidance: binary pass/fail is more reliable than 1-10 scales;
 *     splitting dimensions reduces compositionality errors
 *
 * Design decisions:
 *   - temperature=0 for consistency (same input → same judgment)
 *   - doubleCheck=true runs a second call at temp=0.2 and flags disagreements
 *   - Explicitly instructs against verbosity bias (longer ≠ better)
 *   - successCriteria is the reference answer — its presence is required
 *   - No streaming — single non-streaming call, simpler error handling
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JudgeResult {
  /** Whether the agent output passes the task. Primary signal. */
  pass: boolean;
  /** Normalised score 0.0–1.0 (average of three sub-dimensions). */
  score: number;
  /** 2-3 sentence explanation of the judgment. */
  reason: string;
  /**
   * false when two independent judge calls disagree on pass/fail.
   * Use as a reliability signal — low-confidence results should be
   * down-weighted in aggregate statistics.
   */
  confident: boolean;
  /** Raw sub-scores for diagnostics. */
  dimensions: {
    taskCompletion: number;  // 0-10: did the agent do what was asked?
    accuracy: number;        // 0-10: is the information correct?
    helpfulness: number;     // 0-10: would a real user find this useful?
  };
}

export interface JudgeConfig {
  /** OpenRouter model to use as the judge. Default: deepseek-chat-v3-0324:free */
  model?: string;
  /** OpenRouter API key */
  apiKey: string;
  /** Sampling temperature. Default: 0 for determinism. */
  temperature?: number;
  /**
   * Run a second call at temp=0.2 and set confident=false if pass disagrees.
   * Adds one extra API call per judgment. Default: false.
   */
  doubleCheck?: boolean;
}

const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-chat-v3-0324:free";

// ── Prompt template ───────────────────────────────────────────────────────────

function buildJudgePrompt(
  taskPrompt: string,
  successCriteria: string,
  agentOutput: string,
): string {
  return `You are an impartial evaluator scoring an AI agent's response to a task.

## Task given to the agent
${taskPrompt}

## Success criteria
${successCriteria}

## Agent's response
${agentOutput}

---

Evaluate the response on these three dimensions (0-10 each):
- task_completion: Did the agent fully address what was asked?
- accuracy: Is the information correct, grounded, and free of fabrication?
- helpfulness: Would a real user find this response useful and actionable?

Important rules:
- Do NOT favour longer responses. Length is not quality.
- If the agent says "I cannot find X" when X does not exist, that is correct — mark it as passing.
- Fabricating specific facts, file contents, or numbers is always a failure.
- A score of 6 or above on each dimension means the response passes overall.

Respond with ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "task_completion": <0-10>,
  "accuracy": <0-10>,
  "helpfulness": <0-10>,
  "pass": <true|false>,
  "score": <0.0-1.0>,
  "reason": "<2-3 sentences explaining your judgment>"
}`;
}

// ── HTTP call ─────────────────────────────────────────────────────────────────

interface RawJudgeResponse {
  task_completion: number;
  accuracy: number;
  helpfulness: number;
  pass: boolean;
  score: number;
  reason: string;
}

async function callJudge(
  prompt: string,
  model: string,
  apiKey: string,
  temperature: number,
): Promise<RawJudgeResponse> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/JayCodesX/orager",
      "X-Title": "orager-judge",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Judge API ${res.status}: ${body}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("Empty response from judge model");

  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();

  try {
    return JSON.parse(cleaned) as RawJudgeResponse;
  } catch {
    throw new Error(`Judge returned invalid JSON:\n${cleaned.slice(0, 300)}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score an agent output against a task and its success criteria.
 *
 * @param taskPrompt     The original prompt given to the agent
 * @param successCriteria  What a correct response looks like (from GeneratedTask)
 * @param agentOutput    The agent's full text response
 * @param config         Judge model, API key, and options
 */
export async function judgeOutput(
  taskPrompt: string,
  successCriteria: string,
  agentOutput: string,
  config: JudgeConfig,
): Promise<JudgeResult> {
  const model = config.model ?? DEFAULT_JUDGE_MODEL;
  const temperature = config.temperature ?? 0;
  const prompt = buildJudgePrompt(taskPrompt, successCriteria, agentOutput);

  const first = await callJudge(prompt, model, config.apiKey, temperature);

  let confident = true;

  if (config.doubleCheck) {
    try {
      const second = await callJudge(prompt, model, config.apiKey, 0.2);
      confident = first.pass === second.pass;
    } catch {
      // Double-check is best-effort — don't fail the whole judgment
      confident = false;
    }
  }

  const avg = (first.task_completion + first.accuracy + first.helpfulness) / 30;

  return {
    pass: first.pass,
    score: typeof first.score === "number" ? Math.max(0, Math.min(1, first.score)) : avg,
    reason: first.reason ?? "",
    confident,
    dimensions: {
      taskCompletion: first.task_completion ?? 0,
      accuracy: first.accuracy ?? 0,
      helpfulness: first.helpfulness ?? 0,
    },
  };
}

/**
 * Score a batch of (task, output) pairs sequentially.
 * Returns null for any item that fails (network error, bad JSON) rather
 * than throwing — callers should treat null as "unscored".
 */
export async function judgeOutputBatch(
  items: Array<{
    taskId: string;
    taskPrompt: string;
    successCriteria: string;
    agentOutput: string;
  }>,
  config: JudgeConfig,
): Promise<Array<{ taskId: string; result: JudgeResult | null }>> {
  const results: Array<{ taskId: string; result: JudgeResult | null }> = [];

  for (const item of items) {
    try {
      const result = await judgeOutput(
        item.taskPrompt,
        item.successCriteria,
        item.agentOutput,
        config,
      );
      results.push({ taskId: item.taskId, result });
    } catch (err) {
      console.error(`[judge] ${item.taskId} failed: ${err instanceof Error ? err.message : err}`);
      results.push({ taskId: item.taskId, result: null });
    }
  }

  return results;
}

/**
 * Format a JudgeResult for console output.
 */
export function formatJudgeResult(taskId: string, r: JudgeResult): string {
  const dims = `TC=${r.dimensions.taskCompletion} ACC=${r.dimensions.accuracy} HLP=${r.dimensions.helpfulness}`;
  const conf = r.confident ? "" : " ⚠️ low confidence";
  return `[judge] ${taskId} pass=${r.pass} score=${r.score.toFixed(2)} ${dims}${conf}\n  reason: ${r.reason}`;
}
