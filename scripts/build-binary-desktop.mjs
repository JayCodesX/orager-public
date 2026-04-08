#!/usr/bin/env node
/**
 * scripts/build-binary-desktop.mjs
 *
 * Builds the orager-desktop sidecar binary for the Tauri desktop app.
 *
 * Build command:
 *   node scripts/build-binary-desktop.mjs [--targets darwin-arm64,darwin-x64,linux-x64]
 *   bun run build:binary:desktop
 *
 * This binary is a slimmed-down variant of orager that excludes:
 *   - HTTP UI server (ui-server.ts / --serve / ui subcommand)
 *   - React frontend and static asset embedding
 *   - setup, init, keys, ui CLI subcommands
 *   - OMLS training pipeline (skill-train subcommand)
 *   - Standalone MCP server binary (build that separately if needed)
 *   - OpenTelemetry / tracing (never imported → compiled out by bundler)
 *
 * The following remain fully functional:
 *   - orager-desktop chat [--subprocess]  (agent/run + agent/event protocol)
 *   - orager-desktop run "prompt"
 *   - All session management flags (--list-sessions --json, etc.)
 *
 * Uses the same two-pass approach as build-binary.mjs:
 *   Pass 1: bun build --target=bun  (bundle to JS)
 *   Pass 2: patch bundle (inject __promiseAll helper for Bun 1.3.x bug)
 *   Pass 3: bun build --compile      (compile to native binary per target)
 *
 * Output: bin/orager-desktop-<target>
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dir, "..");

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64"];

// Packages that must never be bundled (same as the full binary):
//   - playwright / playwright-core — devDep with native browser binaries
//   - @huggingface/transformers — optional dep with graceful fallback
const EXTERNAL_PACKAGES = [
  "playwright",
  "playwright-core",
  "@huggingface/transformers",
];

// Entry point for the desktop-only build (excludes UI server, telemetry, etc.)
const ENTRY = "src/index-desktop.ts";
const BIN_NAME = "orager-desktop";

const arg = process.argv.find((a) => a.startsWith("--targets="));
const targets = arg
  ? arg.slice("--targets=".length).split(",").map((t) => t.trim())
  : DEFAULT_TARGETS;

const BUNDLE_DIR = path.join(root, "dist-binary");
const BIN_DIR = path.join(root, "bin");

// ── Pre-flight ────────────────────────────────────────────────────────────────

const bunCheck = spawnSync("bun", ["--version"], { shell: true, stdio: "pipe" });
if (bunCheck.status !== 0) {
  console.error("Error: 'bun' not found in PATH. Install Bun from https://bun.sh and try again.");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: root, ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Patch the Bun-generated bundle to fix known issues:
 *   1. Add the missing __promiseAll helper (Bun 1.3.x bug).
 */
function patchBundle(bundlePath) {
  let src = fs.readFileSync(bundlePath, "utf8");

  if (src.includes("__promiseAll") && !src.includes("var __promiseAll")) {
    src = src.replace(
      /^(\/\/\s*@bun\n)/m,
      '$1var __promiseAll = (p) => Promise.all(p);\n',
    );
    console.log("  [patch] injected __promiseAll helper");
  }

  fs.writeFileSync(bundlePath, src, "utf8");
}

// ── Main ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(BUNDLE_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

console.log(`\n${"─".repeat(60)}`);
console.log(`Building ${BIN_NAME} from ${ENTRY}`);
console.log("─".repeat(60));

const bundleOut = path.join(BUNDLE_DIR, `${BIN_NAME}.js`);
const bundleSubdir = path.join(BUNDLE_DIR, BIN_NAME);
fs.mkdirSync(bundleSubdir, { recursive: true });

const externals = EXTERNAL_PACKAGES.map((p) => `--external=${p}`).join(" ");

// Pass 1: bundle to JS
console.log("\n[1/3] Bundling...");
run(`bun build --target=bun --outdir=${bundleSubdir} ${externals} ${ENTRY}`);
const entryBasename = path.basename(ENTRY, path.extname(ENTRY)) + ".js";
const bundleRaw = path.join(bundleSubdir, entryBasename);
fs.copyFileSync(bundleRaw, bundleOut);

// Pass 2: patch the bundle
console.log("\n[2/3] Patching bundle...");
patchBundle(bundleOut);

// Pass 3: compile per target
console.log("\n[3/3] Compiling binaries...");
for (const target of targets) {
  const suffix = target.replace(/^bun-/, "");
  const outfile = path.join(BIN_DIR, `${BIN_NAME}-${suffix}`);
  run(`bun build --compile --target=${target} --outfile=${outfile} ${externals} ${bundleOut}`);
  const sizeBytes = fs.statSync(outfile).size;
  console.log(`  → ${outfile}  (${Math.round(sizeBytes / 1024 / 1024)} MB)`);
}

console.log(`\n✓ Done. Desktop binaries written to: ${BIN_DIR}/`);
