# Design Brief: orager-desktop v2

**Prepared for:** UX/UI Designer
**Date:** 2026-04-07
**Product:** orager-desktop — a Tauri-based desktop app (React + TypeScript) that wraps the orager AI agent runtime
**Scope:** Full redesign of existing app + new multi-agent channel system

---

## 1. Context

### What is orager?

orager is an open-core AI agent runtime. Users run AI agents that can execute tools (bash, file I/O, web search, browser automation), remember context across sessions, learn from their own runs, and coordinate with other agents. Think of it as "Claude Code but with persistent memory, self-learning, and multi-model routing."

### What is orager-desktop?

A native desktop app (macOS first, Windows/Linux later) that bundles the orager CLI as a background sidecar process. The app communicates with the sidecar over JSON-RPC 2.0 via stdio. Currently it's a functional but utilitarian developer tool. We want to evolve it into something that feels like a **virtual office** where AI agents work as a team.

### What's changing?

We're adding a multi-agent collaboration system inspired by how business operators run teams of AI agents through Discord. The core insight (from real production usage with 10+ agents across two seven-figure businesses) is:

1. **Agents need persistent identities** — not just a prompt, but a soul (personality, role, chain of command), an operating manual (what to do on startup), long-term memory, accumulated lessons, and decision-making patterns.
2. **Agents need to communicate with each other** — through channels with @mentions, threads, and escalation chains. A human should be able to observe all conversations and jump in at any point.
3. **Agents need to compound knowledge** — daily logs, distilled memory, and a lessons file that grows over time. Every mistake is logged once and never repeated.

### Target Users

- **Primary:** Technical founders, indie hackers, and business operators who want AI agents to run parts of their business (content, ops, QA, deployments, customer analysis)
- **Secondary:** Software engineers who use orager for code tasks and want multi-agent workflows
- **Tertiary:** Non-technical operators who are comfortable with tools like Notion/Discord but don't write code

### Reference

The workflow we're modeling: https://youtu.be/MsewgFiY7F4?si=zA5hnHJvoDOuw-xP

---

## 2. Current State

### Existing App Structure (what you're redesigning)

The app currently has a **tab-based layout** with a sessions sidebar:

```
┌──────────────────────────────────────────────────────────┐
│  [Title Bar]                                              │
├────────┬─────────────────────────────────────────────────┤
│        │                                                  │
│  Tabs  │  Content Area                                    │
│  ────  │                                                  │
│  Chat  │  (varies by tab)                                 │
│  Skills│                                                  │
│  Memory│                                                  │
│  Costs │                                                  │
│  Logs  │                                                  │
│  OMLS  │                                                  │
│  ...   │                                                  │
│        │                                                  │
├────────┴─────────────────────────────────────────────────┤
│  [Status Bar]                                             │
└──────────────────────────────────────────────────────────┘
```

### Existing Tabs/Pages

| Tab | What it does | Keep / Rethink |
|---|---|---|
| **SessionChat** | 1:1 chat with a single agent. Message input, streaming responses, tool call display. This is the primary UI today. | **Rethink** — becomes one surface inside a larger agent workspace |
| **SkillBank** | Lists learned skills, delete/inspect. Bare table. | **Rethink** — add Toolkits import, per-agent skill view |
| **MemoryBrowser** | Browse memory namespaces and entries | **Rethink** — integrate with per-agent memory/lessons/patterns |
| **CostTracker** | Charts showing token usage and costs over time | **Keep** — move into a dashboard or agent profile |
| **LogViewer** | Raw system logs | **Keep** — move to developer/debug area |
| **ModelCompare** | Side-by-side model comparison | **Keep** — low priority, can stay as-is |
| **OmlsStatus** | OMLS training status (Pro feature) | **Keep** — move to agent profile or settings |
| **Profiles** | 8 built-in profile presets | **Rethink** — profiles become a starting point for agent creation |
| **Settings** | Config editor | **Rethink** — add Toolkits, Agent Management, License sections |
| **OllamaManager** | Manage local Ollama models | **Keep** — move to settings |
| **Dashboard** | Overview (minimal currently) | **Rethink** — becomes the home screen |

