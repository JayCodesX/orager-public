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
