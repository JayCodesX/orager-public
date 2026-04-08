/**
 * CLI `orager memory` subcommand handler (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts. Handles: list, export, clear, inspect.
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { loadMemoryStoreAny, MEMORY_DIR } from "../memory.js";
import {
  isSqliteMemoryEnabled,
  listMemoryKeysSqlite,
  clearMemoryStoreSqlite,
  loadMasterContext,
  getMemoryEntryCount,
} from "../memory-sqlite.js";
import { loadLatestCheckpointByContextId, deleteCheckpointsByContextId } from "../session.js";
import {
  MEMORY_LAYER1_MASTER_MAX_CHARS,
  MEMORY_LAYER2_RETRIEVED_MAX_CHARS,
  MEMORY_LAYER3_CHECKPOINT_MAX_CHARS,
} from "../loop-helpers.js";

export async function handleMemorySubcommand(argv: string[]): Promise<void> {
  const subIdx = argv.indexOf("memory");
  const subArgs = argv.slice(subIdx + 1);
  const sub = subArgs[0];

  if (sub === "export") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("orager memory export --key <memoryKey>\n");
      process.exit(1);
    }
    const store = await loadMemoryStoreAny(memoryKey);
    process.stdout.write(JSON.stringify(store, null, 2) + "\n");
    process.exit(0);
  }

  if (sub === "list") {
    if (isSqliteMemoryEnabled()) {
      const keys = await listMemoryKeysSqlite();
      for (const k of keys) process.stdout.write(k + "\n");
    } else {
      try {
        const entries = await fs.readdir(MEMORY_DIR);
        for (const entry of entries) {
          if (entry.endsWith(".json")) {
            process.stdout.write(entry.slice(0, -5) + "\n");
          }
        }
      } catch {
        // Directory doesn't exist — no memory keys
      }
    }
    process.exit(0);
  }

  if (sub === "clear") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("orager memory clear --key <memoryKey> [--yes]\n");
      process.exit(1);
    }
    const skipConfirm = subArgs.includes("--yes");
    if (!skipConfirm) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Clear all memory entries for key "${memoryKey}"? [y/N] `, resolve);
      });
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        process.stdout.write("Aborted.\n");
        process.exit(0);
      }
    }
    if (isSqliteMemoryEnabled()) {
      const deleted = await clearMemoryStoreSqlite(memoryKey);
      process.stdout.write(`Cleared ${deleted} entry/entries for key "${memoryKey}".\n`);
    } else {
      const { MEMORY_DIR: memDir } = await import("../memory.js");
      const sanitized = memoryKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
      const filePath = path.join(memDir, `${sanitized}.json`);
      try {
        await fs.unlink(filePath);
        process.stdout.write(`Cleared memory for key "${memoryKey}".\n`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          process.stdout.write(`No memory found for key "${memoryKey}".\n`);
        } else {
          process.stderr.write(`Error: ${(err as Error).message}\n`);
          process.exit(1);
        }
      }
    }
    process.exit(0);
  }

  if (sub === "inspect") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("Usage: orager memory inspect --key <memoryKey>\n");
      process.exit(1);
    }

    const store = await loadMemoryStoreAny(memoryKey);
    const sortedEntries = [...store.entries].sort(
      (a, b) => b.importance - a.importance || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    process.stdout.write(`Memory key:  ${memoryKey}\n`);
    process.stdout.write(`Entries:     ${store.entries.length}\n`);

    if (isSqliteMemoryEnabled()) {
      const count = await getMemoryEntryCount(memoryKey);
      const master = await loadMasterContext(memoryKey);
      const checkpoint = await loadLatestCheckpointByContextId(memoryKey);

      const l1Chars = master?.length ?? 0;
      const l1Tokens = Math.round(l1Chars / 4);
      const l2EstChars = count * 80;
      const l3Chars = checkpoint?.summary?.length ?? 0;
      const l3Tokens = Math.round(l3Chars / 4);

      process.stdout.write(`\n── Layer 1 — Master Context ────────────────────────\n`);
      process.stdout.write(`  ${l1Chars} chars (~${l1Tokens} tokens) / ${MEMORY_LAYER1_MASTER_MAX_CHARS.toLocaleString()} char cap\n`);
      if (master) {
        process.stdout.write(master.slice(0, 600) + (master.length > 600 ? "\n[...]" : "") + "\n");
      } else {
        process.stdout.write("  (empty)\n");
      }

      process.stdout.write(`\n── Layer 2 — Retrieved Entries ─────────────────────\n`);
      process.stdout.write(`  ${count} non-expired entries / ~${l2EstChars} chars / ${MEMORY_LAYER2_RETRIEVED_MAX_CHARS.toLocaleString()} char cap\n`);

      process.stdout.write(`\n── Layer 3 — Session Checkpoint ────────────────────\n`);
      process.stdout.write(`  ${l3Chars} chars (~${l3Tokens} tokens) / ${MEMORY_LAYER3_CHECKPOINT_MAX_CHARS.toLocaleString()} char cap\n`);
      if (checkpoint) {
        process.stdout.write(
          `  session ${checkpoint.threadId.slice(0, 8)}… turn ${checkpoint.lastTurn}\n`,
        );
        if (checkpoint.summary) {
          process.stdout.write(
            checkpoint.summary.slice(0, 600) + (checkpoint.summary.length > 600 ? "\n[...]" : "") + "\n",
          );
        }
      } else {
        process.stdout.write("  (none)\n");
      }

      const total = l1Chars + l2EstChars + l3Chars;
      process.stdout.write(`\nTotal memory section: ~${total} chars\n`);
    }

    if (sortedEntries.length > 0) {
      process.stdout.write(`\n── Top entries (by importance) ─────────────────────\n`);
      for (const e of sortedEntries.slice(0, 10)) {
        const tags = e.tags?.length ? ` [${e.tags.join(",")}]` : "";
        const preview = e.content.length > 100 ? e.content.slice(0, 100) + "…" : e.content;
        process.stdout.write(`  imp:${e.importance}${tags}  ${preview}\n`);
      }
      if (sortedEntries.length > 10) {
        process.stdout.write(`  … and ${sortedEntries.length - 10} more\n`);
      }
    } else {
      process.stdout.write("No entries found.\n");
    }

    process.exit(0);
  }

  if (sub === "reset") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("Usage: orager memory reset --key <memoryKey> [--yes]\n");
      process.exit(1);
    }
    if (!isSqliteMemoryEnabled()) {
      process.stderr.write("reset requires SQLite (ORAGER_DB_PATH must not be 'none').\n");
      process.exit(1);
    }
    const skipConfirm = subArgs.includes("--yes");
    if (!skipConfirm) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `Permanently delete all memory entries and session checkpoints for context "${memoryKey}"? [y/N] `,
          resolve,
        );
      });
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        process.stdout.write("Aborted.\n");
        process.exit(0);
      }
    }
    const deletedEntries = await clearMemoryStoreSqlite(memoryKey);
    const deletedCheckpoints = await deleteCheckpointsByContextId(memoryKey);
    process.stdout.write(
      `Reset complete: deleted ${deletedEntries} memory entries and ${deletedCheckpoints} session checkpoints for context "${memoryKey}".\n`,
    );
    process.exit(0);
  }

  process.stderr.write("Usage: orager memory <export|list|clear|inspect|reset> [options]\n");
  process.exit(1);
}