### Existing Components

- `SessionsSidebar.tsx` — left sidebar listing chat sessions
- `CommandPalette.tsx` — Cmd+K command launcher
- `ModelSelect.tsx` — model dropdown
- `LicenseGate.tsx` — blocks Pro features for free tier
- `OnboardingBanner.tsx` — first-run setup prompt
- `TitleBar.tsx`, `Toast.tsx`, `Tooltip.tsx`, `ConfirmDialog.tsx`

### Tech Stack (fixed, not changing)

- React 19 + TypeScript + Vite
- Tauri 2 (Rust backend)
- Lucide React icons
- Recharts for charts
- No component library currently — custom CSS

### Design System Status

There is **no formal design system** yet. The app uses custom CSS with a dark theme. This redesign is the opportunity to establish one.

---

## 3. Information Architecture (Proposed)

### Top-Level Navigation

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│   [Home]  [Channels]  [Agents]  [Skills]  [Settings]            │
│                                                                  │
│   ─── or sidebar nav ───                                         │
│                                                                  │
│   🏠 Home                                                        │
│   💬 Channels          ← NEW: the Discord-like workspace         │
│   🤖 Agents            ← NEW: agent identity management          │
│   📚 Skills            ← Existing (enhanced)                     │
│   ⚙️ Settings           ← Existing (enhanced)                     │
│                                                                  │
│   ── Collapse into secondary/overflow: ──                        │
│   📊 Costs                                                       │
│   📋 Logs                                                        │
│   🔬 OMLS Status (Pro)                                           │
│   🔀 Model Compare                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Page Hierarchy

```
Home (Dashboard)
├── Activity feed — recent agent messages, task completions, escalations
├── Quick stats — active agents, messages today, costs, lessons learned
└── Quick actions — new chat, create agent, import toolkit

Channels
├── Channel List (sidebar)
│   ├── # general
│   ├── # project-backend
│   ├── # deployments
│   ├── Direct Lines (you + one agent)
│   │   ├── @ machaveli
│   │   ├── @ mercury
│   │   └── @ sunny
│   └── [+ Create Channel]
├── Channel View (main area)
│   ├── Message stream (chronological)
│   ├── Thread panel (slide-out right)
│   ├── Pinned messages
│   └── Message input with @mention autocomplete
└── Channel Settings
    ├── Name, description, topic
    ├── Agent membership
    └── Escalation rules

Agents
├── Agent Grid/List
│   ├── Agent cards with status (active/idle/offline)
│   ├── [+ Create Agent]
│   └── [Import from Toolkit]
├── Agent Profile (detail view)
│   ├── Overview — name, role, status, avatar, model, uptime
│   ├── Soul — view/edit soul.md (rich markdown editor)
│   ├── Operating Manual — view/edit operating-manual.md
│   ├── Memory — curated long-term memory (memory.md)
│   ├── Lessons — lesson list with count, search, add/edit
│   ├── Patterns — decision framework (patterns.md)
│   ├── Daily Logs — timeline of daily log files
│   ├── Skills — agent-specific skills from SkillBank
│   ├── Costs — per-agent cost breakdown
│   └── Channels — which channels this agent is in
└── Agent Creation Wizard
    ├── Step 1: Choose template (from seed agents, toolkit, or blank)
    ├── Step 2: Define soul (name, role, personality, chain of command)
    ├── Step 3: Set capabilities (model, tools, permissions)
    ├── Step 4: Assign channels
    └── Step 5: Review & activate

Skills
├── Skill List — searchable, filterable by type/source
├── Skill Detail — content, usage stats, source
├── Toolkits (import section)
│   ├── Recommended toolkits
│   ├── Custom repo input (owner/repo)
│   ├── Import dialog with category picker + progress
│   └── Imported toolkit history
└── Skill Merge (Pro)

Settings
├── General — model defaults, API keys, data directory
├── Providers — per-provider config (keys, endpoints)
├── Permissions — tool permission matrix, bash policy
├── Toolkits — import/manage GitHub toolkit repos
├── License — tier status, activate/deactivate
├── Ollama — local model management
└── Advanced — telemetry, debug, developer mode
```

