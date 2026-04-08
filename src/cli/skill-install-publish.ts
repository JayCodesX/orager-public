/**
 * skill-install-publish.ts — `orager skills install` and `orager skills publish`
 *
 * Phase 0b: SKILL.md ecosystem compatibility (Agent Skills spec).
 *
 * Install sources:
 *   - GitHub shorthand: owner/repo (clones skills/ directory)
 *   - GitHub shorthand with skill: owner/repo/skill-name
 *   - Local path: ./path/to/skill or /absolute/path/to/skill
 *
 * Publish:
 *   - Export a SkillBank entry as a SKILL.md-compatible directory
 *   - Output: .orager/skills/<name>/SKILL.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { getSkill, listSkills } from "../skillbank.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

/** Resolve the user-level skills directory: ~/.orager/skills/ */
function userSkillsDir(): string {
  return path.join(os.homedir(), ".orager", "skills");
}

/** Resolve the project-level skills directory: <cwd>/.orager/skills/ */
function projectSkillsDir(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), ".orager", "skills");
}

/**
 * Validate a skill name against the Agent Skills spec.
 * - 1-64 chars, lowercase alphanumeric + hyphens
 * - No leading/trailing hyphens, no consecutive hyphens
 */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(name) && !name.includes("--");
}

/**
 * Validate SKILL.md frontmatter has required fields.
 */
