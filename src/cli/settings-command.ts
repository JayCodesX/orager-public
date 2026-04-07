/**
 * settings-command.ts — `orager settings` subcommand
 *
 * Subcommands:
 *   orager settings                — alias for "show"
 *   orager settings show           — pretty-print current settings.json
 *   orager settings path           — print path to settings.json
 *   orager settings validate       — validate settings.json, show warnings/errors
 *   orager settings edit           — open settings.json in $EDITOR
 *   orager settings set <key> <value>  — set a top-level key (JSON value)
 *   orager settings unset <key>    — remove a top-level key
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { validateSettings } from "../settings.js";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const RESET = "\x1b[0m";

function bold(s: string)   { return `${BOLD}${s}${RESET}`; }
function cyan(s: string)   { return `${CYAN}${s}${RESET}`; }
function green(s: string)  { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function red(s: string)    { return `${RED}${s}${RESET}`; }
function dim(s: string)    { return `${DIM}${s}${RESET}`; }

function print(msg: string): void  { process.stdout.write(msg + "\n"); }
function eprint(msg: string): void { process.stderr.write(msg + "\n"); }

// ── Settings path ─────────────────────────────────────────────────────────────

export function resolveSettingsPath(): string {
  return path.join(os.homedir(), ".orager", "settings.json");
}

async function readRaw(settingsPath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(settingsPath, "utf-8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeRaw(settingsPath: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function handleShow(settingsPath: string): Promise<void> {
  const raw = await readRaw(settingsPath);
  if (raw === null) {
    print(dim(`No settings file found at ${settingsPath}`));
    print(dim(`Run ${cyan("orager settings set <key> <value>")} to create one.`));
    return;
  }
  print(`\n${bold("Settings")} ${dim(`(${settingsPath})`)}\n`);
  print(JSON.stringify(raw, null, 2));
  print("");
}

async function handlePath(settingsPath: string): Promise<void> {
  print(settingsPath);
}

async function handleValidate(settingsPath: string): Promise<void> {
  const raw = await readRaw(settingsPath);
  if (raw === null) {
    print(yellow(`No settings file at ${settingsPath} — nothing to validate.`));
    return;
  }

  const { warnings, errors } = validateSettings(raw, settingsPath);

  if (errors.length === 0 && warnings.length === 0) {
    print(green("✓ Settings are valid — no issues found."));
    return;
  }

  for (const e of errors) {
    eprint(red(`ERROR: ${e}`));
  }
  for (const w of warnings) {
    print(yellow(`WARN:  ${w}`));
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

async function handleEdit(settingsPath: string): Promise<void> {
  // Ensure file exists before opening editor
  const raw = await readRaw(settingsPath);
  if (raw === null) {
    await writeRaw(settingsPath, {});
    print(dim(`Created empty settings file at ${settingsPath}`));
  }

  const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi";
  const { status } = spawnSync(editor, [settingsPath], { stdio: "inherit" });
  if (status !== 0) {
    eprint(red(`Editor exited with code ${status}`));
    process.exitCode = 1;
  }
}

async function handleSet(settingsPath: string, key: string, valueStr: string): Promise<void> {
  // Parse value as JSON, falling back to plain string
  let value: unknown;
  try {
    value = JSON.parse(valueStr);
  } catch {
    value = valueStr;
  }

  const raw = (await readRaw(settingsPath)) ?? {};
  raw[key] = value;
  await writeRaw(settingsPath, raw);
  print(green(`Set ${bold(key)} = ${JSON.stringify(value)}`));
}

async function handleUnset(settingsPath: string, key: string): Promise<void> {
  const raw = await readRaw(settingsPath);
  if (raw === null || !(key in raw)) {
    print(yellow(`Key ${bold(key)} not found in settings — nothing to remove.`));
    return;
  }
  delete raw[key];
  await writeRaw(settingsPath, raw);
  print(green(`Removed ${bold(key)} from settings.`));
}

// ── Help text ─────────────────────────────────────────────────────────────────

function printUsage(): void {
  print(`
${bold("orager settings")} — view and edit ~/.orager/settings.json

${bold("USAGE")}
  orager settings [subcommand] [options]

${bold("SUBCOMMANDS")}
  show              Pretty-print current settings (default)
  path              Print path to settings.json
  validate          Validate settings and report warnings/errors
  edit              Open settings.json in $EDITOR
  set <key> <val>   Set a top-level key (value parsed as JSON or string)
  unset <key>       Remove a top-level key

${bold("EXAMPLES")}
  ${dim("# Show current settings")}
  orager settings

  ${dim("# Set hooks to disabled")}
  orager settings set hooksEnabled false

  ${dim("# Configure memory summarization model")}
  orager settings set memory '{"summarizationModel":"openai/gpt-4o-mini"}'

  ${dim("# Open in editor")}
  orager settings edit

  ${dim("# Validate after manual edits")}
  orager settings validate

${bold("KNOWN KEYS")}
  permissions, bashPolicy, hooks, hooksEnabled,
  skillbank, omls, memory, telemetry, providers
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleSettingsSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  const settingsPath = resolveSettingsPath();

  if (!sub || sub === "show") {
    await handleShow(settingsPath);
    return;
  }

  if (sub === "path") {
    await handlePath(settingsPath);
    return;
  }

  if (sub === "validate") {
    await handleValidate(settingsPath);
    return;
  }

  if (sub === "edit") {
    await handleEdit(settingsPath);
    return;
  }

  if (sub === "set") {
    const key = argv[1];
    const val = argv[2];
    if (!key || val === undefined) {
      eprint(red("Usage: orager settings set <key> <value>"));
      process.exitCode = 1;
      return;
    }
    await handleSet(settingsPath, key, val);
    return;
  }

  if (sub === "unset") {
    const key = argv[1];
    if (!key) {
      eprint(red("Usage: orager settings unset <key>"));
      process.exitCode = 1;
      return;
    }
    await handleUnset(settingsPath, key);
    return;
  }

  eprint(red(`Unknown subcommand: ${sub}`));
  printUsage();
  process.exitCode = 1;
}
