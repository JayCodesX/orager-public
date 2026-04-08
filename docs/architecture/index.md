# System Architecture

This page describes the high-level architecture of orager: how the CLI, agent loop, storage, providers, and external services fit together.

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│              Your Code / CLI                                      │
│  orager run · orager chat · orager serve                          │
│  runAgentLoop()  ·  runAgentWorkflow()                            │
└──────────────┬───────────────────────────────────────────────────┘
               │ in-process (default)
               │ or subprocess JSON-RPC 2.0
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Agent Loop (src/loop.ts)                          │
│                                                                    │
│  Input Processing                                                  │
│  ├─ Text prompt + --file attachments                               │
│  │  (images, PDFs, audio/Whisper, text)                            │
│  └─ Modality routing (vision / audio / document)                   │
│                                                                    │
│  System Prompt Assembly                                            │
│  ├─ [FROZEN]  base rules · skills · CLAUDE.md · agents             │
│  │            ← cache_control breakpoint (Anthropic)               │
│  └─ [DYNAMIC] master context · memories · checkpoint               │
│                                                                    │
│  ┌────────────── Turn Loop ───────────────────────────────┐        │
│  │  Provider Adapter → model call (streaming)             │        │
│  │  Parse text + tool calls + <memory_update> blocks      │        │
│  │  Execute tools (10 concurrent max)                     │        │
│  │    ├─ Agent tool → spawn sub-agent loops               │        │
│  │    │    (concurrent, depth-limited, OTEL-traced)       │        │
│  │    └─ RenderUI → Generative UI (blocking)              │        │
│  │  Ingest memory updates                                 │        │
│  │  Summarize at token pressure threshold                 │        │
│  │  SkillBank extraction (success/contrastive/reflect)    │        │
│  └────────────────────────────────────────────────────────┘        │
│                                                                    │
│  Session checkpoint · cost tracking · webhooks · OTEL spans        │
└──────┬──────────┬──────────┬──────────────┬───────────────────────┘
       │          │          │              │
       ▼          ▼          ▼              ▼