---

## 4. Key Screens to Mock

Priority order. Design these first.

### Screen 1: Channel View (highest priority)

This is the core new experience — the "Discord for AI agents."

**Layout:** Three-panel: channel sidebar (left) + message stream (center) + context panel (right, collapsible)

**Channel Sidebar:**
- Grouped sections: Channels, Direct Lines
- Each channel shows: name, unread count badge, last activity timestamp
- Agent presence dots (green = active, yellow = idle, gray = offline)
- Create channel button
- Collapsible sections

**Message Stream:**
- Messages from agents and the user
- Each message: avatar, agent name (with role subtitle), timestamp, content
- Content supports: markdown, code blocks, tool call results (collapsible), file attachments
- @mentions highlighted in message text
- "New messages" divider when scrolling up
- Thread indicator — "3 replies" link that opens thread panel
- System messages for: agent joined, task assigned, escalation, sub-agent spawned/dismissed

**Message Input:**
- Text area with @mention autocomplete (type @ to see agent list)
- Attachment button (files)
- Channel selector if sending from global input
- Enter to send, Shift+Enter for newline

**Context Panel (right, collapsible):**
- Shows either: channel info, or clicked agent's quick profile
- Channel info: description, member agents, pinned messages, escalation chain
- Agent quick profile: soul summary, current task, lesson count, last active

**Key interactions:**
- Click agent avatar → opens agent quick profile in context panel
- Click "3 replies" → opens thread in slide-over panel
- @mention an offline agent → shows "This will wake [agent] when it next checks in"
- Right-click message → pin, reply in thread, copy, delete

### Screen 2: Agent Profile

**Layout:** Header (agent identity) + tabbed content area

**Header:**
- Agent avatar (auto-generated or uploaded), name, role (from soul.md), status badge
- Model badge (e.g., "claude-sonnet-4-6"), uptime, lesson count, total cost
- Action buttons: Start/Stop, Edit, Delete, Open Direct Line

**Tabs:**
- **Soul** — Rich markdown viewer/editor for soul.md. "Edit" button switches to editor mode. Syntax-highlighted YAML frontmatter.
- **Operating Manual** — Same editor pattern for operating-manual.md
- **Lessons** (most novel) — List view: each lesson is a card with "What happened", "Why", "Permanent fix". Sort by date, search. Badge showing total count. "Add lesson" button. Lessons that fired recently highlighted.
- **Patterns** — Decision framework editor. Structured sections: "Questions I ask", "Tradeoffs I evaluate", "My decision process"
- **Memory** — Curated memory entries. Similar to existing MemoryBrowser but scoped to this agent.
- **Daily Logs** — Calendar/timeline view. Click a date to see that day's raw log. Search across logs.
- **Costs** — Per-agent cost chart (reuse CostTracker component)
- **Channels** — List of channels this agent belongs to, with activity sparkline

### Screen 3: Home / Dashboard

**Layout:** Single page with cards/widgets

**Widgets:**
- **Activity Feed** — Recent messages across all channels, collapsed (shows agent name, channel, preview). Click to jump to message.
- **Agent Status Grid** — All agents with status dots, current task preview, last active. Click to open profile.
- **Quick Stats** — Active agents, messages today, tasks completed, lessons learned this week, total cost (period selector)
- **Quick Actions** — "New Chat" (opens 1:1 session), "Create Agent", "Import Toolkit"
- **Alerts** — Escalations waiting for human response, budget warnings, agent errors

### Screen 4: Agent Creation Wizard

**Layout:** Multi-step wizard (stepper at top)

**Step 1: Template**
- Grid of cards: Seed agents (6 built-in), Recently imported toolkit agents, "Start from scratch"
- Search/filter toolkit agents
- Selecting a template pre-fills the soul and capabilities

**Step 2: Soul**
- Form fields: Name, Role (short), Personality (textarea), Chain of Command (who does this agent report to?), Operating Principles (bulleted list editor)
- Preview panel showing the generated soul.md
- "Advanced: Edit raw markdown" toggle

**Step 3: Capabilities**
- Model selector dropdown
- Tool permission checkboxes (grouped by category)
- Bash policy toggle (sandbox level)
- Budget limit (monthly USD cap)

