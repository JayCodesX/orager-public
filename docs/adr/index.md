# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for orager.

ADRs document significant architectural choices: the context that drove them, the decision made, alternatives considered, and the consequences. They are written once and amended only when a decision is revisited or superseded.

## Index

| # | Title | Status | Summary |
|---|-------|--------|---------|
| [ADR-0001](./0001-hierarchical-memory-system.md) | Hierarchical Memory System | Accepted | Three-layer memory (master, long-term, episodic) for cross-session context |
| [ADR-0002](./0002-ann-vector-index.md) | ANN Vector Index | Accepted | sqlite-vec for sub-millisecond semantic retrieval at scale |
| [ADR-0003](./0003-in-process-agents-remove-daemon.md) | In-Process Agents | Accepted | Remove HTTP daemon; agents run in-process with optional subprocess fallback |
| [ADR-0004](./0004-semantic-memory-retrieval-distillation.md) | Semantic Memory Retrieval | Accepted | BM25 + embedding hybrid scoring for memory retrieval |
| [ADR-0005](./0005-multi-context-cross-agent-memory.md) | Multi-Context Memory | Accepted | Cross-agent memory sharing with namespace arrays |
| [ADR-0006](./0006-skillbank-persistent-skill-memory.md) | SkillBank | Accepted | Persistent behavioral skill extraction and injection |
| [ADR-0007](./0007-omls-opportunistic-rl-training.md) | OMLS Training | Accepted | LoRA training with confidence routing and teacher distillation |
| [ADR-0008](./0008-storage-architecture-overhaul.md) | Storage Overhaul | Accepted | bun:sqlite, per-namespace files, sqlite-vec, JSONL sessions |
| [ADR-0009](./0009-local-first-inference-client-architecture.md) | Local-First Inference | Proposed | Desktop client with Ollama, subscription model |
| [ADR-0010](./0010-provider-adapter-system.md) | Provider Adapters | Accepted | Decouple model routing from OpenRouter with adapter system |
| [ADR-0011](./0011-skill-merge-pipeline.md) | Skill Merge Pipeline | Accepted | Consolidate similar skills into meta-skills |
| [ADR-0012](./0012-omls-mode.md) | OMLS Mode | Accepted | Graduated learning: prompt to LoRA to auto |
| [ADR-0013](./0013-prompt-variant-tournament.md) | Prompt Tournament | Accepted | A/B test and optimize base prompt variants |

## Format

ADRs in this project follow the [MADR](https://adr.github.io/madr/) template with the Nygard core fields (Status, Context, Decision, Consequences) extended with Alternatives Considered and Decision Drivers.

## Adding a New ADR

1. Copy the structure from an existing ADR
2. Number sequentially (`0014-...`, `0015-...`)
3. Set status to `Proposed` until merged
4. Add a row to the index above
