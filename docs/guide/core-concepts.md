# Core Concepts

## Agent Loop

The agent loop is orager's core execution engine. Each invocation of `runAgentLoop()` (or `orager run`/`orager chat`) starts a loop that:

1. **Assembles the system prompt** — base instructions, skills, project context (frozen prefix) + memory, checkpoint (dynamic suffix)
2. **Calls the model** — sends messages to the selected provider, streams the response
3. **Parses the response** — extracts text, tool calls, and `<memory_update>` blocks
4. **Executes tools** — runs tool calls (up to 10 concurrently), collects results
5. **Repeats** — feeds tool results back as the next turn, until the model produces a final text response or a limit is reached

The loop ends when: the model responds without tool calls, `maxTurns` is reached, `maxCostUsd` is exceeded, or the agent calls the `finish` tool.

## Tools

orager ships with 23+ built-in tools:

| Category | Tools |
|----------|-------|
| **File System** | `Bash`, `Read`, `Write`, `Edit`, `EditFiles`, `Glob`, `Grep`, `ListDir`, `DeleteFile`, `MoveFile`, `CreateDir` |
| **Web** | `WebSearch`, `WebFetch` |
| **Browser** | `BrowserNavigate`, `BrowserClick`, `BrowserType`, `BrowserScreenshot`, `BrowserEval`, `BrowserClose`, `BrowserScroll`, `BrowserWait` (opt-in) |
| **Agent** | `Agent` (sub-agent spawning), `Finish` (completion signal) |
| **Memory** | `WriteMemory`, `ReadMemory` (opt-in via `--auto-memory`) |
| **UI** | `RenderUI` (Generative UI — forms, tables, confirms) |
| **Notebook** | `NotebookRead`, `NotebookEdit` |

Custom tools can be added via `extraTools` in the API or `--tools-file` on the CLI. MCP servers provide additional tools automatically.

## Memory

orager uses a three-layer memory system, persisted in per-namespace SQLite databases:

| Layer | Scope | Description |
|-------|-------|-------------|
| **Master Context** | Permanent | Core facts the agent always knows. Set via `orager memory` |
| **Long-term Distilled** | Cross-session | Auto-extracted from `<memory_update>` blocks. Typed as insight, fact, decision, risk, competitor, or open_question |
| **Short-term Episodic** | Within-session | Recent turns + condensed summary. Auto-compresses at token pressure threshold |

Retrieval uses **BM25 keyword scoring** combined with **embedding cosine similarity** (local Transformers.js, 384-dim vectors) for hybrid search. FTS5 full-text search and sqlite-vec ANN queries are both available.

## Skills

**SkillBank** captures successful task patterns and reinjects them in future prompts:

- **Success extraction** — after a successful run, extracts reusable patterns
- **Contrastive extraction** — compares fail-then-succeed pairs to extract "do Y instead of Z" skills
- **Self-reflection** — post-run reflection identifies one mistake and one improvement
- **Deduplication** — semantic similarity threshold prevents near-identical skills

Skills are stored in SQLite with FTS5 + sqlite-vec indexes for fast retrieval. SkillBank prompt-mode features are available on all tiers. [OMLS LoRA training](/guide/omls-training) and advanced features (confidence router, prompt tournaments) require a [Pro or Cloud license](/guide/licensing).

## Sessions

Every agent run creates a session stored as an append-only JSONL transcript. Sessions support:

- **Resume** — continue from where you left off (`--session-id`)
- **Fork** — branch from any turn (`--fork-session`)
- **Rollback** — undo the last turn (`--rollback-session`)
- **Compact** — summarize history in-place (`--compact-session`)
- **Search** — full-text search across all sessions (`--search-sessions`)

## Providers

orager routes model calls through a provider adapter system. The resolution chain (first match wins):

1. **Ollama** — when `--ollama` or `ollama.enabled` is set
2. **Anthropic** — model starts with `anthropic/` and `ANTHROPIC_API_KEY` is set
3. **OpenAI** — model starts with `gpt-`/`o1`/`o3`/`o4` and `OPENAI_API_KEY` is set
4. **DeepSeek** — model starts with `deepseek/` and `DEEPSEEK_API_KEY` is set
5. **Gemini** — model starts with `gemini/` and `GEMINI_API_KEY` is set
6. **OpenRouter** — universal fallback (routes to 100+ models)

See [Provider Routing](/guide/provider-routing) for full configuration.

## Sub-Agents

The `Agent` tool lets the model spawn specialized sub-agents at runtime:

- Sub-agents get a **fresh context** with the delegated task
- They **inherit** the parent's memory (read-only), skills, and tools
- Multiple spawns in the same turn run **concurrently**
- Recursion is **depth-limited** (default: 3 levels)

For deterministic pipelines, use `runAgentWorkflow()` instead. See [Multi-Agent Patterns](/guide/multi-agent).
