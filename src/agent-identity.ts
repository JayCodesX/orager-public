/**
 * agent-identity.ts — Per-agent identity files on disk.
 *
 * Each identity-backed agent has a directory under ~/.orager/agents/<agent-id>/
 * containing markdown files that define who the agent is, how it operates,
 * what it has learned, and what it remembers.
 *
 * File structure:
 *   soul.md              — Personality, role, chain of command, operating principles
 *   operating-manual.md  — What to do on startup, recurring tasks, escalation rules
 *   memory.md            — Curated long-term knowledge (Layer 2)
 *   lessons.md           — Mistakes + permanent fixes (Layer 3)
 *   patterns.md          — Decision frameworks, tradeoff evaluations
 *   daily-logs/          — Raw daily journals (Layer 1)
 *     YYYY-MM-DD.md
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./agent-config.js";
import { createChannel, getChannelByName, addMember } from "./channel.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentLesson {
  date: string;
  what: string;
  why: string;
  fix: string;
  neverCompress?: boolean;
}

export interface AgentIdentity {
  id: string;
  soul: string;
  operatingManual: string;
  memory: string;
  lessons: AgentLesson[];
  patterns: string;
  dailyLogs: Map<string, string>;
}

/** Subset returned by list — avoids reading all files */
export interface AgentIdentitySummary {
  id: string;
  hasSoul: boolean;
  hasOperatingManual: boolean;
  lessonCount: number;
  dailyLogCount: number;
  lastDailyLog?: string;
  /** Agent role in the hierarchy */
  role?: "primary" | "specialist";
  /** Agent ID this agent reports to (null = reports to user) */
  reportsTo?: string | null;
  /** Display title (e.g. "Chief Marketing Officer") */
  title?: string;
}

// ── Identity file names ──────────────────────────────────────────────────────

const IDENTITY_FILES = [
  "soul.md",
  "operating-manual.md",
  "memory.md",
  "lessons.md",
  "patterns.md",
] as const;

type IdentityFile = (typeof IDENTITY_FILES)[number];

const DAILY_LOGS_DIR = "daily-logs";

// ── Path helpers ─────────────────────────────────────────────────────────────

function resolveAgentsRoot(): string {
  return path.join(os.homedir(), ".orager", "agents");
}

function resolveIdentityDir(agentId: string): string {
  return path.join(resolveAgentsRoot(), agentId);
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * List all identity-backed agents (directories that contain at least soul.md).
 */
export function listIdentities(): AgentIdentitySummary[] {
  const root = resolveAgentsRoot();
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const results: AgentIdentitySummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip non-identity dirs (e.g. agents.sqlite, *.json files)
    const dir = path.join(root, entry.name);
    const hasSoul = existsSync(path.join(dir, "soul.md"));
    if (!hasSoul) continue;

    const hasOperatingManual = existsSync(path.join(dir, "operating-manual.md"));
    const lessonsRaw = safeReadFile(path.join(dir, "lessons.md"));
    const lessonCount = lessonsRaw ? parseLessons(lessonsRaw).length : 0;

    const logsDir = path.join(dir, DAILY_LOGS_DIR);
    let dailyLogCount = 0;
    let lastDailyLog: string | undefined;
    if (existsSync(logsDir)) {
      const logs = readdirSync(logsDir).filter(f => f.endsWith(".md")).sort();
      dailyLogCount = logs.length;
      if (logs.length > 0) lastDailyLog = logs[logs.length - 1]!.replace(".md", "");
    }

    // Read config.json for hierarchy info (cheap — single JSON parse)
    const config = loadAgentConfig(entry.name);

    results.push({
      id: entry.name,
      hasSoul,
      hasOperatingManual,
      lessonCount,
      dailyLogCount,
      lastDailyLog,
      role: config.role,
      reportsTo: config.reportsTo,
      title: config.title,
    });
  }

  return results;
}

/**
 * Load all identity files for an agent.
 */
