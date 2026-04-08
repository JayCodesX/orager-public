/**
 * CLI `orager run` subcommand handler (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts.
 * Non-interactive: run the agent once with a given prompt and exit.
 *
 * Sprint 10: full flag parity with the main() chat path — all opts.* fields
 * and G.__orager* globals forwarded to runAgentLoop, plus systemPromptFile,
 * toolsFiles, profile, reasoning, and provider routing.
 *
 * PR 7: Production score recording.
 * When ORAGER_RECORD_SCORES=1, each `orager run` records a row in the agents
 * DB so real user runs contribute to the prompt-variant tournament alongside
 * CI benchmark scores. When --agent-id matches a seed agent, an epsilon-greedy
 * variant is selected (exploit best-known variant 80%, explore randomly 20%).
 */

import fs from "node:fs/promises";
import { runAgentLoop } from "../loop.js";
import { emit } from "../emit.js";
import { parseArgs, readStdin } from "../cli/parse-args.js";
import { makeCliOnEmit, collectPositionals, extractFlag } from "./cli-helpers.js";
import { createTrajectoryLogger, pruneOldTrajectories } from "../trajectory-logger.js";
import { extractSkillFromTrajectory, trajectoryPath, DEFAULT_SKILLBANK_CONFIG } from "../skillbank.js";
import { applyProfileAsync } from "../profiles.js";
import { loadToolsFromFile } from "../tools/load-tools.js";
import type { AgentLoopOptions, TurnModelRule, UserMessageContentBlock } from "../types.js";
import { recordProductionScore } from "../agents/score.js";
import { SEED_AGENTS } from "../agents/seeds.js";
import {
  generatePromptVariants,
  assignVariant,
  getBestVariant,
  type PromptVariant,
} from "../agents/refine.js";
import { getAgentsDb } from "../agents/registry.js";

