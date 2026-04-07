/**
 * orager UI server — standalone HTTP server for browser-based configuration.
 *
 * Start with: orager ui [--port 3457]
 *
 * Binds to 127.0.0.1 only. No authentication required (local-only).
 * Serves a React SPA from dist/ui/ and exposes /api/* routes for
 * reading and writing ~/.orager/config.json and ~/.orager/settings.json.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { OragerUserConfig } from "./setup.js";
import { DEFAULT_CONFIG } from "./setup.js";
import type { OragerSettings } from "./settings.js";
import { isNewFormat } from "./config-migration.js";
import { listSessions } from "./session.js";
import { getSpanBuffer, type BufferedSpan } from "./telemetry.js";
import { isBlockedHost } from "./tools/web-fetch.js";
import { resolveUiResponse } from "./tools/render-ui.js";
import { formatDiscordPayload, postWebhook } from "./webhook.js";
import {
  isDailyRotation,
  getLogDir,
  dailyLogPath,
  getTodayDateStr,
  DAILY_LOG_PATTERN,
} from "./logger.js";
import split2 from "split2";

// ── Paths ─────────────────────────────────────────────────────────────────────

const ORAGER_DIR = path.join(os.homedir(), ".orager");
let _configPath = path.join(ORAGER_DIR, "config.json");
let _settingsPath = path.join(ORAGER_DIR, "settings.json");

/** @internal — test use only. Redirects config/settings file paths to a temp dir. */
export function _setPathsForTesting(configPath: string, settingsPath: string): void {
  _configPath = configPath;
  _settingsPath = settingsPath;
}
const UI_PORT_PATH = path.join(ORAGER_DIR, "ui.port");
const UI_PID_PATH = path.join(ORAGER_DIR, "ui.pid");

const DEFAULT_LOG_PATH = path.join(ORAGER_DIR, "orager.log");

/** Random bearer token generated at startup — printed to stdout for the user. */
const UI_AUTH_TOKEN = crypto.randomBytes(24).toString("hex");

// ── Single-instance PID lock (mirrors daemon.ts pattern) ─────────────────────

async function acquireUiPidLock(port: number): Promise<void> {
  await fs.mkdir(ORAGER_DIR, { recursive: true });
  const pidData = JSON.stringify({ pid: process.pid, port });

  // Attempt exclusive atomic write first — succeeds if no lock file exists
  try {
    await fs.writeFile(UI_PID_PATH, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (writeErr) {
    if ((writeErr as NodeJS.ErrnoException).code !== "EEXIST") throw writeErr;
  }

  // File exists — check if the existing process is still alive
  try {
    const existing = await fs.readFile(UI_PID_PATH, "utf8");
    const parsed = JSON.parse(existing) as { pid: number; port: number };
    try {
      process.kill(parsed.pid, 0); // signal 0 = existence check, no signal sent
      throw new Error(
        `orager ui is already running (pid ${parsed.pid}, port ${parsed.port}).\n` +
        `  Stop it first, or remove ${UI_PID_PATH} if the process is stale.`,
      );
    } catch (killErr) {
      // ESRCH = no such process → stale lock, fall through to reclaim
      if ((killErr as NodeJS.ErrnoException).code !== "ESRCH") throw killErr;
    }
  } catch (readErr) {
    if ((readErr as Error).message.startsWith("orager ui is already running")) throw readErr;
    // Unreadable/invalid PID file — treat as stale
  }

  // Stale lock — remove and reclaim
  await fs.unlink(UI_PID_PATH).catch(() => {});
  try {
    await fs.writeFile(UI_PID_PATH, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Race condition — another process grabbed it
    const existing2 = await fs.readFile(UI_PID_PATH, "utf8").catch(() => "{}");
    const parsed2 = JSON.parse(existing2) as { pid?: number; port?: number };
    if (parsed2.pid && parsed2.pid !== process.pid) {
      throw new Error(
        `orager ui is already running (pid ${parsed2.pid}, port ${parsed2.port ?? "?"}).`,
      );
    }
  }
}

async function releaseUiPidLock(): Promise<void> {
  await fs.unlink(UI_PID_PATH).catch(() => {});
}

// Static files live at dist/ui/ relative to this compiled file (dist/ui-server.js)
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_STATIC_DIR = path.join(DIST_DIR, "ui");

// ── MIME types ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        req.destroy();
        reject(new Error("Request body too large (max 512 KB)"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function stripSecrets<T extends object>(obj: T, keys: string[]): T {
  const lowerKeys = keys.map((k) => k.toLowerCase());
  // Build a new null-prototype object with only non-secret keys to avoid
  // remote-property-injection (CodeQL js/remote-property-injection).
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!lowerKeys.some((k) => key.toLowerCase().includes(k))) {
      result[key] = (obj as Record<string, unknown>)[key];
    }
  }
  return result as T;
}

// ── Config API ────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<OragerUserConfig> {
  try {
    const raw = await fs.readFile(_configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as OragerUserConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Recursively merge `source` into `target`. Objects are merged; arrays and
 * scalars in source overwrite target. Needed so that POSTing
 * `{ "advanced": { "temperature": 0.8 } }` doesn't wipe `advanced.summarization`.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    const existing = (result as Record<string, unknown>)[key];
    if (
      val !== null && typeof val === "object" && !Array.isArray(val) &&
      existing !== null && typeof existing === "object" && !Array.isArray(existing)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        existing as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = val;
    }
  }
  return result;
}

async function handleGetConfig(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const config = await loadConfig();
  // Never expose agentApiKey to the browser
  const safe = stripSecrets(config, ["agentApiKey", "key", "token", "secret"]);
  jsonResponse(res, 200, safe);
}

async function handlePostConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message });
    return;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    jsonResponse(res, 400, { error: "Body must be a JSON object" });
    return;
  }

  // Load existing config so we preserve fields not included in the POST body
  // (e.g. agentApiKey which is stripped from GET responses)
  const existing = await loadConfig();
  const incoming = body as Record<string, unknown>;

  // Reject any attempt to set agentApiKey through the UI for safety
  delete incoming["agentApiKey"];

  const merged: OragerUserConfig = deepMerge(existing as Record<string, unknown>, incoming) as OragerUserConfig;
  await atomicWrite(_configPath, JSON.stringify(merged, null, 2));
  const safe = stripSecrets(merged, ["agentApiKey", "key", "token", "secret"]);
  jsonResponse(res, 200, safe);
}

