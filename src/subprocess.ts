/**
 * Subprocess transport for orager agent runs.
 *
 * Protocol: JSON-RPC 2.0 over stdio, one message per line (same as MCP servers).
 *   stdin  → JSON-RPC requests  (agent/run, agent/cancel, agent/ui_response)
 *   stdout ← JSON-RPC responses + streaming notifications (agent/event)
 *   stderr ← diagnostic logs (never mixed into the protocol channel)
 *
 * Orchestrator side: runAgentLoopSubprocess
 *   Spawns a child orager process with --subprocess, writes the agent/run
 *   request, streams agent/event notifications back as EmitEvents, then
 *   resolves when the child sends a final result response.
 *
 * Server side: startSubprocessServer
 *   Reads agent/run from stdin, calls runAgentLoop, emits agent/event
 *   notifications for every EmitEvent, then sends the final JSON-RPC response.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { runAgentLoop } from "./loop.js";
import { runCompare } from "./compare.js";
import { log } from "./logger.js";
import type { AgentLoopOptions, EmitEvent } from "./types.js";
import { resolveUiResponse } from "./tools/render-ui.js";
import type { CompareParams, CompareChunk, CompareResult } from "./compare.js";
import {
  listIdentities, loadIdentity, createIdentity, updateIdentityFile,
  deleteIdentity, appendLesson, appendDailyLog, buildIdentityBlock,
} from "./agent-identity.js";
import {
  indexAgent, rebuildIndex, removeAgentFromIndex, searchIdentities,
} from "./agent-identity-index.js";
import {
  createChannel, getChannel, getChannelByName, listChannels, updateChannel, deleteChannel,
  addMember, removeMember, listMembers,
  postMessage, getMessages, getMessage, searchMessages,
} from "./channel.js";
import { routeMessage, onAgentWake, buildWakePrompt } from "./channel-router.js";
import {
  createSchedule, getSchedule, listSchedules, updateSchedule, deleteSchedule, getRunHistory,
} from "./scheduler-db.js";
import {
  loadAndStartAll, stopAll, registerJob, unregisterJob, isRunning, activeJobCount,
  setExecutor,
} from "./scheduler.js";

// ── Safety limits ────────────────────────────────────────────────────────────
// Reject any single JSON-RPC line exceeding this size to prevent OOM on a
// runaway LLM response or malformed message. 50 MB is generous for real payloads.
const MAX_LINE_BYTES = 50 * 1024 * 1024; // 50 MB

// Default subprocess timeout: 10 minutes. Prevents indefinite hangs when the
// caller doesn't specify an explicit timeout. Override via subprocess.timeoutMs.
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000;

// ── JSON-RPC 2.0 wire types ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) && "method" in msg;
}

function writeLine(stream: NodeJS.WritableStream, msg: JsonRpcMessage): void {
  const ok = stream.write(JSON.stringify(msg) + "\n");
  if (!ok) {
    // Buffer is full — log to stderr so operators can tune pipe buffer sizes.
    // We don't block here because JSON-RPC messages are small enough that the
    // OS will drain the buffer before the next write.
    process.stderr.write("[orager/subprocess] writeLine: write buffer full, message queued\n");
  }
}

// ── Subprocess spawn helper ───────────────────────────────────────────────────

/**
 * Returns [cmd, args] needed to spawn an orager subprocess correctly in both
 * compiled-binary mode and dev/script mode.
 *
 * Compiled binary  (process.execPath === orager binary):
 *   spawn("orager", ["--subprocess"])
 *
 * Dev / script mode (process.execPath === bun, process.argv[1] === src/index.ts):
 *   spawn("bun", ["src/index.ts", "--subprocess"])
 *
 * Without this distinction, dev-mode runs spawn "bun --subprocess" which
 * triggers Bun's own CLI help instead of starting the orager server.
 */
function resolveSubprocessSpawn(explicitBinaryPath?: string): [string, string[]] {
  if (explicitBinaryPath) {
    return [explicitBinaryPath, ["--subprocess"]];
  }
  const scriptPath = process.argv[1];
  const isScript =
    typeof scriptPath === "string" &&
    (scriptPath.endsWith(".ts") || scriptPath.endsWith(".js") || scriptPath.endsWith(".mts"));

  if (isScript) {
    // Dev mode: bun <script> --subprocess
    return [process.execPath, [scriptPath, "--subprocess"]];
  }
  // Compiled binary: orager --subprocess
  return [process.execPath, ["--subprocess"]];
}

