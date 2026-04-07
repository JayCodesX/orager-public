# Troubleshooting

Common issues and how to resolve them.

## API Key Issues

### PROTOCOL_API_KEY not set

```
Error: PROTOCOL_API_KEY environment variable is required
```

Set the OpenRouter API key:

```bash
export PROTOCOL_API_KEY="sk-or-..."
```

Add it to your shell profile (`~/.zshrc` or `~/.bashrc`) to persist across sessions.

### Invalid API key

```
Error: 401 Unauthorized
```

Verify the key is correct and active. OpenRouter keys start with `sk-or-`. Anthropic keys start with `sk-ant-`. Check for trailing whitespace or newlines in the environment variable.

### Wrong provider key

If using a direct provider (Anthropic, OpenAI, DeepSeek, Gemini), ensure the correct environment variable is set:

| Provider | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| OpenRouter | `PROTOCOL_API_KEY` |

## Model Not Found

```
Error: Model "some-model" not found
```

- Check for typos in the model name.
- For OpenRouter models, use the full slug (e.g., `meta-llama/llama-3.1-70b-instruct`).
- For direct providers, use the correct prefix (`anthropic/`, `deepseek/`, `gemini/`).
- Run with `--verbose` to see which provider was matched.

## Ollama Connection Issues

### Service not running

```
Error: connect ECONNREFUSED 127.0.0.1:11434
```

Start the Ollama service:

```bash
ollama serve
```

### Wrong URL

If Ollama runs on a non-default port or remote host:

```bash
orager run --ollama --ollama-url http://192.168.1.100:11434 --ollama-model llama3.2 "task"
```

### Model not pulled

```
Error: model "llama3.2" not found
```

Pull the model first:

```bash
ollama pull llama3.2
```

## OMLS Training Failures

### Missing Python dependencies (Apple Silicon)

```
ModuleNotFoundError: No module named 'mlx_lm'
```

Install the MLX framework:

```bash
pip install mlx-lm
```

### Missing Python dependencies (NVIDIA)

```
ModuleNotFoundError: No module named 'peft'
```

Install the training stack:

```bash
pip install peft transformers bitsandbytes accelerate datasets
```

### Insufficient RAM

```
Error: Out of memory during training
```

OMLS requires at least 8 GB of RAM for training. For 7B models, 16 GB is recommended. Options:

- Use a smaller or quantized model.
- Close memory-intensive applications.
- Offload to a cloud VPS with `orager skill-train --no-local`.

## Session Recovery

### Corrupted JSONL

```
Error: Failed to parse session file
```

Session files are stored as JSONL. If a file is corrupted (e.g., due to a crash mid-write), orager writes a session-recovery manifest alongside the file. Use `--force-resume` to skip corrupted entries and resume from the last valid checkpoint:

```bash
orager chat --session-id <id> --force-resume
```

### Session recovery manifest

After a crash, orager writes a manifest file describing the session state at the time of failure. This manifest is used automatically on the next resume attempt. Check the session directory for `.recovery.json` files.

## Memory Issues

### FTS corruption

If full-text search returns incorrect results or errors:

The SQLite FTS index can become corrupted after unclean shutdowns. orager detects this and rebuilds the index automatically on next startup. If the problem persists, delete the FTS tables and restart -- they will be recreated.

### Embedding model fallback

If the configured embedding model is unavailable, orager falls back to FTS-only retrieval. A warning is logged. Check that the embedding model is accessible and the API key is valid.

## Rate Limiting

### 429 errors

```
Error: 429 Too Many Requests
```

The provider is rate limiting your requests. orager handles this automatically with backoff and retry. If the problem persists:

- Use `--model-fallback` to specify alternative models.
- Reduce concurrency (fewer parallel sub-agents).
- Check your provider plan limits.

### Circuit breaker open

```
Warning: Circuit breaker open for provider "anthropic"
```

The provider has been failing repeatedly. orager skips it temporarily and uses the fallback chain. The circuit breaker will probe the provider after a cooldown period (default: 30 seconds). No action is needed unless the provider is permanently down.

## Debug Flags

### Verbose logging

```bash
orager run --verbose "task"
```

Enables detailed logging including provider resolution, tool dispatch, memory retrieval, and OMLS decisions.

### JSON log format

```bash
ORAGER_JSON_LOGS=1 orager run "task"
```

Outputs structured JSON logs, useful for piping to log aggregation tools.

## Log Locations

All diagnostic logs are written to stderr, never stdout. This keeps the protocol channel clean when running in subprocess mode.

- **Interactive mode**: Logs appear in the terminal alongside output.
- **Subprocess mode**: Redirect stderr to capture logs: `orager run --subprocess "task" 2>debug.log`
- **Browser UI**: The `orager serve` dashboard displays recent logs and telemetry spans.

## Bug Reporting

When filing a bug report, include:

1. orager version (`orager --version`).
2. The command that triggered the issue.
3. Verbose logs (`--verbose`).
4. OS and hardware (especially for OMLS issues).

File issues at: [https://github.com/orager-ai/orager/issues](https://github.com/orager-ai/orager/issues)