async function handleGetConfigDefaults(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  jsonResponse(res, 200, DEFAULT_CONFIG);
}

// ── Settings API ──────────────────────────────────────────────────────────────

async function loadSettingsRaw(): Promise<OragerSettings> {
  try {
    const raw = await fs.readFile(_settingsPath, "utf8");
    return JSON.parse(raw) as OragerSettings;
  } catch {
    return {};
  }
}

async function handleGetSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // If config.json is in new tiered format, extract settings-equivalent fields
  const config = await loadConfig();
  if (isNewFormat(config as Record<string, unknown>)) {
    const settings: OragerSettings = {};
    if (config.permissions) settings.permissions = config.permissions;
    if (config.bashPolicy) settings.bashPolicy = config.bashPolicy;
    if (config.hooks) settings.hooks = config.hooks;
    if (config.hooksEnabled !== undefined) settings.hooksEnabled = config.hooksEnabled;
    jsonResponse(res, 200, settings);
    return;
  }
  // Legacy: read from settings.json
  const settings = await loadSettingsRaw();
  jsonResponse(res, 200, settings);
}

async function handlePostSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message });
    return;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    jsonResponse(res, 400, { error: "Body must be a JSON object" });
    return;
  }

  // If config.json is in new tiered format, merge settings fields into config.json
  const config = await loadConfig();
  if (isNewFormat(config as Record<string, unknown>)) {
    const incoming = body as OragerSettings;
    const patch: Record<string, unknown> = {};
    if (incoming.permissions !== undefined) patch.permissions = incoming.permissions;
    if (incoming.bashPolicy !== undefined) patch.bashPolicy = incoming.bashPolicy;
    if (incoming.hooks !== undefined) patch.hooks = incoming.hooks;
    if (incoming.hooksEnabled !== undefined) patch.hooksEnabled = incoming.hooksEnabled;
    const merged = deepMerge(config as Record<string, unknown>, patch) as OragerUserConfig;
    await atomicWrite(_configPath, JSON.stringify(merged, null, 2));
    jsonResponse(res, 200, incoming);
    return;
  }

  // Legacy: write to settings.json
  const existing = await loadSettingsRaw();
  const merged: OragerSettings = { ...existing, ...(body as OragerSettings) };
  await atomicWrite(_settingsPath, JSON.stringify(merged, null, 2));
  jsonResponse(res, 200, merged);
}

// ── Sessions API ──────────────────────────────────────────────────────────────

async function handleSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));
    const all = await listSessions();
    const page = all.slice(offset, offset + limit);
    jsonResponse(res, 200, { sessions: page, total: all.length, limit, offset });
  } catch (err) {
    jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Logs API ──────────────────────────────────────────────────────────────────

interface LogEntry {
  ts?: string;
  level?: string;
  event?: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  [key: string]: unknown;
}

/**
 * Stream a single log file through the filter pipeline, pushing matching
 * entries into `out`. Resolves when the file is fully read.
 */
async function streamLogFile(
  filePath: string,
  out: LogEntry[],
  filters: { q: string; level: string; event: string; from: string; to: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let readStream: fsSync.ReadStream;
    try {
      readStream = fsSync.createReadStream(filePath, { encoding: "utf8" });
    } catch (err) { reject(err); return; }

    const splitter = split2();
    readStream.pipe(splitter);

    splitter.on("data", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let entry: LogEntry;
      try { entry = JSON.parse(trimmed) as LogEntry; } catch { return; }

      if (filters.level && entry.level !== filters.level) return;
      if (filters.event && (!entry.event || !entry.event.toLowerCase().includes(filters.event))) return;
      if (filters.from && entry.ts && entry.ts < filters.from) return;
      if (filters.to   && entry.ts && entry.ts > filters.to)   return;
      if (filters.q) {
        const haystack = JSON.stringify(entry).toLowerCase();
        if (!haystack.includes(filters.q)) return;
      }
      out.push(entry);
    });

    splitter.on("end",   resolve);
    splitter.on("error", reject);
    readStream.on("error", reject);
  }).catch(() => { /* non-fatal — return whatever was collected */ });
}

/**
 * Returns the list of daily log files that fall within the query's time
 * range, sorted oldest → newest. Includes one day of buffer on each side
 * to handle local-timezone vs UTC boundary edge cases; the entry-level
 * timestamp filter is always the authoritative filter.
 */
