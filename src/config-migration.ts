/**
 * Config migration: transforms old flat config.json + settings.json into
 * the unified tiered format, and flattens the new format back to
 * ConfigFileSchema for the internal pipeline.
 *
 * Detection: if `rawConfig.advanced` exists as an object, the config is
 * already in new format — skip migration.
 *
 * The new format is ONLY for the user-facing ~/.orager/config.json.
 * Internally everything stays flat (ConfigFileSchema → parseArgs).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OragerSettings, MemoryConfig, TelemetryConfig } from "./settings.js";
import type { ConfigFileSchema } from "./cli/config-loading.js";

// ── New tiered config shape ──────────────────────────────────────────────────

export interface AdvancedConfig {
  // Sampling
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;

  // Reasoning
  reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  reasoningMaxTokens?: number;
  reasoningExclude?: boolean;

  // Summarization (merged from both config.json + settings.json memory block)
  summarization?: {
    summarizeAt?: number;
    model?: string;
    keepRecentTurns?: number;
    tokenPressureThreshold?: number;
    turnInterval?: number;
    ingestionMode?: "every_turn" | "periodic";
    ingestionInterval?: number;
  };

  // Memory (non-boolean parts)
  memory?: {
    maxChars?: number;
    retrieval?: "local" | "embedding";
    embeddingModel?: string;
  };

  // SkillBank (absorbed from settings.json skillbank)
  skills?: import("./types.js").SkillBankConfig;

  // Agent behavior
  planMode?: boolean;
  injectContext?: boolean;
  tagToolOutputs?: boolean;
  useFinishTool?: boolean;
  enableBrowserTools?: boolean;
  trackFileChanges?: boolean;

  // Identity
  siteUrl?: string;
  siteName?: string;

  // Security
  requireApproval?: "all" | string[];
  sandboxRoot?: string;
  agentApiKey?: string;

  // Webhook
  webhookUrl?: string;
  webhookFormat?: "discord";

  // Misc
  requiredEnvVars?: string[];
}

export interface ProvidersConfig {
  openrouter?: {
    sort?: "price" | "throughput" | "latency";
    dataCollection?: "allow" | "deny";
    zdr?: boolean;
    providerOrder?: string[];
    providerOnly?: string[];
    providerIgnore?: string[];
    siteUrl?: string;
    siteName?: string;
    apiKey?: string;
    apiKeys?: string[];
    preset?: string;
    transforms?: string[];
    provider?: Record<string, unknown>;
  };
  ollama?: {
    enabled?: boolean;
    model?: string;
    baseUrl?: string;
    checkModel?: boolean;
  };
  anthropic?: Record<string, unknown>;
  openai?: Record<string, unknown>;
  deepseek?: Record<string, unknown>;
  gemini?: Record<string, unknown>;
}

/** The unified config.json format (new tiered structure). */
export interface UnifiedConfig {
  // Tier 1 — Essential (root-level, no nesting)
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
  advanced?: AdvancedConfig;

  // Tier 3 — Provider-specific
  providers?: ProvidersConfig;

  // Absorbed from settings.json
  permissions?: Record<string, "allow" | "deny" | "ask">;
  bashPolicy?: import("./types.js").BashPolicy;
  hooks?: import("./hooks.js").HookConfig;
  hooksEnabled?: boolean;
  telemetry?: TelemetryConfig;

  // OMLS — only enabled flag here; full config in ~/.orager/omls.json
  omls?: { enabled?: boolean };

