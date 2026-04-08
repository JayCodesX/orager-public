/**
 * Dev server lifecycle management tool.
 *
 * Starts, stops, and monitors a local development server (e.g. `npm run dev`,
 * `bun run dev`). Captures stdout/stderr into a ring buffer for log retrieval.
 * Detects server readiness via configurable regex pattern matching.
 *
 * Session-keyed for concurrent isolation. One dev server per session.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ToolExecuteOptions, ToolExecutor, ToolResult, EmitBrowserEvent } from "../types.js";

// ── State ────────────────────────────────────────────────────────────────────

interface DevServerState {
  proc: ChildProcess;
  logs: string[];
  status: "starting" | "ready" | "stopped" | "error";
  port?: number;
  url?: string;
  command: string;
  pid: number;
  startedAt: number;
}

const MAX_LOG_LINES = 1000;

const _devServers = new Map<string, DevServerState>();

function pushLog(state: DevServerState, line: string): void {
  state.logs.push(line);
  if (state.logs.length > MAX_LOG_LINES) {
    state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  }
}

function sessionKey(opts?: ToolExecuteOptions): string {
  return typeof opts?.sessionId === "string" && opts.sessionId
    ? opts.sessionId
    : "default";
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function killServer(state: DevServerState): void {
  state.status = "stopped";
  try { state.proc.kill("SIGTERM"); } catch { /* ok */ }
  // Force kill after 3s if still alive
  setTimeout(() => {
    try { process.kill(state.pid, "SIGKILL"); } catch { /* already dead */ }
  }, 3_000);
}

process.on("exit", () => {
  for (const state of _devServers.values()) {
    try { process.kill(state.pid, "SIGKILL"); } catch { /* ok */ }
  }
});

process.on("SIGTERM", () => {
  for (const [key, state] of _devServers.entries()) {
    killServer(state);
    _devServers.delete(key);
  }
});

let _beforeExitCalled = false;
process.on("beforeExit", () => {
  if (_beforeExitCalled || _devServers.size === 0) return;
  _beforeExitCalled = true;
  for (const [key, state] of _devServers.entries()) {
    killServer(state);
    _devServers.delete(key);
  }
});

// ── Port detection ───────────────────────────────────────────────────────────

const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

function detectPort(text: string): number | undefined {
  const match = PORT_RE.exec(text);
  return match ? parseInt(match[1], 10) : undefined;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

const DEFAULT_READY_PATTERN = "(ready on|listening on|compiled|started server|Local:|VITE|webpack compiled)";

export const devServerTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "dev_server",
      description:
        "Start, stop, or inspect a local development server. " +
        "Only one server per session — calling start when a server is already running returns its status. " +
        "Server logs (stdout/stderr) are captured and available via the logs action.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["start", "stop", "status", "logs"],
            description: "Action to perform",
          },
          command: {
            type: "string",
            description: 'Shell command to start the server (required for "start"), e.g. "npm run dev"',
          },
          port: {
            type: "number",
            description: "Expected port number (optional — auto-detected from stdout if not specified)",
          },
          ready_pattern: {
            type: "string",
            description:
              `Regex pattern to detect server readiness (default: ${JSON.stringify(DEFAULT_READY_PATTERN)})`,
          },
          lines: {
            type: "number",
            description: 'Number of log lines to return for "logs" action (default 50)',
          },
          search: {
            type: "string",
            description: 'Filter logs by substring match (for "logs" action)',
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(input, cwd, opts): Promise<ToolResult> {
    const action = typeof input["action"] === "string" ? input["action"] : "";
    const key = sessionKey(opts);

    switch (action) {
      case "start":
        return startServer(input, cwd, key, opts);
      case "stop":
        return stopServer(key);
      case "status":
        return serverStatus(key);
      case "logs":
        return serverLogs(input, key);
      default:
        return { toolCallId: "", content: `Unknown action: ${action}. Use start, stop, status, or logs.`, isError: true };
    }
  },
};

