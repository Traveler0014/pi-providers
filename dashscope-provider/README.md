# DashScope Provider for pi

Access [DashScope (阿里云百炼)](https://bailian.console.aliyun.com/) models — including Qwen3, Qwen2.5, and DeepSeek — in pi via the OpenAI-compatible API.

## Quick Start

### Option A: `/login` command (recommended)

No environment variable needed. Start pi and run:

```
/login
```

1. Select **"Use an API key"**
2. Find and select **dashscope** (or type to filter)
3. Paste your API key (starts with `sk-`)

The key is stored in `~/.pi/agent/auth.json` and persists across sessions.

### Option B: Environment variable

```bash
export DASHSCOPE_API_KEY="sk-..."
```

### 3A. Install as a local extension

Copy to pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/dashscope-provider.ts
```

Then start pi and select a model:

```
/model dashscope/qwen3-max
```

### 3B. Install as a pi package (npm/git)

```bash
# From local path
pi install /path/to/dashscope-provider

# Or publish to npm first, then:
# pi install npm:dashscope-provider
```

### 3C. Quick test

```bash
pi -e /path/to/dashscope-provider/index.ts
```

## Authentication Priority

1. **`/login` → API key** credentials (saved in `~/.pi/agent/auth.json`) — highest priority
2. **`DASHSCOPE_API_KEY`** environment variable — fallback when not configured via /login

## Available Models

| Model ID | Description | Thinking |
|----------|-------------|----------|
| `qwen3.7-max` | Flagship, best overall quality | Yes |
| `qwen3.7-plus` | Balanced performance and cost | Yes |

To add more DashScope models, edit the `MODELS` array in `index.ts`.

## API Compatibility

This provider uses DashScope's [OpenAI-compatible API](https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope) endpoint:

- **Base URL:** `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **API format:** `openai-completions` (OpenAI Chat Completions)
- **Auth:** `Authorization: Bearer <key>`
- **Thinking:** Top-level `enable_thinking` parameter

## Pricing

> ⚠️ Pricing below is approximate (USD per million tokens). Check [official pricing](https://bailian.console.aliyun.com/) for current rates.

| Model | Input | Output |
|-------|-------|--------|
| qwen3-max | $2.75 | $11.00 |
| qwen3-plus | $0.55 | $2.20 |
| qwen3-235b-a22b | $0.55 | $2.19 |
| qwen2.5-72b | $0.55 | $2.20 |
| qwen2.5-7b | $0.14 | $0.55 |
| qwen-turbo | $0.04 | $0.17 |

## Troubleshooting

### "Invalid API key" / 401
- If using `/login`: run `/login` again → "Use an API key" → dashscope to update
- If using env var: verify `DASHSCOPE_API_KEY` is set correctly
- Check the key is active in [DashScope Console](https://bailian.console.aliyun.com/)

### "Model not found" / 404
- Ensure the model ID matches exactly (case-sensitive)
- Some models may require separate activation in the DashScope console

### Thinking not working
- Only models marked with "Yes" in the thinking column support it
- Use `/thinking` to toggle thinking on/off for supported models
