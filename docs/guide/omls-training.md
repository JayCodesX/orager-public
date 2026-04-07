# OMLS Training Guide

The On-Machine Learning System (OMLS) is orager's local learning subsystem. It observes agent trajectories, extracts reusable skills, and optionally trains LoRA adapters to improve model performance on your specific workflows over time.

## Architecture Overview

OMLS consists of 17 modules in `src/omls/`. At a high level, the system:

1. Records agent trajectories (prompt, tool calls, outcomes).
2. Scores trajectories using a Process Reward Model (PRM).
3. Extracts skills and, optionally, trains weight-level adapters.
4. Serves the improved model or skills on subsequent runs.

## Two Operating Modes

### Prompt Mode (SkillBank-Only)

Prompt mode is the default and requires no GPU. The system distills successful trajectories into reusable skill documents stored in the SkillBank. These skills are injected into future prompts as few-shot exemplars, improving performance without any weight training.

- **Cost**: Free (no compute beyond normal inference).
- **Storage**: Skills live in `~/.orager/skills/`.
- **When to use**: Always active. Sufficient for most workflows.

### LoRA Mode (Weight Training)

LoRA mode fine-tunes a small adapter on top of a base model using your trajectory data. This produces measurably better results for repetitive, domain-specific tasks but requires GPU compute.

- **Cost**: Local GPU time or cloud VPS billing.
- **Storage**: Adapters live in `~/.orager/models/<memoryKey>/<model>/adapter.safetensors` with versioned rollback.
- **When to use**: When prompt mode plateaus and you have enough trajectory data.

### Graduated Learning (ADR-0012)

ADR-0012 defines the progression: **prompt -> LoRA -> auto**. The system starts in prompt mode, and when trajectory volume and PRM scores justify it, graduates to LoRA training automatically (in `auto` mode). You can also force a specific mode via CLI flags.

## Hardware Detection and Backend Selection

OMLS detects available hardware and selects the best backend automatically. The priority order is:

1. **`mlx`** -- Apple Silicon Macs with the MLX framework.
2. **`llamacpp-cuda`** -- NVIDIA GPUs with CUDA support.
3. **`llamacpp-cpu`** -- CPU fallback (slowest, but universally available).

### Apple Silicon (MLX)

Requires macOS with Apple Silicon (M1 or later) and at least 8 GB of unified RAM.

```bash
pip install mlx-lm
```

MLX leverages the unified memory architecture for efficient on-device training and inference. For 7B parameter models, 16 GB RAM is recommended; 8 GB works for smaller models and quantized weights.

### NVIDIA CUDA

Requires an NVIDIA GPU with CUDA drivers installed.

```bash
pip install peft transformers bitsandbytes accelerate datasets
```

Any GPU with 8 GB or more VRAM can handle 7B models with 4-bit quantization. For larger models, 24 GB VRAM (RTX 3090/4090 or A100) is recommended.

### CPU Fallback

No additional dependencies beyond the base Python environment. Training on CPU is slow and only practical for very small models or testing. Inference through llama.cpp works acceptably for interactive use.

### Cloud VPS

When local hardware is insufficient, OMLS can offload training to cloud GPU providers:

- **Together AI** -- Managed fine-tuning API. Upload trajectory data; receive an adapter.
- **Vast.ai** -- Spot GPU instances. OMLS handles provisioning and teardown.
- **RunPod** -- On-demand GPU pods with pre-built templates.

Cloud training is configured in `settings.json` under the `omls.cloud` key.

## Confidence Router

The confidence router decides whether the local/fine-tuned model can handle a request or whether to escalate to a more capable (and expensive) upstream model. It combines three signals:

### Task Classifier (~1 ms)

A lightweight classifier categorizes the incoming prompt by task type (code generation, summarization, Q&A, etc.) and estimates difficulty. This runs in under a millisecond and provides the first signal.

### Self-REF Token (Free)

The model's own confidence token, extracted from the logits of the first generated token. High-confidence generations correlate with correct outputs. This signal is free since it piggybacks on the generation pass.

### Semantic Entropy Gate (~50 ms)

The most expensive signal. The system generates N samples (default 3) at elevated temperature (0.8) and measures semantic entropy across the outputs. High entropy (diverse, contradictory answers) indicates uncertainty.

- **N**: 3 samples (configurable via `entropySamples`)
- **Temperature**: 0.8
- **Latency**: ~50 ms total

### Standing Gates

In addition to the three confidence signals, two standing gates trigger unconditional escalation:

- **`costAbove: 0.05`** -- If the accumulated cost of a run exceeds $0.05, escalate to a stronger model to avoid wasting budget on low-quality local completions.
- **`afterTurn: 8`** -- After 8 turns in a single run, escalate. Long-running loops often indicate the model is stuck.

### Default Configuration

```json
{
  "omls": {
    "confidenceThreshold": 0.40,
    "entropyThreshold": 0.70,
    "entropySamples": 3
  }
}
```

- **`confidenceThreshold`**: Minimum combined confidence score (0-1) to proceed with the local model.
- **`entropyThreshold`**: Maximum semantic entropy (0-1) allowed before escalating.
- **`entropySamples`**: Number of samples for the entropy gate.

## Prompt Strategies

OMLS selects a prompt strategy based on the task classifier output:

| Strategy | Description | Best For |
|---|---|---|
| `standard` | Direct prompt, no scaffolding | Simple lookups, short answers |
| `chain-of-thought` | Step-by-step reasoning prefix | Math, logic, multi-step reasoning |
| `plan-then-act` | Generate plan, then execute | Complex code generation, refactoring |
| `tool-heavy` | Emphasis on tool selection and chaining | File operations, API calls, multi-tool tasks |

The strategy is selected automatically but can be overridden per-skill or in the agent configuration.

## Training Pipeline

The full LoRA training pipeline proceeds through these stages:

1. **Trajectory Buffer** -- Completed agent runs are buffered with their tool calls, outputs, and outcomes.
2. **PRM Scoring** -- A Process Reward Model scores each trajectory step. Only trajectories above the quality threshold proceed.
3. **VPS GPU Provisioning** -- If local hardware is unavailable or insufficient, a cloud GPU instance is provisioned.
4. **GRPO/OPSD Training** -- Group Relative Policy Optimization (GRPO) or On-Policy Self-Distillation (OPSD) trains the adapter on scored trajectories.
5. **Adapter Upload** -- The trained adapter is uploaded to the configured provider (e.g., Together AI).
6. **Model Swap** -- The active model is swapped to use the new adapter via the provider's serving infrastructure.
7. **Notification** -- The user is notified that training completed and the new adapter is active.

### Idle Detector

Training is computationally expensive. The idle detector monitors system activity and schedules training during idle periods (no mouse/keyboard input, low CPU usage). This prevents training from interfering with interactive work. Use `--setup-cron` to configure a system cron job for scheduled training windows.

## Adapter Storage and Rollback

Trained adapters are stored at:

```
~/.orager/models/<memoryKey>/<model>/adapter.safetensors
```

Each training run produces a new versioned adapter. Previous versions are retained, enabling rollback if a new adapter degrades performance. The rollback mechanism compares PRM scores on a held-out validation set.

## Trajectory Retriever

The trajectory retriever provides in-context learning by fetching past successful trajectories and injecting them as few-shot exemplars into the prompt. When OMLS identifies a new task as similar to a previously completed one, it retrieves the highest-scoring trajectory for that task type and includes it in the prompt context. This provides immediate benefit even before any LoRA training occurs.

## Self-Reflection

After any agent run of 3 or more turns, the self-reflection module fires automatically. It:

- Uses the cheapest available model to analyze what went well and what could improve.
- Has a 150-token cap to keep costs negligible.
- Observes a 10-minute cooldown between reflections to avoid excessive overhead.
- Stores reflection outputs as candidate skill extractions.

## Contrastive Extraction

The most powerful skill extraction method. When OMLS has a fail-then-succeed pair for the same task (e.g., a retry that worked after an initial failure), it performs contrastive extraction:

1. Aligns the two trajectories step by step.
2. Identifies the divergence point where the successful run took a different action.
3. Extracts the decision difference as a high-quality skill with strong causal grounding.

Contrastive skills consistently outperform skills extracted from single successful trajectories.

## CLI Reference

```bash
# Train a LoRA adapter using reinforcement learning
orager skill-train --rl

# Force local training (no cloud offload)
orager skill-train --local

# Force cloud training (skip local hardware)
orager skill-train --no-local

# Check training status
orager skill-train --status

# Rollback to a previous adapter version
orager skill-train --rollback

# Set up a system cron job for idle-time training
orager skill-train --setup-cron
```

## Configuration Reference

All OMLS settings live under the `omls` key in `settings.json`:

```json
{
  "omls": {
    "mode": "auto",
    "confidenceThreshold": 0.40,
    "entropyThreshold": 0.70,
    "entropySamples": 3,
    "backend": "auto",
    "cloud": {
      "provider": "together",
      "apiKey": "..."
    },
    "training": {
      "algorithm": "grpo",
      "batchSize": 4,
      "epochs": 3,
      "idleOnly": true
    }
  }
}
```