export function loadIdentity(agentId: string): AgentIdentity | null {
  const dir = resolveIdentityDir(agentId);
  if (!existsSync(path.join(dir, "soul.md"))) return null;

  const dailyLogs = new Map<string, string>();
  const logsDir = path.join(dir, DAILY_LOGS_DIR);
  if (existsSync(logsDir)) {
    for (const file of readdirSync(logsDir)) {
      if (!file.endsWith(".md")) continue;
      const date = file.replace(".md", "");
      dailyLogs.set(date, readFileSync(path.join(logsDir, file), "utf-8"));
    }
  }

  const lessonsRaw = safeReadFile(path.join(dir, "lessons.md")) ?? "";

  return {
    id: agentId,
    soul: safeReadFile(path.join(dir, "soul.md")) ?? "",
    operatingManual: safeReadFile(path.join(dir, "operating-manual.md")) ?? "",
    memory: safeReadFile(path.join(dir, "memory.md")) ?? "",
    lessons: parseLessons(lessonsRaw),
    patterns: safeReadFile(path.join(dir, "patterns.md")) ?? "",
    dailyLogs,
  };
}

/**
 * Create a new agent identity directory with seed files.
 * Optionally accepts config to write config.json and auto-creates a DM channel.
 */
export async function createIdentity(
  agentId: string,
  seed?: Partial<Pick<AgentIdentity, "soul" | "operatingManual" | "memory" | "patterns">>,
  config?: Partial<AgentConfig>,
): Promise<void> {
  const dir = resolveIdentityDir(agentId);
  if (existsSync(path.join(dir, "soul.md"))) {
    throw new Error(`Agent identity "${agentId}" already exists`);
  }

  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, DAILY_LOGS_DIR), { recursive: true });

  writeFileSync(path.join(dir, "soul.md"), seed?.soul ?? defaultSoul(agentId), "utf-8");
  writeFileSync(path.join(dir, "operating-manual.md"), seed?.operatingManual ?? defaultOperatingManual(agentId), "utf-8");
  writeFileSync(path.join(dir, "memory.md"), seed?.memory ?? "", "utf-8");
  writeFileSync(path.join(dir, "lessons.md"), "", "utf-8");
  writeFileSync(path.join(dir, "patterns.md"), seed?.patterns ?? "", "utf-8");

  // Write config.json if provided
  if (config && Object.keys(config).length > 0) {
    saveAgentConfig(agentId, config);
  }

  // Auto-create a DM channel between the user and this agent
  try {
    const dmName = `dm-${agentId}`;
    const existing = await getChannelByName(dmName);
    if (!existing) {
      await createChannel(dmName, `Direct line to ${agentId}`, ["user", agentId]);
    }
  } catch (err) {
    // Non-fatal — agent still works without a DM channel
    process.stderr.write(
      `[agent-identity] failed to create DM channel for ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Update a specific identity file.
 */
export function updateIdentityFile(
  agentId: string,
  file: IdentityFile,
  content: string,
): void {
  const dir = resolveIdentityDir(agentId);
  if (!existsSync(dir)) throw new Error(`Agent identity "${agentId}" does not exist`);
  writeFileSync(path.join(dir, file), content, "utf-8");
}

/**
 * Delete an agent identity directory entirely.
 */
export function deleteIdentity(agentId: string): boolean {
  const dir = resolveIdentityDir(agentId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Append a structured lesson to lessons.md.
 */
export function appendLesson(agentId: string, lesson: Omit<AgentLesson, "date">): void {
  const dir = resolveIdentityDir(agentId);
  if (!existsSync(dir)) throw new Error(`Agent identity "${agentId}" does not exist`);

  const date = todayDateString();
  const entry = formatLesson({ ...lesson, date });
  const filePath = path.join(dir, "lessons.md");

  // Ensure newline separation
  const existing = safeReadFile(filePath) ?? "";
  const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
  appendFileSync(filePath, separator + entry, "utf-8");
}

/**
 * Append text to today's daily log.
 */
export function appendDailyLog(agentId: string, content: string): void {
  const dir = resolveIdentityDir(agentId);
  if (!existsSync(dir)) throw new Error(`Agent identity "${agentId}" does not exist`);

  const logsDir = path.join(dir, DAILY_LOGS_DIR);
  mkdirSync(logsDir, { recursive: true });

  const date = todayDateString();
  const filePath = path.join(logsDir, `${date}.md`);

  const existing = safeReadFile(filePath) ?? "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
  appendFileSync(filePath, `${separator}### ${timestamp}\n\n${content}\n`, "utf-8");
}

// ── Boot sequence ────────────────────────────────────────────────────────────

/**
 * Build the identity context block for an agent's system prompt.
 * Called during agent boot when identityDir is set.
 *
 * Returns a string to inject into the system prompt, or null if no identity.
 */
export function buildIdentityBlock(agentId: string): string | null {
  const identity = loadIdentity(agentId);
  if (!identity) return null;

  const sections: string[] = [];

  // 1. Soul — who you are
  if (identity.soul.trim()) {
    sections.push(`<agent_identity>\n${identity.soul.trim()}\n</agent_identity>`);
  }

  // 2. Operating manual — how you work
  if (identity.operatingManual.trim()) {
    sections.push(`<operating_manual>\n${identity.operatingManual.trim()}\n</operating_manual>`);
  }

  // 3. Lessons — rules you must follow (never repeat these mistakes)
  if (identity.lessons.length > 0) {
    const lessonBlock = identity.lessons
      .map((l, i) => `${i + 1}. [${l.date}] ${l.fix}${l.neverCompress ? " [CRITICAL]" : ""}`)
      .join("\n");
    sections.push(`<lessons count="${identity.lessons.length}">\nThese are mistakes you've made before. NEVER repeat them:\n${lessonBlock}\n</lessons>`);
  }

  // 4. Patterns — decision frameworks
  if (identity.patterns.trim()) {
    sections.push(`<decision_patterns>\n${identity.patterns.trim()}\n</decision_patterns>`);
  }

  // 5. Memory — long-term curated knowledge
  if (identity.memory.trim()) {
    sections.push(`<agent_memory>\n${identity.memory.trim()}\n</agent_memory>`);
  }

  // 6. Recent daily log — where you left off
  const today = todayDateString();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const recentLog = identity.dailyLogs.get(today) ?? identity.dailyLogs.get(yesterday);
  if (recentLog?.trim()) {
    const logDate = identity.dailyLogs.has(today) ? today : yesterday;
    sections.push(`<daily_log date="${logDate}">\n${recentLog.trim()}\n</daily_log>`);
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}

// ── Lessons parser ───────────────────────────────────────────────────────────

/**
 * Parse lessons.md into structured AgentLesson objects.
 *
 * Expected format:
 *   ## YYYY-MM-DD
 *   **What:** Description of what happened
 *   **Why:** Why it happened
 *   **Fix:** What to do instead
 *
 * Lines starting with `<!-- neverCompress -->` mark the lesson as lossless.
 */
export function parseLessons(raw: string): AgentLesson[] {
  if (!raw.trim()) return [];

  const lessons: AgentLesson[] = [];
  const blocks = raw.split(/^## /m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const dateLine = lines[0]?.trim() ?? "";
    const date = dateLine.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
    if (!date) continue;

    const body = lines.slice(1).join("\n");
    const what = extractField(body, "What") ?? "";
    const why = extractField(body, "Why") ?? "";
    const fix = extractField(body, "Fix") ?? "";
    const neverCompress = body.includes("<!-- neverCompress -->");

    if (what || fix) {
      lessons.push({ date, what, why, fix, neverCompress: neverCompress || undefined });
    }
  }

  return lessons;
}

/**
 * Format a lesson into markdown for appending to lessons.md.
 */
export function formatLesson(lesson: AgentLesson): string {
  const lines = [`## ${lesson.date}`];
  if (lesson.neverCompress) lines.push("<!-- neverCompress -->");
  lines.push(`**What:** ${lesson.what}`);
  lines.push(`**Why:** ${lesson.why}`);
  lines.push(`**Fix:** ${lesson.fix}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

// ── Default templates ────────────────────────────────────────────────────────

function defaultSoul(agentId: string): string {
  return `# ${agentId}

## Role
<!-- Define this agent's primary role and responsibilities -->

## Personality
<!-- How should this agent communicate? Formal, casual, terse? -->

## Chain of Command
<!-- Who does this agent report to? Who can give it orders? -->
- Reports to: user

## Operating Principles
<!-- Core principles this agent follows -->
- Be thorough and accurate
- Ask for clarification when uncertain
- Learn from every interaction
`;
}

function defaultOperatingManual(agentId: string): string {
  return `# Operating Manual: ${agentId}

## On Startup
<!-- What should this agent do when it first boots? -->
1. Review recent daily log for context
2. Check for pending tasks
3. Report status

## Escalation Rules
<!-- When should this agent ask for help? -->
- Escalate to user when uncertain about destructive actions
- Escalate when cost exceeds budget threshold
`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function extractField(text: string, field: string): string | null {
  const match = text.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+?)(?=\\n\\*\\*|$)`, "s"));
  return match?.[1]?.trim() ?? null;
}