**Step 4: Channels**
- Checkbox list of existing channels
- "Create new channel" inline option
- Direct line auto-created

**Step 5: Review**
- Summary card with all choices
- "Activate" button — agent starts and reads its identity files

### Screen 5: Skills + Toolkits

**Layout:** Two sections — Skills list (top) + Toolkits (bottom, or tab)

**Skills Section:**
- Searchable table/grid of SkillBank entries
- Columns: name/slug, type (skill/agent/rule), source, success rate, use count
- Click to expand/view full content
- Filter by: type, source toolkit, agent

**Toolkits Section:**
- Input field: "github.com/ [owner/repo]" + Browse button
- Recommended toolkit card (rohitg00/awesome-claude-code-toolkit with counts)
- Import dialog: category checkboxes, progress bar, result summary
- Imported toolkit history with Refresh/Remove actions

### Screen 6: Settings (enhanced)

Add to existing settings:
- **Toolkits tab** — (same as Skills > Toolkits section, accessible from both places)
- **License tab** — Current tier, activate/deactivate, feature matrix
- **Agents tab** — Global agent defaults (default model, default tools, auto-start behavior)

---

## 5. User Flows

### Flow 1: First Launch (Onboarding)

```
App opens → Onboarding screen
  1. "Welcome to orager" — set API key (PROTOCOL_API_KEY)
  2. "Choose your first model" — model selector with recommendations
  3. "Seed your SkillBank" — toolkit import card (optional, can skip)
  4. "Create your first agent" — wizard OR "Start with a quick chat"
  → Home dashboard
```

### Flow 2: Create Agent and Start Working

```
Agents tab → [+ Create Agent]
  → Wizard Step 1: pick "backend-developer" from toolkit
  → Step 2: customize name ("Atlas"), tweak personality
  → Step 3: assign claude-sonnet-4-6, enable Bash/Read/Write/Grep
  → Step 4: add to #backend channel
  → Step 5: review → Activate
  → Redirects to Atlas's Direct Line channel
  → User types first message
  → Agent boots (reads soul → manual → memory → lessons)
  → Agent responds in character
```

### Flow 3: Multi-Agent Collaboration

```
User creates 3 agents: Planner, Coder, Reviewer
User creates #feature-auth channel, adds all 3
User posts in #feature-auth: "Build OAuth2 login flow"
  → Planner picks up (it's first in chain of command)
  → Planner posts plan, @mentions Coder for implementation
  → Coder acknowledges, starts working, posts updates
  → Coder finishes, @mentions Reviewer
  → Reviewer posts feedback, @mentions Coder with fixes
  → Coder applies fixes, @mentions Reviewer again
  → Reviewer approves, @mentions User: "Ready for review"
  → User sees notification on Home dashboard
  → User opens #feature-auth, reads thread, responds
```

### Flow 4: Escalation

```
QA agent (Sunny) detects an error in system health checks
  → Posts in #system-health: "Build failed on staging. Error: ..."
  → @mentions CEO agent (Machaveli)
  → Machaveli investigates, spawns a sub-agent for research
  → Sub-agent reports back in thread
  → Machaveli posts resolution plan, @mentions User for approval
  → User sees escalation badge on Home dashboard
  → User opens #system-health, reviews thread
  → User approves: "Go ahead"
  → Machaveli executes fix, posts confirmation
```

### Flow 5: Agent Learns from Mistake

```
Agent makes an error (e.g., ran migration without backup)
  → Error logged in daily log automatically
  → User corrects agent in channel: "Always backup before migrating"
  → Agent appends to lessons.md:
      What: Ran DB migration without backup
      Why: No pre-migration checklist in operating manual
      Fix: Always run pg_dump before any migration. Added to manual.
  → Next session: agent reads lessons.md at boot
  → Next migration: agent runs backup first automatically
  → Lesson count increments on agent profile
```

### Flow 6: Import Toolkit