async function startServer(
  input: Record<string, unknown>,
  cwd: string,
  key: string,
  opts?: ToolExecuteOptions,
): Promise<ToolResult> {
  // If a server is already running, return its status
  const existing = _devServers.get(key);
  if (existing && existing.status !== "stopped" && existing.status !== "error") {
    return {
      toolCallId: "",
      content: JSON.stringify({
        status: existing.status,
        pid: existing.pid,
        url: existing.url,
        command: existing.command,
        message: "Server already running",
      }, null, 2),
      isError: false,
    };
  }

  const command = typeof input["command"] === "string" ? input["command"].trim() : "";
  if (!command) return { toolCallId: "", content: 'command is required for "start" action', isError: true };

  const specifiedPort = typeof input["port"] === "number" ? input["port"] : undefined;
  const readyPattern = typeof input["ready_pattern"] === "string" ? input["ready_pattern"] : DEFAULT_READY_PATTERN;

  const proc = spawn("bash", ["-c", command], {
    cwd,
    env: { ...process.env, ...opts?.additionalEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!proc.pid) {
    return { toolCallId: "", content: "Failed to start server process", isError: true };
  }

  const state: DevServerState = {
    proc,
    logs: [],
    status: "starting",
    port: specifiedPort,
    url: specifiedPort ? `http://localhost:${specifiedPort}` : undefined,
    command,
    pid: proc.pid,
    startedAt: Date.now(),
  };
  _devServers.set(key, state);

  // Wait for ready pattern or timeout
  const readyRe = new RegExp(readyPattern, "i");

  const readyPromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 15_000);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) pushLog(state, line);
      }

      // Auto-detect port if not specified
      if (!state.port) {
        const detected = detectPort(text);
        if (detected) {
          state.port = detected;
          state.url = `http://localhost:${detected}`;
        }
      }

      if (readyRe.test(text)) {
        clearTimeout(timeout);
        state.status = "ready";
        resolve();
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
  });

  // Handle process exit
  proc.on("exit", (code) => {
    if (state.status !== "stopped") {
      state.status = code === 0 ? "stopped" : "error";
      pushLog(state, `[dev_server] Process exited with code ${code}`);
    }
  });

  proc.on("error", (err) => {
    state.status = "error";
    pushLog(state, `[dev_server] Process error: ${err.message}`);
  });

  await readyPromise;

  // Emit browser event for desktop preview
  if (state.status === "ready" && state.url) {
    opts?.onEmit?.({
      type: "browser",
      action: "server_ready",
      url: state.url,
      port: state.port,
      sessionId: key,
    } as EmitBrowserEvent);
  }

  return {
    toolCallId: "",
    content: JSON.stringify({
      status: state.status,
      pid: state.pid,
      url: state.url,
      command: state.command,
    }, null, 2),
    isError: false,
  };
}

function stopServer(key: string): ToolResult {
  const state = _devServers.get(key);
  if (!state || state.status === "stopped") {
    return { toolCallId: "", content: "No server running", isError: false };
  }

  killServer(state);
  _devServers.delete(key);
  return { toolCallId: "", content: "Server stopped", isError: false };
}

function serverStatus(key: string): ToolResult {
  const state = _devServers.get(key);
  if (!state) {
    return { toolCallId: "", content: "No server running", isError: false };
  }

  return {
    toolCallId: "",
    content: JSON.stringify({
      status: state.status,
      pid: state.pid,
      url: state.url,
      command: state.command,
      uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
    }, null, 2),
    isError: false,
  };
}

function serverLogs(input: Record<string, unknown>, key: string): ToolResult {
  const state = _devServers.get(key);
  if (!state) {
    return { toolCallId: "", content: "No server running", isError: false };
  }

  const maxLines = typeof input["lines"] === "number" ? input["lines"] : 50;
  const search = typeof input["search"] === "string" ? input["search"] : null;

  let lines = state.logs;
  if (search) {
    lines = lines.filter((l) => l.includes(search));
  }
  lines = lines.slice(-maxLines);

  if (lines.length === 0) {
    return { toolCallId: "", content: "(no log output)", isError: false };
  }

  return { toolCallId: "", content: lines.join("\n"), isError: false };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _clearDevServersForTesting(): void {
  for (const [key, state] of _devServers.entries()) {
    try { state.proc.kill("SIGKILL"); } catch { /* ok */ }
    _devServers.delete(key);
  }
}

// ── Exported tool set ────────────────────────────────────────────────────────

export const DEV_SERVER_TOOLS: ToolExecutor[] = [devServerTool];
