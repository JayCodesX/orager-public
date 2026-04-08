# Frontend Handoff: Multi-Agent Channel System

> **For:** orager-desktop frontend engineer
> **From:** Backend (orager core)
> **Date:** 2026-04-07
> **Status:** All backend RPC methods are implemented, tested, and merged to `main`

---

## What Was Built

The orager sidecar now has a complete multi-agent collaboration system. Your job is to build the desktop UI that talks to it over the existing JSON-RPC 2.0 stdio transport (same as `agent/run`, `agent/cancel`, etc.).

**Three new subsystems, 27 RPC methods total:**

1. **Agent Identity** — Persistent agent personas with soul files, lessons, memory, and daily logs
2. **Channels** — Discord-like message channels with @mention routing and threaded replies
3. **Scheduler** — Cron-based task scheduling with run history and channel output

All data is in SQLite on disk. The sidecar handles persistence — the frontend is purely a presentation layer that calls RPC methods.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  orager-desktop (Tauri + React 19)              │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Channels │  │ Agents   │  │ Schedule │     │
│  │ Tab      │  │ Tab      │  │ Tab      │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       │              │              │           │
│       └──────────────┼──────────────┘           │
│                      │                          │
│              JSON-RPC 2.0 (stdio)               │
└──────────────────────┼──────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────┐
│  orager sidecar      │                          │
│                      ▼                          │
│  ┌─────────────────────────────────────────┐    │
│  │ subprocess.ts — RPC method dispatcher   │    │
│  └─────────┬───────────┬───────────┬───────┘    │
│            │           │           │            │
│   ┌────────▼──┐ ┌──────▼───┐ ┌────▼────────┐   │
│   │ agent-    │ │ channel  │ │ scheduler   │   │
│   │ identity  │ │ .ts      │ │ .ts         │   │
│   │ .ts       │ │ channel- │ │ scheduler-  │   │
│   │ agent-    │ │ router   │ │ db.ts       │   │
│   │ identity- │ │ .ts      │ │             │   │
│   │ index.ts  │ │          │ │             │   │
│   └───────────┘ └──────────┘ └─────────────┘   │
│                                                 │
│   ~/.orager/agents/         (identity files)    │
│   ~/.orager/agents/identity-index.sqlite        │
│   ~/.orager/channels/channels.sqlite            │
│   ~/.orager/schedules/schedules.sqlite          │
└─────────────────────────────────────────────────┘
```

---

## TypeScript Types (copy into your project)

```typescript
// ── Agent Identity ──────────────────────────────────────────────────

interface AgentIdentitySummary {
  id: string;
  hasSoul: boolean;
  hasOperatingManual: boolean;
  lessonCount: number;
  dailyLogCount: number;
  lastDailyLog?: string;
}

interface AgentLesson {
  date: string;
  what: string;
  why: string;
  fix: string;
  neverCompress?: boolean;
}

interface AgentIdentity {
  id: string;
  soul: string;
  operatingManual: string;
  memory: string;
  lessons: AgentLesson[];
  patterns: string;
  dailyLogs: Record<string, string>; // { "2026-04-07": "log content..." }
}

// ── Channels ────────────────────────────────────────────────────────

