/**
 * channel.ts — SQLite-backed channel message bus.
 *
 * Channels are persistent communication spaces where agents and the user
 * post messages with @mentions. Think Discord channels for AI agents.
 *
 * Database: ~/.orager/channels/channels.sqlite
 *
 * Tables:
 *   channels        — Channel definitions (id, name, description)
 *   channel_members — Who belongs to each channel (agent slugs + 'user')
 *   messages        — Chronological message stream with @mention parsing
 *   messages_fts    — FTS5 index for full-text search over messages
 */

import { openDb, isSqliteVecAvailable } from "./native-sqlite.js";
import type { SqliteDatabase } from "./native-sqlite.js";
import { runMigrations, type Migration } from "./db-migrations.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Channel {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMember {
  channelId: string;
  memberId: string; // agent slug or 'user'
  joinedAt: string;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  authorId: string; // agent slug or 'user'
  content: string;
  threadId: string | null; // null for top-level, message ID for thread replies
  mentions: string[]; // parsed @mentioned agent IDs
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface PostMessageOptions {
  threadId?: string;
  metadata?: Record<string, unknown>;
}

// ── DB singleton ─────────────────────────────────────────────────────────────

let _db: SqliteDatabase | null = null;
let _customDbPath: string | null = null;

function resolveChannelDbPath(): string {
  if (_customDbPath) return _customDbPath;
  return path.join(os.homedir(), ".orager", "channels", "channels.sqlite");
}

async function getDb(): Promise<SqliteDatabase> {
  if (_db) return _db;

  const dbPath = resolveChannelDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = await openDb(dbPath);
  _migrate(_db);
  return _db;
}

/** Close the DB connection. */
export function closeChannelDb(): void {
  if (_db) {
    try { _db.exec("PRAGMA optimize"); } catch { /* ignore */ }
    _db = null;
  }
}

/** Reset singleton — for testing only. */
export function _resetForTesting(customDbPath?: string): void {
  closeChannelDb();
  _customDbPath = customDbPath ?? null;
}