  // ── Legacy flat fields (kept for backward compat during transition) ────
  // These are read but NOT written by the migration. They exist so that
  // old config.json files still parse correctly before migration runs.
  /** @deprecated Use advanced.temperature */
  temperature?: number;
  /** @deprecated Use advanced.top_p */
  top_p?: number;
  /** @deprecated Use advanced.top_k */
  top_k?: number;
  /** @deprecated Use advanced.frequency_penalty */
  frequency_penalty?: number;
  /** @deprecated Use advanced.presence_penalty */
  presence_penalty?: number;
  /** @deprecated Use advanced.repetition_penalty */
  repetition_penalty?: number;
  /** @deprecated Use advanced.min_p */
  min_p?: number;
  /** @deprecated Use advanced.seed */
  seed?: number;
  /** @deprecated Use advanced.reasoningEffort */
  reasoningEffort?: string;
  /** @deprecated Use advanced.reasoningMaxTokens */
  reasoningMaxTokens?: number;
  /** @deprecated Use advanced.reasoningExclude */
  reasoningExclude?: boolean;
  /** @deprecated Use providers.openrouter.providerOrder */
  providerOrder?: string[];
  /** @deprecated Use providers.openrouter.providerOnly */
  providerOnly?: string[];
  /** @deprecated Use providers.openrouter.providerIgnore */
  providerIgnore?: string[];
  /** @deprecated Use providers.openrouter.sort */
  sort?: string;
  /** @deprecated Use providers.openrouter.dataCollection */
  dataCollection?: string;
  /** @deprecated Use providers.openrouter.zdr */
  zdr?: boolean;
  /** @deprecated Use advanced.summarization.summarizeAt */
  summarizeAt?: number;
  /** @deprecated Use advanced.summarization.model */
  summarizeModel?: string;
  /** @deprecated Use advanced.summarization.keepRecentTurns */
  summarizeKeepRecentTurns?: number;
  /** @deprecated Use advanced.memory.maxChars */
  memoryMaxChars?: number;
  /** @deprecated Use advanced.memory.retrieval */
  memoryRetrieval?: string;
  /** @deprecated Use advanced.memory.embeddingModel */
  memoryEmbeddingModel?: string;
  /** @deprecated Use advanced.siteUrl */
  siteUrl?: string;
  /** @deprecated Use advanced.siteName */
  siteName?: string;
  /** @deprecated Use advanced.requireApproval */
  requireApproval?: "all" | string[];
  /** @deprecated Use advanced.sandboxRoot */
  sandboxRoot?: string;
  /** @deprecated Use advanced.agentApiKey */
  agentApiKey?: string;
  /** @deprecated Use advanced.planMode */
  planMode?: boolean;
  /** @deprecated Use advanced.injectContext */
  injectContext?: boolean;
  /** @deprecated Use advanced.tagToolOutputs */
  tagToolOutputs?: boolean;
  /** @deprecated Use advanced.useFinishTool */
  useFinishTool?: boolean;
  /** @deprecated Use advanced.enableBrowserTools */
  enableBrowserTools?: boolean;
  /** @deprecated Use advanced.trackFileChanges */
  trackFileChanges?: boolean;
  /** @deprecated Use providers.ollama */
  ollama?: { enabled?: boolean; model?: string; baseUrl?: string };
  /** @deprecated Use advanced.webhookUrl */
  webhookUrl?: string;
  /** @deprecated Use advanced.webhookFormat */
  webhookFormat?: "discord";
  /** @deprecated Use advanced.requiredEnvVars */
  requiredEnvVars?: string[];
}

// ── Migration ────────────────────────────────────────────────────────────────

export interface MigrationResult {
  config: UnifiedConfig;
  migrated: boolean;
  warnings: string[];
  settingsAbsorbed: boolean;
}

/** Returns true if the config is already in the new tiered format. */
export function isNewFormat(raw: Record<string, unknown>): boolean {
  return typeof raw.advanced === "object" && raw.advanced !== null;
}

/**
 * Migrate an old-format config.json (+ optional settings.json) to the
 * new unified tiered format. Idempotent: already-migrated configs pass through.
 */