export async function handleRunCommand(
  runArgv: string[],
  deps: {
    releaseCliPidLock: () => Promise<void>;
    setInterruptSessionId: (id: string) => void;
  },
): Promise<void> {
  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    process.stderr.write("orager: API key not set. Export PROTOCOL_API_KEY.\n");
    process.exit(1);
  }

  const opts = parseArgs(runArgv);
  const memoryKey = extractFlag(runArgv, "--memory-key");
  const subprocessEnabled = runArgv.includes("--subprocess");

  const positionals = collectPositionals(runArgv);
  let prompt = positionals.join(" ").trim();

  if (!prompt) {
    if (!process.stdin.isTTY) {
      prompt = await readStdin();
    } else {
      process.stderr.write(
        "orager run: provide a prompt argument or pipe it via stdin\n" +
        "  Example: orager run \"write a hello world script\"\n",
      );
      process.exit(1);
    }
  }

  prompt = prompt.trim();
  if (!prompt) {
    process.stderr.write("orager run: empty prompt\n");
    process.exit(1);
  }

  if (opts.sessionId) deps.setInterruptSessionId(opts.sessionId);

  // ── Load extra tools from --tools-file ──────────────────────────────────────
  const extraTools: AgentLoopOptions["extraTools"] = [];
  for (const f of opts.toolsFiles) {
    try {
      const tools = await loadToolsFromFile(f);
      extraTools.push(...tools);
    } catch (err) {
      process.stderr.write(`orager: warning: could not load tools file "${f}": ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // ── Read optional system prompt file ────────────────────────────────────────
  let appendSystemPrompt: string | undefined;
  if (opts.systemPromptFile) {
    try {
      appendSystemPrompt = await fs.readFile(opts.systemPromptFile, "utf8");
    } catch (err) {
      process.stderr.write(`orager: warning: could not read --system-prompt-file "${opts.systemPromptFile}": ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // ── Build reasoning / provider routing objects ───────────────────────────────
  const reasoning = (opts.reasoningEffort || opts.reasoningMaxTokens || opts.reasoningExclude)
    ? {
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
        ...(opts.reasoningMaxTokens ? { max_tokens: opts.reasoningMaxTokens } : {}),
        ...(opts.reasoningExclude ? { exclude: true } : {}),
      }
    : undefined;

  const provider = (opts.providerOrder || opts.providerIgnore || opts.providerOnly ||
    opts.dataCollection || opts.zdr || opts.sort || opts.quantizations || opts.require_parameters)
    ? {
        ...(opts.providerOrder ? { order: opts.providerOrder } : {}),
        ...(opts.providerIgnore ? { ignore: opts.providerIgnore } : {}),
        ...(opts.providerOnly ? { only: opts.providerOnly } : {}),
        ...(opts.dataCollection ? { data_collection: opts.dataCollection } : {}),
        ...(opts.zdr ? { zdr: true } : {}),
        ...(opts.sort ? { sort: opts.sort } : {}),
        ...(opts.quantizations ? { quantizations: opts.quantizations } : {}),
        ...(opts.require_parameters ? { require_parameters: true } : {}),
      }
    : undefined;

  // ── Merge G.__orager* globals (set by config file expansion) ────────────────
  const G = globalThis as Record<string, unknown>;

  const trajLogger = createTrajectoryLogger(prompt, opts.model, process.cwd());
  const baseOnEmit = makeCliOnEmit(emit);
  const wrappedOnEmit = (event: Parameters<typeof baseOnEmit>[0]) => {
    trajLogger.onEvent(event);
    baseOnEmit(event);
  };

  let _runSubtype = "unknown";
  let _runSessionId: string | null = opts.sessionId;
  let _runTurns = 0;
  let _runCostUsd = 0;
  const resultTrackingEmit = (event: Parameters<typeof baseOnEmit>[0]) => {
    if (event.type === "result") {
      _runSubtype = event.subtype;
      _runSessionId = event.session_id;
      _runTurns = event.turnCount ?? 0;
      _runCostUsd = event.total_cost_usd ?? 0;
    } else if (event.type === "system" && event.subtype === "init") {
      _runSessionId = event.session_id;
    }
    wrappedOnEmit(event);
  };

  // ── Epsilon-greedy variant selection for seed agents (PR 7) ─────────────────
  // When --agent-id names a seed agent and ORAGER_RECORD_SCORES=1, pick the
  // best-known prompt variant 80% of the time (exploit) and a random variant
  // 20% of the time (explore). The chosen variant's system prompt is appended
  // to the run so production scores feed the tournament alongside CI data.
  let _selectedVariant: PromptVariant | null = null;
  const _agentId = opts.agentId ?? null;
  const _seedDef = _agentId ? SEED_AGENTS[_agentId] ?? null : null;
  const _recordScores = process.env["ORAGER_RECORD_SCORES"] === "1";

  if (_recordScores && _agentId && _seedDef) {
    const variants = generatePromptVariants(_agentId, _seedDef.prompt ?? "");
    const explore = Math.random() < 0.20; // 20% exploration rate
    if (explore) {
      _selectedVariant = assignVariant(_agentId, variants);
    } else {
      // Try to exploit the best-known variant; fall back to random if insufficient data.
      const db = await getAgentsDb().catch(() => null);
      const best = db ? await getBestVariant(db, _agentId, variants).catch(() => null) : null;
      _selectedVariant = best ?? assignVariant(_agentId, variants);
    }
    // Append the variant's system prompt on top of the default system prompt.
    // This transforms the agent's behaviour without overwriting any user-supplied
    // --system-prompt-file content (appendSystemPrompt is appended after it).
    appendSystemPrompt = _selectedVariant.prompt +
      (appendSystemPrompt ? "\n\n" + appendSystemPrompt : "");
  }

  const retentionDays = DEFAULT_SKILLBANK_CONFIG.retentionDays;
  pruneOldTrajectories(retentionDays).catch(() => { /* non-fatal */ });

  // ── Build full loop options (parity with main() chat path) ──────────────────
  let loopOpts: AgentLoopOptions = {
    prompt,
    model: opts.model,
    apiKey,
    sessionId: opts.sessionId,
    addDirs: opts.addDirs,
    maxTurns: opts.maxTurns,
    maxRetries: opts.maxRetries,
    forceResume: opts.forceResume,
    cwd: process.cwd(),
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    verbose: opts.verbose,
    onEmit: resultTrackingEmit,
    onLog: (stream, chunk) => {
      if (stream === "stderr") process.stderr.write(chunk);
    },
    models: opts.models.length > 0 ? opts.models : undefined,
    sandboxRoot: opts.sandboxRoot,
    extraTools: extraTools.length > 0 ? extraTools : undefined,
    requireApproval: opts.requireApproval,
    useFinishTool: opts.useFinishTool,
    maxCostUsd: opts.maxCostUsd,
    costQuota: opts.costQuota,
    costPerInputToken: opts.costPerInputToken,
    costPerOutputToken: opts.costPerOutputToken,
    siteUrl: opts.siteUrl,
    siteName: opts.siteName,
    temperature: opts.temperature,
    top_p: opts.top_p,
    top_k: opts.top_k,
    frequency_penalty: opts.frequency_penalty,
    presence_penalty: opts.presence_penalty,
    repetition_penalty: opts.repetition_penalty,
    min_p: opts.min_p,
    seed: opts.seed,
    stop: opts.stop,
    tool_choice: opts.tool_choice,
    parallel_tool_calls: opts.parallel_tool_calls,
    reasoning,
    provider,
    transforms: opts.transforms,
    preset: opts.preset,
    appendSystemPrompt,
    summarizeAt: opts.summarizeAt,
    summarizeModel: opts.summarizeModel,
    summarizeKeepRecentTurns: opts.summarizeKeepRecentTurns,
    visionModel: opts.visionModel,
    turnModelRules: G.__oragerTurnModelRules as TurnModelRule[] | undefined,
    promptContent: G.__oragerPromptContent as UserMessageContentBlock[] | undefined,
    approvalAnswer: (G.__oragerApprovalAnswer as { choiceKey: string; toolCallId: string } | null | undefined) ?? opts.approvalAnswer ?? null,
    approvalMode: (G.__oragerApprovalMode as "tty" | "question" | undefined) ?? opts.approvalMode,
    settingsFile: opts.settingsFile,
    mcpServers: G.__oragerMcpServers as AgentLoopOptions["mcpServers"] | undefined,
    requireMcpServers: G.__oragerRequireMcpServers as string[] | undefined,
    toolTimeouts: G.__oragerToolTimeouts as Record<string, number> | undefined,
    maxSpawnDepth: (G.__oragerMaxSpawnDepth as number | undefined) ?? opts.maxSpawnDepth,
    maxIdenticalToolCallTurns: (G.__oragerMaxIdenticalToolCallTurns as number | undefined) ?? opts.maxIdenticalToolCallTurns,
    toolErrorBudgetHardStop: (G.__oragerToolErrorBudgetHardStop as boolean | undefined) ?? opts.toolErrorBudgetHardStop,
    response_format: G.__oragerResponseFormat as AgentLoopOptions["response_format"] | undefined,
    hooks: G.__oragerHooks as AgentLoopOptions["hooks"] | undefined,
    planMode: (G.__oragerPlanMode as boolean | undefined) ?? opts.planMode,
    injectContext: (G.__oragerInjectContext as boolean | undefined) ?? opts.injectContext,
    tagToolOutputs: (G.__oragerTagToolOutputs as boolean | undefined) ?? opts.tagToolOutputs,
    readProjectInstructions: G.__oragerReadProjectInstructions as boolean | undefined,
    summarizePrompt: G.__oragerSummarizePrompt as string | undefined,
    summarizeFallbackKeep: G.__oragerSummarizeFallbackKeep as number | undefined,
    webhookUrl: G.__oragerWebhookUrl as string | undefined,
    webhookFormat: G.__oragerWebhookFormat as "discord" | undefined,
    webhookSecret: G.__oragerWebhookSecret as string | undefined,
    bashPolicy: G.__oragerBashPolicy as AgentLoopOptions["bashPolicy"] | undefined,
    trackFileChanges: (G.__oragerTrackFileChanges as boolean | undefined) ?? opts.trackFileChanges,
    enableBrowserTools: (G.__oragerEnableBrowserTools as boolean | undefined) ?? opts.enableBrowserTools,
    autoMemory: opts.autoMemory,
    ollama: opts.ollama,
    maxCostUsdSoft: G.__oragerMaxCostUsdSoft as number | undefined,
    approvalTimeoutMs: G.__oragerApprovalTimeoutMs as number | undefined,
    hookTimeoutMs: G.__oragerHookTimeoutMs as number | undefined,
    hookErrorMode: (G.__oragerHookErrorMode as AgentLoopOptions["hookErrorMode"] | undefined) ?? opts.hookErrorMode,
    timeoutSec: opts.timeoutSec,
    apiKeys: G.__oragerApiKeys as string[] | undefined,
    requiredEnvVars: opts.requiredEnvVars,
    memory: G.__oragerMemory as boolean | undefined,
    memoryKey: (G.__oragerMemoryKey as string | undefined) ?? memoryKey,
    memoryMaxChars: G.__oragerMemoryMaxChars as number | undefined,
    agentApiKey: G.__oragerAgentApiKey as string | undefined,
    memoryRetrieval: G.__oragerMemoryRetrieval as "local" | "embedding" | undefined,
    memoryEmbeddingModel: G.__oragerMemoryEmbeddingModel as string | undefined,
    subprocess: subprocessEnabled ? { enabled: true } : undefined,
  };

  if (opts.profile) {
    loopOpts = await applyProfileAsync(opts.profile, loopOpts);
  }

  const _runStartMs = Date.now();

  try {
    await runAgentLoop(loopOpts);
  } finally {
    await trajLogger.finalize().catch(() => { /* non-fatal */ });

    // ── Production score recording (PR 7) ──────────────────────────────────
    // Record this run in the agents DB so real usage feeds the tournament.
    // Only fires when ORAGER_RECORD_SCORES=1 — completely non-fatal.
    recordProductionScore({
      agentId: _agentId ?? "cli",
      sessionId: _runSessionId,
      success: _runSubtype === "success",
      turns: _runTurns,
      costUsd: _runCostUsd,
      durationMs: Date.now() - _runStartMs,
      variantId: _selectedVariant?.variantId ?? null,
      modelId: opts.model,
    });

    const skillbank = DEFAULT_SKILLBANK_CONFIG;
    const _embeddingModel = process.env["ORAGER_EMBEDDING_MODEL"] ?? "";
    if (skillbank.autoExtract && _runSessionId && _embeddingModel) {
      const embeddingModel = _embeddingModel;
      const model = opts.model;
      const sid = _runSessionId;
      // Fetch wiki context for skill extraction (wiki-seeded GEPA)
      let wikiCtx: string | undefined;
      try {
        const { getWikiBlock } = await import("../knowledge-wiki.js");
        wikiCtx = await getWikiBlock(prompt, 2000) ?? undefined;
      } catch { /* wiki unavailable — non-fatal */ }
      extractSkillFromTrajectory(
        trajectoryPath(sid),
        sid,
        model,
        apiKey,
        embeddingModel,
        undefined,
        wikiCtx,
      ).catch(() => { /* non-fatal */ });
    }


    await deps.releaseCliPidLock();
  }
}