interface Channel {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface ChannelSummary {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  messageCount: number;
  lastMessageAt: string | null;
}

interface ChannelMember {
  channelId: string;
  memberId: string; // agent slug or "user"
  joinedAt: string;
}

interface ChannelMessage {
  id: string;
  channelId: string;
  authorId: string; // agent slug or "user"
  content: string;
  threadId: string | null;
  mentions: string[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ── Scheduler ───────────────────────────────────────────────────────

interface Schedule {
  id: string;
  ownerType: "agent" | "user";
  ownerId: string;
  channelId: string;
  cron: string;
  prompt: string;
  model: string | null;
  enabled: boolean;
  source: "manual" | "operating-manual" | "agent-created";
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRun {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "error" | "timeout";
  costUsd: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  sessionId: string | null;
  isCatchup: boolean;
}
```

---

## RPC Method Reference

All methods use JSON-RPC 2.0 format. Send via the existing sidecar stdio transport:

```typescript
// Example: calling channel/list
sidecar.send({
  jsonrpc: "2.0",
  id: nextId(),
  method: "channel/list",
  params: {},
});
```

### Agent Identity (10 methods)

| Method | Params | Returns |
|--------|--------|---------|
| `agent/identity/list` | — | `AgentIdentitySummary[]` |
| `agent/identity/get` | `{ agentId }` | `AgentIdentity \| null` |
| `agent/identity/create` | `{ agentId, soul?, operatingManual?, memory?, patterns? }` | `{ created, agentId }` |
| `agent/identity/update` | `{ agentId, file, content }` | `{ updated }` |
| `agent/identity/delete` | `{ agentId }` | `{ deleted }` |
| `agent/identity/append-lesson` | `{ agentId, what, why, fix, neverCompress? }` | `{ appended }` |
| `agent/identity/append-log` | `{ agentId, content }` | `{ appended }` |
| `agent/identity/search` | `{ query, agentIds?, fileTypes?, limit?, semantic? }` | `IdentitySearchResult[]` |
| `agent/identity/index` | `{ agentId, embeddings? }` | `{ chunksIndexed }` |
| `agent/identity/rebuild-index` | `{ embeddings? }` | `{ agentsIndexed, totalChunks }` |

**`file` param for `agent/identity/update`:** One of `"soul.md"`, `"operating-manual.md"`, `"memory.md"`, `"lessons.md"`, `"patterns.md"`

### Channels (9 methods)

| Method | Params | Returns |
|--------|--------|---------|
| `channel/list` | — | `ChannelSummary[]` |
| `channel/create` | `{ name, description?, members?[] }` | `Channel` |
| `channel/get` | `{ channelId? }` or `{ name? }` | `Channel \| null` |
| `channel/update` | `{ channelId, name?, description? }` | `{ updated }` |
| `channel/delete` | `{ channelId }` | `{ deleted }` |
| `channel/members` | `{ channelId, action?, memberId? }` | `ChannelMember[]` or `{ added }` or `{ removed }` |
| `channel/post` | `{ channelId, authorId, content, threadId?, metadata? }` | `ChannelMessage` |
| `channel/messages` | `{ channelId, limit?, before?, threadId? }` | `ChannelMessage[]` |
| `channel/search` | `{ query, channelId?, authorId?, limit? }` | `ChannelMessage[]` |

**`channel/members` actions:** Omit `action` for list, or pass `"add"` / `"remove"` with `memberId`.

**`channel/post` @mentions:** Include `@agent-id` in `content` and the sidecar auto-routes to that agent (non-blocking). The agent's response is posted back as a threaded reply.

### Scheduler (10 methods)

| Method | Params | Returns |
|--------|--------|---------|
| `schedule/list` | `{ ownerType?, ownerId?, enabledOnly? }` | `Schedule[]` |
| `schedule/create` | `{ ownerType, ownerId, channelId, cron, prompt, model?, source? }` | `Schedule` |
| `schedule/update` | `{ id, cron?, prompt?, channelId?, model?, enabled? }` | `{ updated }` |
| `schedule/delete` | `{ id }` | `{ deleted }` |
| `schedule/pause` | `{ id }` | `{ paused }` |
| `schedule/resume` | `{ id }` | `{ resumed }` |
| `schedule/history` | `{ scheduleId, limit? }` | `ScheduleRun[]` |
| `schedule/start` | — | `{ loaded, catchups }` |
| `schedule/stop` | — | `{ stopped }` |
| `schedule/status` | — | `{ running, activeJobs }` |

**`cron` format:** Standard 5-field cron (`*/30 * * * *`), 6-field with seconds, or 7-field with year. Uses [Croner](https://github.com/Hexagon/croner) syntax.

**`schedule/start`:** Call once on app launch to activate the scheduler. Returns how many schedules were loaded and how many catch-up runs were triggered.

---

## Recommended UI Structure

### 1. Channels View (primary)

```
┌──────────────┬──────────────────────────────────┬──────────────┐
│  # general   │  [message stream]                 │  Members     │
│  # ops       │                                   │  ─────────   │
│  # deploys   │  user (10:30): @mercury check     │  🤖 mercury  │
│  # research  │  the deploy pipeline              │  🤖 venus    │
│              │                                   │  👤 user     │
│  + New       │  mercury (10:31): Pipeline is     │              │
│              │  healthy, all stages green ✅      │  Schedule    │
│              │                                   │  ─────────   │
│              │  ──────── thread (2 replies) ──── │  */30 * * *  │
│              │                                   │  Health chk  │
│              ├───────────────────────────────────│              │
│              │  [message input]  [@mention]       │              │
└──────────────┴──────────────────────────────────┴──────────────┘
```

**Key interactions:**
- Left sidebar: channel list via `channel/list`, create new via `channel/create`
- Center: message stream via `channel/messages` (poll or re-fetch on post)
- Compose: `channel/post` with `authorId: "user"`, parse @mentions for autocomplete from members list
- Right sidebar: `channel/members` for member list, linked schedules via `schedule/list { channelId }`
- Thread view: `channel/messages { threadId }` for threaded replies
- Search: `channel/search` in a modal or inline

### 2. Agents View

```
┌──────────────┬──────────────────────────────────────────────────┐
│  Agents      │  mercury                                         │
│  ─────────   │  ═══════════════════════════                     │
│  🤖 mercury  │  Soul: Deployment specialist. Handles CI/CD...  │
│  🤖 venus    │                                                  │
│  🤖 apollo   │  Lessons (3):                                    │
│              │  ┌─ Never deploy on Fridays [CRITICAL]           │
│  + New Agent │  ├─ Always run smoke tests after deploy          │
│              │  └─ Use staging DB for migration tests           │
│              │                                                  │
│              │  Today's Log:                                    │
│              │  Model: deepseek/deepseek-r1 | Turns: 5         │
│              │  Cost: $0.0042 | Result: success                │
│              │                                                  │
│              │  [Edit Soul] [Edit Manual] [View Patterns]       │
└──────────────┴──────────────────────────────────────────────────┘
```

**Key interactions:**
- Agent list: `agent/identity/list`
- Agent detail: `agent/identity/get { agentId }`
- Edit files: `agent/identity/update { agentId, file, content }`
- Create agent: `agent/identity/create { agentId, soul }`
- Search knowledge: `agent/identity/search { query }` in a search bar

### 3. Schedules View

```
┌──────────────────────────────────────────────────────────────────┐
│  Schedules                                            [+ New]   │
│  ════════════════════════════════════════════════════            │
│                                                                 │
│  ✅ Health Check          */30 * * * *     mercury → #ops       │
│     Last: 2 min ago | Cost: $0.003 | Success                   │
│                                                                 │
│  ✅ Weekly Report         0 9 * * 1        user → #general      │
│     Last: 3 days ago | Cost: $0.12 | Success                   │
│                                                                 │
│  ⏸️ DB Backup Check       0 0 * * *        venus → #ops         │
│     Paused                                                      │
│                                                                 │
│  [Run History]  [Pause/Resume]  [Edit]  [Delete]                │
└──────────────────────────────────────────────────────────────────┘
```

**Key interactions:**
- List: `schedule/list`
- Create: `schedule/create` (form with cron builder, channel picker, agent/user toggle)
- Pause/Resume: `schedule/pause` / `schedule/resume`
- History: `schedule/history { scheduleId }` — show in a slide-out or modal
- Status indicator: `schedule/status` on app load

---

## Startup Sequence

On app launch, the frontend should:

```typescript
// 1. Start the scheduler (loads enabled schedules, runs catch-ups)
await rpc("schedule/start");

// 2. Fetch initial data for the default view
const channels = await rpc("channel/list");
const agents = await rpc("agent/identity/list");
const schedulerStatus = await rpc("schedule/status");
```

---

## Polling Strategy

There is no push notification mechanism yet. Use polling:

| Data | Interval | Method |
|------|----------|--------|
| Channel messages (active channel) | 2-3s | `channel/messages { channelId, limit: 20 }` |
| Channel list (sidebar) | 30s | `channel/list` |
| Agent list | 60s | `agent/identity/list` |
| Scheduler status | 30s | `schedule/status` |

**Future:** We can add JSON-RPC notifications (`channel/message` events) to replace polling with push. Not implemented yet — poll for now.

---

## Error Handling

All RPC errors follow JSON-RPC 2.0:

| Code | Meaning |
|------|---------|
| `-32602` | Missing or invalid params |
| `-32601` | Unknown method |
| `-32000` | Server-side operation error (check `error.message`) |

---

## @mention Behavior

When the user posts a message with `@agent-id`:
1. Frontend sends `channel/post` with content containing `@mercury`
2. Sidecar parses mentions, looks up identity-backed agents
3. Sidecar boots the agent with channel history context
4. Agent's response is posted as a threaded reply automatically
5. Frontend picks up the reply on next `channel/messages` poll

**The frontend does not need to handle agent wake** — it's all server-side. Just poll for new messages.

---

## Notes

- **authorId convention:** Use `"user"` for human messages. Agent messages use the agent's identity ID (e.g., `"mercury"`, `"venus"`).
- **Markdown rendering:** Message `content` may contain markdown. Render with the existing markdown renderer in SessionChat.
- **Thread collapse:** Messages with `threadId !== null` are thread replies. Show a "N replies" collapse/expand in the channel view.
- **Daily logs:** The `dailyLogs` field in `AgentIdentity` is a `Record<string, string>` (date → content), not a Map. Already converted in the RPC layer.
- **Cron validation:** The sidecar validates cron expressions on `schedule/create`. Invalid cron returns a `-32000` error.
- **Channel names:** Must be unique. The sidecar enforces this — duplicate names return a `-32000` error.
