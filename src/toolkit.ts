/**
 * toolkit.ts — Core logic for seeding SkillBank from GitHub toolkit repos.
 *
 * Supports any GitHub repository that follows the toolkit layout:
 *   skills/{name}/SKILL.md    → prompt-only skill instructions
 *   agents/{category}/{name}.md → agent personas (system prompts)
 *   rules/{name}.md           → best practice rules
 *   commands/{category}/{name}.md → command templates (written to disk)
 *
 * Used by:
 *   - CLI: `orager skills seed-toolkit` (seed-toolkit-command.ts)
 *   - RPC: `toolkit/preview` and `toolkit/seed` (subprocess.ts)
 */

import os from "node:os";
import fs from "node:fs/promises";
import { importSeedSkill } from "./skillbank.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolkitRepo {
  owner: string;
  repo: string;
  branch?: string; // defaults to "main"
}

export type ToolkitItemType = "skill" | "agent" | "rule" | "command";

export interface ToolkitItem {
  path: string;
  type: ToolkitItemType;
  slug: string;
}

export interface ToolkitPreview {
  repo: string; // "owner/repo"
  branch: string;
  items: ToolkitItem[];
  counts: Record<ToolkitItemType, number>;
}

export interface ToolkitSeedOptions {
  repo: ToolkitRepo;
  categories?: ToolkitItemType[]; // defaults to all
  limit?: number;
  dryRun?: boolean;
  distill?: boolean;
  distillModel?: string;
  apiKey?: string;
  commandsDir?: string;
  onProgress?: (event: ToolkitProgressEvent) => void;
}

export interface ToolkitProgressEvent {
  phase: "fetching" | "seeding" | "done";
  current: number;
  total: number;
  item?: string;
  status?: "inserted" | "duplicate" | "error" | "skip";
}

export interface ToolkitSeedResult {
  repo: string;
  inserted: number;
  duplicates: number;
  errors: number;
  skipped: number;
  commandsWritten: number;
  commandsSkipped: number;
  total: number;
}

// ── GitHub fetch ─────────────────────────────────────────────────────────────

interface GitTreeItem {
  path: string;
  type: "blob" | "tree";
  url: string;
}

function treeUrl(r: ToolkitRepo): string {
  const branch = r.branch ?? "main";
  return `https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${branch}?recursive=1`;
}

function rawUrl(r: ToolkitRepo, filePath: string): string {
  const branch = r.branch ?? "main";
  return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${branch}/${filePath}`;
}

async function fetchTree(r: ToolkitRepo): Promise<GitTreeItem[]> {
  const res = await fetch(treeUrl(r), {
    headers: { "User-Agent": "orager-toolkit/1.0" },
  });
  if (!res.ok) throw new Error(`GitHub tree API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { tree: GitTreeItem[]; truncated?: boolean };
  return json.tree;
}

