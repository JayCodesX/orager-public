# Session API

Sessions persist the full conversation history for an agent run, enabling resume, fork, rollback, search, and compaction.

---

## Session Lifecycle

1. **Created** on first run -- auto-generated ID or explicit `--session-id` / `sessionId` option.
2. **Stored** as append-only JSONL at `~/.orager/sessions/<id>.jsonl`.
3. **Indexed** in a SQLite database at `~/.orager/sessions/index.sqlite` for metadata and full-text search.
4. **Recovery manifest** written during active runs for crash recovery.

### Storage Layout

```
~/.orager/sessions/
  <session-id>.jsonl           # Append-only conversation log
  index.sqlite                 # Metadata + FTS index across all sessions
  recovery/                    # Crash recovery manifests
    <session-id>.json
```

---

## Operations

### Resume

Continue a previous session from where it left off.

```bash
# CLI
orager run --session-id <id> "continue with the refactor"
orager chat --resume <id>
```

```ts
// Library
await runAgentLoop({
  sessionId: "existing-session-id",
  prompt: "continue with the refactor",
  // ... other options
});
```

Use `forceResume: true` to resume even when the stored working directory differs from the current one.

### Fork

Create a new session branching from an existing one, optionally from a specific turn.

```bash
orager run --fork-session <source-id> "try a different approach"
orager run --fork-session <source-id> --at-turn 5 "try a different approach"
```

### Rollback

Revert a session to a previous state.

```bash
orager run --rollback-session <id>
```

### Compact

Summarize session history in-place to reduce token usage on resume.

```bash
orager run --compact-session <id>
```

Compaction replaces older messages with a summary while preserving recent turns. The original turn count and compaction timestamp are recorded in `compactionHistory` for audit lineage.

### Search

Full-text search across all sessions.

```bash
orager run --search-sessions "authentication bug"
```

Uses the FTS index in `index.sqlite` for fast keyword search.

### Prune

Remove old sessions past a retention threshold.

```bash
orager run --prune-sessions --older-than 30d
```

### Trash / Restore / Delete

Sessions follow a soft-delete lifecycle:

1. **Trash** -- marks the session as `trashed: true` (skipped on resume, excluded from active use)
2. **Restore** -- clears the trashed flag
3. **Delete** -- permanent removal of the JSONL file and index entry

---

## JSONL Format

Each line in the session file is a JSON object representing a single message:

```jsonl
{"role":"system","content":"You are a helpful coding assistant...","timestamp":"2025-01-15T10:00:00.000Z"}
{"role":"user","content":"Refactor the auth module","timestamp":"2025-01-15T10:00:01.000Z"}
{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\"path\":\"src/auth.ts\"}"}}],"timestamp":"2025-01-15T10:00:02.000Z"}
{"role":"tool","tool_call_id":"call_1","content":"// file contents...","timestamp":"2025-01-15T10:00:03.000Z"}
{"role":"assistant","content":"I've reviewed the auth module. Here are the changes...","timestamp":"2025-01-15T10:00:10.000Z"}
```

### Message Fields

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"system" \| "user" \| "assistant" \| "tool"` | Message role. |
| `content` | `string \| null` | Message text. `null` for assistant messages that only contain tool calls. |
| `timestamp` | `string` | ISO 8601 timestamp. |
| `tool_calls` | `ToolCall[]` | Present on assistant messages that invoke tools. |
| `tool_call_id` | `string` | Present on tool messages; correlates with the originating tool call. |

---

## SessionData

The in-memory representation of a session.

```ts
interface SessionData {
  sessionId: string;
  model: string;
  messages: Message[];
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  turnCount: number;
  cwd: string;
  trashed?: boolean;
  summarized?: boolean;
  compactedAt?: string;        // ISO 8601, when last compacted
  compactedFrom?: string;      // source session ID (for fork+compact)
  compactionHistory?: Array<{
    compactedAt: string;
    previousTurnCount: number;
  }>;
  source?: "cli" | "daemon" | "mcp";
  cumulativeCostUsd?: number;
  pendingApproval?: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    assistantMessage: AssistantMessage;
    toolCalls: ToolCall[];
    questionedAt?: string;
  } | null;
}
```

---

## Session Locks

A lock file prevents concurrent access to the same session.

- **Stale lock detection**: locks older than 5 minutes (default) are considered stale and can be overridden.
- **Force resume**: use `--force-resume` or `forceResume: true` to override a stale lock.
- **Lock timeout**: configurable via `sessionLockTimeoutMs` in `AgentLoopOptions`.

```ts
await runAgentLoop({
  sessionId: "my-session",
  forceResume: true,         // override stale locks
  sessionLockTimeoutMs: 300000, // 5 minutes (default)
  // ...
});
```

---

## Session Recovery

During active runs, a recovery manifest is written to `~/.orager/sessions/recovery/<session-id>.json`. If the process crashes, the next run can detect the manifest and offer to resume from the last checkpoint.

The manifest is cleared on normal run completion.
