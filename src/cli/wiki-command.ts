/**
 * wiki-command.ts — CLI handler for `orager wiki` subcommand (Phase 1).
 *
 * Subcommands:
 *   orager wiki list              — list all wiki topic pages
 *   orager wiki show <topic>      — show a single topic page
 *   orager wiki ingest <topic>    — ingest raw content from argument
 *   orager wiki compile [topic]   — compile raw entries into topic pages (requires API key)
 *   orager wiki lint              — check consistency (broken backlinks, stale pages)
 *   orager wiki quality           — show quality gate report
 *   orager wiki stats             — show aggregate statistics
 *   orager wiki seed              — seed topics from project structure
 *   orager wiki delete <topic>    — delete a topic page and its raw entries
 */

import {
  listPages,
  getPage,
  getRawEntries,
  ingestRaw,
  compile,
  lint,
  qualityGate,
  getWikiStats,
  deletePage,
  seedFromProjectMap,
  countPendingRaw,
} from "../knowledge-wiki.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function handleList(): Promise<void> {
  const pages = await listPages();
  if (pages.length === 0) {
    printLine("No wiki pages. Use `orager wiki ingest <topic>` or `orager wiki seed` to get started.");
    return;
  }
  printLine(`\n${pages.length} wiki page(s):\n`);
  for (const p of pages) {
    const pending = await countPendingRaw(p.topic);
    const pendingTag = pending > 0 ? ` (${pending} raw pending)` : "";
    const backlinkTag = p.backlinks.length > 0 ? ` → ${p.backlinks.join(", ")}` : "";
    printLine(`  ${p.topic}  [quality: ${p.qualityScore.toFixed(2)}]${pendingTag}${backlinkTag}`);
    if (p.content) {
      printLine(`    ${p.content.slice(0, 120)}${p.content.length > 120 ? "…" : ""}`);
    }
    printLine("");
  }
}

async function handleShow(argv: string[]): Promise<void> {
  const topic = argv[0];
  if (!topic) {
    printErr("Usage: orager wiki show <topic>");
    process.exit(1);
  }
  const page = await getPage(topic);
  if (!page) {
    printErr(`Topic '${topic}' not found.`);
    process.exit(1);
  }
  printLine(`\nTopic: ${page.topic}`);
  printLine(`Quality: ${page.qualityScore.toFixed(2)}`);
  printLine(`Backlinks: ${page.backlinks.length > 0 ? page.backlinks.join(", ") : "(none)"}`);
  printLine(`Last compiled: ${page.lastCompiled ?? "never"}`);
  printLine(`Last linted: ${page.lastLinted ?? "never"}`);
  printLine(`Created: ${page.createdAt}`);
  printLine(`Updated: ${page.updatedAt}`);
  printLine(`\nContent:\n${page.content || "(empty — run compile to generate)"}`);

  const rawEntries = await getRawEntries(topic);
  if (rawEntries.length > 0) {
    printLine(`\n--- ${rawEntries.length} raw entry(ies) pending compilation ---`);
    for (const r of rawEntries) {
      printLine(`  [${r.createdAt}${r.source ? ` source:${r.source}` : ""}]`);
      printLine(`    ${r.content.slice(0, 200)}${r.content.length > 200 ? "…" : ""}`);
    }
  }
  printLine("");
}

async function handleIngest(argv: string[]): Promise<void> {
  const topic = argv[0];
  if (!topic) {
    printErr("Usage: orager wiki ingest <topic> [content]");
    printErr("       echo 'content' | orager wiki ingest <topic>");
    process.exit(1);
  }

  const content = argv.slice(1).join(" ").trim();
  if (!content) {
    printErr("No content provided. Pass content as arguments or pipe via stdin.");
    process.exit(1);
  }

  const entry = await ingestRaw(topic, content);
  printLine(`Ingested raw entry for topic '${entry.topic}' (id: ${entry.id.slice(0, 8)}…)`);
  printLine(`Run 'orager wiki compile ${entry.topic}' to merge into topic page.`);
}

async function handleCompile(argv: string[]): Promise<void> {
  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    printErr("orager: API key not set. Export PROTOCOL_API_KEY.");
    process.exit(1);
  }

  const model = process.env["ORAGER_DEFAULT_MODEL"] ?? "openai/gpt-4o-mini";
  const topics = argv.filter((a) => !a.startsWith("--"));

  printLine(`Compiling wiki pages (model: ${model})…\n`);

  const { getOpenRouterProvider } = await import("../providers/index.js");
  const provider = getOpenRouterProvider();

  const callLlm = async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const result = await provider.chat({
      apiKey,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return result.content;
  };

  const result = await compile(callLlm, topics.length > 0 ? topics : undefined);
  printLine(`\nCompiled ${result.compiled} topic page(s).`);
  if (result.errors.length > 0) {
    printLine("\nErrors:");
    for (const e of result.errors) printErr(`  ${e}`);
  }
}