async function fetchRaw(r: ToolkitRepo, filePath: string): Promise<string> {
  const url = rawUrl(r, filePath);
  const res = await fetch(url, { headers: { "User-Agent": "orager-toolkit/1.0" } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

// ── Item classification ──────────────────────────────────────────────────────

function classifyItem(path: string): ToolkitItemType | null {
  if (/^skills\/[^/]+\/SKILL\.md$/i.test(path)) return "skill";
  if (/^agents\/.+\.md$/i.test(path) && !/README/i.test(path)) return "agent";
  if (/^rules\/.+\.md$/i.test(path) && !/README/i.test(path)) return "rule";
  if (/^commands\/.+\.md$/i.test(path) && !/README/i.test(path)) return "command";
  return null;
}

export function slugFromPath(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1]!.replace(/\.md$/i, "");
  if (filename.toUpperCase() === "SKILL") {
    return parts[parts.length - 2] ?? filename;
  }
  return filename;
}

// ── Text processing ──────────────────────────────────────────────────────────

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
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

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatSeedText(
  slug: string,
  type: ToolkitItemType,
  description: string,
  body: string,
): string {
  const plain = stripMarkdown(body);
  const WORD_LIMIT = 150;
  const prefix = type === "agent" ? "Agent persona" : type === "rule" ? "Best practice rule" : "Skill";
  const lead = description ? `${prefix} — ${slug}: ${description}` : `${prefix} — ${slug}`;
  const leadWords = lead.split(/\s+/);
  const remaining = WORD_LIMIT - leadWords.length;
  if (remaining <= 10) return leadWords.slice(0, WORD_LIMIT).join(" ");
  const bodyWords = plain.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
  const bodyExcerpt = bodyWords.slice(0, remaining).join(" ");
  return `${lead}.\n\n${bodyExcerpt}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Preview what a toolkit repo contains without importing anything.
 * Returns item counts and the full item list.
 */
export async function previewToolkit(repo: ToolkitRepo): Promise<ToolkitPreview> {
  const tree = await fetchTree(repo);
  const items: ToolkitItem[] = [];
  const counts: Record<ToolkitItemType, number> = { skill: 0, agent: 0, rule: 0, command: 0 };

  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const type = classifyItem(entry.path);
    if (!type) continue;
    items.push({ path: entry.path, type, slug: slugFromPath(entry.path) });
    counts[type]++;
  }

  return {
    repo: `${repo.owner}/${repo.repo}`,
    branch: repo.branch ?? "main",
    items,
    counts,
  };
}

/**
 * Seed SkillBank from a GitHub toolkit repo.
 * Streams progress events via onProgress callback.
 */
export async function seedToolkit(opts: ToolkitSeedOptions): Promise<ToolkitSeedResult> {
  const { repo, categories, limit = Infinity, dryRun = false, onProgress } = opts;
  const commandsDir = opts.commandsDir ?? `${os.homedir()}/.orager/commands`;

  // 1. Fetch and filter items
  onProgress?.({ phase: "fetching", current: 0, total: 0 });
  const preview = await previewToolkit(repo);
  const allowedTypes = new Set<ToolkitItemType>(categories ?? ["skill", "agent", "rule", "command"]);
  const items = preview.items.filter((i) => allowedTypes.has(i.type));

  onProgress?.({ phase: "fetching", current: items.length, total: items.length });

  // 2. Seed each item
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;
  let skipped = 0;
  let commandsWritten = 0;
  let commandsSkipped = 0;
  let processed = 0;

  for (const item of items) {
    if (inserted + commandsWritten >= limit) break;

    let raw: string;
    try {
      raw = await fetchRaw(repo, item.path);
    } catch {
      errors++;
      onProgress?.({ phase: "seeding", current: ++processed, total: items.length, item: item.slug, status: "error" });
      continue;
    }

    const { meta, body } = parseFrontmatter(raw);
    const description = meta["description"] ?? meta["name"] ?? "";

    if (!body || body.length < 30) {
      skipped++;
      onProgress?.({ phase: "seeding", current: ++processed, total: items.length, item: item.slug, status: "skip" });
      continue;
    }

    // Command files: write to disk
    if (item.type === "command") {
      processed++;
      if (dryRun) {
        commandsWritten++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "inserted" });
        continue;
      }
      const destPath = `${commandsDir}/${item.slug}.md`;
      let exists = false;
      try { await fs.access(destPath); exists = true; } catch { /* doesn't exist */ }
      if (exists) {
        commandsSkipped++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "duplicate" });
        continue;
      }
      try {
        await fs.mkdir(commandsDir, { recursive: true });
        await fs.writeFile(destPath, body, "utf8");
        commandsWritten++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "inserted" });
      } catch {
        errors++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "error" });
      }
      continue;
    }

    // Skills, agents, rules: import into SkillBank
    const seedText = formatSeedText(item.slug, item.type, description, body);
    processed++;

    if (dryRun) {
      inserted++;
      onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "inserted" });
      continue;
    }

    const source = `toolkit:${repo.owner}/${repo.repo}:${item.path}`;
    const result = await importSeedSkill(seedText, source, undefined, item.type === "rule" ? 0.85 : 0.5);
    switch (result) {
      case "inserted":
        inserted++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "inserted" });
        break;
      case "duplicate":
        duplicates++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "duplicate" });
        break;
      case "error":
        errors++;
        onProgress?.({ phase: "seeding", current: processed, total: items.length, item: item.slug, status: "error" });
        break;
    }
  }

  const seedResult: ToolkitSeedResult = {
    repo: `${repo.owner}/${repo.repo}`,
    inserted,
    duplicates,
    errors,
    skipped,
    commandsWritten,
    commandsSkipped,
    total: processed,
  };

  onProgress?.({ phase: "done", current: processed, total: items.length });
  return seedResult;
}

/**
 * Parse an "owner/repo" or "owner/repo#branch" string into a ToolkitRepo.
 */
export function parseRepoString(input: string): ToolkitRepo {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const [repoPart, branch] = trimmed.split("#");
  const parts = repoPart!.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${input}". Expected "owner/repo" or "owner/repo#branch".`);
  }
  return { owner: parts[0], repo: parts[1], branch: branch || undefined };
}
