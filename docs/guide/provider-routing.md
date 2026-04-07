# Provider Routing

orager routes model requests through a provider adapter system (defined in ADR-0010). Multiple LLM providers are supported, with automatic detection, fallback chains, and cost-aware selection.

## Resolution Chain

When orager receives a model request, it resolves the provider using a first-match chain:

1. **Ollama** -- Matches if `--ollama` flag is set or `ollama.enabled` is true in settings.
2. **Anthropic Direct** -- Matches models with the `anthropic/` prefix.
3. **OpenAI Direct** -- Matches models starting with `gpt-`, `o1`, `o3`, or `o4`.
4. **DeepSeek Direct** -- Matches models with the `deepseek/` prefix.
5. **Gemini Direct** -- Matches models with the `gemini/` prefix.
6. **OpenRouter** -- Universal fallback. Routes to 100+ models via the OpenRouter API.

The first provider that matches the model identifier wins. If no direct provider matches, OpenRouter handles the request.

## Provider Configuration

### Ollama (Local)

Run models locally via Ollama. No API key required.

```bash
# Enable via CLI flag
orager run --ollama --ollama-model llama3.2 "Explain this code"

# Or set in settings.json
# ollama.enabled: true
# ollama.model: "llama3.2"
# ollama.url: "http://localhost:11434"
```

| Option | Description | Default |
|---|---|---|
| `--ollama` | Enable Ollama provider | `false` |
| `--ollama-model` | Model name (must be pulled locally) | Required |
| `--ollama-url` | Ollama API endpoint | `http://localhost:11434` |

### Anthropic Direct

For Anthropic models (Claude family) without routing through OpenRouter. Supports prompt caching.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
orager run --model anthropic/claude-sonnet-4-20250514 "Review this PR"
```

Anthropic models support `cache_control: ephemeral` breakpoints for prompt caching. orager automatically inserts a cache breakpoint between the frozen prefix (system prompt, skills, CLAUDE.md) and the dynamic suffix (memory, conversation) to maximize cache hits.

### OpenAI Direct

```bash
export OPENAI_API_KEY="sk-..."
orager run --model gpt-4o "Summarize this document"
```

Matches models with prefixes: `gpt-`, `o1`, `o3`, `o4`.

### DeepSeek Direct

```bash
export DEEPSEEK_API_KEY="sk-..."
orager run --model deepseek/deepseek-r1 "Solve this math problem"
```

### Gemini Direct

```bash
export GEMINI_API_KEY="..."
# or
export GOOGLE_API_KEY="..."
orager run --model gemini/gemini-2.5-pro "Analyze this image"
```

Accepts either `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

### OpenRouter (Universal Fallback)

OpenRouter is the default provider when no direct match is found. It routes to 100+ models across many providers.

```bash
export PROTOCOL_API_KEY="sk-or-..."
orager run --model "meta-llama/llama-3.1-70b-instruct" "Write a test"
```

OpenRouter provides model metadata including pricing, context length, and capability flags, which orager uses for cost-aware selection and vision routing.

## Turn-Based Model Rules

Switch models mid-conversation based on turn count:

```json
{
  "turnModelRules": [
    { "afterTurn": 5, "model": "anthropic/claude-sonnet-4-20250514" },
    { "afterTurn": 15, "model": "deepseek/deepseek-chat" }
  ]
}
```

This starts with the primary model, switches to Claude Sonnet after turn 5, and to DeepSeek Chat after turn 15. Useful for starting with a strong model and dropping to cheaper ones as the task progresses.

## Fallback Chains

Specify backup models in case the primary is unavailable or rate-limited:

```bash
orager run --model anthropic/claude-sonnet-4-20250514 \
  --model-fallback deepseek/deepseek-chat \
  --model-fallback meta-llama/llama-3.1-70b-instruct \
  "Fix this bug"
```

Models are tried in order. If the primary returns a 429 (rate limited) or 5xx error, the next model in the chain is used.

## Provider Filtering

Control which providers OpenRouter may use:

```bash
# Prefer specific providers (tried in order)
orager run --provider-order anthropic,aws --model claude-sonnet-4-20250514 "task"

# Restrict to a single provider
orager run --provider-only anthropic --model claude-sonnet-4-20250514 "task"

# Exclude providers
orager run --provider-ignore azure --model claude-sonnet-4-20250514 "task"
```

## Sorting

Control how OpenRouter selects among equivalent provider endpoints:

```bash
orager run --sort price "task"        # Cheapest endpoint first
orager run --sort throughput "task"    # Fastest tokens/sec first
orager run --sort latency "task"      # Lowest TTFT first
```

## Vision Routing

If your primary model does not support vision (image inputs), specify a vision-capable model as a fallback:

```bash
orager run --model deepseek/deepseek-chat \
  --vision-model anthropic/claude-sonnet-4-20250514 \
  "Describe this screenshot"
```

When a message includes image content, orager automatically routes it to the vision model.

## Zero Data Retention

The `--zdr` flag requests Zero Data Retention from providers that support it. When enabled, the provider does not log or store your prompts and completions.

```bash
orager run --zdr --model anthropic/claude-sonnet-4-20250514 "Process this sensitive data"
```

Not all providers support ZDR. orager logs a warning if the selected provider does not advertise ZDR support.

## Provider Health Monitoring

orager tracks error rates per provider in `provider-health.ts`. The system maintains a sliding window of recent requests and their outcomes.

### Circuit Breaker

When a provider's error rate exceeds the threshold (default: 50% over the last 10 requests), the circuit breaker opens and the provider is temporarily skipped. This prevents cascading failures and wasted latency on a downed provider.

The circuit breaker has three states:

- **Closed** -- Normal operation. Requests flow through.
- **Open** -- Provider is failing. Requests skip this provider and fall through to the next in the chain.
- **Half-open** -- After a cooldown period, a single probe request is sent. If it succeeds, the circuit closes. If it fails, the circuit reopens.

## Cost-Aware Selection

OpenRouter provides model metadata including per-token pricing. orager uses this metadata to:

- Estimate cost before sending a request.
- Select the cheapest endpoint when `--sort price` is set.
- Enforce `maxCostUsd` and `costQuota` limits.
- Display cost breakdowns in the `EmitResultEvent`.

See the [Performance and Cost guide](./performance-cost.md) for detailed cost management.
