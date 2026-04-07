/**
 * Tests for config-migration.ts — migrateConfig, flattenConfig, isNewFormat.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  migrateConfig,
  flattenConfig,
  isNewFormat,
  type UnifiedConfig,
} from "../src/config-migration.js";

// ── isNewFormat ──────────────────────────────────────────────────────────────

describe("isNewFormat", () => {
  it("returns false for old flat config", () => {
    expect(isNewFormat({ model: "gpt-4", temperature: 0.7 })).toBe(false);
  });

  it("returns true when advanced key exists as object", () => {
    expect(isNewFormat({ model: "gpt-4", advanced: { temperature: 0.7 } })).toBe(true);
  });

  it("returns false when advanced is null", () => {
    expect(isNewFormat({ model: "gpt-4", advanced: null })).toBe(false);
  });
});

// ── migrateConfig ────────────────────────────────────────────────────────────

describe("migrateConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-migration-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes through already-migrated configs (idempotent)", async () => {
    const newFormat = {
      model: "gpt-4",
      advanced: { temperature: 0.7 },
    };
    const result = await migrateConfig(newFormat, path.join(tmpDir, "no-settings.json"));
    expect(result.migrated).toBe(false);
    expect(result.config.advanced?.temperature).toBe(0.7);
  });

  it("moves sampling params to advanced.*", async () => {
    const old = { model: "gpt-4", temperature: 0.9, top_p: 0.95, min_p: 0.1, seed: 42 };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.migrated).toBe(true);
    expect(result.config.advanced?.temperature).toBe(0.9);
    expect(result.config.advanced?.top_p).toBe(0.95);
    expect(result.config.advanced?.min_p).toBe(0.1);
    expect(result.config.advanced?.seed).toBe(42);
    // Should NOT be at root
    expect((result.config as Record<string, unknown>).temperature).toBeUndefined();
  });

  it("moves reasoning params to advanced.*", async () => {
    const old = { reasoningEffort: "high", reasoningMaxTokens: 8192, reasoningExclude: true };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.config.advanced?.reasoningEffort).toBe("high");
    expect(result.config.advanced?.reasoningMaxTokens).toBe(8192);
    expect(result.config.advanced?.reasoningExclude).toBe(true);
  });

  it("moves summarization params to advanced.summarization", async () => {
    const old = { summarizeAt: 50000, summarizeModel: "gpt-4o-mini", summarizeKeepRecentTurns: 3 };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.config.advanced?.summarization?.summarizeAt).toBe(50000);
    expect(result.config.advanced?.summarization?.model).toBe("gpt-4o-mini");
    expect(result.config.advanced?.summarization?.keepRecentTurns).toBe(3);
  });

  it("moves memory extras to advanced.memory", async () => {
    const old = { memory: true, memoryKey: "proj-1", memoryMaxChars: 8000, memoryRetrieval: "embedding", memoryEmbeddingModel: "text-embedding-3-small" };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    // memory and memoryKey stay at root (Tier 1)
    expect(result.config.memory).toBe(true);
    expect(result.config.memoryKey).toBe("proj-1");
    // Extras go to advanced.memory
    expect(result.config.advanced?.memory?.maxChars).toBe(8000);
    expect(result.config.advanced?.memory?.retrieval).toBe("embedding");
    expect(result.config.advanced?.memory?.embeddingModel).toBe("text-embedding-3-small");
  });

  it("moves provider routing to providers.openrouter", async () => {
    const old = {
      providerOrder: ["Anthropic", "DeepSeek"],
      providerIgnore: ["Google"],
      sort: "price",
      dataCollection: "deny",
      zdr: true,
    };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    const or = result.config.providers?.openrouter;
    expect(or?.providerOrder).toEqual(["Anthropic", "DeepSeek"]);
    expect(or?.providerIgnore).toEqual(["Google"]);
    expect(or?.sort).toBe("price");
    expect(or?.dataCollection).toBe("deny");
    expect(or?.zdr).toBe(true);
  });

  it("moves ollama to providers.ollama", async () => {
    const old = { ollama: { enabled: true, model: "llama3.1:8b", baseUrl: "http://localhost:11434" } };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.config.providers?.ollama?.enabled).toBe(true);
    expect(result.config.providers?.ollama?.model).toBe("llama3.1:8b");
  });

  it("moves agent behavior to advanced.*", async () => {
    const old = { planMode: true, injectContext: false, trackFileChanges: true };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.config.advanced?.planMode).toBe(true);
    expect(result.config.advanced?.injectContext).toBe(false);
    expect(result.config.advanced?.trackFileChanges).toBe(true);
  });

  it("moves identity to advanced.*", async () => {
    const old = { siteUrl: "https://myapp.com", siteName: "my-agent" };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.config.advanced?.siteUrl).toBe("https://myapp.com");
    expect(result.config.advanced?.siteName).toBe("my-agent");
  });

  it("preserves Tier 1 keys at root", async () => {
    const old = { model: "gpt-4", maxTurns: 30, maxCostUsd: 10, profile: "dev" };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.config.model).toBe("gpt-4");
    expect(result.config.maxTurns).toBe(30);
    expect(result.config.maxCostUsd).toBe(10);
    expect(result.config.profile).toBe("dev");
  });

  it("absorbs settings.json when present", async () => {
    const settingsPath = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({
      permissions: { bash: "deny", write: "ask" },
      bashPolicy: { blockedCommands: ["rm -rf /"] },
      hooksEnabled: true,
      skillbank: { enabled: true, maxSkills: 200 },
      memory: { tokenPressureThreshold: 0.8, summarizationModel: "gpt-4o-mini" },
      telemetry: { enabled: true, endpoint: "http://localhost:4318" },
    }));

    const result = await migrateConfig({ model: "gpt-4" }, settingsPath);
    expect(result.settingsAbsorbed).toBe(true);
    expect(result.config.permissions).toEqual({ bash: "deny", write: "ask" });
    expect(result.config.bashPolicy).toEqual({ blockedCommands: ["rm -rf /"] });
    expect(result.config.hooksEnabled).toBe(true);
    expect(result.config.advanced?.skills?.enabled).toBe(true);
    expect(result.config.advanced?.skills?.maxSkills).toBe(200);
    expect(result.config.advanced?.summarization?.tokenPressureThreshold).toBe(0.8);
    expect(result.config.advanced?.summarization?.model).toBe("gpt-4o-mini");
    expect(result.config.telemetry?.enabled).toBe(true);
  });

  it("renames settings.json to settings.json.bak after absorption", async () => {
    const settingsPath = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ permissions: { bash: "allow" } }));

    await migrateConfig({ model: "gpt-4" }, settingsPath);

    // Original should be gone
    await expect(fs.access(settingsPath)).rejects.toThrow();
    // .bak should exist
    const bakStat = await fs.stat(settingsPath + ".bak");
    expect(bakStat.isFile()).toBe(true);
  });

  it("skips .bak rename when .bak already exists", async () => {
    const settingsPath = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ permissions: {} }));
    await fs.writeFile(settingsPath + ".bak", "old backup");

    const result = await migrateConfig({ model: "gpt-4" }, settingsPath);
    expect(result.warnings.some(w => w.includes("settings.json.bak already exists"))).toBe(true);
    // Original settings.json should still be there since .bak wasn't overwritten
    const bakContent = await fs.readFile(settingsPath + ".bak", "utf8");
    expect(bakContent).toBe("old backup");
  });

  it("config.json values win over settings.json on provider conflict", async () => {
    const settingsPath = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({
      providers: {
        openrouter: { sort: "latency", dataCollection: "allow" },
      },
    }));

    const old = { sort: "price", dataCollection: "deny" };
    const result = await migrateConfig(old, settingsPath);
    // config.json values should win
    expect(result.config.providers?.openrouter?.sort).toBe("price");
    expect(result.config.providers?.openrouter?.dataCollection).toBe("deny");
  });

  it("extracts OMLS to separate file and keeps only enabled flag", async () => {
    const settingsPath = path.join(tmpDir, "settings.json");
    const omlsDir = path.join(tmpDir, ".orager-omls");
    await fs.writeFile(settingsPath, JSON.stringify({
      omls: {
        enabled: true,
        mode: "auto",
        autoLoraThreshold: 150,
        rl: { enabled: true, backend: "vastai" },
      },
    }));

    const result = await migrateConfig({ model: "gpt-4" }, settingsPath);
    expect(result.config.omls).toEqual({ enabled: true });
  });

  it("warns about unrecognized keys", async () => {
    const old = { model: "gpt-4", unknownThing: 42, anotherWeirdKey: "hi" };
    const result = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
    expect(result.warnings).toContain('Unrecognized config key "unknownThing" was not migrated');
    expect(result.warnings).toContain('Unrecognized config key "anotherWeirdKey" was not migrated');
  });

  it("handles empty config gracefully", async () => {
    const result = await migrateConfig({}, path.join(tmpDir, "no-settings.json"));
    expect(result.migrated).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.warnings).toEqual([]);
  });
});

// ── flattenConfig ────────────────────────────────────────────────────────────

describe("flattenConfig", () => {
  it("flattens Tier 1 keys directly", () => {
    const cfg: UnifiedConfig = { model: "gpt-4", maxTurns: 20, memory: true };
    const flat = flattenConfig(cfg);
    expect(flat.model).toBe("gpt-4");
    expect(flat.maxTurns).toBe(20);
    expect(flat.memory).toBe(true);
  });

  it("flattens advanced sampling to root", () => {
    const cfg: UnifiedConfig = {
      advanced: { temperature: 0.9, top_p: 0.95, seed: 42 },
    };
    const flat = flattenConfig(cfg);
    expect(flat.temperature).toBe(0.9);
    expect(flat.top_p).toBe(0.95);
    expect(flat.seed).toBe(42);
  });

  it("flattens advanced.summarization to summarize* keys", () => {
    const cfg: UnifiedConfig = {
      advanced: {
        summarization: { summarizeAt: 50000, model: "gpt-4o-mini", keepRecentTurns: 3 },
      },
    };
    const flat = flattenConfig(cfg);
    expect(flat.summarizeAt).toBe(50000);
    expect(flat.summarizeModel).toBe("gpt-4o-mini");
    expect(flat.summarizeKeepRecentTurns).toBe(3);
  });

  it("flattens advanced.memory to memory* keys", () => {
    const cfg: UnifiedConfig = {
      advanced: { memory: { maxChars: 8000, retrieval: "embedding", embeddingModel: "emb-3" } },
    };
    const flat = flattenConfig(cfg);
    expect(flat.memoryMaxChars).toBe(8000);
    expect(flat.memoryRetrieval).toBe("embedding");
    expect(flat.memoryEmbeddingModel).toBe("emb-3");
  });

  it("flattens providers.openrouter to root routing keys", () => {
    const cfg: UnifiedConfig = {
      providers: {
        openrouter: {
          sort: "price",
          dataCollection: "deny",
          zdr: true,
          providerOrder: ["Anthropic"],
        },
      },
    };
    const flat = flattenConfig(cfg);
    expect(flat.sort).toBe("price");
    expect(flat.dataCollection).toBe("deny");
    expect(flat.zdr).toBe(true);
    expect(flat.providerOrder).toEqual(["Anthropic"]);
  });

  it("flattens providers.ollama to ollama object", () => {
    const cfg: UnifiedConfig = {
      providers: { ollama: { enabled: true, model: "llama3.1:8b" } },
    };
    const flat = flattenConfig(cfg);
    expect(flat.ollama?.enabled).toBe(true);
    expect(flat.ollama?.model).toBe("llama3.1:8b");
  });

  it("flattens agent behavior keys", () => {
    const cfg: UnifiedConfig = {
      advanced: { planMode: true, trackFileChanges: false, enableBrowserTools: true },
    };
    const flat = flattenConfig(cfg);
    expect(flat.planMode).toBe(true);
    expect(flat.trackFileChanges).toBe(false);
    expect(flat.enableBrowserTools).toBe(true);
  });

  it("handles legacy flat keys when no advanced block", () => {
    const cfg: UnifiedConfig = {
      model: "gpt-4",
      temperature: 0.7,
      sort: "price",
    } as UnifiedConfig;
    const flat = flattenConfig(cfg);
    expect(flat.temperature).toBe(0.7);
    expect(flat.sort).toBe("price");
  });

  it("passes hooks and bashPolicy through", () => {
    const cfg: UnifiedConfig = {
      hooks: { PreToolCall: "echo hi" } as Record<string, string>,
      bashPolicy: { blockedCommands: ["rm"] } as Record<string, unknown>,
    };
    const flat = flattenConfig(cfg);
    expect(flat.hooks).toEqual({ PreToolCall: "echo hi" });
    expect(flat.bashPolicy).toEqual({ blockedCommands: ["rm"] });
  });

  it("roundtrips: migrate then flatten preserves values", async () => {
    const old = {
      model: "deepseek/deepseek-chat-v3-0324",
      maxTurns: 20,
      temperature: 0.7,
      sort: "price",
      dataCollection: "deny",
      zdr: true,
      summarizeAt: 80000,
      memory: true,
      memoryMaxChars: 10000,
      planMode: false,
      siteUrl: "https://myapp.com",
      ollama: { enabled: true, model: "llama3.1:8b" },
    };

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rt-test-"));
    try {
      const { config } = await migrateConfig(old, path.join(tmpDir, "no-settings.json"));
      const flat = flattenConfig(config);

      expect(flat.model).toBe("deepseek/deepseek-chat-v3-0324");
      expect(flat.maxTurns).toBe(20);
      expect(flat.temperature).toBe(0.7);
      expect(flat.sort).toBe("price");
      expect(flat.dataCollection).toBe("deny");
      expect(flat.zdr).toBe(true);
      expect(flat.summarizeAt).toBe(80000);
      expect(flat.memory).toBe(true);
      expect(flat.memoryMaxChars).toBe(10000);
      expect(flat.planMode).toBe(false);
      expect(flat.siteUrl).toBe("https://myapp.com");
      expect(flat.ollama?.enabled).toBe(true);
      expect(flat.ollama?.model).toBe("llama3.1:8b");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