function dailyFilesInRange(logDir: string, from: string, to: string): string[] {
  let files: string[];
  try { files = fsSync.readdirSync(logDir); }
  catch { return []; }

  // Compute inclusive file-date bounds with ±1 day buffer for tz safety.
  const fromFileBound = from
    ? (() => { const d = new Date(from); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })()
    : "";
  const toFileBound = to
    ? (() => { const d = new Date(to);   d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()
    : "";

  return files
    .map((f) => { const m = DAILY_LOG_PATTERN.exec(f); return m ? { file: f, date: m[1]! } : null; })
    .filter((x): x is { file: string; date: string } => x !== null)
    .filter(({ date }) => (!fromFileBound || date >= fromFileBound) && (!toFileBound || date <= toFileBound))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ file }) => path.join(logDir, file));
}

async function handleGetLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url    = new URL(req.url ?? "/", "http://localhost");
  const q      = url.searchParams.get("q")?.toLowerCase() ?? "";
  const level  = url.searchParams.get("level") ?? "";
  const event  = url.searchParams.get("event")?.toLowerCase() ?? "";
  const from   = url.searchParams.get("from") ?? "";
  const to     = url.searchParams.get("to") ?? "";
  const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 500);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const filters = { q, level, event, from, to };
  const entries: LogEntry[] = [];

  if (isDailyRotation()) {
    // ── Daily rotation: read across multiple dated files ──────────────────────
    const logDir = getLogDir();
    const files  = dailyFilesInRange(logDir, from, to);

    if (files.length === 0) {
      jsonResponse(res, 200, { entries: [], total: 0, configured: true });
      return;
    }

    for (const filePath of files) {
      await streamLogFile(filePath, entries, filters);
    }
  } else {
    // ── Legacy: single named file ─────────────────────────────────────────────
    const logFile = process.env["ORAGER_LOG_FILE"] ?? DEFAULT_LOG_PATH;
    try {
      await streamLogFile(logFile, entries, filters);
    } catch (logErr) {
      if ((logErr as NodeJS.ErrnoException).code === "ENOENT") {
        jsonResponse(res, 200, { entries: [], total: 0, configured: true });
        return;
      }
      throw logErr;
    }
  }

  const total = entries.length;
  const page  = entries.slice(offset, offset + limit);
  jsonResponse(res, 200, {
    entries: page,
    total,
    truncated: total > offset + limit,
    configured: true,
  });
}

async function handleLogStream(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:5173",
  });
  res.write(": connected\n\n");

  // Resolve the initial file to tail.
  const resolveCurrentFile = (): string =>
    isDailyRotation()
      ? dailyLogPath(getTodayDateStr())
      : (process.env["ORAGER_LOG_FILE"] ?? DEFAULT_LOG_PATH);

  let watchedFile = resolveCurrentFile();
  let filePos = 0;
  try {
    const stat = await fs.stat(watchedFile);
    filePos = stat.size; // start from the end — only stream new lines
  } catch { /* file may not exist yet */ }

  let closed = false;
  res.on("close", () => {
    closed = true;
    fsSync.unwatchFile(watchedFile);
  });

  /** Read and emit any new bytes appended to watchedFile since filePos. */
  const readNewBytes = async (): Promise<void> => {
    try {
      const stat = await fs.stat(watchedFile);
      if (stat.size <= filePos) return; // unchanged
      const buf = Buffer.alloc(stat.size - filePos);
      // L-08: wrap fd operations in try/finally to prevent fd leak on read error
      const fd  = fsSync.openSync(watchedFile, "r");
      try {
        fsSync.readSync(fd, buf, 0, buf.length, filePos);
      } finally {
        fsSync.closeSync(fd);
      }
      filePos = stat.size;
      for (const line of buf.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as LogEntry;
          res.write("data: " + JSON.stringify(entry) + "\n\n");
        } catch { /* skip malformed lines */ }
      }
    } catch { /* non-fatal */ }
  };

  let onFileChange: () => Promise<void>;
  onFileChange = async () => {
    if (closed) return;

    // Midnight rollover: if the expected file path has changed, switch to it.
    const expectedFile = resolveCurrentFile();
    if (expectedFile !== watchedFile) {
      fsSync.unwatchFile(watchedFile);
      watchedFile = expectedFile;
      filePos = 0; // read from the start of the new daily file
      fsSync.watchFile(watchedFile, { interval: 500 }, onFileChange);
      // Fall through to read any lines already written to the new file.
    }

    await readNewBytes();
  };

  fsSync.watchFile(watchedFile, { interval: 500 }, onFileChange);
}

// ── Telemetry API ─────────────────────────────────────────────────────────────

async function handleGetSpans(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url    = new URL(req.url ?? "/", "http://localhost");
  const traceId = url.searchParams.get("traceId") ?? "";
  const name   = url.searchParams.get("name")?.toLowerCase() ?? "";
  const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 500);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const buf    = getSpanBuffer();
  let spans    = buf.getAll();

  if (traceId) spans = spans.filter((s) => s.traceId === traceId);
  if (name)    spans = spans.filter((s) => s.name.toLowerCase().includes(name));

  const total = spans.length;
  const page  = spans.slice(offset, offset + limit);

  jsonResponse(res, 200, {
    spans:      page,
    total,
    bufferSize: buf.size,
    bufferMax:  buf.max,
    configured: true,
  });
}

