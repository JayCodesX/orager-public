/**
 * seed-toolkit-command.ts — `orager skills seed-toolkit`
 *
 * Seeds SkillBank with curated skills, agent personas, and rules from a
 * GitHub toolkit repository.
 *
 * Default repo: https://github.com/rohitg00/awesome-claude-code-toolkit
 *
 * Content fetched:
 *   skills/{name}/SKILL.md    → prompt-only skill instructions
 *   agents/{category}/{name}.md → agent personas (system prompts)
 *   rules/{name}.md           → best practice rules (seeded with high success_rate)
 *   commands/{category}/{name}.md → command templates (written to disk)
 *
 * Flags:
 *   --repo <owner/repo>  Use a custom GitHub toolkit repo (default: rohitg00/awesome-claude-code-toolkit)
 *   --dry-run            Print what would be imported without writing to DB
 *   --skills-only        Only import skills/ entries
 *   --agents-only        Only import agents/ entries
 *   --rules-only         Only import rules/ entries
 *   --commands           Also import commands/ entries (written to disk, not SkillBank)
 *   --commands-only      Only import commands/ entries
 *   --local              Write commands to .orager/commands/ in cwd (default: ~/.orager/commands/)
 *   --limit <n>          Stop after n insertions (default: unlimited)
 *   --preview            Show counts without importing
 */

import os from "node:os";
import {
  seedToolkit,
  previewToolkit,
  parseRepoString,
  type ToolkitRepo,
  type ToolkitItemType,
} from "../toolkit.js";

const DEFAULT_REPO = "rohitg00/awesome-claude-code-toolkit";

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

export async function handleSeedToolkitSubcommand(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const preview = argv.includes("--preview");
  const skillsOnly = argv.includes("--skills-only");
  const agentsOnly = argv.includes("--agents-only");
  const rulesOnly = argv.includes("--rules-only");
  const commandsOnly = argv.includes("--commands-only");
  const commandsMode = argv.includes("--commands") || commandsOnly;
  const localCommands = argv.includes("--local");

  // Parse --repo flag
  const repoArg = argv.find((a) => a.startsWith("--repo=") || a === "--repo");
  let repoStr = DEFAULT_REPO;
  if (repoArg) {
    repoStr = repoArg.includes("=")
      ? repoArg.split("=")[1]!
      : argv[argv.indexOf("--repo") + 1] ?? DEFAULT_REPO;
  }

  let repo: ToolkitRepo;
  try {
    repo = parseRepoString(repoStr);
  } catch (err) {
    printErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Parse --limit
  const limitArg = argv.find((a) => a.startsWith("--limit=") || a === "--limit");
  let limit = Infinity;
  if (limitArg) {
    const val = limitArg.includes("=")
      ? limitArg.split("=")[1]
      : argv[argv.indexOf("--limit") + 1];
    limit = parseInt(val ?? "", 10);
    if (isNaN(limit) || limit <= 0) {
      printErr("--limit must be a positive integer");
      process.exit(1);
    }
  }

  // Build categories filter
  let categories: ToolkitItemType[] | undefined;
  if (skillsOnly) categories = ["skill"];
  else if (agentsOnly) categories = ["agent"];
  else if (rulesOnly) categories = ["rule"];
  else if (commandsOnly) categories = ["command"];
  else if (commandsMode) categories = ["skill", "agent", "rule", "command"];

  const repoLabel = `${repo.owner}/${repo.repo}`;

  // ── Preview mode ────────────────────────────────────────────────────────────
  if (preview) {
    printLine(`\nPreviewing toolkit: ${repoLabel}…\n`);
    try {
      const result = await previewToolkit(repo);
      printLine(`  Skills:   ${result.counts.skill}`);
      printLine(`  Agents:   ${result.counts.agent}`);
      printLine(`  Rules:    ${result.counts.rule}`);
      printLine(`  Commands: ${result.counts.command}`);
      printLine(`  Total:    ${result.items.length}\n`);
    } catch (err) {
      printErr(`Failed to preview: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  // ── Seed mode ───────────────────────────────────────────────────────────────
  printLine(`\nSeeding SkillBank from ${repoLabel}…`);
  if (dryRun) printLine("(dry run — no changes will be written)\n");

  const commandsDir = localCommands
    ? `${process.cwd()}/.orager/commands`
    : `${os.homedir()}/.orager/commands`;

  try {
    const result = await seedToolkit({
      repo,
      categories,
      limit,
      dryRun,
      commandsDir,
      onProgress: (event) => {
        if (event.phase === "fetching" && event.total > 0) {
          printLine(`Found ${event.total} file(s) to process.\n`);
        }
        if (event.phase === "seeding" && event.item) {
          const tag = event.status === "inserted" ? "seeded"
            : event.status === "duplicate" ? "duplicate"
            : event.status === "skip" ? "skip"
            : "error";
          printLine(`  [${tag.padEnd(9)}] ${event.item}`);
        }
      },
    });

    printLine(`\n──────────────────────────────────`);
    printLine(`Processed: ${result.total}`);
    if (dryRun) {
      printLine(`Would insert: ${result.inserted}`);
      if (commandsMode) printLine(`Would write commands: ${result.commandsWritten}`);
    } else {
      printLine(`Inserted:   ${result.inserted}`);
      printLine(`Duplicates: ${result.duplicates}`);
      printLine(`Errors:     ${result.errors}`);
      if (commandsMode || result.commandsWritten > 0) {
        printLine(`Commands written:  ${result.commandsWritten}`);
        printLine(`Commands skipped:  ${result.commandsSkipped}`);
      }
      if (result.inserted > 0) {
        printLine(`\nRun \`orager skills list\` to see the new skills.`);
        printLine(`Run \`orager skills merge\` to cluster and synthesize meta-skills.`);
      }
      if (result.commandsWritten > 0) {
        const cmdDirDisplay = localCommands ? ".orager/commands/" : "~/.orager/commands/";
        printLine(`\nCommands written to ${cmdDirDisplay}`);
      }
    }
    printLine("");
  } catch (err) {
    printErr(`Failed to seed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