async function handleLint(): Promise<void> {
  const result = await lint();
  printLine("\nWiki lint results");
  printLine("─────────────────────────────────");
  printLine(`Broken backlinks:  ${result.brokenBacklinks.length}`);
  printLine(`Stale pages:       ${result.stalePagesCount}`);
  printLine(`Orphan pages:      ${result.orphanPagesCount}`);

  if (result.brokenBacklinks.length > 0) {
    printLine("\nBroken backlinks:");
    for (const bl of result.brokenBacklinks) {
      printLine(`  ${bl.page} → ${bl.target} (target does not exist)`);
    }
  }
  printLine("");
}

async function handleQuality(): Promise<void> {
  const report = await qualityGate();
  printLine("\nWiki quality report");
  printLine("─────────────────────────────────");
  printLine(`Total pages:         ${report.totalPages}`);
  printLine(`Average score:       ${report.avgScore.toFixed(2)}`);
  printLine(`Low quality (<0.4):  ${report.lowQualityPages.length}`);
  printLine(`High quality (≥0.7): ${report.highQualityPages.length}`);

  if (report.lowQualityPages.length > 0) {
    printLine("\nLow quality pages (need recompile):");
    for (const p of report.lowQualityPages) {
      printLine(`  ${p.topic} — ${p.score.toFixed(2)}`);
    }
  }
  if (report.highQualityPages.length > 0) {
    printLine("\nHigh quality pages:");
    for (const p of report.highQualityPages) {
      printLine(`  ${p.topic} — ${p.score.toFixed(2)}`);
    }
  }
  printLine("");
}

async function handleStats(): Promise<void> {
  const stats = await getWikiStats();
  printLine("\nKnowledge Wiki statistics");
  printLine("─────────────────────────────────");
  printLine(`Topic pages:       ${stats.totalPages}`);
  printLine(`Raw entries:       ${stats.totalRawEntries}`);
  printLine(`Avg quality:       ${stats.avgQualityScore.toFixed(2)}`);

  if (stats.topTopics.length > 0) {
    printLine("\nTop topics:");
    for (const t of stats.topTopics) {
      printLine(`  ${t.topic} — ${t.score.toFixed(2)}`);
    }
  }

  if (stats.totalPages === 0) {
    printLine("\nNo wiki pages yet. Try:");
    printLine("  orager wiki seed              — seed from project structure");
    printLine("  orager wiki ingest <topic>    — add raw knowledge");
  }
  printLine("");
}

async function handleSeed(): Promise<void> {
  const cwd = process.cwd();
  printLine(`Seeding wiki from project structure (${cwd})…\n`);
  const seeded = await seedFromProjectMap(cwd);
  if (seeded === 0) {
    printLine("No project structure found. Run in a project directory with source files.");
  } else {
    printLine(`Seeded ${seeded} raw entries. Run 'orager wiki compile' to build topic pages.`);
  }
}

async function handleDelete(argv: string[]): Promise<void> {
  const topic = argv[0];
  if (!topic) {
    printErr("Usage: orager wiki delete <topic>");
    process.exit(1);
  }
  const deleted = await deletePage(topic);
  if (deleted) {
    printLine(`Deleted topic '${topic}' and its raw entries.`);
  } else {
    printErr(`Topic '${topic}' not found.`);
    process.exit(1);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleWikiSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      await handleList();
      break;
    case "show":
    case "get":
      await handleShow(rest);
      break;
    case "ingest":
    case "add":
      await handleIngest(rest);
      break;
    case "compile":
    case "build":
      await handleCompile(rest);
      break;
    case "lint":
    case "check":
      await handleLint();
      break;
    case "quality":
    case "gate":
      await handleQuality();
      break;
    case "stats":
      await handleStats();
      break;
    case "seed":
      await handleSeed();
      break;
    case "delete":
    case "rm":
      await handleDelete(rest);
      break;
    default:
      printLine("Usage: orager wiki <subcommand> [args]");
      printLine("");
      printLine("Subcommands:");
      printLine("  list                  List all wiki topic pages");
      printLine("  show <topic>          Show a single topic page with details");
      printLine("  ingest <topic> <text> Add raw knowledge for a topic");
      printLine("  compile [topic...]    Compile raw entries into topic pages (requires API key)");
      printLine("  lint                  Check consistency (broken backlinks, staleness)");
      printLine("  quality               Show quality gate report");
      printLine("  stats                 Show aggregate statistics");
      printLine("  seed                  Seed topics from project structure");
      printLine("  delete <topic>        Delete a topic page and its raw entries");
      printLine("");
      if (sub && sub !== "--help" && sub !== "help") {
        printErr(`Unknown subcommand: '${sub}'`);
        process.exit(1);
      }
      break;
  }
}