async function handleGetTraces(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const buf   = getSpanBuffer();
  const spans = buf.getAll();

  // Group by traceId
  const traceMap = new Map<string, BufferedSpan[]>();
  for (const s of spans) {
    const list = traceMap.get(s.traceId) ?? [];
    list.push(s);
    traceMap.set(s.traceId, list);
  }

  const traces = [...traceMap.entries()]
    .map(([traceId, traceSpans]) => {
      const root    = traceSpans.find((s) => !s.parentSpanId) ?? traceSpans[0];
      const start   = Math.min(...traceSpans.map((s) => s.startTimeMs));
      const end     = Math.max(...traceSpans.map((s) => s.endTimeMs));
      const errors  = traceSpans.filter((s) => s.status === "error").length;
      return {
        traceId,
        rootSpanName:     root?.name ?? "unknown",
        startTimeMs:      start,
        totalDurationMs:  end - start,
        spanCount:        traceSpans.length,
        errorCount:       errors,
      };
    })
    .sort((a, b) => b.startTimeMs - a.startTimeMs);

  jsonResponse(res, 200, { traces, total: traces.length, configured: true });
}

// ── Webhook test ─────────────────────────────────────────────────────────────

// ── Models proxy (fetches from OpenRouter /models) ──────────────────────────

let modelsCache: { data: unknown; fetchedAt: number } | null = null;
const MODELS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function handleGetModels(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Return cached if fresh
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL) {
    jsonResponse(res, 200, modelsCache.data);
    return;
  }
  let apiKey = process.env["PROTOCOL_API_KEY"] ?? "";
  if (!apiKey) {
    try {
      const cfg = await loadConfig();
      apiKey = (cfg as Record<string, unknown>).agentApiKey as string ?? "";
    } catch { /* ignore */ }
  }
  const baseUrl = (process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  try {
    // SSRF guard: validate that the base URL points to a public, non-internal host
    const parsedModelsUrl = new URL(`${baseUrl}/models`);
    if (await isBlockedHost(parsedModelsUrl.hostname)) {
      jsonResponse(res, 400, { error: "OPENROUTER_BASE_URL points to a blocked (internal) host" });
      return;
    }
    const upstream = await fetch(`${baseUrl}/models`, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "HTTP-Referer": "https://paperclip.ai",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) {
      jsonResponse(res, upstream.status, { error: `OpenRouter returned ${upstream.status}` });
      return;
    }
    // CodeQL: [js/file-access-to-http] — intentional proxy; data is from trusted OpenRouter API, sanitized below
    const json = await upstream.json() as { data?: unknown[] };
    const models = (json.data ?? []) as Array<{
      id: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string | number; completion?: string | number };
      architecture?: { input_modalities?: string[]; output_modalities?: string[] };
      supported_parameters?: string[];
    }>;
    // Slim down to what the UI needs
    const slim = models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      context_length: m.context_length ?? 0,
      prompt_price: m.pricing?.prompt ? Number(m.pricing.prompt) : 0,
      completion_price: m.pricing?.completion ? Number(m.pricing.completion) : 0,
      supports_vision: m.architecture?.input_modalities?.includes("image") ?? false,
      supports_audio: m.architecture?.input_modalities?.includes("audio") ?? false,
      // include_reasoning means the model exposes its thinking process with a
      // configurable budget (R1, o3, Claude extended thinking, etc.)
      supports_reasoning: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("include_reasoning"),
    }));
    // Extract unique providers
    const providers = [...new Set(slim.map((m) => m.id.split("/")[0]!).filter(Boolean))].sort();
    const result = { models: slim, providers };
    modelsCache = { data: result, fetchedAt: Date.now() };
    jsonResponse(res, 200, result);
  } catch (err) {
    jsonResponse(res, 502, { error: `Failed to fetch models: ${(err as Error).message}` });
  }
}

// ── Credits proxy (fetches from OpenRouter /auth/key) ────────────────────────

