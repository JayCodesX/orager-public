# Quick Start

## CLI — First Agent Run

Run a one-shot prompt:

```bash
orager run "Summarize the README in this directory"
```

Start an interactive conversation:

```bash
orager chat
```

Use a specific model:

```bash
orager run --model anthropic/claude-sonnet-4-6 "Explain this codebase"
```

Attach files (images, PDFs, audio, text):

```bash
orager run --file screenshot.png --file report.pdf "What does this show?"
```

Run locally with Ollama:

```bash
orager run --ollama --ollama-model llama3.2 "Refactor this function"
```

## Library — First Integration

```typescript
import { runAgentLoop } from "@orager/core";

await runAgentLoop({
  prompt: "Write a test for the auth module",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.PROTOCOL_API_KEY!,
  cwd: process.cwd(),
  onEmit: (e) => console.log(JSON.stringify(e)),
});
```

## Resume a Session

Every run creates a persistent session. Resume it by ID:

```bash
orager chat --session-id my-project
```

List and search sessions:

```bash
orager --list-sessions
orager --search-sessions "auth bug"
```

## Use a Profile

Profiles are opinionated presets for common tasks:

```bash
orager run --profile code-review "Review this PR"
orager run --profile bug-fix "Fix the failing test in auth.test.ts"
orager run --profile test-writer "Add tests for the payment module"
```

Available profiles: `code-review`, `bug-fix`, `research`, `refactor`, `test-writer`, `devops`, `dev`, `deploy`.

## Browser UI

Launch the dashboard to view sessions, costs, and configuration:

```bash
orager serve              # http://localhost:3457
orager serve --port 8080
```

## Next Steps

- [Core Concepts](/guide/core-concepts) — understand how the agent loop, memory, and skills work
- [CLI Reference](/guide/cli-reference) — full flag reference for all commands
- [Configuration](/guide/configuration) — customize settings.json and env vars
- [Library API](/api/library) — programmatic usage with `runAgentLoop`