```
Settings → Toolkits → Enter "rohitg00/awesome-claude-code-toolkit" → Browse
  → Preview loads: 136 agents, 35 skills, 15 rules, 42 commands
  → Import dialog: check Agents ✓, Skills ✓, Rules ✓, Commands ☐
  → Click Import → progress bar streams
  → Complete: "142 imported, 38 duplicates, 2 errors"
  → Toolkit appears in "Imported" list
  → Imported agents available as templates in Agent Creation Wizard
```

---

## 6. Component Inventory

### New Components Needed

**Channel System:**
- `ChannelSidebar` — channel list with sections, badges, presence dots
- `ChannelView` — message stream container
- `MessageBubble` — single message (agent or user), with avatar, name, timestamp, content
- `MessageInput` — textarea with @mention autocomplete, attachments
- `MentionAutocomplete` — dropdown showing matching agents when typing @
- `ThreadPanel` — slide-out panel for threaded replies
- `ContextPanel` — right panel for channel info or agent quick profile
- `SystemMessage` — styled message for events (joined, escalated, spawned)
- `ToolCallResult` — collapsible display of tool execution results within messages
- `SubAgentSpawnIndicator` — visual indicator when a sub-agent is working
- `EscalationBadge` — badge/banner for messages needing human response
- `ChannelCreateDialog` — create channel with name, description, agent members
- `ChannelSettings` — edit channel, manage members, escalation rules

**Agent System:**
- `AgentCard` — card showing agent avatar, name, role, status, quick stats
- `AgentGrid` — grid/list of agent cards
- `AgentProfile` — full profile page with tabbed sections
- `AgentProfileHeader` — avatar, name, role, status, action buttons
- `SoulEditor` — markdown editor for soul.md with preview
- `LessonCard` — individual lesson (what/why/fix) with date
- `LessonList` — searchable, sortable list of lessons
- `PatternEditor` — structured editor for decision frameworks
- `DailyLogTimeline` — calendar/timeline for browsing daily logs
- `DailyLogViewer` — read-only view of a single day's log
- `AgentCreationWizard` — multi-step wizard container
- `TemplateGrid` — card grid for picking agent templates
- `SoulForm` — structured form for soul.md fields
- `CapabilitiesForm` — model + tools + permissions form
- `ChannelAssignmentPicker` — checkbox list of channels

**Dashboard:**
- `ActivityFeed` — chronological list of recent events across channels
- `AgentStatusGrid` — compact grid of all agents with status
- `QuickStatsBar` — stat cards (agents, messages, costs, lessons)
- `QuickActions` — action button row
- `EscalationAlerts` — list of pending human-required actions

**Toolkit:**
- `ToolkitImportInput` — repo input field with Browse button
- `ToolkitRecommendedCard` — featured toolkit with counts
- `ToolkitImportDialog` — category picker, progress bar, results
- `ToolkitImportedList` — history of imported toolkits with Refresh/Remove
- `ToolkitProgressBar` — streaming progress during import

**Shared/Foundation:**
- `Avatar` — agent avatar component (auto-generated from initials/hash, or custom image)
- `StatusDot` — green/yellow/gray presence indicator
- `Badge` — count badge, tier badge, status badge
- `MarkdownEditor` — split-pane markdown editor with preview
- `MarkdownViewer` — rendered markdown display
- `SearchInput` — search field with keyboard shortcut hint
- `EmptyState` — illustrated empty state for lists/pages
- `Stepper` — wizard step indicator
- `TabBar` — generic tab navigation
- `SplitPane` — resizable two/three panel layout
- `SlideOver` — slide-in panel (for threads, context)
- `Kbd` — keyboard shortcut display component

### Existing Components to Redesign

| Component | Current | Redesign Notes |
|---|---|---|
| `SessionChat` | Full-page 1:1 chat | Becomes the Direct Line channel view — same chat UX but inside the channel frame |
| `SessionsSidebar` | List of past sessions | Evolves into `ChannelSidebar` — channels replace sessions as the primary nav |
| `SkillBank` | Bare table | Add toolkit import section, per-agent filtering, richer skill cards |
| `MemoryBrowser` | Namespace browser | Integrate into Agent Profile > Memory tab. Global view stays but secondary |
| `Dashboard` | Minimal | Full home screen with activity feed, agent grid, stats, alerts |
| `Settings` | Config editor | Add Toolkits, License, Agents tabs |
| `OnboardingBanner` | Simple banner | Full onboarding flow (API key → model → toolkit → first agent) |
| `CommandPalette` | Cmd+K | Extend with: switch channel, @mention agent, create agent, search messages |