async function handleGetCredits(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let apiKey = process.env["PROTOCOL_API_KEY"] ?? "";
  if (!apiKey) {
    // Try reading from config file
    try {
      const cfg = await loadConfig();
      apiKey = (cfg as Record<string, unknown>).agentApiKey as string ?? "";
    } catch { /* ignore */ }
  }
  if (!apiKey) {
    jsonResponse(res, 200, { configured: false });
    return;
  }
  const baseUrl = (process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  try {
    // SSRF guard: validate that the base URL points to a public, non-internal host
    const parsedAuthUrl = new URL(`${baseUrl}/auth/key`);
    if (await isBlockedHost(parsedAuthUrl.hostname)) {
      jsonResponse(res, 400, { error: "OPENROUTER_BASE_URL points to a blocked (internal) host" });
      return;
    }
    const upstream = await fetch(`${baseUrl}/auth/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) {
      jsonResponse(res, upstream.status, { error: `Provider returned ${upstream.status}` });
      return;
    }
    const json = await upstream.json() as { data?: unknown };
    jsonResponse(res, 200, { configured: true, ...(json.data as Record<string, unknown>) });
  } catch (err) {
    jsonResponse(res, 502, { error: `Failed to fetch credits: ${(err as Error).message}` });
  }
}

async function handleWebhookTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let parsed: { url?: unknown; format?: unknown };
  try {
    parsed = await readJsonBody(req) as { url?: unknown; format?: unknown };
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON" });
    return;
  }
  if (typeof parsed.url !== "string" || !parsed.url) {
    jsonResponse(res, 400, { error: "url is required" });
    return;
  }
  let url: URL;
  try {
    url = new URL(parsed.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http/https");
  } catch {
    jsonResponse(res, 400, { error: "url must be a valid http/https URL" });
    return;
  }
  // H-03: SSRF protection — block requests to private/internal IP ranges
  try {
    const blocked = await isBlockedHost(url.hostname);
    if (blocked) {
      jsonResponse(res, 400, {
        error: `SSRF blocked: '${url.hostname}' resolves to a private or internal IP address`,
      });
      return;
    }
  } catch {
    // DNS error is non-fatal; let fetch surface network errors naturally
  }

  const format = parsed.format === "discord" ? "discord" : undefined;
  const secret = (globalThis as Record<string, unknown>).__oragerWebhookSecret as string | undefined;
  const testPayload = {
    type: "result" as const,
    subtype: "success" as const,
    result: "Test webhook from orager UI",
    session_id: "test-session-00000000",
    finish_reason: "stop",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
    turnCount: 1,
  };
  // Use postWebhook (same path as real deliveries) so test payloads are HMAC-signed
  // when a webhookSecret is configured, giving consumers a realistic test.
  const err = await postWebhook(url.toString(), testPayload, format, secret);
  if (err) {
    jsonResponse(res, 200, { ok: false, error: err });
  } else {
    jsonResponse(res, 200, { ok: true, status: 200 });
  }
}

// ── Static file serving ───────────────────────────────────────────────────────

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;

  // Security: prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^\/+/, "");
  const filePath = path.join(UI_STATIC_DIR, safePath || "index.html");
  if (!filePath.startsWith(UI_STATIC_DIR)) {
    jsonResponse(res, 403, { error: "Forbidden" });
    return;
  }

  async function serveIndex(): Promise<void> {
    try {
      const indexPath = path.join(UI_STATIC_DIR, "index.html");
      let html = await fs.readFile(indexPath, "utf8");
      // Inject auth token so the SPA can authenticate API calls.
      // Use a per-request nonce so the inline script passes CSP.
      const nonce = crypto.randomBytes(16).toString("base64");
      const tokenScript = `<script nonce="${nonce}">window.__ORAGER_TOKEN__="${UI_AUTH_TOKEN}";</script>`;
      html = html.replace("</head>", `${tokenScript}</head>`);
      const buf = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
        "Content-Security-Policy":
          `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
          "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
          "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
      });
      res.end(buf);
    } catch {
      jsonResponse(res, 503, { error: "UI not built. Run: npm run build:ui" });
    }
  }

  // If path has no extension, serve index.html (SPA client-side routing)
  if (!path.extname(safePath)) {
    await serveIndex();
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Fall back to index.html for any unknown path (SPA fallback)
      await serveIndex();
    } else {
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  }
}

// ── Auth check ───────────────────────────────────────────────────────────────

function checkUiAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  // Allow OPTIONS (preflight) without auth
  if (req.method === "OPTIONS") return true;
  // Static files (non-API) don't need auth — they're just the SPA bundle
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) return true;
  // API routes require the bearer token
  const auth = req.headers.authorization;
  if (auth === `Bearer ${UI_AUTH_TOKEN}`) return true;
  // Also accept as query param for SSE endpoints (EventSource can't set headers)
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.searchParams.get("token") === UI_AUTH_TOKEN) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized — pass the token printed at startup" }));
  return false;
}

// ── /api/tournament ──────────────────────────────────────────────────────────

async function handleTournament(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const { getAgentsDb } = await import("./agents/registry.js");
    const { getVariantStats, getVariantJudgeStats } = await import("./agents/score.js");

    const TEXT_AGENTS = ["explorer", "planner", "researcher", "coder", "reviewer"];
    const db = await getAgentsDb();

    const agents: Array<{
      agentId: string;
      variants: Array<{
        variantId: string;
        strategy: string;
        runs: number;
        successRate: number;
        vsBaseline: number | null;
        avgTurns: number;
        avgCostUsd: number;
        avgJudgeScore: number | null;
      }>;
    }> = [];

    for (const agentId of TEXT_AGENTS) {
      const stats = getVariantStats(db, agentId);
      if (stats.length === 0) continue;

      const judgeMap = getVariantJudgeStats(db, agentId);
      const originalId = `${agentId}-v0-original`;
      const originalRate = stats.find((s) => s.variantId === originalId)?.successRate ?? null;

      agents.push({
        agentId,
        variants: stats.map((s) => {
          const strategy = (() => {
            const prefix = `${agentId}-v`;
            if (!s.variantId.startsWith(prefix)) return s.variantId;
            const rest = s.variantId.slice(prefix.length);
            const idx = rest.indexOf("-");
            return idx >= 0 ? rest.slice(idx + 1) : rest;
          })();
          return {
            variantId: s.variantId,
            strategy,
            runs: s.runs,
            successRate: s.successRate,
            vsBaseline: originalRate != null && s.variantId !== originalId
              ? Math.round((s.successRate - originalRate) * 1000) / 1000
              : null,
            avgTurns: s.avgTurns,
            avgCostUsd: s.avgCostUsd,
            avgJudgeScore: judgeMap.get(s.variantId) ?? null,
          };
        }),
      });
    }

    // Vision per-model leaderboard
    const visionModelRows = db.prepare(
      `SELECT model_id,
              COUNT(*) AS runs,
              ROUND(AVG(CAST(success AS REAL)), 4) AS win_rate,
              ROUND(AVG(judge_score), 4) AS avg_judge
       FROM agent_scores
       WHERE agent_id = 'vision' AND model_id IS NOT NULL
       GROUP BY model_id
       ORDER BY win_rate DESC`,
    ).all() as Array<{ model_id: string; runs: number; win_rate: number; avg_judge: number | null }>;

    const visionModels = visionModelRows.map((r) => ({
      modelId: r.model_id,
      shortName: r.model_id.split("/").pop() ?? r.model_id,
      runs: r.runs,
      winRate: r.win_rate,
      avgJudgeScore: r.avg_judge ?? null,
    }));

    jsonResponse(res, 200, { agents, visionModels });
  } catch (err) {
    jsonResponse(res, 500, { error: (err as Error).message });
  }
}


