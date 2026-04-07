/**
 * Typed fetch helpers for the orager UI server API.
 * All paths are relative — the Vite dev proxy forwards /api/* to 127.0.0.1:3457.
 */

/** Tiered config — new format with advanced/providers nesting. */
export interface OragerUserConfig {
  // Tier 1 — Essential
  model?: string;
  models?: string[];
  visionModel?: string;
  audioModel?: string;
  maxTurns?: number;
  maxRetries?: number;
  timeoutSec?: number;
  maxCostUsd?: number;
  maxCostUsdSoft?: number;
  memory?: boolean;
  memoryKey?: string;
  profile?: string;

  // Tier 2 — Power user
  advanced?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    min_p?: number;
    seed?: number;
    reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    reasoningMaxTokens?: number;
    reasoningExclude?: boolean;
    summarization?: {
      summarizeAt?: number;
      model?: string;
      keepRecentTurns?: number;
      tokenPressureThreshold?: number;
      turnInterval?: number;
      ingestionMode?: "every_turn" | "periodic";
      ingestionInterval?: number;
    };
    memory?: {
      maxChars?: number;
      retrieval?: "local" | "embedding";
      embeddingModel?: string;
    };
    skills?: {
      enabled?: boolean;
      maxSkills?: number;
      topK?: number;
      autoExtract?: boolean;
      retentionDays?: number;
    };
    planMode?: boolean;
    injectContext?: boolean;
    tagToolOutputs?: boolean;
    useFinishTool?: boolean;
    enableBrowserTools?: boolean;
    trackFileChanges?: boolean;
    siteUrl?: string;
    siteName?: string;
    requireApproval?: "all" | string[];
    sandboxRoot?: string;
    webhookUrl?: string;
    webhookFormat?: "discord";
    requiredEnvVars?: string[];
  };

  // Tier 3 — Providers
  providers?: {
    openrouter?: {
      sort?: "price" | "throughput" | "latency";
      dataCollection?: "allow" | "deny";
      zdr?: boolean;
      providerOrder?: string[];
      providerOnly?: string[];
      providerIgnore?: string[];
    };
    ollama?: {
      enabled?: boolean;
      model?: string;
      baseUrl?: string;
    };
  };

  // Absorbed from settings.json
  permissions?: Record<string, "allow" | "deny" | "ask">;
  bashPolicy?: {
    blockedCommands?: string[];
    isolateEnv?: boolean;
    allowedEnvVars?: string[];
    denyEnvVars?: string[];
  };
  hooks?: {
    PreToolCall?: string;
    PostToolCall?: string;
    PreTurn?: string;
    PostTurn?: string;
  };
  hooksEnabled?: boolean;
  telemetry?: { enabled?: boolean; endpoint?: string };
  omls?: { enabled?: boolean };

  // Legacy flat fields (backward compat — server auto-migrates these)
  temperature?: number;
  top_p?: number;
  sort?: "price" | "throughput" | "latency";
  dataCollection?: "allow" | "deny";
  zdr?: boolean;
  summarizeAt?: number;
  summarizeModel?: string;
  memoryMaxChars?: number;
  memoryRetrieval?: "local" | "embedding";
  siteUrl?: string;
  siteName?: string;
  planMode?: boolean;
  injectContext?: boolean;
  tagToolOutputs?: boolean;
  useFinishTool?: boolean;
  enableBrowserTools?: boolean;
  trackFileChanges?: boolean;
  ollama?: { enabled?: boolean; model?: string; baseUrl?: string };
  webhookUrl?: string;
  webhookFormat?: "discord";
  requireApproval?: "all" | string[];
  sandboxRoot?: string;
}

export interface OragerSettings {
  permissions?: Record<string, "allow" | "deny" | "ask">;
  bashPolicy?: {
    blockedCommands?: string[];
    isolateEnv?: boolean;
    allowedEnvVars?: string[];
    denyEnvVars?: string[];
  };
  hooks?: {
    PreToolCall?: string;
    PostToolCall?: string;
    PreTurn?: string;
    PostTurn?: string;
  };
  hooksEnabled?: boolean;
}

