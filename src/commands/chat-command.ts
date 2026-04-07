/**
 * CLI `orager chat` subcommand handler (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts.
 * Interactive multi-turn conversation. Reads user messages from stdin and
 * runs the agent loop for each, preserving session context between turns.
 *
 * Sprint 10: forward all relevant opts.* fields (model/sampling params,
 * approval mode, spawn depth, etc.) to runAgentLoop for flag parity.
 *
 * PR 7: Production score recording.
 * Each conversation turn is recorded in the agents DB when
 * ORAGER_RECORD_SCORES=1. Variant selection is pinned to the first turn of
 * each session so all turns within one conversation share the same variant.
 */

import readline from "node:readline";
import { runAgentLoop } from "../loop.js";
import { emit } from "../emit.js";
import { parseArgs } from "../cli/parse-args.js";
import { extractFlag } from "./cli-helpers.js";
import { createTrajectoryLogger, pruneOldTrajectories } from "../trajectory-logger.js";
import { extractSkillFromTrajectory, trajectoryPath, DEFAULT_SKILLBANK_CONFIG } from "../skillbank.js";
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

export async function handleChatCommand(
  chatArgv: string[],
  deps: {
    setInterruptSessionId: (id: string) => void;
  },
): Promise<void> {
  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    process.stderr.write("orager: API key not set. Export PROTOCOL_API_KEY.\n");
    process.exit(1);
  }

  const opts = parseArgs(chatArgv);
  const memoryKey = extractFlag(chatArgv, "--memory-key");

  let sessionId: string | null = opts.sessionId;
  let forceResume = !!sessionId;

  const isInteractive = process.stdin.isTTY;

  if (isInteractive) {
    process.stderr.write(`orager chat — model: ${opts.model}\n`);
    if (sessionId) process.stderr.write(`Resuming session: ${sessionId}\n`);
    process.stderr.write(`Type your message and press Enter. Ctrl+D or "exit" to quit.\n\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  const retentionDays = DEFAULT_SKILLBANK_CONFIG.retentionDays;
  pruneOldTrajectories(retentionDays).catch(() => { /* non-fatal */ });

  // ── Epsilon-greedy variant selection (PR 7) ──────────────────────────────────
  // Pin the variant for the lifetime of this chat session so all turns share
  // the same system-prompt transform. 80% exploit best-known / 20% explore.
  const _agentId = opts.agentId ?? null;
  const _seedDef = _agentId ? SEED_AGENTS[_agentId] ?? null : null;
  const _recordScores = process.env["ORAGER_RECORD_SCORES"] === "1";

  let _sessionVariant: PromptVariant | null = null;
  let _variantSystemPrompt: string | undefined;

  if (_recordScores && _agentId && _seedDef) {
    const variants = generatePromptVariants(_agentId, _seedDef.prompt ?? "");
    const explore = Math.random() < 0.20;
    if (explore) {
      _sessionVariant = assignVariant(_agentId, variants);
    } else {
      const db = await getAgentsDb().catch(() => null);
      const best = db ? await getBestVariant(db, _agentId, variants).catch(() => null) : null;
      _sessionVariant = best ?? assignVariant(_agentId, variants);
    }
    _variantSystemPrompt = _sessionVariant.prompt;
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

  const G = globalThis as Record<string, unknown>;

  const showPrompt = () => {
    if (isInteractive) process.stderr.write("you> ");
  };

  showPrompt();

  for await (const line of rl) {
    const userPrompt = line.trim();
    if (!userPrompt) { showPrompt(); continue; }
    if (userPrompt === "exit" || userPrompt === "quit") break;

    if (sessionId) deps.setInterruptSessionId(sessionId);

    let capturedSessionId: string | null = null;
    let _turnSubtype = "unknown";
    let _turnTurns = 0;
    let _turnCostUsd = 0;

    const trajLogger = createTrajectoryLogger(userPrompt, opts.model, process.cwd());

    const chatOnEmit = (event: Parameters<typeof emit>[0]) => {
      trajLogger.onEvent(event);
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") process.stdout.write(block.text);
        }
      } else if (event.type === "result") {
        capturedSessionId = event.session_id;
        _turnSubtype = event.subtype;
        _turnTurns = event.turnCount ?? 0;
        _turnCostUsd = event.total_cost_usd ?? 0;
        process.stdout.write("\n");
      } else {
        emit(event);
      }
    };

    try {
      await runAgentLoop({
        prompt: userPrompt,
        model: opts.model,
        apiKey,
        sessionId,
        forceResume,
        addDirs: opts.addDirs,
        maxTurns: opts.maxTurns,
        maxRetries: opts.maxRetries,
        cwd: process.cwd(),
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        verbose: opts.verbose,
        onEmit: chatOnEmit,
        onLog: (stream, chunk) => {
          if (stream === "stderr") process.stderr.write(chunk);
        },
        models: opts.models.length > 0 ? opts.models : undefined,
        requireApproval: opts.requireApproval,
        useFinishTool: opts.useFinishTool,
        maxCostUsd: opts.maxCostUsd,
        costQuota: opts.costQuota,
        costPerInputToken: opts.costPerInputToken,
        costPerOutputToken: opts.costPerOutputToken,
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
        summarizeAt: opts.summarizeAt,
        summarizeModel: opts.summarizeModel,
        summarizeKeepRecentTurns: opts.summarizeKeepRecentTurns,
        visionModel: opts.visionModel,
        turnModelRules: G.__oragerTurnModelRules as TurnModelRule[] | undefined,
        promptContent: G.__oragerPromptContent as UserMessageContentBlock[] | undefined,
        approvalAnswer: (G.__oragerApprovalAnswer as { choiceKey: string; toolCallId: string } | null | undefined) ?? opts.approvalAnswer ?? null,
        approvalMode: (G.__oragerApprovalMode as "tty" | "question" | undefined) ?? opts.approvalMode,
        mcpServers: G.__oragerMcpServers as AgentLoopOptions["mcpServers"] | undefined,
        maxSpawnDepth: (G.__oragerMaxSpawnDepth as number | undefined) ?? opts.maxSpawnDepth,
        maxIdenticalToolCallTurns: (G.__oragerMaxIdenticalToolCallTurns as number | undefined) ?? opts.maxIdenticalToolCallTurns,
        toolErrorBudgetHardStop: (G.__oragerToolErrorBudgetHardStop as boolean | undefined) ?? opts.toolErrorBudgetHardStop,
        hooks: G.__oragerHooks as AgentLoopOptions["hooks"] | undefined,
        planMode: (G.__oragerPlanMode as boolean | undefined) ?? opts.planMode,
        injectContext: (G.__oragerInjectContext as boolean | undefined) ?? opts.injectContext,
        tagToolOutputs: (G.__oragerTagToolOutputs as boolean | undefined) ?? opts.tagToolOutputs,
        trackFileChanges: (G.__oragerTrackFileChanges as boolean | undefined) ?? opts.trackFileChanges,
        enableBrowserTools: (G.__oragerEnableBrowserTools as boolean | undefined) ?? opts.enableBrowserTools,
        autoMemory: opts.autoMemory,
        ollama: opts.ollama,
        hookErrorMode: (G.__oragerHookErrorMode as AgentLoopOptions["hookErrorMode"] | undefined) ?? opts.hookErrorMode,
        timeoutSec: opts.timeoutSec,
        requiredEnvVars: opts.requiredEnvVars,
        memory: G.__oragerMemory as boolean | undefined,
        memoryKey: (G.__oragerMemoryKey as string | undefined) ?? memoryKey,
        memoryRetrieval: G.__oragerMemoryRetrieval as "local" | "embedding" | undefined,
        memoryEmbeddingModel: G.__oragerMemoryEmbeddingModel as string | undefined,
        appendSystemPrompt: _variantSystemPrompt,
      });
    } catch (err) {
      process.stderr.write(`\norager: error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      await trajLogger.finalize().catch(() => { /* non-fatal */ });

      // ── Production score recording (PR 7) ────────────────────────────────
      const _turnSid = capturedSessionId ?? sessionId;
      recordProductionScore({
        agentId: _agentId ?? "cli",
        sessionId: _turnSid,
        success: _turnSubtype === "success",
        turns: _turnTurns,
        costUsd: _turnCostUsd,
        durationMs: 0, // chat turns don't track wall-clock per-turn
        variantId: _sessionVariant?.variantId ?? null,
        modelId: opts.model,
      });

      const sid = capturedSessionId ?? sessionId;
      const _embeddingModel = process.env["ORAGER_EMBEDDING_MODEL"] ?? "";
      if (DEFAULT_SKILLBANK_CONFIG.autoExtract && sid && _embeddingModel) {
        extractSkillFromTrajectory(
          trajectoryPath(sid),
          sid,
          opts.model,
          apiKey,
          _embeddingModel,
        ).catch(() => { /* non-fatal */ });
      }
    }

    if (capturedSessionId) {
      sessionId = capturedSessionId;
      forceResume = true;
    }

    showPrompt();
  }

  if (isInteractive) process.stderr.write("\nGoodbye!\n");
}