// ── Intelligence endpoint ─────────────────────────────────────────────────────

/**
 * GET /api/intelligence?cwd=<path>&memoryKey=<key>
 *
 * Aggregates project-index, skillbank, and memory data into a single payload
 * for the Intelligence tab. All reads are non-fatal — missing data returns nulls.
 */
async function handleGetIntelligence(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const cwd = url.searchParams.get("cwd") ?? process.cwd();
  const memoryKey = url.searchParams.get("memoryKey") ?? "";

  try {
    const [
      { getProjectMap, formatProjectMap },
      { listSkills, getSkillStats },
      { isSqliteMemoryEnabled, resolveMemoryDbPath },
      { openDb },
      { memoryKeyFromCwd },
    ] = await Promise.all([
      import("./project-index.js"),
      import("./skillbank.js"),
      import("./memory-sqlite.js"),
      import("./native-sqlite.js"),
      import("./memory.js"),
    ]);

    const effectiveMemoryKey = memoryKey.trim() || memoryKeyFromCwd(cwd);

    // ── Project map (file intelligence) ───────────────────────────────────────
    const projectMap = await getProjectMap(cwd).catch(() => null);
    const projectMapText = projectMap
      ? await formatProjectMap(projectMap, cwd).catch(() => null)
      : null;

    // ── Skills (distilled knowledge) ──────────────────────────────────────────
    const skills = await listSkills(false).catch(() => []);
    const skillStats = await getSkillStats().catch(() => null);

    // ── Memory stats ──────────────────────────────────────────────────────────
    let memoryStats: { total: number; byType: Record<string, number> } | null = null;
    if (isSqliteMemoryEnabled()) {
      try {
        const dbPath = resolveMemoryDbPath(effectiveMemoryKey);
        const db = await openDb(dbPath).catch(() => null);
        if (db) {
          const now = new Date().toISOString();
          const total = (db.prepare(
            `SELECT COUNT(*) AS n FROM memory_entries WHERE memory_key=? AND type != 'master_context' AND (expires_at IS NULL OR expires_at > ?)`
          ).get(effectiveMemoryKey, now) as { n: number } | undefined)?.n ?? 0;

          const typeRows = db.prepare(
            `SELECT type, COUNT(*) AS n FROM memory_entries WHERE memory_key=? AND (expires_at IS NULL OR expires_at > ?) GROUP BY type`
          ).all(effectiveMemoryKey, now) as { type: string; n: number }[];
          const byType: Record<string, number> = {};
          for (const r of typeRows) byType[r.type] = r.n;
          memoryStats = { total, byType };
        }
      } catch { /* non-fatal */ }
    }

    // ── Session timeline — memory growth per session ───────────────────────────
    let sessionTimeline: { sessionId: string; date: string; memoryAdded: number }[] = [];
    if (isSqliteMemoryEnabled()) {
      try {
        const dbPath = resolveMemoryDbPath(effectiveMemoryKey);
        const db = await openDb(dbPath).catch(() => null);
        if (db) {
          const rows = db.prepare(`
            SELECT run_id AS sessionId, MIN(created_at) AS date, COUNT(*) AS memoryAdded
            FROM memory_entries
            WHERE memory_key=? AND run_id IS NOT NULL AND type != 'master_context'
            GROUP BY run_id
            ORDER BY date ASC
            LIMIT 50
          `).all(effectiveMemoryKey) as { sessionId: string; date: string; memoryAdded: number }[];
          sessionTimeline = rows;
        }
      } catch { /* non-fatal */ }
    }

    jsonResponse(res, 200, {
      cwd,
      memoryKey: effectiveMemoryKey,
      projectMap: projectMap ? {
        totalFiles: projectMap.totalFiles,
        clusters: projectMap.clusters,
        hotFiles: projectMap.hotFiles,
        entryPoints: projectMap.entryPoints,
        callChains: projectMap.callChains ?? [],
        indexedAt: projectMap.indexedAt,
        fromCache: projectMap.fromCache ?? false,
      } : null,
      projectMapText,
      skills,
      skillStats,
      memoryStats,
      sessionTimeline,
    });
  } catch (err) {
    jsonResponse(res, 500, { error: (err as Error).message });
  }
}

