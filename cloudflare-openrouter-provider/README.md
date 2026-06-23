# cloudflare-openrouter-provider

[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) provider for pi — access [OpenRouter](https://openrouter.ai) models via Cloudflare AI Gateway's OpenAI passthrough.

## Models

| Model | Context | Max Output | Image | Reasoning |
|-------|---------|------------|-------|-----------|
| `anthropic/claude-opus-4.6` | 200K | 64K | ✓ | ✓ |
| `openai/gpt-5.5` | 128K | 16K | ✓ | ✗ |
| `google/gemini-3.1-pro` | 128K | 16K | ✓ | ✓ |
| `google/gemini-3.5-flash` | 128K | 16K | ✓ | ✓ |
| `moonshotai/kimi-k2.5` | 128K | 16K | ✓ | ✗ |
| `moonshotai/kimi-k2.6` | 128K | 16K | ✓ | ✗ |
| `moonshotai/kimi-k2.7-code` | 128K | 16K | ✓ | ✓ |
| `minimax/minimax-m2.7` | 128K | 16K | ✗ | ✗ |
| `minimax/minimax-m3` | 128K | 16K | ✗ | ✗ |
| `qwen/qwen3.7-plus` | 1M | 64K | ✓ | ✓ |
| `qwen/qwen3.7-max` | 1M | 64K | ✗ | ✓ |
| `z-ai/glm-5.1` | 200K | 64K | ✗ | ✓ |
| `z-ai/glm-5.2` | 1M | 1M | ✗ | ✓ |

> Model parameters are placeholders. Update after configuring Cloudflare AI Gateway access.

## Prerequisites

1. **Cloudflare account** with AI Gateway enabled
2. **AI Gateway** created at [dash.cloudflare.com](https://dash.cloudflare.com) → AI → AI Gateway
3. **OpenRouter upstream** configured in the gateway:
   - **Stored BYOK** (recommended): Store your OpenRouter API key in the AI Gateway dashboard
   - **Unified Billing**: Cloudflare account is billed directly (no upstream key needed)

## Setup

### Environment Variables (required)

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"    # dashboard overview page
export CLOUDFLARE_GATEWAY_ID="your-gateway-slug"  # AI → AI Gateway
```

### API Key Configuration

Use `/login` to store your Cloudflare API token:

```
/login → "Use an API key" → Cloudflare AI Gateway (OpenRouter) → paste token
```

Key is stored in `~/.pi/agent/auth.json`.

## Usage

```bash
# Select a model
/model cloudflare-openrouter/anthropic/claude-opus-4.6

# Or specify via CLI
pi --provider cloudflare-openrouter --model "anthropic/claude-opus-4.6"
```

## Auth Details

- **Gateway auth:** `Authorization: Bearer <cloudflare-api-token>` (standard Bearer auth)
- **Base URL:** `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openrouter/v1`
- **API format:** OpenAI Chat Completions compatible (OpenRouter passthrough)
- **Thinking:** OpenRouter-style `reasoning: { effort }` for reasoning models

## Adding More Models

The extension includes a curated set of models. To add more OpenRouter models, create a `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "cloudflare-openrouter": {
      "models": [
        {
          "id": "mistral/mistral-large-2",
          "name": "Mistral Large 2",
          "api": "openai-completions",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

## Install

```bash
# Via pi (recommended)
pi install git@github.com:Traveler0014/pi-providers.git

# One-click script
curl -fsSL https://github.com/Traveler0014/pi-providers.git/raw/master/install.sh | bash

# Manual
cp index.ts ~/.pi/agent/extensions/cloudflare-openrouter-provider.ts
```

## License

MIT
