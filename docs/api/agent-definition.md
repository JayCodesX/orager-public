# Agent Definition

Types for defining sub-agents (dynamic spawning) and multi-agent workflows.

```ts
import type {
  AgentDefinition,
  AgentConfig,
  AgentWorkflow,
  ParallelGroup,
  WorkflowStep,
} from "@orager/core";
```

---

## AgentDefinition

Defines a sub-agent that can be spawned dynamically by the parent agent via the `Agent` tool. Register agents in `AgentLoopOptions.agents`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `string` | Yes | One or two sentences describing what this agent does. The parent model reads this to decide delegation. Be specific: "Use for X when Y" is better than "An agent that does X". |
| `prompt` | `string` | Yes | System prompt prepended to the task. Defines role, constraints, and output format. |
| `name` | `string` | No | Human-readable display name. Defaults to the registry key. |
| `model` | `string` | No | Model override. Any OpenRouter model ID or `"inherit"`. Default: inherit the parent's model. |
| `tools` | `string[]` | No | Tool allow-list using exact tool names (e.g. `"Read"`, `"Bash"`, `"WebSearch"`). Omit to inherit all parent tools (minus the Agent tool itself). |
| `disallowedTools` | `string[]` | No | Tool deny-list. Applied after the allow-list: deny-list wins. |
| `memoryKey` | `string` | No | Memory namespace override. Omit to inherit the parent's key (read-only unless `memoryWrite` is true). |
| `memoryWrite` | `boolean` | No | Allow memory writes. Default: `false` (sub-agents read but do not write). |
| `skills` | `boolean` | No | Inject SkillBank skills. Default: `true`. Disable for fast/cheap utility agents. |
| `maxTurns` | `number` | No | Turn limit. Default: inherits parent's `maxTurns`. |
| `maxCostUsd` | `number` | No | Per-spawn cost ceiling in USD. Default: no limit (parent's cap applies). |
| `effort` | `"low" \| "medium" \| "high"` | No | Compute effort level. `"low"` for quick lookups, `"high"` for deep reasoning. Default: `"medium"`. |
| `tags` | `string[]` | No | Tags for catalog organization and filtering. |
| `readProjectInstructions` | `boolean` | No | Read project's CLAUDE.md. Default: `false`. Enable for agents that need project conventions. |

### Example: Dynamic Agent Spawning

```ts
import { runAgentLoop } from "@orager/core";

await runAgentLoop({
  prompt: "Review the auth module for security issues",
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.OPENROUTER_API_KEY!,
  cwd: process.cwd(),
  sessionId: null,
  addDirs: [],
  maxTurns: 30,
  dangerouslySkipPermissions: false,
  verbose: false,
  onEmit: (event) => { /* handle events */ },
  agents: {
    "security-reviewer": {
      description: "Use for reviewing code for security vulnerabilities, OWASP issues, and injection risks.",
      prompt: "You are a security specialist. Analyze code for vulnerabilities. Output a structured report with severity ratings.",
      model: "deepseek/deepseek-r1",
      tools: ["Read", "Glob", "Grep"],
      memoryWrite: false,
      maxTurns: 10,
      maxCostUsd: 1.0,
      effort: "high",
    },
    "test-writer": {
      description: "Use for generating unit tests for functions and modules.",
      prompt: "You are a test engineer. Write comprehensive unit tests with edge cases.",
      tools: ["Read", "Write", "Bash"],
      memoryWrite: false,
      maxTurns: 15,
    },
  },
});
```

The parent model decides when to delegate based on each agent's `description`. Sub-agents cannot spawn further sub-agents (the Agent tool is excluded from their toolset).

---

## AgentConfig

Per-step configuration for use in an `AgentWorkflow`. Specifies only the fields that differ from the shared base config.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | `string` | Yes | Human-readable step name. Used in logs and cost tracking. |
| `model` | `string` | Yes | Model for this step. Overrides `AgentWorkflow.base.model`. |
| `appendSystemPrompt` | `string` | No | Appended to the shared system prompt. Defines step-specific role and output format. |
| `temperature` | `number` | No | Sampling temperature for this step. |
| `memoryKey` | `string \| string[]` | No | Memory namespace(s). Array form: index 0 is the write target, all elements are read sources. |
| `maxTurns` | `number` | No | Turn limit for this step. |
| `maxCostUsd` | `number` | No | Hard cost ceiling in USD for this step. |

---

## AgentWorkflow

Defines a multi-agent pipeline with sequential and parallel execution.

| Field | Type | Description |
|-------|------|-------------|
| `base` | `Omit<AgentLoopOptions, "prompt" \| "model">` | Shared base config applied to every step unless overridden. |
| `steps` | `(AgentConfig \| ParallelGroup)[]` | Ordered list of steps. Each is either sequential (single `AgentConfig`) or parallel (`ParallelGroup`). |
| `handoff` | `(stepIndex: number, output: string) => string` | Optional transform between steps. Default: pass output through as-is. |

---

## ParallelGroup

A group of agents that execute concurrently. All agents in the group receive the same input prompt; their outputs are concatenated (separated by `\n---\n`) before being passed to the next step.

```ts
interface ParallelGroup {
  parallel: AgentConfig[];
}
```

---

## WorkflowStep

Union type for a single workflow step:

```ts
type WorkflowStep = AgentConfig | ParallelGroup;
```

---

## Example: Sequential Workflow

```ts
import { runAgentWorkflow } from "@orager/core";
import type { AgentWorkflow } from "@orager/core";

const workflow: AgentWorkflow = {
  base: {
    apiKey: process.env.OPENROUTER_API_KEY!,
    cwd: process.cwd(),
    addDirs: [],
    sessionId: null,
    maxTurns: 10,
    dangerouslySkipPermissions: false,
    verbose: false,
    onEmit: (event) => {
      if (event.type === "text_delta") process.stdout.write(event.delta);
    },
  },
  steps: [
    {
      role: "researcher",
      model: "deepseek/deepseek-r1",
      appendSystemPrompt: "Research the topic thoroughly. Output structured findings.",
      maxCostUsd: 2.0,
    },
    {
      role: "writer",
      model: "anthropic/claude-sonnet-4-6",
      appendSystemPrompt: "Synthesize the research into a clear, well-structured report.",
      temperature: 0.3,
    },
  ],
};

await runAgentWorkflow(workflow, "Analyze the competitive landscape for AI coding agents");
```

## Example: Parallel + Sequential

```ts
const workflow: AgentWorkflow = {
  base: { /* ... shared config ... */ },
  steps: [
    // Step 1: Two researchers run in parallel
    {
      parallel: [
        { role: "web-researcher", model: "deepseek/deepseek-chat", maxCostUsd: 1.0 },
        { role: "code-researcher", model: "deepseek/deepseek-chat", maxCostUsd: 1.0 },
      ],
    },
    // Step 2: Synthesizer receives both outputs joined by \n---\n
    {
      role: "synthesizer",
      model: "anthropic/claude-sonnet-4-6",
      temperature: 0.2,
    },
  ],
};

await runAgentWorkflow(workflow, "Compare React and Svelte for our use case");
```