// ── Live run event bus ────────────────────────────────────────────────────────

interface RunSession {
  listeners: Set<http.ServerResponse>;
  lines: string[];   // pre-formatted "data: ...\n\n" SSE lines for replay
  done: boolean;
}

const RUN_SESSIONS = new Map<string, RunSession>();

function broadcastRunLine(runId: string, line: string): void {
  const session = RUN_SESSIONS.get(runId);
  if (!session) return;
  session.lines.push(line);
  for (const res of session.listeners) {
    try { res.write(line); } catch { /* client disconnected */ }
  }
}

function closeRunSession(runId: string): void {
  const session = RUN_SESSIONS.get(runId);
  if (!session) return;
  session.done = true;
  const doneLine = "data: " + JSON.stringify({ type: "done" }) + "\n\n";
  session.lines.push(doneLine);
  for (const res of session.listeners) {
    try { res.write(doneLine); res.end(); } catch { /* ignore */ }
  }
  session.listeners.clear();
  // GC after 10 minutes
  setTimeout(() => RUN_SESSIONS.delete(runId), 10 * 60 * 1000).unref();
}

async function handleUiResponse(
  _runId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: { requestId?: string; value?: unknown };
  try {
    body = await readJsonBody(req) as typeof body;
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON" });
    return;
  }
  const { requestId, value } = body;
  if (!requestId || typeof requestId !== "string") {
    jsonResponse(res, 400, { error: "requestId is required" });
    return;
  }
  const resolved = resolveUiResponse(requestId, JSON.stringify(value ?? null));
  if (!resolved) {
    jsonResponse(res, 404, { error: "No pending render_ui request found for this requestId" });
    return;
  }
  jsonResponse(res, 200, { ok: true });
}

async function handleStartRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: { prompt?: string; model?: string; maxTurns?: number; maxCostUsd?: number; cwd?: string };
  try {
    body = await readJsonBody(req) as typeof body;
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON" });
    return;
  }

  const { prompt, model, maxTurns, maxCostUsd, cwd: bodyCwd } = body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    jsonResponse(res, 400, { error: "prompt is required" });
    return;
  }

  const apiKey = process.env["OPENROUTER_API_KEY"] ?? process.env["PROTOCOL_API_KEY"] ?? "";
  if (!apiKey) {
    jsonResponse(res, 400, { error: "OPENROUTER_API_KEY is not set in the server environment" });
    return;
  }

  const runId = crypto.randomUUID();
  RUN_SESSIONS.set(runId, { listeners: new Set(), lines: [], done: false });
  jsonResponse(res, 200, { runId });

  const runCwd = bodyCwd ?? process.cwd();
  const runModel = (typeof model === "string" && model.trim()) ? model.trim() : "deepseek/deepseek-chat-v3-0324";

  import("./loop.js").then(({ runAgentLoop }) =>
    runAgentLoop({
      prompt: prompt.trim(),
      model: runModel,
      sessionId: null,
      apiKey,
      cwd: runCwd,
      maxTurns: typeof maxTurns === "number" ? maxTurns : 20,
      maxCostUsd: typeof maxCostUsd === "number" ? maxCostUsd : 1.00,
      dangerouslySkipPermissions: false,
      verbose: false,
      addDirs: [],
      onEmit: (event) => {
        broadcastRunLine(runId, "data: " + JSON.stringify(event) + "\n\n");
      },
    }),
  ).then(() => {
    closeRunSession(runId);
  }).catch((err: Error) => {
    broadcastRunLine(runId, "data: " + JSON.stringify({ type: "error", message: err.message }) + "\n\n");
    closeRunSession(runId);
  });
}

