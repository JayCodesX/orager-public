/**
 * mcp-command.ts — `orager mcp` subcommand.
 *
 * Subcommands:
 *   orager mcp list                        — show configured MCP servers
 *   orager mcp presets                     — list available preset bundles
 *   orager mcp add --preset <name>         — add a preset's servers to config.json
 *     [--dry-run]                            Preview without writing
 *     [--force]                              Overwrite existing servers
 *   orager mcp add <name> <command> [args] — add a single custom server
 *   orager mcp remove <name>               — remove a server from config.json
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { MCP_PRESETS, getPreset, getRequiredEnvVars, listPresetNames } from "../mcp-presets.js";
import type { McpPresetServer } from "../mcp-presets.js";

type McpServerEntry = { command: string; args?: string[]; env?: Record<string, string> };
type ConfigJson = { mcpServers?: Record<string, McpServerEntry>; [key: string]: unknown };

const CONFIG_PATH = path.join(os.homedir(), ".orager", "config.json");

function printLine(msg: string): void { process.stdout.write(msg + "\n"); }
function printErr(msg: string): void { process.stderr.write(msg + "\n"); }

// ── Config file helpers ──────────────────────────────────────────────────────

async function readConfig(): Promise<ConfigJson> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ConfigJson;
  } catch {
    return {};
  }
}

async function writeConfig(cfg: ConfigJson): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function stripDescription(server: McpPresetServer): McpServerEntry {
  const { description: _, ...entry } = server;
  return entry;
}

// ── Subcommand: list ─────────────────────────────────────────────────────────

async function handleList(): Promise<void> {
  const cfg = await readConfig();
  const servers = cfg.mcpServers ?? {};
  const names = Object.keys(servers);

  if (names.length === 0) {
    printLine("No MCP servers configured in ~/.orager/config.json");
    printLine("\nUse `orager mcp add --preset <name>` to add a curated preset.");
    printLine("Run `orager mcp presets` to see available presets.");
    return;
  }

  printLine(`\n${names.length} MCP server(s) configured:\n`);
  for (const [name, server] of Object.entries(servers)) {
    const cmd = [server.command, ...(server.args ?? [])].join(" ");
    const envKeys = server.env ? Object.keys(server.env) : [];
    const envStr = envKeys.length > 0 ? `  env: ${envKeys.join(", ")}` : "";
    printLine(`  ${name}`);
    printLine(`    ${cmd}${envStr}`);
  }
  printLine("");
}

// ── Subcommand: presets ──────────────────────────────────────────────────────

function handlePresets(): void {
  printLine("\nAvailable MCP presets:\n");
  for (const name of listPresetNames()) {
    const preset = MCP_PRESETS[name]!;
    const serverNames = Object.keys(preset.servers).join(", ");
    printLine(`  ${name}`);
    printLine(`    ${preset.description}`);
    printLine(`    Servers: ${serverNames}`);
    printLine("");
  }
  printLine("Usage: orager mcp add --preset <name>");
  printLine("");
}

// ── Subcommand: add ──────────────────────────────────────────────────────────

async function handleAdd(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const presetIdx = argv.indexOf("--preset");

  if (presetIdx !== -1) {
    // Add from preset
    const presetName = argv[presetIdx + 1];
    if (!presetName) {
      printErr("Usage: orager mcp add --preset <name>");
      printErr(`Available: ${listPresetNames().join(", ")}`);
      process.exit(1);
    }
    const preset = getPreset(presetName);
    if (!preset) {
      printErr(`Unknown preset: '${presetName}'`);
      printErr(`Available: ${listPresetNames().join(", ")}`);
      process.exit(1);
    }

    const cfg = await readConfig();
    const existing = cfg.mcpServers ?? {};
    let added = 0;
    let skipped = 0;

    if (dryRun) printLine(`\n[dry-run] Preset '${presetName}': ${preset.description}\n`);
    else printLine(`\nAdding preset '${presetName}': ${preset.description}\n`);

    const newServers: Record<string, McpServerEntry> = {};

    for (const [serverName, server] of Object.entries(preset.servers)) {
      if (existing[serverName] && !force) {
        printLine(`  [skip] ${serverName} — already configured (use --force to overwrite)`);
        skipped++;
        continue;
      }
      if (dryRun) {
        const cmd = [server.command, ...(server.args ?? [])].join(" ");
        printLine(`  [would add] ${serverName}: ${cmd}`);
        if (server.description) printLine(`              ${server.description}`);
        added++;
      } else {
        newServers[serverName] = stripDescription(server);
        added++;
        printLine(`  [added] ${serverName}`);
      }
    }

    if (!dryRun && added > 0) {
      cfg.mcpServers = { ...existing, ...newServers };
      await writeConfig(cfg);
    }

    // Show env var placeholders that need filling
    const envVars = getRequiredEnvVars(preset);
    if (envVars.size > 0) {
      printLine("\n⚠ The following env vars need your real values in ~/.orager/config.json:");
      for (const [serverName, vars] of envVars) {
        for (const v of vars) {
          printLine(`  mcpServers.${serverName}.env.${v}`);
        }
      }
    }

    printLine(`\n${added} added, ${skipped} skipped.`);
    if (!dryRun && added > 0) {
      printLine(`Config written to ${CONFIG_PATH}`);
    }
    printLine("");
    return;
  }

  // Add a single custom server: orager mcp add <name> <command> [args...]
  const cleanArgv = argv.filter((a) => !a.startsWith("--"));
  const [name, command, ...args] = cleanArgv;
  if (!name || !command) {
    printErr("Usage: orager mcp add <name> <command> [args...]");
    printErr("       orager mcp add --preset <preset-name>");
    process.exit(1);
  }

  const cfg = await readConfig();
  const existing = cfg.mcpServers ?? {};

  if (existing[name] && !force) {
    printErr(`Server '${name}' already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  if (dryRun) {
    printLine(`[dry-run] Would add server '${name}': ${command} ${args.join(" ")}`);
    return;
  }

  const entry: McpServerEntry = { command };
  if (args.length > 0) entry.args = args;

  cfg.mcpServers = { ...existing, [name]: entry };
  await writeConfig(cfg);
  printLine(`Added MCP server '${name}'. Config written to ${CONFIG_PATH}`);
}

// ── Subcommand: remove ───────────────────────────────────────────────────────

async function handleRemove(argv: string[]): Promise<void> {
  const name = argv.find((a) => !a.startsWith("--"));
  if (!name) {
    printErr("Usage: orager mcp remove <server-name>");
    process.exit(1);
  }

  const cfg = await readConfig();
  const existing = cfg.mcpServers ?? {};

  if (!existing[name]) {
    printErr(`Server '${name}' not found in config.`);
    printLine(`Configured servers: ${Object.keys(existing).join(", ") || "(none)"}`);
    process.exit(1);
  }

  delete existing[name];
  cfg.mcpServers = existing;
  await writeConfig(cfg);
  printLine(`Removed MCP server '${name}'. Config written to ${CONFIG_PATH}`);
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function handleMcpSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      await handleList();
      break;
    case "presets":
      handlePresets();
      break;
    case "add":
      await handleAdd(rest);
      break;
    case "remove":
    case "rm":
      await handleRemove(rest);
      break;
    default:
      printLine("Usage: orager mcp <subcommand> [args]");
      printLine("");
      printLine("Subcommands:");
      printLine("  list                       Show configured MCP servers");
      printLine("  presets                    List available preset bundles");
      printLine("  add --preset <name>        Add a curated preset bundle");
      printLine("    [--dry-run]                Preview without writing");
      printLine("    [--force]                  Overwrite existing servers");
      printLine("  add <name> <cmd> [args]    Add a single custom MCP server");
      printLine("  remove <name>              Remove a server from config");
      printLine("");
      printLine(`Available presets: ${listPresetNames().join(", ")}`);
      printLine("");
      if (sub && sub !== "--help" && sub !== "help") {
        printErr(`Unknown subcommand: '${sub}'`);
        process.exit(1);
      }
      break;
  }
}
