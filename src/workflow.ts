/**
 * runAgentWorkflow — sequential & parallel multi-agent orchestration.
 *
 * Executes an AgentWorkflow step by step. Each step is either:
 *   - A single AgentConfig — runs sequentially
 *   - A ParallelGroup — runs all agents concurrently via Promise.all
 *
 * The output of each step is passed to the next via the optional handoff
 * function (default: pass-through). For parallel groups, outputs are joined
 * with `\n---\n` before handoff.
 */

import { runAgentLoop } from "./loop.js";
import type {
  AgentConfig,
  AgentLoopOptions,
  AgentWorkflow,
  EmitEvent,
  ParallelGroup,
  WorkflowStep,
} from "./types.js";

/** Type guard for ParallelGroup. */
function isParallelGroup(step: WorkflowStep): step is ParallelGroup {
  return "parallel" in step && Array.isArray((step as ParallelGroup).parallel);
}

/**
 * Build a full AgentLoopOptions from the workflow base config and a step config,
 * capturing the step's text output into `outputRef`.
 */
function buildStepOpts(
  base: AgentWorkflow["base"],
  step: AgentConfig,
  prompt: string,
  outputRef: { text: string },
): AgentLoopOptions {
  const collectingOnEmit = (event: EmitEvent) => {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") outputRef.text += block.text;
      }
    }
    base.onEmit(event);
  };

  return {
    ...base,
    model: step.model,
    prompt,
    onEmit: collectingOnEmit,
    ...(step.appendSystemPrompt !== undefined && { appendSystemPrompt: step.appendSystemPrompt }),
    ...(step.temperature !== undefined && { temperature: step.temperature }),
    ...(step.memoryKey !== undefined && { memoryKey: step.memoryKey }),
    ...(step.maxTurns !== undefined && { maxTurns: step.maxTurns }),
    ...(step.maxCostUsd !== undefined && { maxCostUsd: step.maxCostUsd }),
    siteName: step.role,
  };
}

/**
 * Run a single sequential step. Returns the step's text output.
 */
async function runSequentialStep(
  base: AgentWorkflow["base"],
  step: AgentConfig,
  prompt: string,
  stepIndex: number,
): Promise<string> {
  const outputRef = { text: "" };
  const opts = buildStepOpts(base, step, prompt, outputRef);

  try {
    await runAgentLoop(opts);
  } catch (err) {
    throw new Error(
      `Workflow step ${stepIndex} ("${step.role}") failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return outputRef.text;
}

/**
 * Run a parallel group. All agents receive the same prompt and execute
 * concurrently. Returns their outputs joined with `\n---\n`.
 */
async function runParallelStep(
  base: AgentWorkflow["base"],
  group: ParallelGroup,
  prompt: string,
  stepIndex: number,
): Promise<string> {
  const agents = group.parallel;
  if (agents.length === 0) return "";

  const results = await Promise.all(
    agents.map(async (agent) => {
      const outputRef = { text: "" };
      const opts = buildStepOpts(base, agent, prompt, outputRef);
      try {
        await runAgentLoop(opts);
      } catch (err) {
        throw new Error(
          `Workflow step ${stepIndex} parallel agent ("${agent.role}") failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return outputRef.text;
    }),
  );

  return results.join("\n---\n");
}

/**
 * Run a multi-agent workflow with sequential and parallel steps.
 *
 * @param workflow - The workflow definition (base config + ordered steps).
 * @param initialPrompt - The prompt for the first step.
 */
export async function runAgentWorkflow(
  workflow: AgentWorkflow,
  initialPrompt: string,
): Promise<void> {
  const { base, steps, handoff } = workflow;

  if (steps.length === 0) return;

  let currentPrompt = initialPrompt;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    const stepOutput = isParallelGroup(step)
      ? await runParallelStep(base, step, currentPrompt, i)
      : await runSequentialStep(base, step, currentPrompt, i);

    // Prepare the prompt for the next step unless this was the last one.
    if (i < steps.length - 1) {
      currentPrompt = handoff ? handoff(i, stepOutput) : stepOutput;
    }
  }
}
