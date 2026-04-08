# Installation

## Prerequisites

- **Node.js** >= 20.3.0 or **Bun** >= 1.3
- A provider API key ([OpenRouter](https://openrouter.ai), [Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com), or [Ollama](https://ollama.com) for local models)

## Package Manager

### Global CLI

```bash
# npm
npm install -g @orager/core

# bun
bun add -g @orager/core

# Run without installing
npx @orager/core run "Hello, world!"
```

### Library Dependency

```bash
# npm
npm install @orager/core

# bun
bun add @orager/core
```

## Standalone Binaries

Pre-built binaries require no Node.js or Bun installation:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/JayCodesX/orager/releases/latest/download/orager-darwin-arm64 \
  -o /usr/local/bin/orager && chmod +x /usr/local/bin/orager

# macOS (Intel)
curl -L https://github.com/JayCodesX/orager/releases/latest/download/orager-darwin-x64 \
  -o /usr/local/bin/orager && chmod +x /usr/local/bin/orager

# Linux (x64)
curl -L https://github.com/JayCodesX/orager/releases/latest/download/orager-linux-x64 \
  -o /usr/local/bin/orager && chmod +x /usr/local/bin/orager
```

## From Source

```bash
git clone https://github.com/JayCodesX/orager
cd orager && bun install
bun run build
```

## Setup

Set your API key and run the setup wizard:

```bash
export PROTOCOL_API_KEY=your_openrouter_api_key

orager setup            # interactive wizard
orager setup --check    # validate config and test API key
```

The wizard creates `~/.orager/settings.json` with sensible defaults.

### Provider-Specific Keys

For direct provider access (bypassing OpenRouter), set the relevant key:

| Provider | Environment Variable |
|----------|---------------------|
| OpenRouter | `PROTOCOL_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Ollama | No key needed (local) |

See [Provider Routing](/guide/provider-routing) for details on how orager selects providers.

### License Activation (Optional)

The core runtime works without a license key. If you have a **Pro** or **Cloud** license, activate it to unlock OMLS training, prompt tournaments, and other advanced features:

```bash
# Via CLI
orager license activate <your-license-key>

# Or via environment variable
export ORAGER_LICENSE_KEY="<your-license-key>"
```

See [Licensing & Tiers](/guide/licensing) for details on what each tier includes.
