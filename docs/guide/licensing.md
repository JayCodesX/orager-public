# Licensing & Tiers

orager follows an **open-core** model. The core runtime is open source under the Apache 2.0 license. Advanced features — primarily OMLS training, prompt tournaments, and team collaboration — require a Pro or Cloud license.

## Tiers

| | Open Source | Orager Cloud | SkillBank Pro | Enterprise |
|---|---|---|---|---|
| **Price** | Free | ~$20/mo | ~$30/mo | Custom |
| **License** | Apache 2.0 | Commercial | Commercial | Commercial |
| **Status** | Available now | Coming soon | Coming soon | Contact us |

### Open Source (Free)

Everything you need to build and run production agents, self-hosted:

- Multi-turn agent loop with 23+ built-in tools
- 3-layer persistent memory (master context, long-term retrieval, session checkpoints)
- BM25 + embedding hybrid retrieval with local embeddings
- SkillBank auto-learning (prompt-mode extraction and injection)
- 7 provider adapters (OpenRouter, Anthropic, OpenAI, DeepSeek, Gemini, Ollama)
- Multi-agent orchestration (dynamic spawning, sequential workflows, parallel execution)
- Browser UI, profiles, session management, cost tracking
- MCP server support, hook system, approval workflows
- Full CLI and library API

### Orager Cloud (~$20/mo)

Managed agents with hosted memory and zero infrastructure:

- Everything in Open Source
- Hosted SQLite memory (no local storage management)
- Web dashboard with session history and replay
- Cloud-managed sessions

### SkillBank Pro (~$30/mo)

Team-scale learning and OMLS training:

- Everything in Cloud
- **OMLS LoRA training** — fine-tune adapters locally (MLX/CUDA) or via cloud VPS
- **Confidence router** — 3-signal routing (task classifier, Self-REF, semantic entropy)
- **Prompt tournaments** — A/B test and optimize base prompt variants
- **Meta-optimizer** — continuous self-improvement via `--learn` flag
- **Skill merge pipeline** — automatic consolidation of semantically similar skills
- **Benchmarking** — task-based agent benchmarking with scoring
- Team skill sharing across namespaces
- Nightly OMLS training runs

### Enterprise (Custom)

Self-hosted deployment for organizations:

- Everything in Pro
- Private deployment and air-gapped operation
- SSO and audit logs
- SLA and dedicated support
- Private skill marketplace

## Feature Matrix

| Feature | Open Source | Pro / Cloud |
|---|:---:|:---:|
| Agent loop, tools, streaming | Y | Y |
| 3-layer memory + BM25/embedding retrieval | Y | Y |
| SkillBank (prompt-mode extraction) | Y | Y |
| Contrastive skill extraction | Y | Y |
| Self-reflection loop | Y | Y |
| Trajectory indexing (few-shot exemplars) | Y | Y |
| 7 provider adapters + fallback chains | Y | Y |
| Multi-agent (spawning, workflows, parallel) | Y | Y |
| Browser UI, profiles, sessions | Y | Y |
| MCP servers, hooks, approval workflows | Y | Y |
| Cost tracking, OpenTelemetry | Y | Y |
| OMLS LoRA training (local + cloud VPS) | | Y |
| Confidence router (3-signal) | | Y |
| Prompt tournaments | | Y |
| Meta-optimizer (`--learn`) | | Y |
| Skill merge pipeline | | Y |
| Agent benchmarking | | Y |
| Hosted memory (Cloud tier) | | Y |
| Team skill sharing (Pro tier) | | Y |

## Activating a License

### Via environment variable

```bash
export ORAGER_LICENSE_KEY="eyJ0aWVyIjo....<signature>"
```

### Via license file

```bash
orager license activate <key>
```

This writes the key to `~/.orager/license.json`:

```json
{
  "key": "eyJ0aWVyIjo....<signature>"
}
```

### Checking license status

```bash
orager license status
```

Displays the current tier, seat, expiry date, and validation status.

### Deactivating

```bash
orager license deactivate
```

Removes the license file and resets to the free tier. All features continue to work at the Open Source level.

## Resolution Order

orager resolves the license key in this order:

1. `ORAGER_LICENSE_KEY` environment variable
2. `~/.orager/license.json` file

If no key is found or the key is invalid/expired, the tier falls back to **free** and the agent works normally — gated features are simply unavailable.

## Key Format

License keys use Ed25519 signature verification:

```
base64(JSON payload) . base64(Ed25519 signature)
```

The payload contains `tier`, `exp` (expiry date), and `seat` (email). The public verification key is embedded in the binary. Keys cannot be forged without the private signing key.

## What Happens Without a License

orager runs at full capability on the Open Source tier. The core runtime, memory, SkillBank (prompt mode), all providers, multi-agent patterns, and every CLI command except `skill-train`, `benchmark`, and `optimize` work without any license key.

When a gated feature is invoked without a valid license, orager logs a message like:

```
[learn] --learn requires a Pro or Cloud license. Run `orager license status` for details.
```

No data is lost and no functionality degrades — the gated feature simply does not activate.