┌──────────┐ ┌─────────┐ ┌──────────┐ ┌─────────────────────┐
│ SQLite   │ │ Provider │ │ OMLS     │ │ External Services   │
│ Stores   │ │ Adapters │ │ Pipeline │ │                     │
│          │ │          │ │          │ │ MCP Servers          │
│ memory/  │ │ Ollama   │ │ Conf.   │ │ Webhooks             │
│ sessions/│ │ Anthropic│ │ Router   │ │ OTEL Collector       │
│ skills   │ │ OpenAI   │ │ Traj.   │ │ Browser (Playwright) │
│ wiki     │ │ DeepSeek │ │ Buffer   │ │                     │
│ project  │ │ Gemini   │ │ Trainer  │ │                     │
│ index    │ │ OpenRtr  │ │ Adapter  │ │                     │
└──────────┘ └─────────┘ └──────────┘ └─────────────────────┘
```

## Data Flow

A single agent turn follows this path:

1. **User prompt** -- The user provides a text prompt (via CLI, REPL, or programmatic call), optionally attaching files (`--file`). Multimodal inputs are routed to the appropriate modality handler (vision, audio/Whisper, or document extraction).

2. **System prompt assembly** -- The frozen prefix (base rules, skills, CLAUDE.md content, agent definitions) is concatenated with the dynamic suffix (master context, retrieved memories, session checkpoint). On Anthropic models a `cache_control: ephemeral` breakpoint separates frozen from dynamic content so the frozen prefix stays in the prompt cache across turns.

3. **Provider call** -- The assembled messages are dispatched through the configured provider adapter (Anthropic, OpenAI, Ollama, DeepSeek, Gemini, or OpenRouter) as a streaming request. The adapter normalizes the response into a common event format.

4. **Response parsing** -- The streamed response is parsed into three categories: plain text blocks, tool-use requests, and `<memory_update>` XML blocks. Each category is handled independently.

5. **Tool execution** -- Pending tool calls are executed concurrently (up to 10 at a time). The Agent tool spawns recursive sub-agent loops (depth-limited, traced via OpenTelemetry). The RenderUI tool triggers a blocking Generative UI render cycle.

6. **Memory and skill updates** -- `<memory_update>` blocks are ingested into the three-layer memory system. The SkillBank evaluates the turn for extractable skills (success patterns, contrastive corrections, reflections).

7. **Session checkpoint** -- The turn transcript is appended to the JSONL session file. Cost counters are updated. Webhook notifications and OTEL spans are emitted.

8. **Loop decision** -- If the model produced a tool call, the loop continues with the tool results as the next user message. If the model produced only text (no tool calls), the loop terminates and returns the final assistant response to the caller.

## Module Map

| Directory / File | Feature |
|---|---|
| `src/commands/` | CLI subcommands (`run`, `chat`, `serve`, etc.) |
| `src/tools/` | 23+ built-in tools (file I/O, shell, browser, search, agent, render-ui, etc.) |
| `src/omls/` | OMLS learning pipeline -- 17 modules covering confidence routing, trajectory buffering, LoRA training, teacher distillation, and adapter hot-swap |
| `src/agents/` | Agent registry, scoring, benchmarking -- 12 modules for multi-agent orchestration |
| `src/providers/` | Provider adapters for 7 backends (Anthropic, OpenAI, Ollama, DeepSeek, Gemini, OpenRouter, direct) |
| `src/memory*.ts` | Three-layer memory system: master context (permanent), long-term (FTS5 + embedding retrieval), episodic (session checkpoints) |
| `src/session*.ts` | Session persistence, resume, and recovery manifest |
| `src/loop*.ts` | Agent execution engine -- turn loop, token-pressure summarization, cost tracking |
| `src/skillbank.ts` | SkillBank persistence -- extraction, deduplication, merge pipeline, injection |
| `src/knowledge-wiki.ts` | Knowledge Wiki -- persistent factual entries with FTS and embedding search |
| `src/project-index.ts` | Code intelligence -- call graphs, symbol clusters, project-scoped retrieval |
| `src/ui-server.ts` | Browser UI server (config editor, logs, cost dashboard -- no agent execution) |
| `src/subprocess.ts` | JSON-RPC 2.0 transport for isolated child-process agent execution |
| `src/mcp*.ts` | MCP (Model Context Protocol) client integration |
| `src/telemetry.ts` | OpenTelemetry instrumentation (spans, metrics, trace propagation) |
| `src/profiles.ts` | 8 built-in agent profiles (coding, research, planning, etc.) |
| `src/workflow.ts` | Multi-agent sequential workflow orchestration |

## Storage Layout

All persistent data lives under `~/.orager/`:

```
~/.orager/
  settings.json                  # user settings
  memory/<memoryKey>.sqlite      # per-namespace memory (FTS5 + sqlite-vec)
  skills/skills.sqlite           # SkillBank (FTS5 + sqlite-vec)
  sessions/
    index.sqlite                 # session metadata + FTS
    <sessionId>.jsonl            # append-only turn transcripts
  models/<key>/<model>/
    adapter.safetensors          # current LoRA adapter
    adapter.v<N>.safetensors     # versioned rollback copies
    adapter.meta.json            # training metadata
  wiki/wiki.sqlite               # Knowledge Wiki pages
  project-index/<id>.sqlite      # Project Index (call graphs, clusters)
  trajectories/trajectory-index.sqlite  # OMLS trajectory index
```

Key storage design choices:

- **Per-namespace SQLite files** for memory allow independent backup, migration, and concurrent access across agents sharing namespaces.
- **JSONL session files** are append-only for crash safety; the index SQLite stores metadata and full-text search over session content.
- **LoRA adapters** are versioned with `.v<N>.safetensors` copies so failed training runs can be rolled back.
- **sqlite-vec** is used alongside FTS5 for hybrid BM25 + embedding retrieval in memory and skills.

## Architecture Decision Records

All major architectural decisions are documented as ADRs. See the [ADR index](../adr/index.md) for the full list of 13 records covering memory, storage, provider adapters, OMLS training, SkillBank, and more.
