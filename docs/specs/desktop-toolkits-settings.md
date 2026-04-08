# Desktop UI Spec: Settings > Toolkits

## Overview

A new **Toolkits** section in Settings allows users to browse, preview, and import GitHub toolkit repositories into SkillBank. Supports any repo that follows the toolkit layout convention (`skills/`, `agents/`, `rules/`, `commands/` directories with markdown files).

## RPC Methods

### `toolkit/preview`

Preview a toolkit repo's contents without importing.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "toolkit/preview",
  "params": {
    "repo": "rohitg00/awesome-claude-code-toolkit"
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "repo": "rohitg00/awesome-claude-code-toolkit",
    "branch": "main",
    "items": [
      { "path": "agents/core-development/backend-developer.md", "type": "agent", "slug": "backend-developer" },
      { "path": "skills/tdd-mastery/SKILL.md", "type": "skill", "slug": "tdd-mastery" }
    ],
    "counts": { "skill": 35, "agent": 136, "rule": 15, "command": 42 }
  }
}
```

### `toolkit/seed`

Import items from a toolkit repo into SkillBank. Streams `toolkit/progress` notifications during import.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "toolkit/seed",
  "params": {
    "repo": "rohitg00/awesome-claude-code-toolkit",
    "categories": ["skill", "agent", "rule"],
    "limit": 50,
    "dryRun": false
  }
}
```

**Progress notification (streamed):**
```json
{
  "jsonrpc": "2.0",
  "method": "toolkit/progress",
  "params": {
    "phase": "seeding",
    "current": 47,
    "total": 186,
    "item": "backend-developer",
    "status": "inserted"
  }
}
```

**Final response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "repo": "rohitg00/awesome-claude-code-toolkit",
    "inserted": 142,
    "duplicates": 38,
    "errors": 2,
    "skipped": 4,
    "commandsWritten": 0,
    "commandsSkipped": 0,
    "total": 186
  }
}
```

## UI Layout

### Settings > Toolkits

```
┌─────────────────────────────────────────────────────────────────────┐
│  Settings                                                           │
│                                                                     │
│  [General]  [Models]  [Permissions]  [Toolkits]  [License]          │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  TOOLKITS                                                           │
│                                                                     │
│  Import curated skills, agents, and rules from GitHub               │
│  repositories into your SkillBank.                                  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  ┌────────────────────────────────────────────────────┐       │  │
│  │  │  github.com/ [owner/repo________________] [Browse] │       │  │
│  │  └────────────────────────────────────────────────────┘       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ─── RECOMMENDED ───────────────────────────────────────────────── │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  rohitg00/awesome-claude-code-toolkit          [Import]       │  │
│  │  136 agents · 35 skills · 15 rules · 42 commands              │  │
│  │  The community-curated toolkit for Claude Code agents         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ─── IMPORTED ──────────────────────────────────────────────────── │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  rohitg00/awesome-claude-code-toolkit     Imported 2h ago     │  │
│  │  142 imported · 38 duplicates · 2 errors                      │  │
│  │                                     [Refresh]  [Remove]       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  acme-corp/internal-agents            Imported 3d ago         │  │
│  │  24 imported · 0 duplicates · 0 errors                        │  │
│  │                                     [Refresh]  [Remove]       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Import Dialog (after clicking [Import] or [Browse])

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Import from rohitg00/awesome-claude-code-toolkit            │
│                                                              │
│  Select what to import:                                      │
│                                                              │
│  ☑  Agents     136 agent personas                            │
│  ☑  Skills      35 curated skills                            │
│  ☑  Rules       15 best-practice rules                       │
│  ☐  Commands    42 command templates                         │
│                                                              │
│  Total: 186 items will be imported into SkillBank.           │
│  Duplicates are automatically skipped.                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ████████████████████░░░░░░░░░  87 / 186              │  │
│  │  Seeding backend-developer...                          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                                   [Cancel]  [Import]         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Import Complete State

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Import complete                                             │
│                                                              │
│  ✓ 142 items imported                                        │
│  ○  38 duplicates skipped                                    │
│  ✕   2 errors                                                │
│                                                              │
│  Skills are now available in your SkillBank and will be      │
│  automatically retrieved during future agent runs.           │
│                                                              │
│                                              [Done]          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Interaction Flow

1. **Settings > Toolkits** shows the input field, recommended repo, and any previously imported repos.

2. **User enters a repo** (e.g. `acme-corp/my-toolkit`) in the input field and clicks **Browse**, OR clicks **Import** on the recommended repo.

3. **Desktop calls `toolkit/preview`** to fetch item counts. If the repo doesn't follow the toolkit layout (0 items), show an inline error: "No toolkit items found. The repo should contain `skills/`, `agents/`, `rules/`, or `commands/` directories."

4. **Import dialog** opens with category checkboxes (all checked by default except commands). User can toggle categories.

5. **User clicks Import**. Desktop calls `toolkit/seed` with the selected categories. A progress bar updates as `toolkit/progress` notifications arrive.

6. **On completion**, the dialog shows the result summary. The repo is added to the "Imported" list with a timestamp.

7. **Imported repos** persist in `~/.orager/settings.json` under a `toolkits.imported` array:

```json
{
  "toolkits": {
    "imported": [
      {
        "repo": "rohitg00/awesome-claude-code-toolkit",
        "importedAt": "2026-04-07T19:00:00Z",
        "inserted": 142,
        "duplicates": 38,
        "errors": 2
      }
    ]
  }
}
```

8. **Refresh** re-runs `toolkit/seed` for the same repo (new items are added, existing duplicates are skipped).

9. **Remove** deletes the entry from the imported list. It does NOT remove already-imported skills from SkillBank (those are permanent unless manually deleted from the Skills tab).

## Design Notes

- The input field accepts: `owner/repo`, `owner/repo#branch`, or a full `https://github.com/owner/repo` URL. The `parseRepoString()` function in `src/toolkit.ts` handles all formats.
- The recommended repo is hardcoded in the desktop app. It can be updated via app releases.
- Progress bar uses the `toolkit/progress` notification's `current/total` fields.
- The import runs in the background — the user can navigate away from Settings and the import continues. A toast notification appears on completion.
- Error states: network failure (show retry), invalid repo format (inline validation), GitHub rate limit (show message with retry-after).