// ── Kill helpers ──────────────────────────────────────────────────────────────

const SIGKILL_GRACE_MS = 2000;

function killChild(child: ReturnType<typeof spawn>): void {
  try { child.kill("SIGTERM"); } catch { /* already dead */ }
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }, SIGKILL_GRACE_MS).unref();
}

// ── Orchestrator side ─────────────────────────────────────────────────────────

/**
 * Run the agent loop in a child orager process over JSON-RPC 2.0 stdio.
 * Equivalent to runAgentLoop but the work happens in an isolated subprocess.
 */
export async function runAgentLoopSubprocess(opts: AgentLoopOptions): Promise<void> {
  const { subprocess, onEmit, ...rest } = opts;
  const timeoutMs = subprocess?.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;

  // Strip the subprocess option itself — the child runs in-process mode.
  const params: Omit<AgentLoopOptions, "onEmit" | "subprocess"> = rest;

  const [spawnCmd, spawnArgs] = resolveSubprocessSpawn(subprocess?.binaryPath);
  const child = spawn(spawnCmd, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settled = false;
  let responseReceived = false;

  return new Promise<void>((resolve, reject) => {
    // ── Timeout ────────────────────────────────────────────────────────────────
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killChild(child);
          reject(new Error(`orager subprocess timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
    }

    // ── Read stdout line by line ───────────────────────────────────────────────
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (Buffer.byteLength(trimmed) > MAX_LINE_BYTES) {
        process.stderr.write(`[orager/subprocess] dropping oversized message from child (${Buffer.byteLength(trimmed)} bytes > ${MAX_LINE_BYTES} limit)\n`);
        return;
      }
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        process.stderr.write(`[orager/subprocess] malformed JSON from child: ${trimmed}\n`);
        return;
      }

      if (isNotification(msg) && msg.method === "agent/event") {
        // Forward the EmitEvent to the caller's onEmit handler.
        try {
          onEmit(msg.params as EmitEvent);
        } catch (err) {
          // onEmit errors must not propagate into the protocol loop, but they
          // should not be silently discarded — log so operators can diagnose.
          process.stderr.write(
            `[orager/subprocess] onEmit handler threw (event dropped): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return;
      }

      if (isResponse(msg) && msg.id === 1) {
        // Final response — resolve or reject.
        responseReceived = true;
        cleanup();
        if (!settled) {
          settled = true;
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve();
          }
        }
      }
    });

    // ── Stderr → logger ───────────────────────────────────────────────────────
    child.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // ── Child exit ────────────────────────────────────────────────────────────
    child.on("close", (code) => {
      cleanup();
      if (!settled) {
        settled = true;
        if (code === 0 && !responseReceived) {
          // Clean exit but the JSON-RPC result response was never sent — treat
          // as a failure so callers don't silently succeed with no output.
          reject(new Error("orager subprocess exited without sending a JSON-RPC response"));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`orager subprocess exited with code ${code}`));
        }
      }
    });

    child.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // ── Send the agent/run request ─────────────────────────────────────────────
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params,
    };
    child.stdin!.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`orager subprocess stdin error: ${err.message}`));
      }
    });
    writeLine(child.stdin!, request);
    child.stdin!.end();
  });
}

// ── Orchestrator side — compare/run ──────────────────────────────────────────

/**
 * Fan out a prompt to N models via a child orager subprocess over JSON-RPC 2.0.
 *
 * The child streams `compare/chunk` notifications for each model's deltas.
 * Resolves with the full CompareResult once all models finish.
 */
