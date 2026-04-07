# Library API

The core programmatic interface for running agents and orchestrating workflows.

```ts
import { runAgentLoop, runAgentWorkflow } from "@orager/core";
```

---

## runAgentLoop(opts: AgentLoopOptions)

Main entry point for executing a single agent. Returns a `Promise<void>` that resolves when the agent finishes. All output is delivered through the `onEmit` callback.

```ts
await runAgentLoop({
  prompt: "Refactor the auth module to use JWT",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.OPENROUTER_API_KEY!,
  cwd: process.cwd(),
  sessionId: null,
  addDirs: [],
  maxTurns: 20,
  dangerouslySkipPermissions: false,
  verbose: false,
  onEmit: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "result") console.log("Done:", event.subtype);
  },
});
```

### AgentLoopOptions

#### Core

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The user prompt. |
| `model` | `string` | Model ID (e.g. `"deepseek/deepseek-chat"`, `"anthropic/claude-sonnet-4-6"`). |
| `apiKey` | `string` | Provider API key (typically `OPENROUTER_API_KEY`). |
| `cwd` | `string` | Working directory for file operations and tool execution. |
| `sessionId` | `string \| null` | Session to resume. Pass `null` for a new session. |
| `addDirs` | `string[]` | Additional directories to include in project context. |
| `maxTurns` | `number` | Turn limit. Set to `0` for unlimited. Default: `20`. |
| `maxRetries` | `number` | Retries for failed API calls. Default: `3`. |
| `maxCostUsd` | `number` | Hard cost cap in USD. The loop exits with `error_max_cost` when exceeded. |
| `maxCostUsdSoft` | `number` | Soft cost warning in USD. Logs a warning but continues. Must be less than `maxCostUsd`. |
| `costQuota` | `CostQuotaConfig` | Rolling cost quota: `{ maxUsd: number, windowMs?: number }`. Prevents runaway aggregate spend across multiple runs. Default window: 24 hours. |
| `onEmit` | `(event: EmitEvent) => void` | Event callback (required). All output is delivered through this. |
| `onLog` | `(stream, chunk) => void` | Optional log stream callback. |
| `verbose` | `boolean` | Enable verbose logging. |
| `dangerouslySkipPermissions` | `boolean` | Skip all tool approval checks. **Use only in trusted environments.** |

#### Model Parameters

| Field | Type | Description |
|-------|------|-------------|
| `temperature` | `number` | Sampling temperature. |
| `top_p` | `number` | Nucleus sampling threshold. |
| `top_k` | `number` | Top-k sampling. |
| `frequency_penalty` | `number` | Penalize frequent tokens. |
| `presence_penalty` | `number` | Penalize tokens already present. |
| `repetition_penalty` | `number` | Repetition penalty factor. |
| `min_p` | `number` | Minimum probability threshold. |
| `seed` | `number` | Deterministic seed for reproducible output. |
| `stop` | `string[]` | Stop sequences. |

#### Routing

| Field | Type | Description |
|-------|------|-------------|
| `turnModelRules` | `TurnModelRule[]` | Per-turn model escalation rules. Evaluated before each API call; first match wins. |
| `provider` | `OpenRouterProviderRouting` | OpenRouter provider routing preferences. |
| `reasoning` | `OpenRouterReasoningConfig` | Reasoning/thinking configuration for supported models. |
| `visionModel` | `string` | Fallback model for non-vision models when image inputs are detected. |
| `audioModel` | `string` | Model override for audio/speech inputs. |
| `preset` | `string` | OpenRouter preset slug (named server-side config). |
| `transforms` | `string[]` | OpenRouter context transforms. |

#### Memory

| Field | Type | Description |
|-------|------|-------------|
| `memoryKey` | `string` | Memory namespace. Derived from working directory when omitted. |
| `appendSystemPrompt` | `string` | Extra text appended to the system prompt. |
| `summarizeAt` | `number` | Fraction (0-1) of context window at which summarization triggers. Default: `0.70`. Set to `0` to disable. |
| `summarizeModel` | `string` | Model for summarization calls. Defaults to the primary model. |
| `summarizeTurnInterval` | `number` | Force summarization every N turns. Default: `6`. Set to `0` to disable. |
| `summarizeKeepRecentTurns` | `number` | Keep the last N assistant turns intact during summarization. Default: `4`. |
| `summarizePrompt` | `string` | Custom system prompt for summarization calls. |
| `summarizeFallbackKeep` | `number` | Turns to keep when summarization fails. Default: `40`. |

