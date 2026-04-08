/**
 * agent-config.ts — Per-agent configuration stored as config.json.
 *
 * Lives alongside identity files at ~/.orager/agents/<agent-id>/config.json.
 * Contains role hierarchy, model preferences, permissions, and runtime limits.
 *
 * This is the backend-authoritative store — the desktop's localStorage-based
 * AgentConfig is a client cache that will migrate to call these RPCs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentRole = "primary" | "specialist";

export interface AgentPermissions {
  /** Can this agent create other agents? */
  createAgents?: boolean;
  /** Can this agent use the terminal/bash tool? */
  bash?: boolean;
  /** Can this agent browse the web? */
  webAccess?: boolean;
  /** Can this agent read/write/edit files? */
  fileSystem?: boolean;
  /** Can this agent use MCP servers? */
  mcp?: boolean;
}

export interface AgentConfig {
  /** Role in the hierarchy: "primary" (CEO-level) or "specialist" */
  role: AgentRole;
  /** Agent ID this agent reports to. null = reports to user directly */
  reportsTo: string | null;
  /** Display label for the agent's function (e.g. "Chief Marketing Officer") */
  title?: string;
  /** Which API provider to use: "openrouter" | "anthropic" | "openai" | "gemini" | "deepseek" */
  provider?: string;
  /** Primary model ID (e.g. "openai/gpt-4o") */
  model?: string;
  /** Fallback model used when primary fails */
  fallbackModel?: string;
  /** Vision model for image inputs */
  visionModel?: string;
  /** Max turns per run */
  maxTurns?: number;
  /** Hard cost cap (USD) per run */
  maxCostUsd?: number;
  /** Agent permissions */
  permissions?: AgentPermissions;
  /** Template ID this agent was created from (for provenance) */
  templateId?: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AgentConfig = {
  role: "specialist",
  reportsTo: null,
};

const CONFIG_FILENAME = "config.json";

// ── Path helpers ─────────────────────────────────────────────────────────────

function resolveAgentsRoot(): string {
  return path.join(os.homedir(), ".orager", "agents");
}

function resolveConfigPath(agentId: string): string {
  return path.join(resolveAgentsRoot(), agentId, CONFIG_FILENAME);
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Load an agent's config.json. Returns defaults if file doesn't exist.
 */
export function loadAgentConfig(agentId: string): AgentConfig {
  const configPath = resolveConfigPath(agentId);
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Corrupted JSON — return defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save an agent's config.json. Creates the directory if needed.
 */
export function saveAgentConfig(agentId: string, config: Partial<AgentConfig>): void {
  const configPath = resolveConfigPath(agentId);
  const dir = path.dirname(configPath);
  mkdirSync(dir, { recursive: true });

  // Merge with existing config to preserve fields not in the update
  const existing = loadAgentConfig(agentId);
  const merged = { ...existing, ...config };

  // Clean undefined values
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) clean[k] = v;
  }

  writeFileSync(configPath, JSON.stringify(clean, null, 2) + "\n", "utf-8");
}

/**
 * Check if an agent has a specific permission.
 */
export function hasPermission(agentId: string, perm: keyof AgentPermissions): boolean {
  const config = loadAgentConfig(agentId);
  return config.permissions?.[perm] === true;
}

/**
 * Get the chain of command for an agent (walk up reportsTo).
 * Returns [immediate supervisor, ..., top-level primary].
 * Guards against circular references with a max depth.
 */
export function getChainOfCommand(agentId: string, maxDepth = 10): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = agentId;

  for (let i = 0; i < maxDepth; i++) {
    if (!currentId || visited.has(currentId)) break;
    visited.add(currentId);

    const config = loadAgentConfig(currentId);
    if (config.reportsTo) {
      chain.push(config.reportsTo);
      currentId = config.reportsTo;
    } else {
      break;
    }
  }

  return chain;
}

/**
 * List all agents that report to a given agent.
 */
export function getDirectReports(agentId: string): string[] {
  const root = resolveAgentsRoot();
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const reports: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === agentId) continue;
    const config = loadAgentConfig(entry.name);
    if (config.reportsTo === agentId) {
      reports.push(entry.name);
    }
  }

  return reports;
}