export async function runCompareSubprocess(
  params: CompareParams,
  onChunk: (chunk: CompareChunk) => void,
  opts?: { binaryPath?: string; timeoutMs?: number },
): Promise<CompareResult> {
  const timeoutMs = opts?.timeoutMs;

  const [spawnCmd, spawnArgs] = resolveSubprocessSpawn(opts?.binaryPath);
  const child = spawn(spawnCmd, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settled = false;

  return new Promise<CompareResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killChild(child);
          reject(new Error(`orager compare subprocess timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
    }

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (Buffer.byteLength(trimmed) > MAX_LINE_BYTES) {
        process.stderr.write(`[orager/compare] dropping oversized message (${Buffer.byteLength(trimmed)} bytes)\n`);
        return;
      }
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        process.stderr.write(`[orager/compare] malformed JSON from child: ${trimmed}\n`);
        return;
      }

      // Forward compare/chunk streaming notifications to the caller
      if (isNotification(msg) && msg.method === "compare/chunk") {
        try {
          onChunk(msg.params as CompareChunk);
        } catch (err) {
          process.stderr.write(
            `[orager/compare] onChunk handler threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return;
      }

      // Final response
      if (isResponse(msg) && msg.id === 1) {
        cleanup();
        if (!settled) {
          settled = true;
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result as CompareResult);
          }
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on("close", (code) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(
          code === 0
            ? "orager compare subprocess exited without sending a JSON-RPC response"
            : `orager compare subprocess exited with code ${code}`,
        ));
      }
    });

    child.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "compare/run",
      params,
    };
    child.stdin!.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`orager compare subprocess stdin error: ${err.message}`));
      }
    });
    writeLine(child.stdin!, request);
    child.stdin!.end();
  });
}

// ── Server side ───────────────────────────────────────────────────────────────

/**
 * Start the subprocess server. Reads JSON-RPC requests from stdin in a
 * persistent message loop, dispatches to handlers, streams notifications
 * to stdout.  The server stays alive until stdin closes (desktop sidecar
 * mode) or after a single agent/run completes (CLI subprocess mode).
 *
 * Called when orager is spawned with --subprocess.
 */