// ── Migrations ───────────────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_channels_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS channels (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        member_id   TEXT NOT NULL,
        joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (channel_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        author_id   TEXT NOT NULL,
        content     TEXT NOT NULL,
        thread_id   TEXT,
        mentions    TEXT,
        metadata    JSON,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id, created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `,
  },
];

function _migrate(db: SqliteDatabase): void {
  runMigrations(db, MIGRATIONS);
}

// ── Channel CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a new channel.
 */
export async function createChannel(
  name: string,
  description?: string,
  initialMembers?: string[],
): Promise<Channel> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO channels (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, description ?? "", now, now);

  // Add initial members
  if (initialMembers?.length) {
    const addMember = db.prepare(
      "INSERT OR IGNORE INTO channel_members (channel_id, member_id, joined_at) VALUES (?, ?, ?)",
    );
    for (const memberId of initialMembers) {
      addMember.run(id, memberId, now);
    }
  }

  return { id, name, description: description ?? "", createdAt: now, updatedAt: now };
}

/**
 * Get a channel by ID.
 */
export async function getChannel(channelId: string): Promise<Channel | null> {
  const db = await getDb();
  const row = db.prepare(
    "SELECT id, name, description, created_at, updated_at FROM channels WHERE id = ?",
  ).get(channelId) as { id: string; name: string; description: string; created_at: string; updated_at: string } | null;

  if (!row) return null;
  return { id: row.id, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * Get a channel by name (e.g. "#general").
 */
export async function getChannelByName(name: string): Promise<Channel | null> {
  const db = await getDb();
  const row = db.prepare(
    "SELECT id, name, description, created_at, updated_at FROM channels WHERE name = ?",
  ).get(name) as { id: string; name: string; description: string; created_at: string; updated_at: string } | null;

  if (!row) return null;
  return { id: row.id, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * List all channels with summary stats.
 */
export async function listChannels(): Promise<ChannelSummary[]> {
  const db = await getDb();
  const rows = db.prepare(`
    SELECT
      c.id, c.name, c.description,
      (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at
    FROM channels c
    ORDER BY c.updated_at DESC
  `).all() as Array<{
    id: string; name: string; description: string;
    member_count: number; message_count: number; last_message_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    memberCount: r.member_count,
    messageCount: r.message_count,
    lastMessageAt: r.last_message_at,
  }));
}

/**
 * Update a channel's name or description.
 */
export async function updateChannel(
  channelId: string,
  updates: { name?: string; description?: string },
): Promise<boolean> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }

  if (sets.length === 0) return false;

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(channelId);

  const result = db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return (result as any)?.changes > 0;
}

/**
 * Delete a channel and all its messages/members (CASCADE).
 */
export async function deleteChannel(channelId: string): Promise<boolean> {
  const db = await getDb();
  const result = db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
  return (result as any)?.changes > 0;
}

// ── Members ──────────────────────────────────────────────────────────────────

/**
 * List members of a channel.
 */
export async function listMembers(channelId: string): Promise<ChannelMember[]> {
  const db = await getDb();
  const rows = db.prepare(
    "SELECT channel_id, member_id, joined_at FROM channel_members WHERE channel_id = ? ORDER BY joined_at",
  ).all(channelId) as Array<{ channel_id: string; member_id: string; joined_at: string }>;

  return rows.map((r) => ({ channelId: r.channel_id, memberId: r.member_id, joinedAt: r.joined_at }));
}

/**
 * Add a member to a channel.
 */
export async function addMember(channelId: string, memberId: string): Promise<void> {
  const db = await getDb();
  db.prepare(
    "INSERT OR IGNORE INTO channel_members (channel_id, member_id, joined_at) VALUES (?, ?, ?)",
  ).run(channelId, memberId, new Date().toISOString());
}

/**
 * Remove a member from a channel.
 */
export async function removeMember(channelId: string, memberId: string): Promise<void> {
  const db = await getDb();
  db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND member_id = ?").run(channelId, memberId);
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Parse @mentions from message content.
 * Matches @word-with-dashes patterns (agent slugs).
 */
export function parseMentions(content: string): string[] {
  const matches = content.match(/@([a-zA-Z0-9_-]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))]; // deduplicate, strip @
}

/**
 * Post a message to a channel.
 */
export async function postMessage(
  channelId: string,
  authorId: string,
  content: string,
  opts?: PostMessageOptions,
): Promise<ChannelMessage> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const mentions = parseMentions(content);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO messages (id, channel_id, author_id, content, thread_id, mentions, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, channelId, authorId, content,
    opts?.threadId ?? null,
    JSON.stringify(mentions),
    opts?.metadata ? JSON.stringify(opts.metadata) : null,
    now,
  );

  // Touch channel updated_at
  db.prepare("UPDATE channels SET updated_at = ? WHERE id = ?").run(now, channelId);

  return {
    id, channelId, authorId, content,
    threadId: opts?.threadId ?? null,
    mentions, metadata: opts?.metadata ?? null,
    createdAt: now,
  };
}

/**
 * Get paginated message history for a channel.
 */
export async function getMessages(
  channelId: string,
  opts?: { limit?: number; before?: string; threadId?: string },
): Promise<ChannelMessage[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 50;

  let sql = "SELECT * FROM messages WHERE channel_id = ?";
  const params: unknown[] = [channelId];

  if (opts?.threadId !== undefined) {
    sql += " AND thread_id = ?";
    params.push(opts.threadId);
  } else if (opts?.threadId === undefined) {
    // Top-level messages only (no thread filter specified = show all)
  }

  if (opts?.before) {
    sql += " AND created_at < ?";
    params.push(opts.before);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string; channel_id: string; author_id: string; content: string;
    thread_id: string | null; mentions: string; metadata: string | null;
    created_at: string;
  }>;

  // Return in chronological order
  return rows.reverse().map(rowToMessage);
}

/**
 * Get a single message by ID.
 */
export async function getMessage(messageId: string): Promise<ChannelMessage | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

/**
 * Search messages across all channels using FTS5.
 */
export async function searchMessages(
  query: string,
  opts?: { channelId?: string; authorId?: string; limit?: number },
): Promise<ChannelMessage[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 20;

  const sanitized = query.replace(/[*^()\[\]{}":]/g, " ").trim();
  const words = sanitized.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");

  let sql = `
    SELECT m.* FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (opts?.channelId) {
    sql += " AND m.channel_id = ?";
    params.push(opts.channelId);
  }
  if (opts?.authorId) {
    sql += " AND m.author_id = ?";
    params.push(opts.authorId);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToMessage);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToMessage(row: any): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    threadId: row.thread_id ?? null,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  };
}
