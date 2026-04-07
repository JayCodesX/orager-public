/**
 * Context injection — automatically gathers relevant environment context
 * to prepend to the agent's initial prompt.
 *
 * Gathers (non-fatally): git status, recent commits, current branch,
 * directory listing, package.json name+version, project structure map.
 *
 * The project map uses Phase 1 relevance filtering when a prompt is supplied,
 * so agents receive only the clusters most pertinent to their current task.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { getProjectMap, formatProjectMap, type ProjectMap } from "./project-index.js";

const exec = promisify(execFile);
const TIMEOUT = 3000;

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { cwd, timeout: TIMEOUT });
    return stdout.trim();
  } catch {
    return "";
  }
}

export interface InjectedContext {
  gitBranch?: string;
  gitStatus?: string;
  recentCommits?: string;
  packageName?: string;
  packageVersion?: string;
  dirListing?: string;
  projectMap?: ProjectMap;
}

/**
 * Gather context for the current working directory.
 * All operations are best-effort — failures return empty strings.
 */
export async function gatherContext(cwd: string): Promise<InjectedContext> {
  const [gitBranch, gitStatus, recentCommits, dirBytes, projectMap] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    run("git", ["status", "--short"], cwd),
    run("git", ["log", "--oneline", "-10"], cwd),
    fs.readdir(cwd).catch(() => [] as string[]),
    getProjectMap(cwd).catch(() => null),
  ]);

  let packageName: string | undefined;
  let packageVersion: string | undefined;
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    packageName = pkg.name;
    packageVersion = pkg.version;
  } catch { /* not a Node project */ }

  const dirListing = Array.isArray(dirBytes)
    ? (dirBytes as string[]).slice(0, 30).join("  ")
    : "";

  return {
    gitBranch: gitBranch || undefined,
    gitStatus: gitStatus || undefined,
    recentCommits: recentCommits || undefined,
    packageName,
    packageVersion,
    dirListing: dirListing || undefined,
    projectMap: projectMap ?? undefined,
  };
}

/**
 * Format gathered context into a compact string to prepend to the prompt.
 *
 * When both cwd and prompt are provided, the project map section uses
 * cosine similarity (local embeddings, keyword fallback) to rank clusters
 * and call chains by relevance to the agent's current task.
 */
export async function formatContext(ctx: InjectedContext, cwd?: string, prompt?: string): Promise<string> {
  const lines: string[] = ["[Auto-injected context]"];
  if (ctx.packageName) lines.push(`Project: ${ctx.packageName}${ctx.packageVersion ? ` v${ctx.packageVersion}` : ""}`);
  if (ctx.gitBranch)   lines.push(`Branch: ${ctx.gitBranch}`);
  if (ctx.gitStatus)   lines.push(`Git status:\n${ctx.gitStatus}`);
  if (ctx.recentCommits) lines.push(`Recent commits:\n${ctx.recentCommits}`);
  if (ctx.dirListing)  lines.push(`Directory: ${ctx.dirListing}`);
  if (ctx.projectMap)  lines.push(await formatProjectMap(ctx.projectMap, cwd ?? process.cwd(), prompt));
  return lines.join("\n");
}