function validateSkillMd(content: string): { valid: boolean; error?: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { valid: false, error: "Missing YAML frontmatter (must start with ---)" };
  }
  const afterOpen = trimmed.slice(3);
  const closeIdx = afterOpen.indexOf("---");
  if (closeIdx === -1) {
    return { valid: false, error: "Unclosed YAML frontmatter (missing closing ---)" };
  }
  const block = afterOpen.slice(0, closeIdx);
  const hasName = /^name\s*:/m.test(block);
  const hasDescription = /^description\s*:/m.test(block);
  if (!hasName) return { valid: false, error: "Missing required 'name' field in frontmatter" };
  if (!hasDescription) return { valid: false, error: "Missing required 'description' field in frontmatter" };
  return { valid: true };
}

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
function execCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.on("data", (d: Buffer) => stdout.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.join(""));
      } else {
        reject(new Error(stderr.join("") || `Command failed with exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Parse the install source into a structured format.
 *
 * Supported formats:
 *   owner/repo              → clone repo, install all skills from skills/ dir
 *   owner/repo/skill-name   → clone repo, install one skill
 *   ./local/path            → copy from local filesystem
 *   /absolute/path          → copy from local filesystem
 */
interface InstallSource {
  type: "github" | "local";
  /** For github: "owner/repo". For local: the resolved path. */
  location: string;
  /** Specific skill name to install, or null for all. */
  skillName: string | null;
}

function parseInstallSource(source: string): InstallSource {
  // Local paths
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("~/") || source.startsWith("..")) {
    const resolved = source.startsWith("~")
      ? path.join(os.homedir(), source.slice(2))
      : path.resolve(source);
    return { type: "local", location: resolved, skillName: null };
  }

  // GitHub shorthand: owner/repo or owner/repo/skill-name
  const parts = source.split("/");
  if (parts.length === 2) {
    return { type: "github", location: source, skillName: null };
  }
  if (parts.length === 3) {
    return { type: "github", location: `${parts[0]}/${parts[1]}`, skillName: parts[2] };
  }

  // Fallback: treat as local
  return { type: "local", location: path.resolve(source), skillName: null };
}

/**
 * Install a single skill directory to the target skills root.
 * Validates SKILL.md, copies the directory.
 */
async function installSkillDir(
  skillDir: string,
  skillName: string,
  targetRoot: string,
): Promise<boolean> {
  const skillMdPath = path.join(skillDir, "SKILL.md");

  // Read and validate SKILL.md in one step (avoids TOCTOU race)
  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf8");
  } catch {
    printErr(`  ✗ ${skillName}: no SKILL.md found, skipping`);
    return false;
  }
  const validation = validateSkillMd(content);
  if (!validation.valid) {
    printErr(`  ✗ ${skillName}: invalid SKILL.md — ${validation.error}`);
    return false;
  }

  // Copy to target
  const destDir = path.join(targetRoot, skillName);
  await fs.mkdir(destDir, { recursive: true });
  await copyDir(skillDir, destDir);
  printLine(`  ✓ ${skillName}`);
  return true;
}

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install skills from a GitHub repository.
 * Clones the repo to a temp dir, then copies skills to the target.
 */
async function installFromGitHub(
  repo: string,
  skillName: string | null,
  targetRoot: string,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-skill-install-"));

  try {
    printLine(`Cloning ${repo}...`);
    const repoUrl = `https://github.com/${repo}.git`;
    await execCommand("git", ["clone", "--depth", "1", repoUrl, tmpDir]);

    // Look for skills in: skills/, .orager/skills/, or root-level skill dirs
    const skillsSearchDirs = [
      path.join(tmpDir, "skills"),
      path.join(tmpDir, ".orager", "skills"),
      tmpDir,
    ];

    if (skillName) {
      // Install a specific skill
      let found = false;
      for (const searchDir of skillsSearchDirs) {
        const candidate = path.join(searchDir, skillName);
        try {
          await fs.access(path.join(candidate, "SKILL.md"));
          found = await installSkillDir(candidate, skillName, targetRoot);
          if (found) break;
        } catch {
          continue;
        }
      }
      if (!found) {
        printErr(`Skill '${skillName}' not found in ${repo}`);
        process.exit(1);
      }
    } else {
      // Install all skills found
      let installed = 0;
      for (const searchDir of skillsSearchDirs) {
        try {
          const entries = await fs.readdir(searchDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(searchDir, entry.name);
            try {
              await fs.access(path.join(candidate, "SKILL.md"));
              if (await installSkillDir(candidate, entry.name, targetRoot)) {
                installed++;
              }
            } catch {
              continue; // No SKILL.md — skip
            }
          }
        } catch {
          continue; // Directory doesn't exist
        }
      }
      if (installed === 0) {
        printErr(`No valid skills found in ${repo}`);
        process.exit(1);
      }
      printLine(`\nInstalled ${installed} skill(s).`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Install skills from a local path.
 */
async function installFromLocal(
  sourcePath: string,
  targetRoot: string,
): Promise<void> {
  // Check if source is a single skill dir (has SKILL.md) or a parent of skills
  const skillMdPath = path.join(sourcePath, "SKILL.md");
  try {
    await fs.access(skillMdPath);
    // It's a single skill — install it
    const skillName = path.basename(sourcePath);
    await installSkillDir(sourcePath, skillName, targetRoot);
    printLine(`\nInstalled 1 skill.`);
    return;
  } catch {
    // Not a single skill — look for subdirectories with SKILL.md
  }

  let installed = 0;
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sourcePath, entry.name);
    try {
      await fs.access(path.join(candidate, "SKILL.md"));
      if (await installSkillDir(candidate, entry.name, targetRoot)) {
        installed++;
      }
    } catch {
      continue;
    }
  }

  if (installed === 0) {
    printErr(`No valid skills found in ${sourcePath}`);
    process.exit(1);
  }
  printLine(`\nInstalled ${installed} skill(s).`);
}

/**
 * Handle `orager skills install <source> [--project]`.
 */
export async function handleInstall(argv: string[]): Promise<void> {
  const isProject = argv.includes("--project");
  const source = argv.find((a) => !a.startsWith("--"));

  if (!source) {
    printLine("Usage: orager skills install <source> [--project]");
    printLine("");
    printLine("Sources:");
    printLine("  owner/repo              Install all skills from a GitHub repo");
    printLine("  owner/repo/skill-name   Install a specific skill from a GitHub repo");
    printLine("  ./path/to/skill         Install from a local path");
    printLine("");
    printLine("Options:");
    printLine("  --project               Install to .orager/skills/ (project-level)");
    printLine("                          Default: ~/.orager/skills/ (user-level)");
    return;
  }

  const targetRoot = isProject ? projectSkillsDir() : userSkillsDir();
  await fs.mkdir(targetRoot, { recursive: true });

  const parsed = parseInstallSource(source);

  printLine(`Installing to: ${targetRoot}\n`);

  if (parsed.type === "github") {
    await installFromGitHub(parsed.location, parsed.skillName, targetRoot);
  } else {
    await installFromLocal(parsed.location, targetRoot);
  }
}

// ── Publish ─────────────────────────────────────────────────────────────────

/**
 * Convert a SkillBank entry (learned skill) to Agent Skills spec SKILL.md format.
 *
 * SkillBank stores free-text instructions extracted from trajectories.
 * This function wraps them in the Agent Skills frontmatter format.
 */
function skillToSkillMd(
  id: string,
  text: string,
  opts?: { description?: string },
): string {
  // Generate a spec-compliant name from the skill ID
  const name = id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "unnamed-skill";

  // Use first sentence or first 200 chars as description
  const description = opts?.description
    || text.split(/[.\n]/)[0]?.trim().slice(0, 200)
    || "Learned skill extracted from agent trajectory";

  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `metadata:`,
    `  source: orager-skillbank`,
    `  original-id: "${id}"`,
    "---",
    "",
    text,
    "",
  ];

  return lines.join("\n");
}

/**
 * Handle `orager skills publish <id> [--project] [--all]`.
 *
 * Exports SkillBank entries as SKILL.md directories.
 */
export async function handlePublish(argv: string[]): Promise<void> {
  const isProject = argv.includes("--project");
  const exportAll = argv.includes("--all");
  const skillId = argv.find((a) => !a.startsWith("--"));

  if (!skillId && !exportAll) {
    printLine("Usage: orager skills publish <skill-id> [--project]");
    printLine("       orager skills publish --all [--project]");
    printLine("");
    printLine("Exports SkillBank entries as Agent Skills (SKILL.md) directories.");
    printLine("");
    printLine("Options:");
    printLine("  --project   Write to .orager/skills/ (project-level)");
    printLine("              Default: ~/.orager/skills/ (user-level)");
    printLine("  --all       Export all non-deleted skills");
    return;
  }

  const targetRoot = isProject ? projectSkillsDir() : userSkillsDir();
  await fs.mkdir(targetRoot, { recursive: true });

  if (exportAll) {
    const skills = await listSkills(false);
    if (skills.length === 0) {
      printLine("No skills to export.");
      return;
    }
    let exported = 0;
    for (const sk of skills) {
      const name = sk.id
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64) || `skill-${exported}`;

      const content = skillToSkillMd(sk.id, sk.text);
      const destDir = path.join(targetRoot, name);
      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(path.join(destDir, "SKILL.md"), content, "utf8");
      printLine(`  ✓ ${name}/SKILL.md`);
      exported++;
    }
    printLine(`\nPublished ${exported} skill(s) to ${targetRoot}`);
    return;
  }

  // Single skill export
  const skill = await getSkill(skillId!);
  if (!skill) {
    printErr(`Skill '${skillId}' not found. Run \`orager skills list\` to see available skills.`);
    process.exit(1);
  }

  const name = skill.id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "unnamed-skill";

  const content = skillToSkillMd(skill.id, skill.text);
  const destDir = path.join(targetRoot, name);
  await fs.mkdir(destDir, { recursive: true });
  const destFile = path.join(destDir, "SKILL.md");
  await fs.writeFile(destFile, content, "utf8");
  printLine(`Published to: ${destFile}`);
}

// ── Exports for testing ─────────────────────────────────────────────────────

export { isValidSkillName, validateSkillMd, skillToSkillMd, parseInstallSource };
