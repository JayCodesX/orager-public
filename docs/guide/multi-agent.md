# Multi-Agent Patterns

orager supports two multi-agent patterns: dynamic spawning (ad-hoc sub-agents) and sequential/parallel workflows (structured pipelines). Both patterns share the same event system, memory model, and cost controls.

## Dynamic Spawning

Use the Agent tool to spawn sub-agents on the fly during a run. Each sub-agent gets its own context window, runs independently, and returns its output to the parent.

### AgentDefinition

The Agent tool accepts an `AgentDefinition` object:

```typescript
interface AgentDefinition {
  // Required
  description: string;         // What this sub-agent does (shown in logs)

  // Optional
  prompt?: string;             // System prompt override
  name?: string;               // Display name for tracing
  model?: string;              // Model to use (inherits parent if omitted)
  tools?: string[];            // Allowlist of tool names
  denyTools?: string[];        // Blocklist of tool names
  memoryKey?: string;          // Memory namespace (inherits parent if omitted)
  memoryWrite?: boolean;       // Allow writing to memory (default: false)
  skills?: boolean;            // Load SkillBank skills (default: true)
  maxTurns?: number;           // Turn limit
  maxCostUsd?: number;         // Cost cap in USD
}
```

### Example: Dynamic Sub-Agent

```typescript
// Inside a tool handler or agent loop
const result = await agentTool.execute({
  description: "Analyze the test failures and suggest fixes",
  model: "anthropic/claude-sonnet-4-20250514",
  tools: ["Read", "Grep", "Glob"],
  denyTools: ["Bash"],
  maxTurns: 10,
  maxCostUsd: 0.50,
  memoryWrite: false,
});
```

### Sub-Agent Behavior

- **Fresh context**: Each sub-agent starts with a clean conversation. It does not see the parent's message history.
- **Memory inheritance**: Sub-agents inherit the parent's memory namespace in read-only mode by default. They can read skills and memory entries but cannot write unless `memoryWrite: true` is set.
- **Concurrent execution**: Multiple sub-agents can run in parallel. The parent waits for all to complete before continuing.
- **Depth limit**: Sub-agents can spawn their own sub-agents, but nesting is limited to a default depth of 3 to prevent runaway recursion.
- **Event tagging**: All events emitted by sub-agents include a `_subagentType` field so the parent can distinguish them from its own events.

## Sequential Workflows

Use `runAgentWorkflow` for structured, multi-step pipelines where the output of one step feeds into the next.

### AgentWorkflow

```typescript
interface AgentWorkflow {
  base?: Partial<AgentConfig>;  // Shared options applied to all steps
  steps: (AgentConfig | ParallelGroup)[];
}
```

### AgentConfig

Each step in the pipeline is an `AgentConfig`:

```typescript
interface AgentConfig {
  role: string;                   // Descriptive role (e.g., "code-reviewer")
  model?: string;                 // Model override
  appendSystemPrompt?: string;    // Extra system prompt text
  temperature?: number;           // Sampling temperature
  memoryKey?: string;             // Memory namespace
  maxTurns?: number;              // Turn limit for this step
  maxCostUsd?: number;            // Cost cap for this step
}
```

### Example: Sequential Pipeline

```typescript
import { runAgentWorkflow } from "./workflow.js";

const workflow: AgentWorkflow = {
  base: {
    model: "anthropic/claude-sonnet-4-20250514",
    maxTurns: 15,
  },
  steps: [
    {
      role: "planner",
      appendSystemPrompt: "Break the task into subtasks. Output a numbered plan.",
      temperature: 0.3,
    },
    {
      role: "implementer",
      appendSystemPrompt: "Execute each subtask from the plan. Use tools as needed.",
      maxCostUsd: 2.0,
    },
    {
      role: "reviewer",
      appendSystemPrompt: "Review the implementation. List issues and suggest fixes.",
      temperature: 0.2,
      maxTurns: 5,
    },
  ],
};

const result = await runAgentWorkflow(workflow, "Add input validation to the signup form");
```

### Handoff

By default, each step receives the previous step's assistant text output as its prompt (pass-through). You can customize the handoff with a function:

```typescript
const workflow: AgentWorkflow = {
  steps: [
    { role: "researcher" },
    { role: "writer" },
  ],
};

// Custom handoff: transform output between steps
const result = await runAgentWorkflow(workflow, initialPrompt, {
  handoff: (previousOutput, stepIndex) => {
    if (stepIndex === 1) {
      return `Based on this research:\n\n${previousOutput}\n\nWrite a summary document.`;
    }
    return previousOutput;
  },
});
```

## Parallel Groups

Steps in a workflow can be a `ParallelGroup` instead of a single `AgentConfig`. All agents in a parallel group receive the same prompt, run concurrently via `Promise.all`, and their outputs are joined with `\n---\n`.

```typescript
const workflow: AgentWorkflow = {
  steps: [
    { role: "planner" },
    // Parallel group: three reviewers run simultaneously
    [
      { role: "security-reviewer", appendSystemPrompt: "Focus on security issues." },
      { role: "perf-reviewer", appendSystemPrompt: "Focus on performance issues." },
      { role: "style-reviewer", appendSystemPrompt: "Focus on code style." },
    ] as ParallelGroup,
    { role: "synthesizer", appendSystemPrompt: "Combine the review feedback into an action plan." },
  ],
};
```

The synthesizer step receives all three review outputs separated by `---` as its input prompt.

## Memory Sharing Patterns

### Read-Only Inheritance (Default)

Sub-agents and workflow steps inherit the parent's memory namespace. They can read skills, master context, and retrieved memory entries but cannot write back. This is the safe default that prevents sub-agents from corrupting shared memory.

### Explicit Write Access

Set `memoryWrite: true` on an `AgentDefinition` to allow a sub-agent to write to the inherited memory namespace. Use this when a sub-agent's job is specifically to record findings or update knowledge.

```typescript
const result = await agentTool.execute({
  description: "Research the API and record findings in memory",
  memoryWrite: true,
  maxTurns: 20,
});
```

### Cross-Namespace Access

Use a `memoryKey` array to give an agent read access to multiple memory namespaces:

```typescript
const result = await agentTool.execute({
  description: "Compare frontend and backend patterns",
  memoryKey: ["frontend", "backend"],
});
```

The agent can read from both namespaces. Writes (if enabled) go to the first namespace in the array.

## Observability

### OTEL Span Nesting

orager uses `AsyncLocalStorage` to propagate OpenTelemetry trace context through the agent hierarchy. Each sub-agent and workflow step creates a child span under its parent:

```
agent-loop (parent)
  +-- sub-agent: "code-reviewer"
  |     +-- tool: Read
  |     +-- tool: Grep
  +-- sub-agent: "test-runner"
        +-- tool: Bash
```

Spans include attributes for role, model, cost, turn count, and memory namespace. View traces in the browser UI Telemetry tab or export to any OTEL-compatible backend.

### Event Stream

All agent events (tool calls, completions, errors) flow through the unified event emitter. Sub-agent events carry `_subagentType` so consumers can filter or group by agent identity.