export async function migrateConfig(
  rawConfig: Record<string, unknown>,
  settingsPath?: string,
): Promise<MigrationResult> {
  const warnings: string[] = [];

  // Already migrated — pass through
  if (isNewFormat(rawConfig)) {
    return { config: rawConfig as unknown as UnifiedConfig, migrated: false, warnings, settingsAbsorbed: false };
  }

  // Work on a shallow copy
  const old = { ...rawConfig } as Record<string, unknown>;
  const config: UnifiedConfig = {};
  const advanced: AdvancedConfig = {};
  const providers: ProvidersConfig = {};

  // ── Tier 1: Essential (stay at root) ─────────────────────────────────────
  const tier1Keys = ["model", "models", "visionModel", "audioModel", "maxTurns",
    "maxRetries", "timeoutSec", "maxCostUsd", "maxCostUsdSoft", "memory",
    "memoryKey", "profile"] as const;
  for (const k of tier1Keys) {
    if (old[k] !== undefined) {
      (config as Record<string, unknown>)[k] = old[k];
      delete old[k];
    }
  }

  // ── Sampling → advanced.* ────────────────────────────────────────────────
  const samplingKeys = ["temperature", "top_p", "top_k", "frequency_penalty",
    "presence_penalty", "repetition_penalty", "min_p", "seed"] as const;
  for (const k of samplingKeys) {
    if (old[k] !== undefined) {
      (advanced as Record<string, unknown>)[k] = old[k];
      delete old[k];
    }
  }

  // ── Reasoning → advanced.* ───────────────────────────────────────────────
  const reasoningKeys = ["reasoningEffort", "reasoningMaxTokens", "reasoningExclude"] as const;
  for (const k of reasoningKeys) {
    if (old[k] !== undefined) {
      (advanced as Record<string, unknown>)[k] = old[k];
      delete old[k];
    }
  }

  // ── Summarization → advanced.summarization ───────────────────────────────
  const summarization: NonNullable<AdvancedConfig["summarization"]> = {};
  if (old.summarizeAt !== undefined) { summarization.summarizeAt = old.summarizeAt as number; delete old.summarizeAt; }
  if (old.summarizeModel !== undefined) { summarization.model = old.summarizeModel as string; delete old.summarizeModel; }
  if (old.summarizeKeepRecentTurns !== undefined) { summarization.keepRecentTurns = old.summarizeKeepRecentTurns as number; delete old.summarizeKeepRecentTurns; }
  if (Object.keys(summarization).length > 0) advanced.summarization = summarization;

  // ── Memory extras → advanced.memory ──────────────────────────────────────
  const memAdvanced: NonNullable<AdvancedConfig["memory"]> = {};
  if (old.memoryMaxChars !== undefined) { memAdvanced.maxChars = old.memoryMaxChars as number; delete old.memoryMaxChars; }
  if (old.memoryRetrieval !== undefined) { memAdvanced.retrieval = old.memoryRetrieval as "local" | "embedding"; delete old.memoryRetrieval; }
  if (old.memoryEmbeddingModel !== undefined) { memAdvanced.embeddingModel = old.memoryEmbeddingModel as string; delete old.memoryEmbeddingModel; }
  if (Object.keys(memAdvanced).length > 0) advanced.memory = memAdvanced;

  // ── Provider routing → providers.openrouter ──────────────────────────────
  const orCfg: NonNullable<ProvidersConfig["openrouter"]> = {};
  if (old.providerOrder !== undefined) { orCfg.providerOrder = old.providerOrder as string[]; delete old.providerOrder; }
  if (old.providerOnly !== undefined) { orCfg.providerOnly = old.providerOnly as string[]; delete old.providerOnly; }
  if (old.providerIgnore !== undefined) { orCfg.providerIgnore = old.providerIgnore as string[]; delete old.providerIgnore; }
  if (old.sort !== undefined) { orCfg.sort = old.sort as "price" | "throughput" | "latency"; delete old.sort; }
  if (old.dataCollection !== undefined) { orCfg.dataCollection = old.dataCollection as "allow" | "deny"; delete old.dataCollection; }
  if (old.zdr !== undefined) { orCfg.zdr = old.zdr as boolean; delete old.zdr; }
  if (Object.keys(orCfg).length > 0) providers.openrouter = orCfg;

  // ── Ollama → providers.ollama ────────────────────────────────────────────
  if (old.ollama && typeof old.ollama === "object") {
    providers.ollama = old.ollama as ProvidersConfig["ollama"];
    delete old.ollama;
  }

  // ── Identity → advanced.* ────────────────────────────────────────────────
  if (old.siteUrl !== undefined) { advanced.siteUrl = old.siteUrl as string; delete old.siteUrl; }
  if (old.siteName !== undefined) { advanced.siteName = old.siteName as string; delete old.siteName; }

  // ── Agent behavior → advanced.* ──────────────────────────────────────────
  const behaviorKeys = ["planMode", "injectContext", "tagToolOutputs", "useFinishTool",
    "enableBrowserTools", "trackFileChanges"] as const;
  for (const k of behaviorKeys) {
    if (old[k] !== undefined) {
      (advanced as Record<string, unknown>)[k] = old[k];
      delete old[k];
    }
  }

  // ── Security → advanced.* ────────────────────────────────────────────────
  if (old.requireApproval !== undefined) { advanced.requireApproval = old.requireApproval as "all" | string[]; delete old.requireApproval; }
  if (old.sandboxRoot !== undefined) { advanced.sandboxRoot = old.sandboxRoot as string; delete old.sandboxRoot; }
  if (old.agentApiKey !== undefined) { advanced.agentApiKey = old.agentApiKey as string; delete old.agentApiKey; }

  // ── Webhook → advanced.* ─────────────────────────────────────────────────
  if (old.webhookUrl !== undefined) { advanced.webhookUrl = old.webhookUrl as string; delete old.webhookUrl; }
  if (old.webhookFormat !== undefined) { advanced.webhookFormat = old.webhookFormat as "discord"; delete old.webhookFormat; }

  // ── Misc → advanced.* ────────────────────────────────────────────────────
  if (old.requiredEnvVars !== undefined) { advanced.requiredEnvVars = old.requiredEnvVars as string[]; delete old.requiredEnvVars; }

  // ── Assemble ─────────────────────────────────────────────────────────────
  if (Object.keys(advanced).length > 0) config.advanced = advanced;
  if (Object.keys(providers).length > 0) config.providers = providers;

  // ── Absorb settings.json ─────────────────────────────────────────────────
  let settingsAbsorbed = false;
  const sPath = settingsPath ?? path.join(os.homedir(), ".orager", "settings.json");
  try {
    const settingsRaw = await fs.readFile(sPath, "utf8");
    const settings = JSON.parse(settingsRaw) as OragerSettings;

    if (settings.permissions) config.permissions = settings.permissions;
    if (settings.bashPolicy) config.bashPolicy = settings.bashPolicy;
    if (settings.hooks) config.hooks = settings.hooks;
    if (settings.hooksEnabled !== undefined) config.hooksEnabled = settings.hooksEnabled;
    if (settings.telemetry) config.telemetry = settings.telemetry;

    // skillbank → advanced.skills
    if (settings.skillbank) {
      if (!config.advanced) config.advanced = {};
      config.advanced.skills = settings.skillbank;
    }

    // memory → advanced.summarization (fill in, don't overwrite)
    if (settings.memory) {
      if (!config.advanced) config.advanced = {};
      if (!config.advanced.summarization) config.advanced.summarization = {};
      const s = config.advanced.summarization;
      const m = settings.memory;
      if (m.tokenPressureThreshold !== undefined && s.tokenPressureThreshold === undefined)
        s.tokenPressureThreshold = m.tokenPressureThreshold;
      if (m.turnInterval !== undefined && s.turnInterval === undefined)
        s.turnInterval = m.turnInterval;
      if (m.keepRecentTurns !== undefined && s.keepRecentTurns === undefined)
        s.keepRecentTurns = m.keepRecentTurns;
      if (m.summarizationModel !== undefined && s.model === undefined)
        s.model = m.summarizationModel;
      if (m.ingestionMode !== undefined && s.ingestionMode === undefined)
        s.ingestionMode = m.ingestionMode;
      if (m.ingestionInterval !== undefined && s.ingestionInterval === undefined)
        s.ingestionInterval = m.ingestionInterval;
    }

    // providers from settings → merge into config.providers (config.json wins)
    if (settings.providers) {
      if (!config.providers) config.providers = {};
      for (const [prov, val] of Object.entries(settings.providers)) {
        if (val && typeof val === "object") {
          const existing = (config.providers as Record<string, unknown>)[prov];
          if (!existing) {
            (config.providers as Record<string, unknown>)[prov] = val;
          } else if (typeof existing === "object") {
            // Shallow merge — config.json wins on conflict
            (config.providers as Record<string, unknown>)[prov] = { ...val as object, ...existing as object };
          }
        }
      }
    }


    // Rename settings.json → settings.json.bak
    const bakPath = sPath + ".bak";
    try {
      await fs.access(bakPath);
      // .bak already exists — don't overwrite
      warnings.push(`settings.json.bak already exists — not overwriting. You can delete settings.json manually.`);
    } catch {
      try {
        await fs.rename(sPath, bakPath);
      } catch (err) {
        warnings.push(`Could not rename settings.json to .bak: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    settingsAbsorbed = true;
  } catch {
    // settings.json doesn't exist or can't be read — that's fine
  }

  // Warn about any remaining unrecognized keys from old config
  for (const k of Object.keys(old)) {
    warnings.push(`Unrecognized config key "${k}" was not migrated`);
  }

  return { config, migrated: true, warnings, settingsAbsorbed };
}

// ── Flatten (new format → ConfigFileSchema for internal pipeline) ────────────

/**
 * Flatten a UnifiedConfig back to the flat ConfigFileSchema shape so the
 * existing loadConfigFile → parseArgs pipeline works unchanged.
 */
export function flattenConfig(cfg: UnifiedConfig): ConfigFileSchema {
  const flat: ConfigFileSchema = {};

  // Tier 1 — straight copy
  if (cfg.model !== undefined) flat.model = cfg.model;
  if (cfg.models !== undefined) flat.models = cfg.models;
  if (cfg.visionModel !== undefined) flat.visionModel = cfg.visionModel;
  if (cfg.audioModel !== undefined) flat.audioModel = cfg.audioModel;
  if (cfg.maxTurns !== undefined) flat.maxTurns = cfg.maxTurns;
  if (cfg.maxRetries !== undefined) flat.maxRetries = cfg.maxRetries;
  if (cfg.timeoutSec !== undefined) flat.timeoutSec = cfg.timeoutSec;
  if (cfg.maxCostUsd !== undefined) flat.maxCostUsd = cfg.maxCostUsd;
  if (cfg.maxCostUsdSoft !== undefined) flat.maxCostUsdSoft = cfg.maxCostUsdSoft;
  if (cfg.memory !== undefined) flat.memory = cfg.memory;
  if (cfg.memoryKey !== undefined) flat.memoryKey = cfg.memoryKey;
  if (cfg.profile !== undefined) flat.profile = cfg.profile;

  // Advanced — unpack
  const a = cfg.advanced;
  if (a) {
    // Sampling
    if (a.temperature !== undefined) flat.temperature = a.temperature;
    if (a.top_p !== undefined) flat.top_p = a.top_p;
    if (a.top_k !== undefined) flat.top_k = a.top_k;
    if (a.frequency_penalty !== undefined) flat.frequency_penalty = a.frequency_penalty;
    if (a.presence_penalty !== undefined) flat.presence_penalty = a.presence_penalty;
    if (a.repetition_penalty !== undefined) flat.repetition_penalty = a.repetition_penalty;
    if (a.min_p !== undefined) flat.min_p = a.min_p;
    if (a.seed !== undefined) flat.seed = a.seed;

    // Reasoning
    if (a.reasoningEffort !== undefined) flat.reasoningEffort = a.reasoningEffort;
    if (a.reasoningMaxTokens !== undefined) flat.reasoningMaxTokens = a.reasoningMaxTokens;
    if (a.reasoningExclude !== undefined) flat.reasoningExclude = a.reasoningExclude;

    // Summarization
    if (a.summarization) {
      if (a.summarization.summarizeAt !== undefined) flat.summarizeAt = a.summarization.summarizeAt;
      if (a.summarization.model !== undefined) flat.summarizeModel = a.summarization.model;
      if (a.summarization.keepRecentTurns !== undefined) flat.summarizeKeepRecentTurns = a.summarization.keepRecentTurns;
    }

    // Memory
    if (a.memory) {
      if (a.memory.maxChars !== undefined) flat.memoryMaxChars = a.memory.maxChars;
      if (a.memory.retrieval !== undefined) flat.memoryRetrieval = a.memory.retrieval;
      if (a.memory.embeddingModel !== undefined) flat.memoryEmbeddingModel = a.memory.embeddingModel;
    }

    // Agent behavior
    if (a.planMode !== undefined) flat.planMode = a.planMode;
    if (a.injectContext !== undefined) flat.injectContext = a.injectContext;
    if (a.tagToolOutputs !== undefined) flat.tagToolOutputs = a.tagToolOutputs;
    if (a.useFinishTool !== undefined) flat.useFinishTool = a.useFinishTool;
    if (a.enableBrowserTools !== undefined) flat.enableBrowserTools = a.enableBrowserTools;
    if (a.trackFileChanges !== undefined) flat.trackFileChanges = a.trackFileChanges;

    // Identity
    if (a.siteUrl !== undefined) flat.siteUrl = a.siteUrl;
    if (a.siteName !== undefined) flat.siteName = a.siteName;

    // Security
    if (a.requireApproval !== undefined) flat.requireApproval = a.requireApproval;
    if (a.sandboxRoot !== undefined) flat.sandboxRoot = a.sandboxRoot;
    if (a.agentApiKey !== undefined) flat.agentApiKey = a.agentApiKey;

    // Webhook
    if (a.webhookUrl !== undefined) flat.webhookUrl = a.webhookUrl;
    if (a.webhookFormat !== undefined) flat.webhookFormat = a.webhookFormat;

    // Misc
    if (a.requiredEnvVars !== undefined) flat.requiredEnvVars = a.requiredEnvVars;
  }

  // Providers — unpack OpenRouter
  const or = cfg.providers?.openrouter;
  if (or) {
    if (or.providerOrder !== undefined) flat.providerOrder = or.providerOrder;
    if (or.providerOnly !== undefined) flat.providerOnly = or.providerOnly;
    if (or.providerIgnore !== undefined) flat.providerIgnore = or.providerIgnore;
    if (or.sort !== undefined) flat.sort = or.sort;
    if (or.dataCollection !== undefined) flat.dataCollection = or.dataCollection;
    if (or.zdr !== undefined) flat.zdr = or.zdr;
    if (or.preset !== undefined) flat.preset = or.preset;
    if (or.transforms !== undefined) flat.transforms = or.transforms;
  }

  // Providers — unpack Ollama
  const ol = cfg.providers?.ollama;
  if (ol) {
    flat.ollama = {
      enabled: ol.enabled,
      model: ol.model,
      baseUrl: ol.baseUrl,
    };
  }

  // Absorbed settings fields → pass through to result object
  // (hooks, bashPolicy, permissions are handled as complex objects)
  if (cfg.hooks) flat.hooks = cfg.hooks as Record<string, string>;
  if (cfg.bashPolicy) flat.bashPolicy = cfg.bashPolicy as Record<string, unknown>;

  // Legacy flat fields — if someone hasn't migrated yet and the code reads
  // the config directly, these provide fallback values
  if (!a) {
    // Copy all legacy flat fields that exist
    const legacyKeys = [
      "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty",
      "repetition_penalty", "min_p", "seed", "reasoningEffort", "reasoningMaxTokens",
      "reasoningExclude", "providerOrder", "providerOnly", "providerIgnore",
      "sort", "dataCollection", "zdr", "summarizeAt", "summarizeModel",
      "summarizeKeepRecentTurns", "memoryMaxChars", "memoryRetrieval",
      "memoryEmbeddingModel", "siteUrl", "siteName", "requireApproval",
      "sandboxRoot", "agentApiKey", "planMode", "injectContext", "tagToolOutputs",
      "useFinishTool", "enableBrowserTools", "trackFileChanges", "webhookUrl",
      "webhookFormat", "requiredEnvVars",
    ] as const;
    for (const k of legacyKeys) {
      const v = (cfg as Record<string, unknown>)[k];
      if (v !== undefined) (flat as Record<string, unknown>)[k] = v;
    }
    // Ollama legacy
    if (cfg.ollama && typeof cfg.ollama === "object" && !cfg.providers?.ollama) {
      flat.ollama = cfg.ollama;
    }
  }

  return flat;
}

// ── Persistence helper ───────────────────────────────────────────────────────

/**
 * Atomically write a migrated config to ~/.orager/config.json.
 * Uses the same tmp-then-rename pattern as setup.ts writeConfig().
 */
export async function persistMigratedConfig(
  config: UnifiedConfig,
  configPath?: string,
): Promise<void> {
  const filePath = configPath ?? path.join(os.homedir(), ".orager", "config.json");
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, filePath);
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => {});
  }
}
