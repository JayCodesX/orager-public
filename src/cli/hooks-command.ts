/**
 * hooks-command.ts — `orager hooks` subcommand
 *
 * Subcommands:
 *   orager hooks list                — show configured hooks
 *   orager hooks add <event> <cmd>   — add a shell command hook for the given event
 *   orager hooks remove <event> <cmd>— remove a specific hook command from the given event
 *   orager hooks seed-toolkit        — fetch toolkit hooks and configure settings.json
 *     [--dry-run]                      Preview without writing
 *     [--hooks <name,name,...>]         Only seed specific hooks (comma-separated)
 *     [--dir <path>]                   Directory to write hook scripts (default: ~/.orager/hooks/)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const TOOLKIT_RAW = "https://raw.githubusercontent.com/rohitg00/awesome-claude-code-toolkit/main";

function printLine(msg: string): void { process.stdout.write(msg + "\n"); }
function printErr(msg: string): void { process.stderr.write(msg + "\n"); }

// Curated hooks that map cleanly to orager's hook system
const CURATED_HOOKS: Array<{
  slug: string;           // filename in toolkit hooks/scripts/
  description: string;
  event: "PreToolCall" | "PostToolCall" | "SessionStart" | "SessionStop" | "Stop";
  tools?: string[];       // tool names this hook applies to (for PreToolCall filtering)
}> = [
  { slug: "secret-scanner",  description: "Block secrets before file writes",        event: "PreToolCall", tools: ["write_file", "edit_file"] },
  { slug: "commit-guard",    description: "Enforce conventional commit format",       event: "PreToolCall", tools: ["bash"] },
  { slug: "type-check",      description: "Run tsc --noEmit after TypeScript edits",  event: "PostToolCall", tools: ["write_file", "edit_file"] },
  { slug: "auto-test",       description: "Run related tests after file edits",       event: "PostToolCall", tools: ["write_file", "edit_file"] },
  { slug: "lint-fix",        description: "Auto-fix lint issues after writes",        event: "PostToolCall", tools: ["write_file", "edit_file"] },
  { slug: "learning-log",    description: "Save session learnings to daily log",      event: "SessionStop" },
  { slug: "session-start",   description: "Load previous context on session start",   event: "SessionStart" },
  { slug: "prompt-check",    description: "Detect vague prompts and request clarity", event: "PreToolCall" },
  { slug: "stop-check",      description: "Remind to run tests if code was modified", event: "Stop" },
];

// ── Seed toolkit hooks ────────────────────────────────────────────────────────

export async function handleSeedToolkitHooks(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");

  // --hooks <name,name,...>
  let selectedSlugs: string[] | null = null;
  const hooksIdx = argv.findIndex((a) => a === "--hooks");
  if (hooksIdx !== -1) {
    const val = argv[hooksIdx + 1];
    if (!val || val.startsWith("--")) {
      printErr("error: --hooks requires a comma-separated list of hook names");
      process.exit(1);
    }
    selectedSlugs = val.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // --dir <path>
  let hooksDir = path.join(os.homedir(), ".orager", "hooks");
  const dirIdx = argv.findIndex((a) => a === "--dir");
  if (dirIdx !== -1) {
    const val = argv[dirIdx + 1];
    if (!val || val.startsWith("--")) {
      printErr("error: --dir requires a path argument");
      process.exit(1);
    }
    hooksDir = val;
  }

  const hooksToSeed = selectedSlugs
    ? CURATED_HOOKS.filter((h) => selectedSlugs!.includes(h.slug))
    : CURATED_HOOKS;

  if (hooksToSeed.length === 0) {
    printErr("No matching hooks found. Available hooks:");
    for (const h of CURATED_HOOKS) {
      printErr(`  ${h.slug} (${h.event}): ${h.description}`);
    }
    process.exit(1);
  }

  printLine(`\nSeeding ${hooksToSeed.length} hook(s) from awesome-claude-code-toolkit…`);
  if (dryRun) printLine("(dry run — no files will be written)\n");

  if (!dryRun) {
    await fs.mkdir(hooksDir, { recursive: true });
  }

  const settingsPath = path.join(os.homedir(), ".orager", "settings.json");
  const { loadSettings } = await import("../settings.js");
  const currentSettings = await loadSettings(settingsPath);
  const newHooks: Record<string, string[]> = {};

  let written = 0;
  let failed = 0;

  for (const hook of hooksToSeed) {
    // Try .js first, then .py
    let content: string | null = null;
    let ext = "js";
    for (const tryExt of ["js", "py"]) {
      const url = `${TOOLKIT_RAW}/hooks/scripts/${hook.slug}.${tryExt}`;
      try {
        const res = await fetch(url, { headers: { "User-Agent": "orager-hooks/1.0" } });
        if (res.ok) {
          content = await res.text();
          ext = tryExt;
          break;
        }
      } catch { /* try next */ }
    }

    const scriptPath = path.join(hooksDir, `${hook.slug}.${ext}`);

    if (dryRun) {
      printLine(`  [dry-run] ${hook.slug}.${ext} → ${scriptPath}`);
      printLine(`            event: ${hook.event}${hook.tools ? ` (tools: ${hook.tools.join(", ")})` : ""}`);
      written++;
      continue;
    }

    if (content === null) {
      printErr(`  [error]   ${hook.slug} — could not fetch from toolkit`);
      failed++;
      continue;
    }

    try {
      // CodeQL: [js/http-to-file-access] — intentional: writing hook script from toolkit to project
      await fs.writeFile(scriptPath, content, { mode: 0o755, encoding: "utf8" });
      printLine(`  [written] ${hook.slug}.${ext} → ${scriptPath}`);
      written++;
    } catch (err) {
      printErr(`  [error]   ${hook.slug}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }

    // Accumulate settings entry
    if (!newHooks[hook.event]) newHooks[hook.event] = [];
    newHooks[hook.event]!.push(scriptPath);
  }

  if (dryRun) {
    printLine(`\nWould write ${written} script(s) to ${hooksDir}`);
    printLine("Would update ~/.orager/settings.json hooks section");
    return;
  }

  if (written === 0) {
    printLine("\nNo hooks were written.");
    return;
  }

  // ── Merge into settings.json ──────────────────────────────────────────────
  const existingHooks = (currentSettings.hooks ?? {}) as Record<string, string | string[]>;
  const mergedHooks: Record<string, string | string[]> = { ...existingHooks };

  for (const [event, scripts] of Object.entries(newHooks)) {
    const existing = mergedHooks[event];
    if (existing === undefined) {
      mergedHooks[event] = scripts.length === 1 ? scripts[0]! : scripts;
    } else {
      // Append (don't overwrite)
      const existingArr = Array.isArray(existing) ? existing : [existing];
      const combined = [...existingArr, ...scripts];
      mergedHooks[event] = combined;
    }
  }

  const updatedSettings = { ...currentSettings, hooks: mergedHooks };
  const updatedJson = JSON.stringify(updatedSettings, null, 2) + "\n";

  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, updatedJson, "utf8");
    printLine(`\nUpdated ~/.orager/settings.json with ${Object.keys(newHooks).length} hook event(s)`);
  } catch (err) {
    printErr(`Failed to update settings.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  printLine(`\nSeeded ${written} hook(s). Run \`orager hooks list\` to see configured hooks.`);
  if (failed > 0) printLine(`${failed} hook(s) failed to fetch.`);
}

// ── List hooks ────────────────────────────────────────────────────────────────

export async function handleListHooks(): Promise<void> {
  const { loadSettings } = await import("../settings.js");
  const settings = await loadSettings();
  const hooks = settings.hooks;

  if (!hooks || Object.keys(hooks).length === 0) {
    printLine("No hooks configured. Run `orager hooks seed-toolkit` to add curated hooks.");
    return;
  }

  printLine("\nConfigured hooks:\n");
  const events = Object.keys(hooks) as Array<keyof typeof hooks>;
  for (const event of events) {
    const target = hooks[event];
    if (!target) continue;
    const targets = Array.isArray(target) ? target : [target];
    printLine(`  ${event}:`);
    for (const t of targets) {
      if (typeof t === "string") {
        printLine(`    • ${t}`);
      } else if (typeof t === "object" && "url" in t) {
        printLine(`    • (url) ${(t as { url: string }).url}`);
      }
    }
  }
  printLine("");
}

// ── Valid event names ────────────────────────────────────────────────────────

const VALID_EVENTS = [
  "PreToolCall", "PostToolCall", "SessionStart", "SessionStop",
  "PreLLMRequest", "PostLLMResponse", "Stop", "ToolDenied", "ToolTimeout", "MaxTurnsReached",
] as const;

// ── Add hook ─────────────────────────────────────────────────────────────────

export async function handleAddHook(argv: string[]): Promise<void> {
  const event = argv[0];
  const command = argv.slice(1).join(" ");

  if (!event || !command) {
    printErr("Usage: orager hooks add <event> <command>");
    printErr(`Events: ${VALID_EVENTS.join(", ")}`);
    process.exit(1);
  }

  if (!VALID_EVENTS.includes(event as typeof VALID_EVENTS[number])) {
    printErr(`Unknown hook event '${event}'.`);
    printErr(`Valid events: ${VALID_EVENTS.join(", ")}`);
    process.exit(1);
  }

  const settingsPath = path.join(os.homedir(), ".orager", "settings.json");
  const { loadSettings } = await import("../settings.js");
  const settings = await loadSettings(settingsPath);

  const hooks = (settings.hooks ?? {}) as Record<string, string | string[]>;
  const existing = hooks[event];

  if (existing === undefined) {
    hooks[event] = command;
  } else if (typeof existing === "string") {
    if (existing === command) {
      printLine(`Hook already configured for ${event}.`);
      return;
    }
    hooks[event] = [existing, command];
  } else {
    if (existing.includes(command)) {
      printLine(`Hook already configured for ${event}.`);
      return;
    }
    existing.push(command);
  }

  const updated = { ...settings, hooks };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  printLine(`Added hook for ${event}: ${command}`);
}

// ── Remove hook ──────────────────────────────────────────────────────────────

export async function handleRemoveHook(argv: string[]): Promise<void> {
  const event = argv[0];
  const command = argv.slice(1).join(" ");

  if (!event || !command) {
    printErr("Usage: orager hooks remove <event> <command>");
    process.exit(1);
  }

  const settingsPath = path.join(os.homedir(), ".orager", "settings.json");
  const { loadSettings } = await import("../settings.js");
  const settings = await loadSettings(settingsPath);

  const hooks = (settings.hooks ?? {}) as Record<string, string | string[]>;
  const existing = hooks[event];

  if (existing === undefined) {
    printErr(`No hooks configured for ${event}.`);
    process.exit(1);
  }

  if (typeof existing === "string") {
    if (existing !== command) {
      printErr(`Hook command not found for ${event}.`);
      process.exit(1);
    }
    delete hooks[event];
  } else {
    const idx = existing.indexOf(command);
    if (idx === -1) {
      printErr(`Hook command not found for ${event}.`);
      process.exit(1);
    }
    existing.splice(idx, 1);
    if (existing.length === 0) delete hooks[event];
    else if (existing.length === 1) hooks[event] = existing[0]!;
  }

  const updated = { ...settings, hooks };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  printLine(`Removed hook for ${event}: ${command}`);
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function handleHooksSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printLine(`
orager hooks — manage agent run hooks

SUBCOMMANDS
  list                        Show configured hooks from ~/.orager/settings.json
  add <event> <command>       Add a shell command hook for the given event
  remove <event> <command>    Remove a hook command from the given event
  seed-toolkit                Fetch curated hooks from awesome-claude-code-toolkit

EVENTS
  ${VALID_EVENTS.join(", ")}

SEED-TOOLKIT FLAGS
  --dry-run                   Preview without writing files or updating settings
  --hooks <name,name,...>     Only seed the specified hooks (comma-separated)
  --dir <path>                Directory to write hook scripts (default: ~/.orager/hooks/)

AVAILABLE TOOLKIT HOOKS
${CURATED_HOOKS.map((h) => `  ${h.slug.padEnd(18)} [${h.event}] — ${h.description}`).join("\n")}
`);
    return;
  }

  if (sub === "list") {
    await handleListHooks();
    return;
  }

  if (sub === "add") {
    await handleAddHook(argv.slice(1));
    return;
  }

  if (sub === "remove") {
    await handleRemoveHook(argv.slice(1));
    return;
  }

  if (sub === "seed-toolkit") {
    await handleSeedToolkitHooks(argv.slice(1));
    return;
  }

  printErr(`orager hooks: unknown subcommand '${sub}'`);
  printErr("Run `orager hooks --help` for usage.");
  process.exit(1);
}