export async function startSubprocessServer(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  let agentRunning = false;

  // ── Wire executor for scheduled tasks ───────────────────────────────────
  // When a cron job fires, the scheduler calls this to run the agent loop.
  // API keys are available as env vars (injected by the desktop on sidecar start).
  setExecutor(async (schedule, _isCatchup) => {
    const startTime = Date.now();
    const apiKey =
      process.env["OPENROUTER_API_KEY"] ??
      process.env["ANTHROPIC_API_KEY"] ??
      process.env["OPENAI_API_KEY"] ??
      process.env["GEMINI_API_KEY"] ??
      process.env["DEEPSEEK_API_KEY"] ??
      "";

    if (!apiKey) {
      return { status: "error", errorMessage: "No API key configured", durationMs: 0 };
    }

    // Build identity context if the schedule owner is an agent
    let systemPrefix = "";
    let agentModel: string | undefined;
    let agentMaxTurns: number | undefined;
    if (schedule.ownerType === "agent") {
      const block = buildIdentityBlock(schedule.ownerId);
      if (block) systemPrefix = block + "\n\n";
      // Read agent's config for model/limits preference
      const { loadAgentConfig: loadCfg } = await import("./agent-config.js");
      const cfg = loadCfg(schedule.ownerId);
      agentModel = cfg.model;
      agentMaxTurns = cfg.maxTurns;
    }

    const prompt = systemPrefix + schedule.prompt;
    let resultText = "";
    let costUsd = 0;

    // Inject create_agent tool if the agent has permission
    let extraTools: import("./types.js").ToolExecutor[] | undefined;
    if (schedule.ownerType === "agent") {
      const { shouldIncludeCreateAgentTool, createAgentTool } = await import("./tools/create-agent.js");
      if (shouldIncludeCreateAgentTool(schedule.ownerId)) {
        extraTools = [createAgentTool];
      }
    }

    try {
      await runAgentLoop({
        prompt,
        model: schedule.model || agentModel || process.env["ORAGER_MODEL"] || "openrouter/auto",
        apiKey,
        sessionId: null,
        addDirs: [],
        maxTurns: agentMaxTurns ?? 10,
        cwd: process.env["HOME"] || "/tmp",
        dangerouslySkipPermissions: true,
        verbose: false,
        extraTools,
        onEmit: (event) => {
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") resultText += block.text;
            }
          }
          if (event.type === "result" && typeof event.total_cost_usd === "number") {
            costUsd = event.total_cost_usd;
          }
        },
      });

      return {
        status: "success",
        durationMs: Date.now() - startTime,
        costUsd,
        result: resultText || undefined,
      };
    } catch (err) {
      return {
        status: "error",
        durationMs: Date.now() - startTime,
        costUsd,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── Wire wake handler for @mention routing ──────────────────────────────
  // When a channel message @mentions an agent, the router calls this to run
  // the agent, then posts the response back to the channel.
  onAgentWake(async (event) => {
    const apiKey =
      process.env["OPENROUTER_API_KEY"] ??
      process.env["ANTHROPIC_API_KEY"] ??
      process.env["OPENAI_API_KEY"] ??
      process.env["GEMINI_API_KEY"] ??
      process.env["DEEPSEEK_API_KEY"] ??
      "";

    if (!apiKey) return null;

    // Read agent's preferred model from config
    const { loadAgentConfig: loadCfg } = await import("./agent-config.js");
    const cfg = loadCfg(event.agentId);

    // Build the prompt with channel context and identity
    const identityBlock = buildIdentityBlock(event.agentId);
    const wakePrompt = (identityBlock ? identityBlock + "\n\n" : "") + buildWakePrompt(event);

    // Inject create_agent tool if the agent has permission
    let wakeExtraTools: import("./types.js").ToolExecutor[] | undefined;
    {
      const { shouldIncludeCreateAgentTool: shouldInclude, createAgentTool: caTool } = await import("./tools/create-agent.js");
      if (shouldInclude(event.agentId)) {
        wakeExtraTools = [caTool];
      }
    }

    let resultText = "";

    try {
      await runAgentLoop({
        prompt: wakePrompt,
        model: cfg.model || process.env["ORAGER_MODEL"] || "openrouter/auto",
        apiKey,
        sessionId: null,
        addDirs: [],
        maxTurns: cfg.maxTurns ?? 5,
        cwd: process.env["HOME"] || "/tmp",
        dangerouslySkipPermissions: true,
        verbose: false,
        extraTools: wakeExtraTools,
        onEmit: (ev) => {
          if (ev.type === "assistant" && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === "text") resultText += block.text;
            }
          }
        },
      });

      return resultText || null;
    } catch (err) {
      process.stderr.write(`[wake-handler] agent ${event.agentId} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  });

  // ── Auto-start scheduler ────────────────────────────────────────────────
  // Load cron jobs and start firing on schedule (with missed-run catch-up).
  loadAndStartAll().then((result) => {
    process.stderr.write(`[scheduler] started: ${result.loaded} jobs loaded, ${result.catchups} catch-ups\n`);
  }).catch((err) => {
    process.stderr.write(`[scheduler] failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  });

  const dispatch = async (request: JsonRpcRequest): Promise<void> => {
    switch (request.method) {
      // ── License RPCs (instant, no agent loop) ──────────────────────────
      case "license/status": {
        const { getLicenseInfo } = await import("./license.js");
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: getLicenseInfo(),
        });
        break;
      }
      case "license/activate": {
        const { activateLicense } = await import("./license.js");
        const params = request.params as { key?: string } | undefined;
        if (!params?.key) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: key" },
          });
          break;
        }
        const info = activateLicense(params.key);
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: info,
        });
        break;
      }
      case "license/deactivate": {
        const { deactivateLicense, getLicenseInfo } = await import("./license.js");
        deactivateLicense();
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: getLicenseInfo(),
        });
        break;
      }

      // ── Skill RPCs ─────────────────────────────────────────────────────
      case "skills/list": {
        const { listSkills } = await import("./skillbank.js");
        const params = request.params as { includeDeleted?: boolean } | undefined;
        const skills = await listSkills(params?.includeDeleted ?? false);
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: skills,
        });
        break;
      }
      case "skills/update": {
        const { getSkill, deleteSkill } = await import("./skillbank.js");
        const params = request.params as { id: string; deleted?: boolean } | undefined;
        if (!params?.id) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: id" },
          });
          break;
        }
        if (params.deleted) {
          await deleteSkill(params.id);
        }
        const skill = await getSkill(params.id);
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: skill ?? null,
        });
        break;
      }

      case "skills/import": {
        const { importSeedSkill } = await import("./skillbank.js");
        const params = request.params as { text: string; source?: string } | undefined;
        if (!params?.text) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: text" },
          });
          break;
        }
        const importResult = await importSeedSkill(
          params.text,
          params.source ?? "demo-seed",
        );
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: { status: importResult },
        });
        break;
      }

      // ── Memory RPCs ────────────────────────────────────────────────────
      case "memory/list": {
        const { listMemoryKeysSqlite, loadMemoryStoreSqlite } = await import("./memory-sqlite.js");
        const params = request.params as { namespace?: string } | undefined;
        if (params?.namespace) {
          const store = await loadMemoryStoreSqlite(params.namespace);
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: { namespaces: [params.namespace], entries: store.entries },
          });
        } else {
          const keys = await listMemoryKeysSqlite();
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: { namespaces: keys, entries: [] },
          });
        }
        break;
      }
      case "memory/delete": {
        const { removeMemoryEntrySqlite } = await import("./memory-sqlite.js");
        const params = request.params as { namespace: string; id: string } | undefined;
        if (!params?.namespace || !params?.id) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: namespace, id" },
          });
          break;
        }
        const removed = await removeMemoryEntrySqlite(params.namespace, params.id);
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: { ok: removed },
        });
        break;
      }

      // ── Toolkit RPCs ────────────────────────────────────────────────────
      case "toolkit/preview": {
        const { previewToolkit, parseRepoString } = await import("./toolkit.js");
        const params = request.params as { repo?: string } | undefined;
        if (!params?.repo) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: repo (e.g. \"owner/repo\" or \"owner/repo#branch\")" },
          });
          break;
        }
        try {
          const parsed = parseRepoString(params.repo);
          const preview = await previewToolkit(parsed);
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: preview,
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }
      case "toolkit/seed": {
        const { seedToolkit, parseRepoString } = await import("./toolkit.js");
        const params = request.params as {
          repo?: string;
          categories?: string[];
          limit?: number;
          dryRun?: boolean;
        } | undefined;
        if (!params?.repo) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: repo" },
          });
          break;
        }
        try {
          const parsed = parseRepoString(params.repo);
          const result = await seedToolkit({
            repo: parsed,
            categories: params.categories as import("./toolkit.js").ToolkitItemType[] | undefined,
            limit: params.limit,
            dryRun: params.dryRun,
            onProgress: (event) => {
              writeLine(process.stdout, {
                jsonrpc: "2.0",
                method: "toolkit/progress",
                params: event,
              } as JsonRpcNotification);
            },
          });
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result,
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      // ── Agent run (long-running, one at a time) ────────────────────────
      case "agent/run": {
        if (agentRunning) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: "Agent is already running" },
          });
          break;
        }
        agentRunning = true;
        try {
          await handleAgentRun(request);
        } finally {
          agentRunning = false;
        }
        break;
      }

      // ── Model comparison ───────────────────────────────────────────────
      case "compare/run": {
        await handleCompareRun(request);
        break;
      }

      // ── UI response (notification, no response needed) ─────────────────
      case "agent/ui_response": {
        const params = request.params as { requestId: string; value: unknown } | undefined;
        if (params?.requestId) {
          resolveUiResponse(params.requestId, JSON.stringify(params.value ?? null));
        }
        break;
      }

      // ── Agent identity CRUD ────────────────────────────────────────────
      case "agent/identity/list": {
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: listIdentities(),
        });
        break;
      }

      case "agent/identity/get": {
        const params = request.params as { agentId: string } | undefined;
        if (!params?.agentId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: agentId" },
          });
          break;
        }
        const identity = loadIdentity(params.agentId);
        if (!identity) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: `Agent identity "${params.agentId}" not found` },
          });
          break;
        }
        // Convert Map to plain object for JSON serialization
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: { ...identity, dailyLogs: Object.fromEntries(identity.dailyLogs) },
        });
        break;
      }

      case "agent/identity/create": {
        const params = request.params as {
          agentId: string;
          soul?: string;
          operatingManual?: string;
          memory?: string;
          patterns?: string;
          config?: {
            role?: "primary" | "specialist";
            reportsTo?: string | null;
            title?: string;
            provider?: string;
            model?: string;
            fallbackModel?: string;
            visionModel?: string;
            maxTurns?: number;
            maxCostUsd?: number;
            permissions?: Record<string, boolean>;
            templateId?: string;
          };
        } | undefined;
        if (!params?.agentId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: agentId" },
          });
          break;
        }
        try {
          await createIdentity(params.agentId, {
            soul: params.soul,
            operatingManual: params.operatingManual,
            memory: params.memory,
            patterns: params.patterns,
          }, params.config);
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: { created: true, agentId: params.agentId },
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/identity/update": {
        const params = request.params as {
          agentId: string;
          file: string;
          content: string;
        } | undefined;
        if (!params?.agentId || !params?.file || params?.content === undefined) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: agentId, file, content" },
          });
          break;
        }
        try {
          updateIdentityFile(
            params.agentId,
            params.file as "soul.md" | "operating-manual.md" | "memory.md" | "lessons.md" | "patterns.md",
            params.content,
          );
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: { updated: true },
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/identity/delete": {
        const params = request.params as { agentId: string } | undefined;
        if (!params?.agentId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: agentId" },
          });
          break;
        }
        const deleted = deleteIdentity(params.agentId);
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: { deleted },
        });
        break;
      }

      case "agent/identity/append-lesson": {
        const params = request.params as {
          agentId: string;
          what: string;
          why: string;
          fix: string;
          neverCompress?: boolean;
        } | undefined;
        if (!params?.agentId || !params?.what || !params?.fix) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: agentId, what, fix" },
          });
          break;
        }
        try {
          appendLesson(params.agentId, {
            what: params.what,
            why: params.why ?? "",
            fix: params.fix,
            neverCompress: params.neverCompress,
          });
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: { appended: true },
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/identity/append-log": {
        const params = request.params as { agentId: string; content: string } | undefined;
        if (!params?.agentId || !params?.content) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: agentId, content" },
          });
          break;
        }
        try {
          appendDailyLog(params.agentId, params.content);
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: { appended: true },
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      // ── Identity index: search, index, rebuild ──────────────────────────
      case "agent/identity/search": {
        const params = request.params as { query: string; agentIds?: string[]; fileTypes?: string[]; limit?: number; semantic?: boolean } | undefined;
        if (!params?.query) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: query" },
          });
          break;
        }
        try {
          const results = await searchIdentities(params.query, {
            agentIds: params.agentIds,
            fileTypes: params.fileTypes as any,
            limit: params.limit,
            semantic: params.semantic,
          });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: results });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/identity/index": {
        const params = request.params as { agentId: string; embeddings?: boolean } | undefined;
        if (!params?.agentId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: agentId" },
          });
          break;
        }
        try {
          const result = await indexAgent(params.agentId, { embeddings: params.embeddings });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/identity/rebuild-index": {
        const params = request.params as { embeddings?: boolean } | undefined;
        try {
          const result = await rebuildIndex({ embeddings: params?.embeddings });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      // ── Agent config (config.json) ──────────────────────────────────────
      case "agent/config/get": {
        const params = request.params as { agentId: string } | undefined;
        if (!params?.agentId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: agentId" },
          });
          break;
        }
        try {
          const { loadAgentConfig } = await import("./agent-config.js");
          const config = loadAgentConfig(params.agentId);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: config });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/config/update": {
        const params = request.params as { agentId: string; config: Record<string, unknown> } | undefined;
        if (!params?.agentId || !params?.config) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: agentId, config" },
          });
          break;
        }
        try {
          const { saveAgentConfig } = await import("./agent-config.js");
          saveAgentConfig(params.agentId, params.config as any);
          const { loadAgentConfig } = await import("./agent-config.js");
          const updated = loadAgentConfig(params.agentId);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: updated });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/config/reports": {
        const params = request.params as { agentId: string } | undefined;
        if (!params?.agentId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: agentId" },
          });
          break;
        }
        try {
          const { getDirectReports, getChainOfCommand } = await import("./agent-config.js");
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: {
              directReports: getDirectReports(params.agentId),
              chainOfCommand: getChainOfCommand(params.agentId),
            },
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      // ── Agent templates ─────────────────────────────────────────────────
      case "agent/templates/list": {
        const params = request.params as { category?: string } | undefined;
        try {
          const { listTemplates } = await import("./agent-templates.js");
          const templates = listTemplates(params?.category as any);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: templates });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/templates/get": {
        const params = request.params as { templateId: string } | undefined;
        if (!params?.templateId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: templateId" },
          });
          break;
        }
        try {
          const { getTemplate } = await import("./agent-templates.js");
          const template = getTemplate(params.templateId);
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: template ?? null,
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "agent/templates/categories": {
        try {
          const { getTemplateCategories } = await import("./agent-templates.js");
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            result: getTemplateCategories(),
          });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      // ── Channel operations ───────────────────────────────────────────────
      case "channel/list": {
        try {
          const result = await listChannels();
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/create": {
        const params = request.params as { name: string; description?: string; members?: string[] } | undefined;
        if (!params?.name) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: name" },
          });
          break;
        }
        try {
          const result = await createChannel(params.name, params.description, params.members);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/get": {
        const params = request.params as { channelId?: string; name?: string } | undefined;
        try {
          const result = params?.channelId
            ? await getChannel(params.channelId)
            : params?.name
            ? await getChannelByName(params.name)
            : null;
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/update": {
        const params = request.params as { channelId: string; name?: string; description?: string } | undefined;
        if (!params?.channelId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: channelId" },
          });
          break;
        }
        try {
          const result = await updateChannel(params.channelId, { name: params.name, description: params.description });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { updated: result } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/delete": {
        const params = request.params as { channelId: string } | undefined;
        if (!params?.channelId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: channelId" },
          });
          break;
        }
        try {
          const result = await deleteChannel(params.channelId);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { deleted: result } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/members": {
        const params = request.params as { channelId: string; action?: "list" | "add" | "remove"; memberId?: string } | undefined;
        if (!params?.channelId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: channelId" },
          });
          break;
        }
        try {
          if (params.action === "add" && params.memberId) {
            await addMember(params.channelId, params.memberId);
            writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { added: true } });
          } else if (params.action === "remove" && params.memberId) {
            await removeMember(params.channelId, params.memberId);
            writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { removed: true } });
          } else {
            const members = await listMembers(params.channelId);
            writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: members });
          }
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/post": {
        const params = request.params as { channelId: string; authorId: string; content: string; threadId?: string; metadata?: Record<string, unknown> } | undefined;
        if (!params?.channelId || !params?.authorId || !params?.content) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: channelId, authorId, content" },
          });
          break;
        }
        try {
          const msg = await postMessage(params.channelId, params.authorId, params.content, {
            threadId: params.threadId,
            metadata: params.metadata,
          });
          // Route @mentions (non-blocking — don't await, fire and forget)
          routeMessage(msg).catch((err) => {
            process.stderr.write(`[subprocess] mention routing failed: ${err instanceof Error ? err.message : String(err)}\n`);
          });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: msg });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/messages": {
        const params = request.params as { channelId: string; limit?: number; before?: string; threadId?: string } | undefined;
        if (!params?.channelId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: channelId" },
          });
          break;
        }
        try {
          const messages = await getMessages(params.channelId, {
            limit: params.limit,
            before: params.before,
            threadId: params.threadId,
          });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: messages });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "channel/search": {
        const params = request.params as { query: string; channelId?: string; authorId?: string; limit?: number } | undefined;
        if (!params?.query) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: query" },
          });
          break;
        }
        try {
          const results = await searchMessages(params.query, {
            channelId: params.channelId,
            authorId: params.authorId,
            limit: params.limit,
          });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: results });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      // ── Schedule operations ──────────────────────────────────────────────
      case "schedule/list": {
        const params = request.params as { ownerType?: "agent" | "user"; ownerId?: string; enabledOnly?: boolean } | undefined;
        try {
          const result = await listSchedules(params);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/create": {
        const params = request.params as {
          ownerType: "agent" | "user"; ownerId: string; channelId: string;
          cron: string; prompt: string; model?: string; source?: "manual" | "operating-manual" | "agent-created";
        } | undefined;
        if (!params?.ownerType || !params?.ownerId || !params?.channelId || !params?.cron || !params?.prompt) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required params: ownerType, ownerId, channelId, cron, prompt" },
          });
          break;
        }
        try {
          const schedule = await createSchedule(params);
          // Auto-register with Croner if scheduler is running
          if (isRunning()) registerJob(schedule);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: schedule });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/update": {
        const params = request.params as { id: string; cron?: string; prompt?: string; channelId?: string; model?: string | null; enabled?: boolean } | undefined;
        if (!params?.id) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: id" },
          });
          break;
        }
        try {
          const updated = await updateSchedule(params.id, params);
          // Re-register job if cron changed or enabled/disabled
          if (isRunning()) {
            const schedule = await getSchedule(params.id);
            if (schedule?.enabled) {
              registerJob(schedule);
            } else {
              unregisterJob(params.id);
            }
          }
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { updated } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/delete": {
        const params = request.params as { id: string } | undefined;
        if (!params?.id) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: id" },
          });
          break;
        }
        try {
          unregisterJob(params.id);
          const deleted = await deleteSchedule(params.id);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { deleted } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/pause": {
        const params = request.params as { id: string } | undefined;
        if (!params?.id) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: id" },
          });
          break;
        }
        try {
          await updateSchedule(params.id, { enabled: false });
          unregisterJob(params.id);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { paused: true } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/resume": {
        const params = request.params as { id: string } | undefined;
        if (!params?.id) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: id" },
          });
          break;
        }
        try {
          await updateSchedule(params.id, { enabled: true });
          const schedule = await getSchedule(params.id);
          if (schedule) registerJob(schedule);
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { resumed: true } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/history": {
        const params = request.params as { scheduleId: string; limit?: number } | undefined;
        if (!params?.scheduleId) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32602, message: "Missing required param: scheduleId" },
          });
          break;
        }
        try {
          const history = await getRunHistory(params.scheduleId, { limit: params.limit });
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: history });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/start": {
        try {
          const result = await loadAndStartAll();
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/stop": {
        try {
          stopAll();
          writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { stopped: true } });
        } catch (err) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case "schedule/status": {
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          result: { running: isRunning(), activeJobs: activeJobCount() },
        });
        break;
      }

      // ── Unknown method ─────────────────────────────────────────────────
      default:
        writeLine(process.stdout, {
          jsonrpc: "2.0", id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        });
        break;
    }
  };

  // ── Persistent message loop ────────────────────────────────────────────
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed) > MAX_LINE_BYTES) {
      log.warn(`JSON-RPC message exceeds max size (${Buffer.byteLength(trimmed)} bytes) — skipping`);
      return;
    }
    try {
      const msg = JSON.parse(trimmed) as JsonRpcRequest;
      if (!msg.method) return; // not a valid request
      dispatch(msg).catch((err) => {
        log.error(`RPC dispatch error for ${msg.method}: ${err}`);
        if (msg.id !== undefined) {
          writeLine(process.stdout, {
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        }
      });
    } catch {
      // Malformed JSON — ignore
    }
  });

  // Stay alive until stdin closes (sidecar mode)
  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}