---

## 7. Design Principles

### 1. Transparency over Magic
Every agent action should be visible. The user should always be able to see what an agent is doing, why it made a decision, and what it learned. No black boxes.

### 2. Human Always in the Loop
Agents can coordinate autonomously, but the human can intervene at any point. Escalations should be prominent. The user is the CEO of the CEO agent.

### 3. Compound Knowledge is Visible
Lessons learned, daily logs, and memory growth should be surfaced prominently. The user should feel their agents getting smarter over time — show lesson counts, memory growth charts, pattern libraries.

### 4. Discord Familiarity, Not Discord Clone
Users who've used Discord/Slack should feel immediately at home. But we're not building a chat app — we're building an agent workspace. Prioritize: agent status, tool outputs, task progress, and escalations over emoji reactions and typing indicators.

### 5. Progressive Disclosure
New users start with a single agent in a direct line. The channel system, multi-agent coordination, and advanced features reveal themselves as the user grows. Don't overwhelm on first launch.

### 6. Dark-First
Current app is dark theme. Keep it. Agent runtimes are developer/power-user tools. Light theme is nice-to-have later.

---

## 8. Visual References

For mood and interaction patterns, reference:

| Reference | What to take from it |
|---|---|
| **Discord** | Channel sidebar, message stream, thread panel, @mentions, presence dots |
| **Linear** | Clean dark UI, command palette, keyboard-first navigation, issue detail views |
| **Raycast** | Onboarding flow, command palette, extension/plugin installation |
| **Cursor** | AI chat integrated into a professional tool, not a toy |
| **Notion** | Rich markdown editing, database views, page hierarchy |
| **GitHub Copilot Chat** | Tool call display, streaming responses, code blocks in chat |

---

## 9. Deliverables Expected

### Phase 1 (Design System + Core Screens)
1. **Design system** — color palette, typography, spacing, component tokens (dark theme)
2. **Channel View** — the primary screen, fully specced with all states
3. **Agent Profile** — all tabs mocked
4. **Home Dashboard** — activity feed, agent grid, stats
5. **Agent Creation Wizard** — all 5 steps

### Phase 2 (Supporting Screens)
6. **Skills + Toolkits** — import flow, skill list
7. **Settings** — enhanced with new tabs
8. **Onboarding Flow** — first launch experience
9. **Empty States** — for channels, agents, skills, lessons (each needs a unique empty state)

### Phase 3 (Interaction Details)
10. **Thread interactions** — opening, replying, collapsing
11. **Escalation flow** — notification, badge, response
12. **Sub-agent lifecycle** — spawn indicator, thread report, dismissal
13. **Command palette** — extended with agent/channel commands
14. **Mobile responsive** (if applicable — Tauri is desktop-only, but window resizing should be graceful)

### File Format
- Figma preferred
- Component-based (reusable, not flattened)
- Include both spec view (with measurements) and prototype view (clickable flows)
- Export assets at 1x, 2x for Retina

---

## 10. Technical Constraints

- **Framework:** React 19 + TypeScript. Components will be implemented as `.tsx` files.
- **No component library** currently. If the designer recommends one (shadcn/ui, Radix, etc.), that's fine — but it must work with Tailwind or vanilla CSS in a Vite + React setup.
- **Tauri limitations:** No browser APIs like `window.open()`. All native features (file dialogs, notifications) go through Tauri's Rust backend.
- **Sidecar communication:** All agent data comes via JSON-RPC 2.0. The UI renders data from RPC responses and reacts to streaming RPC notifications. Design should account for loading states and streaming content.
- **Offline-capable:** Agent identity files and channel history are local SQLite. The app should work without internet (except for LLM API calls).
- **Data shapes:** See `docs/specs/desktop-toolkits-settings.md` for RPC method examples. Agent profile data comes from markdown files on disk. Channel messages come from SQLite.