async function handleRunEvents(
  runId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const session = RUN_SESSIONS.get(runId);
  if (!session) {
    jsonResponse(res, 404, { error: "Run session not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  // Replay buffered events
  for (const line of session.lines) {
    res.write(line);
  }

  if (session.done) {
    res.end();
    return;
  }

  session.listeners.add(res);
  req.on("close", () => {
    session.listeners.delete(res);
  });
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // ── Security headers (audit E-09) ─────────────────────────────────────────
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // CORS: only allow cross-origin requests in development (vite dev server)
  if (process.env.NODE_ENV === "development" || process.env.ORAGER_UI_DEV === "1") {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!checkUiAuth(req, res)) return;

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname === "/api/config" && req.method === "GET") {
      await handleGetConfig(req, res);
    } else if (pathname === "/api/config" && req.method === "POST") {
      await handlePostConfig(req, res);
    } else if (pathname === "/api/config/defaults" && req.method === "GET") {
      await handleGetConfigDefaults(req, res);
    } else if (pathname === "/api/settings" && req.method === "GET") {
      await handleGetSettings(req, res);
    } else if (pathname === "/api/settings" && req.method === "POST") {
      await handlePostSettings(req, res);
    } else if (pathname === "/api/sessions" && req.method === "GET") {
      await handleSessions(req, res);
    } else if (pathname === "/api/logs" && req.method === "GET") {
      await handleGetLogs(req, res);
    } else if (pathname === "/api/logs/stream" && req.method === "GET") {
      await handleLogStream(req, res);
    } else if (pathname === "/api/telemetry/spans" && req.method === "GET") {
      await handleGetSpans(req, res);
    } else if (pathname === "/api/telemetry/traces" && req.method === "GET") {
      await handleGetTraces(req, res);
    } else if (pathname === "/api/models" && req.method === "GET") {
      await handleGetModels(req, res);
    } else if (pathname === "/api/credits" && req.method === "GET") {
      await handleGetCredits(req, res);
    } else if (pathname === "/api/webhook/test" && req.method === "POST") {
      await handleWebhookTest(req, res);
    } else if (pathname === "/api/tournament" && req.method === "GET") {
      await handleTournament(req, res);
    } else if (pathname === "/api/keychain/status" && req.method === "GET") {
      await handleKeychainStatus(req, res);
    } else if (pathname === "/api/keychain/key" && req.method === "POST") {
      await handleKeychainSetKey(req, res);
    } else if (pathname === "/api/keychain/key" && req.method === "DELETE") {
      await handleKeychainDeleteKey(req, res);
    } else if (pathname === "/api/intelligence" && req.method === "GET") {
      await handleGetIntelligence(req, res);
    } else if (pathname === "/api/run" && req.method === "POST") {
      await handleStartRun(req, res);
    } else if (pathname.startsWith("/api/run/") && pathname.endsWith("/events") && req.method === "GET") {
      const runId = pathname.slice("/api/run/".length, -"/events".length);
      await handleRunEvents(runId, req, res);
    } else if (pathname.startsWith("/api/run/") && pathname.endsWith("/ui_response") && req.method === "POST") {
      const runId = pathname.slice("/api/run/".length, -"/ui_response".length);
      await handleUiResponse(runId, req, res);
    } else if (pathname.startsWith("/api/")) {
      jsonResponse(res, 404, { error: "Not found" });
    } else {
      await serveStatic(req, res);
    }
  } catch (err) {
    process.stderr.write(`[orager-ui] unhandled error: ${(err as Error).message}\n`);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  }
}

// ── Keychain handlers ─────────────────────────────────────────────────────────

async function handleKeychainStatus(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { getAuthStatus, isKeychainSupported } = await import("./keychain.js");
  const status = await getAuthStatus();
  jsonResponse(res, 200, { supported: isKeychainSupported(), providers: status });
}

async function handleKeychainSetKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let parsed: { provider?: string; key?: string };
  try {
    parsed = await readJsonBody(req) as { provider?: string; key?: string };
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON" });
    return;
  }

  const { provider, key } = parsed;
  const VALID_PROVIDERS = new Set(["openrouter", "anthropic", "openai", "deepseek", "gemini"]);

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    jsonResponse(res, 400, { error: `Invalid provider. Must be one of: ${[...VALID_PROVIDERS].join(", ")}` });
    return;
  }
  if (!key || typeof key !== "string" || !key.trim()) {
    jsonResponse(res, 400, { error: "key must be a non-empty string" });
    return;
  }

  try {
    const { setKeychainKey } = await import("./keychain.js");
    await setKeychainKey(provider as import("./keychain.js").KeychainProvider, key.trim());
    jsonResponse(res, 200, { ok: true, provider });
  } catch (err) {
    jsonResponse(res, 500, { error: err instanceof Error ? err.message : "Failed to save key" });
  }
}

async function handleKeychainDeleteKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const provider = url.searchParams.get("provider");
  const VALID_PROVIDERS = new Set(["openrouter", "anthropic", "openai", "deepseek", "gemini"]);

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    jsonResponse(res, 400, { error: `Invalid provider. Must be one of: ${[...VALID_PROVIDERS].join(", ")}` });
    return;
  }

  const { deleteKeychainKey } = await import("./keychain.js");
  await deleteKeychainKey(provider as import("./keychain.js").KeychainProvider);
  jsonResponse(res, 200, { ok: true, provider });
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

/** @internal — test use only. Creates a real HTTP server without PID lock or signal handlers. */
export async function _createTestServer(port: number): Promise<{ server: http.Server; token: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, token: UI_AUTH_TOKEN });
    });
  });
}

export interface UiServerOptions {
  port?: number;
}

export async function startUiServer(opts: UiServerOptions = {}): Promise<void> {
  const port = opts.port ?? 3457;

  // Enforce single-instance before binding the port
  await acquireUiPidLock(port);

  const server = http.createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      void releaseUiPidLock();
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  // Write port file so tooling (and the setup wizard) can discover the server
  await atomicWrite(UI_PORT_PATH, String(port));

  const uiDir = UI_STATIC_DIR;
  const uiBuilt = fsSync.existsSync(path.join(uiDir, "index.html"));

  process.stdout.write(
    `[orager-ui] server running at http://127.0.0.1:${port}\n`,
  );
  process.stdout.write(`UI auth token: ${UI_AUTH_TOKEN}\n`);
  if (!uiBuilt) {
    process.stdout.write(
      `[orager-ui] WARNING: UI not built. Run 'npm run build:ui' then restart.\n`,
    );
  }

  // Clean up port and PID files on exit
  async function cleanup(): Promise<void> {
    try { await fs.unlink(UI_PORT_PATH); } catch { /* ignore */ }
    await releaseUiPidLock();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => {
    try { fsSync.unlinkSync(UI_PORT_PATH); } catch { /* ignore */ }
    try { fsSync.unlinkSync(UI_PID_PATH); } catch { /* ignore */ }
  });

  // Keep process alive
  await new Promise<never>(() => { /* server runs indefinitely */ });
}