// ── Method handlers (server side) ─────────────────────────────────────────────

async function handleAgentRun(request: JsonRpcRequest): Promise<void> {
  const params = request.params as Omit<AgentLoopOptions, "onEmit" | "subprocess">;

  const onEmit = (event: EmitEvent): void => {
    // The desktop listens for a desktop-compatible init notification to learn the
    // real session ID assigned by the loop (e.g. to update the URL from a
    // /session/local-<timestamp> placeholder to /session/<real-id>).
    // Transform the internal system/init event into the shape the desktop expects.
    let notifParams: unknown = event;
    if (event.type === "system" && event.subtype === "init") {
      notifParams = { type: "init", sessionId: event.session_id };
    }
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "agent/event",
      params: notifParams,
    };
    writeLine(process.stdout, notification);
  };

  try {
    await runAgentLoop({ ...params, onEmit });
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: { done: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("subprocess_run_error", { error: message });
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message },
    });
    process.exit(1);
  }
}

async function handleCompareRun(request: JsonRpcRequest): Promise<void> {
  const params = request.params as CompareParams;

  const onChunk = (chunk: CompareChunk): void => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "compare/chunk",
      params: chunk,
    };
    writeLine(process.stdout, notification);
  };

  try {
    const result = await runCompare(params, onChunk);
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("subprocess_compare_error", { error: message });
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message },
    });
    process.exit(1);
  }
}