#### Tools

| Field | Type | Description |
|-------|------|-------------|
| `extraTools` | `ToolExecutor[]` | Additional custom tool executors beyond the built-in set. |
| `requireApproval` | `string[] \| "all"` | Require approval before executing tools. `"all"` covers every tool; an array limits to named tools. |
| `onApprovalRequest` | `(toolName, input) => Promise<boolean>` | Override the default TTY approval prompt. |
| `onToolCall` | `(toolName, input) => Promise<string \| null>` | Handler for delegated tools (`execute: false`). Return the result string or `null` for failure. |
| `tool_choice` | `"auto" \| "none" \| "required"` | Tool selection mode. |
| `parallel_tool_calls` | `boolean` | Allow parallel tool execution. |
| `toolTimeouts` | `Record<string, number>` | Per-tool execution timeouts in milliseconds. |
| `useFinishTool` | `boolean` | Include the built-in finish tool for explicit completion signaling. |

#### Agents

| Field | Type | Description |
|-------|------|-------------|
| `agents` | `Record<string, AgentDefinition>` | Named sub-agent definitions available for delegation. See [Agent Definition](agent-definition.md). |
| `maxSpawnDepth` | `number` | Maximum depth of nested agent spawning. Default: `2`. Set to `0` to disable. |
| `maxSpawnsPerSession` | `number` | Maximum total spawns per session across all depths. Default: `50`. |

#### Safety

| Field | Type | Description |
|-------|------|-------------|
| `sandboxRoot` | `string` | Restrict file-path tools to this directory subtree. |
| `bashPolicy` | `BashPolicy` | Policy restricting bash tool (command blocklist, env isolation). |
| `abortSignal` | `AbortSignal` | Cancel the agent loop mid-run. Exits cleanly with `error_cancelled`. |

#### MCP

| Field | Type | Description |
|-------|------|-------------|
| `mcpServers` | `Record<string, McpServerConfig>` | MCP server configurations for external tool providers. |

#### Other

| Field | Type | Description |
|-------|------|-------------|
| `attachments` | `string[]` | File paths to attach to the first user message (images, PDFs, text). |
| `subprocess` | `{ enabled: boolean }` | Run the agent in an isolated child process via JSON-RPC 2.0. See [Subprocess Transport](subprocess.md). |
| `siteUrl` | `string` | Sent as `HTTP-Referer` to identify your app to OpenRouter. |
| `siteName` | `string` | Sent as `X-Title` to display your app name in OpenRouter dashboards. |
| `forceResume` | `boolean` | Resume a session even if its stored cwd differs from the current cwd. |
| `approvalMode` | `"tty" \| "question"` | `"question"` emits a question event and terminates instead of blocking on TTY. |
| `approvalTimeoutMs` | `number` | Timeout for TTY-mode approval prompts. Default: 5 minutes. |

---

## runAgentWorkflow(workflow, initialPrompt)

Orchestrates sequential and parallel multi-agent pipelines. Each step receives the previous step's output as its prompt (customizable via the `handoff` function).

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
    { role: "researcher", model: "deepseek/deepseek-r1", maxCostUsd: 2.0 },
    { role: "writer", model: "anthropic/claude-sonnet-4-6", temperature: 0.3 },
  ],
};

