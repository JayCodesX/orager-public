# Performance and Cost

orager provides cost tracking, prompt caching, rate limiting, circuit breakers, and observability to keep agent runs efficient and within budget.

## Cost Tracking

### Hard Stop

Set an absolute cost ceiling per run:

```bash
orager run --max-cost-usd 5.00 "Refactor the auth module"
```

Or in `AgentLoopOptions`:

```typescript
await runAgentLoop({
  prompt: "task",
  maxCostUsd: 5.0,
});
```

When `maxCostUsd` is reached, the agent loop terminates immediately. The `EmitResultEvent` includes `total_cost_usd` and `cost_breakdown` so you can see where the budget went.

### Soft Warning

```json
{
  "maxCostUsdSoft": 2.0
}
```

When the soft limit is hit, orager emits a warning event but continues execution. Useful for alerting without hard-stopping long-running tasks.

### Rolling Cost Quota

The `costQuota` system prevents runaway aggregate spend across multiple runs:

```json
{
  "costQuota": {
    "maxUsd": 50.0,
    "windowMinutes": 1440
  }
}
```

This caps total spending to $50 over a rolling 24-hour window. If the quota is exhausted, new runs are blocked until older charges roll out of the window.

The cost quota system includes anomaly detection: if a single run's cost exceeds 3x the rolling average, a warning is emitted before the run completes.

## Prompt Caching

Anthropic models support prompt caching via `cache_control: ephemeral` breakpoints. orager automatically structures prompts to maximize cache hits:

1. **Frozen prefix** -- System prompt, skill definitions, and CLAUDE.md content. This rarely changes between turns.
2. **Cache breakpoint** -- A `cache_control: ephemeral` marker inserted between the prefix and suffix.
3. **Dynamic suffix** -- Memory entries, conversation history, and tool outputs. This changes every turn.

The frozen prefix is cached on Anthropic's servers, significantly reducing input token costs for multi-turn conversations. Cache hits are reflected in the cost breakdown.

## Token Estimation

orager uses tiktoken to estimate token counts before sending requests. This enables:

- Pre-request cost estimation for budget enforcement.
- Context window management (avoiding truncation errors).
- Accurate progress reporting during long runs.

Token estimates are approximate. Actual token counts from the provider response are used for billing.

## Context Summarization

When conversation context grows too large, orager can summarize older turns to free up context window space:

```json
{
  "summarizeAt": 0.75,
  "summarizeModel": "deepseek/deepseek-chat",
  "summarizeTurnInterval": 10,
  "summarizeKeepRecentTurns": 3
}
```

| Field | Description |
|---|---|
| `summarizeAt` | Fraction of context window usage (0-1) that triggers summarization. |
| `summarizeModel` | Model used for summarization (use a cheap, fast model). |
| `summarizeTurnInterval` | Minimum turns between summarization passes. |
| `summarizeKeepRecentTurns` | Number of recent turns preserved verbatim (not summarized). |

Summarization replaces older conversation turns with a concise summary, preserving key decisions, tool outputs, and outcomes while discarding verbose intermediate steps.

## Rate Limiting

### Rate Limit Tracker

`rate-limit-tracker.ts` monitors provider rate limit headers (`X-RateLimit-Remaining`, `Retry-After`) and tracks current usage against limits. When approaching a limit, the tracker introduces backoff delays to avoid 429 errors.

### Rate Limit Gate

`rate-limit-gate.ts` acts as a gate before requests. If the tracker indicates the provider is at capacity, the gate holds the request until capacity frees up, rather than sending it and receiving a 429.

## Circuit Breaker

`circuit-breaker.ts` prevents cascading failures when a provider is experiencing an outage:

- **Closed** -- Requests flow normally. Errors are counted.
- **Open** -- Error threshold exceeded. Requests fail immediately without hitting the provider. This saves latency and avoids hammering a failing endpoint.
- **Half-open** -- After a cooldown, a single probe request is sent. Success closes the circuit; failure reopens it.

Default thresholds:

- Error rate to open: 50% over last 10 requests
- Cooldown before half-open: 30 seconds
- Consecutive successes to close: 2

## Provider Health Monitoring

`provider-health.ts` tracks per-provider metrics:

- Error rate (sliding window)
- Average latency (p50, p95, p99)
- Availability (uptime over last hour)

These metrics feed into the fallback chain and provider selection logic. Unhealthy providers are deprioritized.

## Tool Error Budgets

Limit how many tool errors an agent can tolerate before stopping:

```bash
orager run --tool-error-budget-hard-stop 5 "task"
```

After 5 tool execution errors (non-zero exit codes, timeouts, etc.), the agent loop terminates. This prevents infinite retry loops on broken tools.

## OpenTelemetry

orager exports OpenTelemetry traces for full observability.

### Setup

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
orager run "task"
```

### Span Hierarchy

Traces include spans for:

- **Agent loop** -- Top-level span covering the entire run.
- **Tool calls** -- Child spans for each tool invocation, including parameters and duration.
- **Sub-agents** -- Nested spans for sub-agent execution.
- **Provider requests** -- HTTP spans for model API calls with token counts and cost.

### Built-in Span Buffer

Even without an external OTEL collector, orager maintains an in-memory buffer of the last 2,000 spans. These are visible in the browser UI under the Telemetry tab (`orager serve`).

## Token Budgeting Strategies

### For Interactive Sessions

Set a generous `maxCostUsd` and use `maxCostUsdSoft` for early warnings:

```json
{
  "maxCostUsd": 10.0,
  "maxCostUsdSoft": 5.0
}
```

### For Batch/CI Runs

Use tight budgets and rolling quotas:

```json
{
  "maxCostUsd": 2.0,
  "costQuota": { "maxUsd": 20.0, "windowMinutes": 60 }
}
```

### For Cost-Sensitive Workflows

Combine cheap models with turn-based rules:

```json
{
  "model": "deepseek/deepseek-chat",
  "turnModelRules": [
    { "afterTurn": 3, "model": "meta-llama/llama-3.1-8b-instruct" }
  ],
  "maxCostUsd": 1.0
}
```

Start with a capable model for the initial planning turns, then drop to a cheaper model for execution.
