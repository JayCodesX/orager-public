# Subprocess Transport

When `subprocess.enabled = true` or the `--subprocess` CLI flag is set, `runAgentLoop` delegates execution to an isolated child process that communicates over JSON-RPC 2.0 via stdio.

This uses the same protocol as MCP servers.

---

## Overview

```
┌─────────────┐   stdin (JSON-RPC requests)    ┌─────────────────┐
│ Orchestrator │ ──────────────────────────────> │  Child Process   │
│              │ <────────────────────────────── │  (orager --subprocess) │
│              │   stdout (JSON-RPC responses    │                 │
│              │          + notifications)       │                 │
│              │                                 │  stderr: logs   │
└─────────────┘                                 └─────────────────┘
```

- **stdin** -- JSON-RPC requests (one per line)
- **stdout** -- JSON-RPC responses and notifications (one per line)
- **stderr** -- diagnostic logs only (never protocol data)

---

## Wire Format

All messages are newline-delimited JSON. Each line is a complete JSON-RPC 2.0 message.

### JsonRpcRequest

Sent from orchestrator to child process.

```ts
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}
```

### JsonRpcNotification

Sent from child process to orchestrator (no `id` field, no response expected).

```ts
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}
```

### JsonRpcResponse

Sent from child process to orchestrator in response to a request.

```ts
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}
```

---

## Methods

### agent/run

Start agent execution. Sent as a request; the child responds with a result when the run completes.

**Request params**: `AgentLoopOptions` (serialized). Security-sensitive fields (`sandboxRoot`, `requireApproval`, `bashPolicy`, `dangerouslySkipPermissions`, `hooks`, `mcpServers`, `webhookUrl`, `apiKeys`) are stripped by the allowlist sanitizer on the server side.

**Response result**: The `EmitResultEvent` payload.

### agent/cancel

Cancel a running agent. Sent as a request.

**Request params**: `{}` (empty)

**Response result**: `{ cancelled: true }`

### agent/ui_response

Respond to a UI prompt (from `render_ui` tool). Sent as a request.

**Request params**: `{ requestId: string, response: unknown }`

**Response result**: `{ ok: true }`

### agent/event

Streaming notification sent from child to orchestrator for every `EmitEvent` during the run.

**Notification params**: `EmitEvent` (any event type: `system`, `assistant`, `text_delta`, `thinking_delta`, `tool`, `result`, `question`, `warn`, `ui_render`)

---

## Safety Limits

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_LINE_BYTES` | 50 MB | Maximum size of a single JSON-RPC line. Rejects oversized messages to prevent OOM. |
| `DEFAULT_SUBPROCESS_TIMEOUT_MS` | 10 minutes | Default timeout for subprocess runs. Prevents indefinite hangs. Override via `subprocess.timeoutMs`. |

---

## API

### runAgentLoopSubprocess(opts: AgentLoopOptions)

**Orchestrator side.** Spawns a child orager process with `--subprocess`, writes an `agent/run` request, streams `agent/event` notifications back as `EmitEvent` objects through `opts.onEmit`, and resolves when the child sends the final result response.

```ts
import { runAgentLoopSubprocess } from "@orager/core";

await runAgentLoopSubprocess({
  prompt: "Fix the failing test",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.OPENROUTER_API_KEY!,
  cwd: process.cwd(),
  sessionId: null,
  addDirs: [],
  maxTurns: 10,
  dangerouslySkipPermissions: false,
  verbose: false,
  onEmit: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
```

### startSubprocessServer()

**Server side.** Called automatically when orager is invoked with `--subprocess`. Reads `agent/run` from stdin, calls `runAgentLoop` internally, emits `agent/event` notifications for every `EmitEvent`, and sends the final JSON-RPC response when the run completes.

This function is not typically called directly by library consumers.

---

## CLI Usage

```bash
# Run an agent in a subprocess
orager run --subprocess "Fix the failing test"

# Subprocess with model override
orager run --subprocess --model deepseek/deepseek-r1 "Analyze this codebase"
```

---

## Error Handling

When the child process exits with a non-zero code or the timeout is reached, the orchestrator emits an `EmitResultEvent` with `subtype: "error"` containing the error details.

JSON-RPC errors use standard error codes:

| Code | Meaning |
|------|---------|
| `-32700` | Parse error (malformed JSON) |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
