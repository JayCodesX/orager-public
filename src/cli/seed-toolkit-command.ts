/**
 * seed-toolkit-command.ts — `orager skills seed-toolkit`
 *
 * Seeds SkillBank with curated skills, agent personas, and rules from the
 * awesome-claude-code-toolkit GitHub repository:
 *   https://github.com/rohitg00/awesome-claude-code-toolkit
 *
 * Content fetched:
 *   skills/ * /SKILL.md    → prompt-only skill instructions
 *   agents/ ** / *.md      → agent personas (system prompts)
 *   rules/ * .md           → best practice rules (seeded with high success_rate)
 *
 * Each item is formatted into a ~150-word actionable instruction and
 * passed through the normal importSeedSkill() path, which handles
 * embedding, deduplication, and SkillBank insertion.
 *
 * Flags:
 *   --dry-run         Print what would be imported without writing to DB
 *   --skills-only     Only import skills/ entries
 *   --agents-only     Only import agents/ entries
 *   --rules-only      Only import rules/ entries
 *   --commands        Also import commands/ entries (written to disk, not SkillBank)
 *   --commands-only   Only import commands/ entries
 *   --local           Write commands to .orager/commands/ in cwd (default: ~/.orager/commands/)
 *   --limit <n>       Stop after n insertions (default: unlimited)
 *   --distill         Use LLM to compress each item to ≤150-word format
 *                     (requires PROTOCOL_API_KEY; costs ~1 cheap LLM call/item)
 */

import os from "node:os";
import fs from "node:fs/promises";
import { importSeedSkill } from "../skillbank.js";
import { getOpenRouterProvider } from "../providers/index.js";

const TOOLKIT_OWNER = "rohitg00";
const TOOLKIT_REPO = "awesome-claude-code-toolkit";
const TOOLKIT_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${TOOLKIT_OWNER}/${TOOLKIT_REPO}/${TOOLKIT_BRANCH}`;
const TREE_API = `https://api.github.com/repos/${TOOLKIT_OWNER}/${TOOLKIT_REPO}/git/trees/${TOOLKIT_BRANCH}?recursive=1`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

/** Parse YAML-style frontmatter delimited by ---. Returns { meta, body }. */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!content.startsWith("---")) return { meta, body: content };

  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta, body: content };

  const block = content.slice(3, end).trim();
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (k) meta[k] = v;
  }
  return { meta, body: content.slice(end + 4).trim() };
}

/**
 * Derive a slug from a file path.
 * e.g. "skills/tdd-mastery/SKILL.md" → "tdd-mastery"
 *      "agents/quality-assurance/qa-automation.md" → "qa-automation"
 */
function slugFromPath(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1]!.replace(/\.md$/i, "");
  if (filename.toUpperCase() === "SKILL") {
    return parts[parts.length - 2] ?? filename;
  }
  return filename;
}

/**
 * Strip markdown formatting to produce plain-text content.
 * Preserves meaningful bullet points and numbered lists.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^\s*[-*]\s+/gm, "• ") // bullets
    .replace(/\n{3,}/g, "\n\n") // collapse blank lines
    .trim();
}

/**
 * Format a skill/agent document into a ≤150-word seed text without an LLM.
 * Strategy:
 *   - Lead with description (from frontmatter) as a summary sentence
 *   - Include the first meaningful paragraph and bullet points from the body
 *   - Truncate at word limit
 */
function formatSeedText(
  slug: string,
  type: "skill" | "agent" | "rule",
  description: string,
  body: string,
): string {
  const plain = stripMarkdown(body);

  // Take the description as the lead, then fill up to ~150 words from body
  const WORD_LIMIT = 150;
  let leadPrefix: string;
  if (type === "agent") {
    leadPrefix = "Agent persona";
  } else if (type === "rule") {
    leadPrefix = "Best practice rule";
  } else {
    leadPrefix = "Skill";
  }
  const lead = description
    ? `${leadPrefix} — ${slug}: ${description}`
    : `${leadPrefix} — ${slug}`;

  const leadWords = lead.split(/\s+/);
  const remaining = WORD_LIMIT - leadWords.length;

  if (remaining <= 10) return leadWords.slice(0, WORD_LIMIT).join(" ");

  // Take the first `remaining` words from the body
  const bodyWords = plain.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
  const bodyExcerpt = bodyWords.slice(0, remaining).join(" ");

  return `${lead}.\n\n${bodyExcerpt}`;
}

