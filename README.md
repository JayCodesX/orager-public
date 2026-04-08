# orager

[![CI](https://github.com/JayCodesX/orager/actions/workflows/ci.yml/badge.svg)](https://github.com/JayCodesX/orager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40orager%2Fcore)](https://www.npmjs.com/package/@orager/core)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)

**The AI agent runtime that learns from every run.**

orager is an open-core TypeScript library and CLI for building AI agents with persistent memory, self-improving skills, and multi-model routing. The core runtime is open source (Apache 2.0) and production-ready. Advanced features — OMLS training, prompt tournaments, and team collaboration — are available with a [Pro or Cloud license](https://oragerai.com).

```bash
npm install -g @orager/core
```

## Hello World

```typescript
import { runAgentLoop } from "@orager/core";

await runAgentLoop({
  prompt: "Summarize the last 10 git commits",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.PROTOCOL_API_KEY!,
  onEmit: (e) => console.log(e),
});
```

---

## Features

### Core Runtime

| Feature | Description |
|---------|-------------|
| **Multi-turn tool-calling loop** | Autonomous agent loop with streaming, up to 10 concurrent tool calls per turn |
| **23+ built-in tools** | Bash, file I/O, web search, browser automation, notebooks, and more |
| **Plan mode** | Structured reasoning with exit gates — agent plans before executing |
| **Approval workflows** | Per-tool permission matrix (allow/deny/ask), bashPolicy, sandbox root |
| **Subprocess isolation** | JSON-RPC 2.0 over stdio for out-of-process agent execution |
| **Prompt caching** | Frozen prefix + dynamic suffix with `cache_control` breakpoint (Anthropic models) |
| **Generative UI** | `render_ui` tool — forms, tables, confirms with blocking responses |

### Memory & Knowledge

| Feature | Description |
|---------|-------------|
| **3-layer persistent memory** | Master context (permanent), distilled facts (cross-session), episodic (within-session) |
| **BM25 + embedding hybrid retrieval** | Keyword scoring + cosine similarity for accurate memory search |
| **Local embeddings** | Transformers.js (all-MiniLM-L6-v2, 384-dim) — zero API cost |
| **Knowledge Wiki** | Self-maintaining structured knowledge base with quality scoring |
| **Project Index** | Code intelligence — file clustering, call graphs, hot-file detection |

### Model Routing

| Feature | Description |
|---------|-------------|
| **7 provider adapters** | OpenRouter, Anthropic, OpenAI, DeepSeek, Gemini, Ollama, OMLS local |
| **Turn-based escalation** | `turnModelRules` — switch models mid-run based on turn count |
| **Vision routing** | Automatic fallback to vision-capable model for image tasks |
| **Cost-aware selection** | Sort by price, throughput, or latency; provider fallback chains |
| **Zero Data Retention** | `--zdr` flag for privacy-sensitive workloads |

### Multi-Agent

| Feature | Description |
|---------|-------------|
| **Dynamic sub-agent spawning** | Parent model delegates to specialized agents at runtime |
| **Sequential workflows** | `runAgentWorkflow` — ordered pipelines with handoff functions |
| **Parallel execution** | Multiple Agent tool calls in one turn run concurrently |
| **Depth limiting** | Configurable max recursion depth (default: 3) |
| **Memory sharing** | Sub-agents inherit parent memory (read-only by default) |

### Self-Learning

| Feature | Description |
|---------|-------------|
| **SkillBank** | Captures successful task patterns, reinjects via semantic retrieval |
| **Contrastive extraction** | Learns from fail→succeed pairs ("do Y instead of Z") |
| **Self-reflection** | Post-run analysis identifies mistakes and improvements |
| **Trajectory indexing** | Past successful runs as few-shot exemplars (in-context learning) |
| **OMLS LoRA training** | Fine-tune adapters locally (MLX / CUDA) or via cloud VPS `Pro` |
| **Confidence routing** | 3-signal router: task classifier, Self-REF, semantic entropy `Pro` |
| **Prompt tournaments** | A/B test and optimize base prompt variants `Pro` |

### Developer Experience

| Feature | Description |
|---------|-------------|
| **8 built-in profiles** | `code-review`, `bug-fix`, `research`, `refactor`, `test-writer`, `devops`, `dev`, `deploy` |
| **Browser UI** | `orager serve` — dashboard for config, logs, costs, telemetry |
| **MCP server support** | Connect Model Context Protocol servers for extended tool access |
| **OpenTelemetry** | Traces, spans, and metrics with built-in span buffer (2,000 spans) |
| **Session management** | Fork, compact, rollback, resume, FTS search across sessions |
| **Cost tracking** | Hard/soft limits, rolling quotas, anomaly detection |

---

## CLI

| Command | Description |
|---------|-------------|
| `orager run "prompt"` | One-shot agent execution |
| `orager chat` | Interactive multi-turn REPL |
| `orager serve` | Browser UI (config, logs, costs, telemetry) |
| `orager setup` | Interactive setup wizard |
| `orager memory` | Manage memory namespaces |
| `orager skills` | Manage SkillBank learned skills |
| `orager skill-train` | OMLS training (LoRA adapters) `Pro` |
| `orager agents` | Agent catalog management |
| `orager keys` | API key management (OS keychain) |
| `orager init` | Scaffold `.orager/` project directory |
| `orager compare` | Run prompt against multiple models |
| `orager optimize` | Self-optimize agent prompts (GEPA) `Pro` |
| `orager benchmark` | Benchmark agents on tasks `Pro` |
| `orager wiki` | Knowledge Wiki management |
| `orager mcp` | Run as MCP server |

<details>
<summary>Common flags</summary>

```
--model <id>              Model ID (e.g. deepseek/deepseek-chat)
--max-turns <n>           Maximum agent turns (default: 20)
--max-cost-usd <n>        Hard cost cap in USD
--session-id <id>         Resume an existing session
--memory-key <key>        Memory namespace
--file <path>             Attach a file (repeatable)
--profile <name>          Apply a profile preset
--subprocess              Run in isolated child process
--verbose                 Verbose diagnostic logging
--ollama                  Route to local Ollama server
```

</details>

[Full CLI Reference →](https://jaycodesx.github.io/orager/guide/cli-reference)

---

## Library Usage

### Basic Agent

```typescript
import { runAgentLoop } from "@orager/core";

await runAgentLoop({
  prompt: "Write tests for the auth module",
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.PROTOCOL_API_KEY!,
  cwd: process.cwd(),
  maxTurns: 20,
  onEmit: (e) => console.log(e),
});
```

### Dynamic Agent Spawning

```typescript
import { runAgentLoop } from "@orager/core";
import type { AgentDefinition } from "@orager/core";

const agents: Record<string, AgentDefinition> = {
  researcher: {
    description: "Searches the web and summarises findings.",
    prompt: "You are a thorough research assistant. Always cite sources.",
    model: "deepseek/deepseek-r1",
  },
  coder: {
    description: "Writes, reviews, and refactors code.",
    prompt: "You are an expert software engineer.",
    tools: ["Bash", "Read", "Write", "Grep", "Glob"],
  },
};

await runAgentLoop({
  prompt: "Research vector databases and write benchmark code for each.",
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.PROTOCOL_API_KEY!,
  agents,
  cwd: process.cwd(),
  onEmit: (e) => console.log(e),
});
```

### Sequential Workflows

```typescript
import { runAgentWorkflow } from "@orager/core";
import type { AgentWorkflow } from "@orager/core";

const workflow: AgentWorkflow = {
  base: {
    apiKey: process.env.PROTOCOL_API_KEY!,
    cwd: process.cwd(),
    onEmit: (e) => console.log(e),
  },
  steps: [
    { role: "researcher", model: "deepseek/deepseek-r1" },
    { role: "writer",     model: "anthropic/claude-sonnet-4-6" },
    { role: "reviewer",   model: "deepseek/deepseek-chat" },
  ],
};

await runAgentWorkflow(workflow, "Investigate and write a report on...");
```

### Custom Tools

```typescript
import { runAgentLoop } from "@orager/core";
import type { ToolExecutor } from "@orager/core";

const myTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  },
  execute: async (args) => {
    return { content: `Weather in ${args.city}: 72°F, sunny`, isError: false };
  },
};

await runAgentLoop({
  prompt: "What's the weather in Tokyo?",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.PROTOCOL_API_KEY!,
  extraTools: [myTool],
  onEmit: (e) => console.log(e),
});
```

---

## Configuration

### `~/.orager/settings.json`

```json
{
  "model": "deepseek/deepseek-chat",
  "memory": {
    "tokenPressureThreshold": 0.70,
    "turnInterval": 6,
    "keepRecentTurns": 4
  },
  "omls": {
    "enabled": true,
    "mode": "prompt",
    "minBatchSize": 8
  },
  "bashPolicy": {
    "blockedCommands": ["rm -rf /", "sudo"]
  },
  "permissions": {
    "bash": "ask",
    "write_file": "allow"
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PROTOCOL_API_KEY` | OpenRouter API key (required) |
| `ANTHROPIC_API_KEY` | Direct Anthropic access |
| `OPENAI_API_KEY` | Direct OpenAI access |
| `DEEPSEEK_API_KEY` | Direct DeepSeek access |
| `GEMINI_API_KEY` | Direct Gemini access |
| `ORAGER_MODEL` | Default model override |
| `ORAGER_MAX_TURNS` | Default max turns |
| `ORAGER_MAX_COST_USD` | Default cost cap |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enable OpenTelemetry tracing |

[Full Configuration Guide →](https://jaycodesx.github.io/orager/guide/configuration)

---

## Architecture

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
│                  Agent Loop (loop.ts)                              │
│                                                                    │
│  System Prompt Assembly                                            │
│  ├─ [FROZEN]  base rules · skills · project context · agents       │
│  │            ← cache_control breakpoint (Anthropic)               │
│  └─ [DYNAMIC] master context · memories · checkpoint               │
│                                                                    │
│  ┌────────────── Turn Loop ───────────────────────────────┐        │
│  │  Provider Adapter → model call (streaming)             │        │
│  │  Parse text + tool calls + <memory_update> blocks      │        │
│  │  Execute tools (10 concurrent max)                     │        │
│  │    ├─ Agent tool → sub-agent loops (concurrent)        │        │
│  │    └─ RenderUI → Generative UI (blocking)              │        │
│  │  Memory ingestion + SkillBank extraction               │        │
│  │  Context summarization at token pressure               │        │
│  └────────────────────────────────────────────────────────┘        │
│                                                                    │
│  Session checkpoint · cost tracking · OTEL spans · webhooks        │
└──────┬──────────┬──────────┬──────────────┬───────────────────────┘
       │          │          │              │
       ▼          ▼          ▼              ▼
┌──────────┐ ┌─────────┐ ┌──────────┐ ┌─────────────────────┐
│ Storage  │ │ 7 Prov. │ │ OMLS     │ │ External            │
│          │ │ Adapters │ │          │ │                     │
│ memory/  │ │ Ollama   │ │ Router   │ │ MCP Servers         │
│ sessions/│ │ Anthropic│ │ Trainer  │ │ Webhooks            │
│ skills   │ │ OpenAI   │ │ Buffer   │ │ OTEL Collector      │
│ wiki     │ │ DeepSeek │ │ Adapter  │ │ Browser (Playwright)│
│          │ │ Gemini   │ │          │ │                     │
│          │ │ OpenRtr  │ │          │ │                     │
└──────────┘ └─────────┘ └──────────┘ └─────────────────────┘
```

### Storage Layout

```
~/.orager/
  settings.json                  # user settings
  memory/<memoryKey>.sqlite      # per-namespace memory (FTS5 + sqlite-vec)
  skills/skills.sqlite           # SkillBank — learned task patterns
  sessions/
    index.sqlite                 # session metadata + FTS
    <sessionId>.jsonl            # append-only turn transcripts
  models/<key>/<model>/
    adapter.safetensors          # current LoRA adapter
    adapter.v<N>.safetensors     # versioned rollback copies
    adapter.meta.json            # training metadata
  wiki/wiki.sqlite               # Knowledge Wiki
  project-index/<id>.sqlite      # code intelligence index
  trajectories/                  # OMLS trajectory data
```

---

## Tiers

orager is **open-core**. The core runtime is Apache 2.0 and always will be. Paid tiers add managed infrastructure and advanced learning features.

| Tier | Price | Highlights |
|------|-------|------------|
| **Open Source** | Free | Full runtime, 23+ tools, 3-layer memory, SkillBank, 7 providers |
| **Orager Cloud** | ~$20/mo | Hosted memory, web dashboard, session replay |
| **SkillBank Pro** | ~$30/mo | OMLS LoRA training, prompt tournaments, team skill sharing |
| **Enterprise** | Custom | Self-hosted, SSO, audit logs, SLA |

[Licensing & Tiers →](https://jaycodesx.github.io/orager/guide/licensing) | [oragerai.com →](https://oragerai.com)

## Roadmap

- **Orager Cloud** — managed agents, hosted memory, zero infrastructure (coming soon)
- **Skill Marketplace** — publish and subscribe to community skill packs
- **Enterprise** — self-hosted deployment, SSO, audit logs, SLA

---

## Contributing

```bash
git clone https://github.com/JayCodesX/orager
cd orager && bun install

# Run targeted tests (preferred during development)
bun test ./tests/some-file.test.ts

# Full test suite
bun run test:bun

# Type checking
bun run typecheck
```

**Test patterns:** Always use `bun test`, not `npm test`. See [CLAUDE.md](./CLAUDE.md) for mock isolation patterns and test conventions.

[Documentation →](https://jaycodesx.github.io/orager/)

---

## License

Apache 2.0 — see [LICENSE](./LICENSE)

The open-source distribution is licensed under [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0). Pro and Cloud features require a commercial license. See [Licensing & Tiers](https://jaycodesx.github.io/orager/guide/licensing) for details.