export function getToken(): string {
  return (window as unknown as { __ORAGER_TOKEN__?: string }).__ORAGER_TOKEN__ ?? "";
}

/** Auth headers for direct fetch calls that bypass apiFetch. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => apiFetch<OragerUserConfig>("/api/config"),
  saveConfig: (cfg: Partial<OragerUserConfig>) =>
    apiFetch<OragerUserConfig>("/api/config", {
      method: "POST",
      body: JSON.stringify(cfg),
    }),
  getConfigDefaults: () => apiFetch<OragerUserConfig>("/api/config/defaults"),

  getSettings: () => apiFetch<OragerSettings>("/api/settings"),
  saveSettings: (s: OragerSettings) =>
    apiFetch<OragerSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify(s),
    }),

  testWebhook: (url: string, format?: "discord") =>
    apiFetch<{ ok: boolean; status?: number; error?: string }>("/api/webhook/test", {
      method: "POST",
      body: JSON.stringify({ url, format }),
    }),

  getOmlsStatus: () => apiFetch<{
    localAdapter: { version: number; backend: string; baseModel: string; trainedAt: string; trajectoryCount: number } | null;
    cloudEndpoint: string | null;
    bufferSize: number;
    skillGen: number;
  } | null>("/api/omls/status").catch(() => null),

  getIntelligence: (cwd?: string, memoryKey?: string) => {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (memoryKey) params.set("memoryKey", memoryKey);
    return apiFetch<IntelligenceResponse>(`/api/intelligence?${params.toString()}`);
  },

  startRun: (body: { prompt: string; model?: string; maxTurns?: number; maxCostUsd?: number }) =>
    apiFetch<{ runId: string }>("/api/run", { method: "POST", body: JSON.stringify(body) }),

  submitUiResponse: (runId: string, requestId: string, value: unknown) =>
    apiFetch<{ ok: true }>(`/api/run/${encodeURIComponent(runId)}/ui_response`, {
      method: "POST",
      body: JSON.stringify({ requestId, value }),
    }),

  getTournament: () => apiFetch<{
    agents: Array<{
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
    }>;
    visionModels: Array<{
      modelId: string;
      shortName: string;
      runs: number;
      winRate: number;
      avgJudgeScore: number | null;
    }>;
  }>("/api/tournament"),
};

// ── Intelligence types ────────────────────────────────────────────────────────

export interface FileCluster {
  name: string;
  files: string[];
  crossClusterImports?: number;
}

export interface Skill {
  id: string;
  text: string;
  useCount: number;
  successRate: number;
  createdAt: string;
  updatedAt: string;
  sourceSession: string;
  version: number;
}

export interface SkillStats {
  total: number;
  avgSuccessRate: number;
  topByUse: Skill[];
  weakSkills: Skill[];
}

export interface IntelligenceResponse {
  cwd: string;
  memoryKey: string;
  projectMap: {
    totalFiles: number;
    clusters: FileCluster[];
    hotFiles: string[];
    entryPoints: string[];
    callChains: string[];
    indexedAt: string;
    fromCache: boolean;
  } | null;
  projectMapText: string | null;
  skills: Skill[];
  skillStats: SkillStats | null;
  memoryStats: { total: number; byType: Record<string, number> } | null;
  sessionTimeline: { sessionId: string; date: string; memoryAdded: number }[];
}

// ── Keychain API ──────────────────────────────────────────────────────────────

interface KeychainStatus {
  supported: boolean;
  providers: Record<string, { configured: boolean }>;
}

export function getKeychainStatus(): Promise<KeychainStatus> {
  return apiFetch<KeychainStatus>("/api/keychain/status");
}

export function setKeychainKey(provider: string, key: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/keychain/key", {
    method: "POST",
    body: JSON.stringify({ provider, key }),
  });
}

export function deleteKeychainKey(provider: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/keychain/key?provider=${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}