const DISTILL_PROMPT = `You are distilling a curated AI skill or agent persona into a reusable SkillBank entry.

Produce ONE concise instruction (≤ 150 words) an AI agent should follow when working on similar tasks.

Rules:
- Task-agnostic: no specific file names, project names, or session IDs
- Actionable: start with a verb phrase ("When X, always Y", "Before X, verify Y", "Prefer X over Y")
- Preserves the most useful behavioural patterns from the source
- Output ONLY the instruction text, no preamble`;

async function distillWithLLM(
  raw: string,
  model: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const result = await getOpenRouterProvider().chat({
      apiKey,
      model,
      messages: [
        { role: "system", content: DISTILL_PROMPT },
        { role: "user", content: raw },
      ],
      max_completion_tokens: 250,
      temperature: 0.3,
    });
    const text = (result.content ?? "").trim();
    return text.length >= 20 ? text : null;
  } catch {
    return null;
  }
}

// ── GitHub fetch helpers ──────────────────────────────────────────────────────

interface GitTreeItem {
  path: string;
  type: "blob" | "tree";
  url: string;
}

async function fetchTree(): Promise<GitTreeItem[]> {
  const res = await fetch(TREE_API, {
    headers: { "User-Agent": "orager-seed-toolkit/1.0" },
  });
  if (!res.ok) throw new Error(`GitHub tree API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { tree: GitTreeItem[]; truncated?: boolean };
  if (json.truncated) {
    process.stderr.write("[seed-toolkit] warning: GitHub tree response truncated\n");
  }
  return json.tree;
}

async function fetchRaw(filePath: string): Promise<string> {
  const url = `${RAW_BASE}/${filePath}`;
  const res = await fetch(url, { headers: { "User-Agent": "orager-seed-toolkit/1.0" } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

// ── Item selection ────────────────────────────────────────────────────────────

function isSkillFile(p: string): boolean {
  // skills/{name}/SKILL.md
  return /^skills\/[^/]+\/SKILL\.md$/i.test(p);
}

function isAgentFile(p: string): boolean {
  // agents/{category}/{name}.md  (any depth, any .md that's not README)
  return (
    /^agents\/.+\.md$/i.test(p) &&
    !/README/i.test(p)
  );
}

function isRulesFile(p: string): boolean {
  return /^rules\/.+\.md$/i.test(p) && !/README/i.test(p);
}

function isCommandFile(p: string): boolean {
  return /^commands\/.+\.md$/i.test(p) && !/README/i.test(p);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleSeedToolkitSubcommand(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const skillsOnly = argv.includes("--skills-only");
  const agentsOnly = argv.includes("--agents-only");
  const rulesOnly = argv.includes("--rules-only");
  const commandsOnly = argv.includes("--commands-only");
  const commandsMode = argv.includes("--commands") || commandsOnly;
  const localCommands = argv.includes("--local");
  const distill = argv.includes("--distill");

  // Resolve commands directory
  const commandsDir = localCommands
    ? `${process.cwd()}/.orager/commands`
    : `${os.homedir()}/.orager/commands`;

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

  let distillModel = process.env["ORAGER_DEFAULT_MODEL"] ?? "openai/gpt-4o-mini";
  let apiKey = "";
  if (distill) {
    apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
    if (!apiKey) {
      printErr("--distill requires PROTOCOL_API_KEY to be set");
      process.exit(1);
    }
    const modelArg = argv.find((a) => a.startsWith("--distill-model="));
    if (modelArg) distillModel = modelArg.split("=")[1]!;
  }

  printLine(`\nSeeding SkillBank from ${TOOLKIT_OWNER}/${TOOLKIT_REPO}…`);
  if (rulesOnly) printLine("(rules-only mode — importing rules/ entries only)");
  if (dryRun) printLine("(dry run — no changes will be written)\n");

  // ── Fetch repo tree ──────────────────────────────────────────────────────────
  let tree: GitTreeItem[];
  try {
    tree = await fetchTree();
  } catch (err) {
    printErr(`Failed to fetch toolkit repo tree: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const files = tree
    .filter((item) => item.type === "blob")
    .filter((item) => {
      if (skillsOnly) return isSkillFile(item.path);
      if (agentsOnly) return isAgentFile(item.path);
      if (rulesOnly) return isRulesFile(item.path);
      if (commandsOnly) return isCommandFile(item.path);
      const isSkillOrAgent = isSkillFile(item.path) || isAgentFile(item.path) || isRulesFile(item.path);
      if (commandsMode) return isSkillOrAgent || isCommandFile(item.path);
      return isSkillOrAgent;
    });

  printLine(`Found ${files.length} file(s) to process.\n`);
  if (files.length === 0) {
    printLine("Nothing to import. Exiting.");
    return;
  }

  // ── Process each file ────────────────────────────────────────────────────────
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;
  let processed = 0;
  let commandsWritten = 0;
  let commandsSkipped = 0;

  for (const item of files) {
    if (inserted >= limit) break;

    const isCmd = isCommandFile(item.path);
    const type: "skill" | "agent" | "rule" = isSkillFile(item.path) ? "skill" : isRulesFile(item.path) ? "rule" : "agent";
    const slug = slugFromPath(item.path);
    const source = `toolkit:${item.path}`;

    let raw: string;
    try {
      raw = await fetchRaw(item.path);
    } catch (err) {
      printErr(`  [error] ${item.path}: ${err instanceof Error ? err.message : String(err)}`);
      errors++;
      continue;
    }

    const { meta, body } = parseFrontmatter(raw);
    const description = meta["description"] ?? meta["name"] ?? "";

    if (!body || body.length < 30) {
      printLine(`  [skip]  ${item.path} — body too short`);
      continue;
    }

    // ── Command files: write to disk ─────────────────────────────────────────
    if (isCmd) {
      processed++;
      const destPath = `${commandsDir}/${slug}.md`;
      if (dryRun) {
        printLine(`  [dry-run] command ${slug} → ${destPath}`);
        commandsWritten++;
        continue;
      }
      // Check if already exists
      let alreadyExists = false;
      try {
        await fs.access(destPath);
        alreadyExists = true;
      } catch { /* does not exist */ }
      if (alreadyExists) {
        printLine(`  [exists]  command ${slug}`);
        commandsSkipped++;
        continue;
      }
      try {
        await fs.mkdir(commandsDir, { recursive: true });
        // CodeQL: [js/http-to-file-access] — intentional: writing toolkit command template to project
        await fs.writeFile(destPath, body, "utf8");
        printLine(`  [written] command ${slug} → ${destPath}`);
        commandsWritten++;
      } catch (err) {
        printErr(`  [error]  command ${slug}: ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }
      continue;
    }

    let seedText: string;
    if (distill) {
      const raw_combined = `${description ? `Description: ${description}\n\n` : ""}${body}`;
      const distilled = await distillWithLLM(raw_combined, distillModel, apiKey);
      if (!distilled) {
        printLine(`  [skip]  ${slug} — distillation returned empty`);
        continue;
      }
      seedText = distilled;
    } else {
      seedText = formatSeedText(slug, type, description, body);
    }

    processed++;

    if (dryRun) {
      printLine(`  [dry-run] ${type} ${slug}`);
      printLine(`    ${seedText.replace(/\n/g, " ").slice(0, 120)}…`);
      printLine("");
      inserted++;
      continue;
    }

    const result = await importSeedSkill(seedText, source, undefined, type === "rule" ? 0.85 : 0.5);
    switch (result) {
      case "inserted":
        printLine(`  [seeded]    ${type} ${slug}`);
        inserted++;
        break;
      case "duplicate":
        printLine(`  [duplicate] ${type} ${slug}`);
        duplicates++;
        break;
      case "error":
        printLine(`  [error]     ${type} ${slug}`);
        errors++;
        break;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  printLine(`\n──────────────────────────────────`);
  printLine(`Processed: ${processed}`);
  if (dryRun) {
    printLine(`Would insert: ${inserted}`);
    if (commandsMode) printLine(`Would write commands: ${commandsWritten}`);
  } else {
    printLine(`Inserted:   ${inserted}`);
    printLine(`Duplicates: ${duplicates}`);
    printLine(`Errors:     ${errors}`);
    if (commandsMode) {
      printLine(`Commands written:  ${commandsWritten}`);
      printLine(`Commands skipped:  ${commandsSkipped}`);
    }
    if (inserted > 0) {
      printLine(`\nRun \`orager skills list\` to see the new skills.`);
      printLine(`Run \`orager skills merge\` to cluster and synthesize meta-skills.`);
      if (!skillsOnly && !agentsOnly) {
        printLine(`Note: rules/ entries are seeded with success_rate=0.85 (higher retrieval priority).`);
      }
    }
    if (commandsWritten > 0) {
      const cmdDirDisplay = localCommands ? ".orager/commands/" : "~/.orager/commands/";
      printLine(`\nCommands written to ${cmdDirDisplay}`);
    }
  }
  printLine("");
}
