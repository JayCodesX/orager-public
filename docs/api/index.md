# API Reference

`@orager/core` exposes a programmatic API for running agents, orchestrating multi-agent workflows, and managing persistent memory and sessions.

## Installation

```bash
npm install @orager/core
# or
bun add @orager/core
```

## Quick Start

```ts
import { runAgentLoop, runAgentWorkflow } from "@orager/core";
import type {
  AgentLoopOptions,
  AgentDefinition,
  AgentWorkflow,
  EmitEvent,
  ToolDefinition,
} from "@orager/core";
```

## Reference Pages

| Page | Description |
|------|-------------|
| [Library API](library.md) | `runAgentLoop`, `runAgentWorkflow`, `EmitEvent` types, and all options |
| [Agent Definition](agent-definition.md) | `AgentDefinition`, `AgentConfig`, `AgentWorkflow`, `ParallelGroup` |
| [Memory API](memory-api.md) | `MemoryStore`, `MemoryEntry`, retrieval (FTS5 + ANN), storage layout |
| [Session API](session-api.md) | Session lifecycle, JSONL format, resume/fork/rollback/compact/search |
| [Subprocess Transport](subprocess.md) | JSON-RPC 2.0 stdio protocol for isolated agent runs |

## Architecture Overview

```
runAgentLoop(opts)          -- single-agent execution
runAgentWorkflow(wf, prompt) -- multi-agent pipeline (sequential + parallel)

Memory: 3-layer SQLite-backed (master context, retrieved entries, session checkpoints)
Sessions: append-only JSONL + SQLite index
Subprocess: JSON-RPC 2.0 over stdio (same protocol as MCP servers)
```

## Type Imports

All public types are exported from the package root:

```ts
import type {
  // Options
  AgentLoopOptions,
  TurnModelRule,
  TurnContext,
  TurnCallOverrides,
  CostQuotaConfig,

  // Events
  EmitEvent,
  EmitInitEvent,
  EmitAssistantEvent,
  EmitToolEvent,
  EmitResultEvent,
  EmitQuestionEvent,
  EmitTextDeltaEvent,
  EmitThinkingDeltaEvent,
  EmitWarnEvent,
  EmitPlanModeEvent,
  EmitUiRenderEvent,

  // Agents
  AgentDefinition,
  AgentConfig,
  AgentWorkflow,
  ParallelGroup,
  WorkflowStep,

  // Tools
  ToolDefinition,
  ToolExecutor,
  ToolResult,

  // Memory
  MemoryStore,
  MemoryEntry,
  MemoryEntryType,

  // Sessions
  SessionData,
  SessionSummary,
} from "@orager/core";
```
