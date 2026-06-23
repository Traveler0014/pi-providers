# dashscope-provider

[DashScope (阿里云百炼)](https://bailian.console.aliyun.com/) provider for pi — access Qwen3.7 models via the OpenAI-compatible API.

## Models

| Model | Context | Max Output | Image | Pricing (CNY/1M) |
|-------|---------|------------|-------|------------------|
| `qwen3.7-max` | 991K | 64K | ✗ | ¥12 / ¥36 |
| `qwen3.7-plus` | 991K | 64K | ✓ | ¥2 / ¥8 |

Both models support reasoning (thinking mode).

## Setup

Get an API key from [DashScope Console](https://bailian.console.aliyun.com/?tab=api).

### Option A: `/login` command (recommended)

```
/login → "Use an API key" → dashscope → paste sk-...
```

Key is stored in `~/.pi/agent/auth.json` and persists across sessions.

### Option B: Environment variable

```bash
export DASHSCOPE_API_KEY="sk-..."
```

## Usage

```bash
/model dashscope/qwen3.7-max
```

## Install

```bash
# Via pi (recommended)
pi install git@github.com:Traveler0014/pi-providers.git

# One-click script
curl -fsSL https://github.com/Traveler0014/pi-providers.git/raw/master/install.sh | bash

# Manual
cp index.ts ~/.pi/agent/extensions/dashscope-provider.ts
```

## API Details

- **Base URL:** `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **API format:** OpenAI Chat Completions compatible
- **Auth:** `Authorization: Bearer <key>`
- **Thinking:** DashScope `enable_thinking` top-level parameter (`thinkingFormat: "qwen"`)

## Compat Settings

```typescript
{
  supportsDeveloperRole: false,   // Qwen uses "system" role
  requiresToolResultName: true,   // Qwen requires name in tool results
  maxTokensField: "max_tokens",   // DashScope accepts max_tokens
  thinkingFormat: "qwen",         // enable_thinking: true/false
}
```

## License

MIT