await runAgentWorkflow(workflow, "Analyze the competitive landscape for AI agents");
```

### AgentWorkflow

| Field | Type | Description |
|-------|------|-------------|
| `base` | `Omit<AgentLoopOptions, "prompt" \| "model">` | Shared base config applied to every step. |
| `steps` | `(AgentConfig \| ParallelGroup)[]` | Ordered list of workflow steps. |
| `handoff` | `(stepIndex: number, output: string) => string` | Optional transform between steps. Default: pass output through as-is. |

For parallel groups, all agents receive the same input prompt and run concurrently. Outputs are joined with `\n---\n` before handoff.

See [Agent Definition](agent-definition.md) for `AgentConfig` and `ParallelGroup` details.

---

## EmitEvent Types

All agent output is delivered as `EmitEvent` objects through the `onEmit` callback. The `type` field is the discriminator.

### EmitInitEvent

Emitted once at the start of a run.

```ts
{
  type: "system",
  subtype: "init",
  model: string,
  session_id: string,
}
```

### EmitAssistantEvent

Emitted when the model completes a turn. Contains the full message with text, thinking, and tool-use blocks.

```ts
{
  type: "assistant",
  streamed?: boolean,  // true if content was already emitted as deltas
  message: {
    role: "assistant",
    content: Array<
      | { type: "text", text: string }
      | { type: "thinking", thinking: string }
      | { type: "tool_use", id: string, name: string, input: Record<string, unknown> }
    >,
  },
}
```

When `streamed` is `true`, consumers should skip re-rendering text blocks to avoid duplicating content already received via `text_delta` events.

### EmitTextDeltaEvent

Streaming text token. Emitted as each token arrives from the LLM.

```ts
{
  type: "text_delta",
  delta: string,
}
```

### EmitThinkingDeltaEvent

Streaming reasoning/thinking token for models that expose internal reasoning (e.g. DeepSeek R1).

```ts
{
  type: "thinking_delta",
  delta: string,
}
```

### EmitToolEvent

Emitted after tool execution completes.

```ts
{
  type: "tool",
  content: Array<{
    type: "tool_result",
    tool_use_id: string,
    content: string,
    is_error?: boolean,
    image_url?: string,
  }>,
}
```

### EmitResultEvent

Emitted once when the agent loop terminates.

```ts
{
  type: "result",
  subtype: ResultSubtype,
  result: string,
  session_id: string,
  finish_reason: string | null,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_read_input_tokens: number,
    cache_write_tokens?: number,
  },
  total_cost_usd: number,
  cost_breakdown?: { input_usd: number, output_usd: number },
  turnCount?: number,
  toolMetrics?: Record<string, ToolMetric>,
  filesChanged?: string[],
}
```

#### Result Subtypes

| Subtype | Description |
|---------|-------------|
| `success` | Agent completed normally. |
| `error_max_turns` | Turn limit reached. |
| `error_max_cost` | Cost cap exceeded. |
| `error` | Unrecoverable error. |
| `error_circuit_open` | Circuit breaker tripped after repeated failures. |
| `interrupted` | Run interrupted (e.g. by user). |
| `error_cancelled` | Cancelled via `AbortSignal`. |
| `error_tool_budget` | Tool error budget exhausted. |
| `error_loop_abort` | Loop aborted by internal safety check. |

#### ToolMetric

```ts
{
  calls: number,     // total invocations
  errors: number,    // invocations that returned isError: true
  totalMs: number,   // wall-clock milliseconds
}
```

### EmitQuestionEvent

Emitted when a tool requires user approval (when `approvalMode` is `"question"`).

```ts
{
  type: "question",
  prompt: string,
  choices: Array<{ key: string, label: string, description?: string }>,
  toolCallId: string,
  toolName: string,
}
```

### EmitWarnEvent

Non-fatal warning during a run.

```ts
{
  type: "warn",
  subtype?: "dropped_opts" | "session_lost",
  message: string,
  dropped_opts?: string[],   // when subtype is "dropped_opts"
  session_id?: string,       // when subtype is "session_lost"
}
```

### EmitPlanModeEvent

Emitted when the model exits plan mode.

```ts
{
  type: "system",
  subtype: "plan_mode_exit",
  plan_summary: string,
}
```

### EmitUiRenderEvent

Emitted by the `render_ui` tool to request interactive UI rendering from the frontend.

```ts
{
  type: "ui_render",
  requestId: string,
  spec: UiComponentSpec,  // "confirm" | "form" | "select" | "table"
}
```

The agent loop blocks until the frontend resolves the `requestId` via the appropriate response mechanism (HTTP endpoint or JSON-RPC call).
