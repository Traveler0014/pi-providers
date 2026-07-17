# dashscope-provider

[DashScope (阿里云百炼)](https://bailian.console.aliyun.com/) provider for pi — access Qwen3.7 models via the OpenAI-compatible API.

## Features

- **Runtime model discovery** — fetches the live model list from DashScope's
  `/v1/models` endpoint at startup, so new `qwen3.7-*` variants (including
  dated snapshots like `qwen3.7-max-2026-xx`) appear automatically without a
  code change.
- **Discovery cache** — discovered models are cached to
  `~/.pi/agent/dashscope-models.cache.json` (project-level override at
  `.pi/dashscope-models.cache.json`). A warm cache lets pi start instantly and
  refresh in the background, instead of blocking startup on the network.
- **Graceful fallback** — if the endpoint is unreachable, the provider falls
  back to the cached list, then to a static snapshot, so pi never fails to
  start because of a flaky endpoint.
- **Discovery toggle** — set `DASHSCOPE_DISCOVERY=off` to skip network calls
  entirely and rely on cache/fallback (useful when startup latency matters).

## Models

The model list is discovered at runtime. The static fallback (used only when
 discovery is off and no cache exists) includes:

| Model | Context | Max Output | Image | Pricing (CNY/1M) |
|-------|---------|------------|-------|------------------|
| `qwen3.7-max` | 991K | 64K | ✗ | ¥12 / ¥36 |
| `qwen3.7-plus` | 991K | 64K | ✓ | ¥2 / ¥8 |

All listed models support reasoning (thinking mode). Live discovery may
 surface additional dated/preview variants.

## Discovery

### How it works

At startup the provider:

1. Reads the cache (project-level `.pi/` overrides user-level `~/.pi/agent/`).
   If present, registers those models immediately (no network wait).
2. If discovery is on (default):
   - **Cache hit** → refreshes in the background; on success re-registers with
     the live list and updates the cache. On failure, keeps the cache.
   - **Cache miss** → fetches synchronously (bounded to 8s); on success
     registers + caches, on failure registers the static fallback.
3. If discovery is off: uses cache if present, else the static fallback.

### Toggling discovery

```bash
# Disable discovery (use cache/fallback only)
export DASHSCOPE_DISCOVERY=off
```

Accepted values: `off`, `0`, `false` disable it; anything else (including
unset) leaves it on.

### Provider config

Override the endpoint and/or model filter via a user-level config file at
`~/.pi/agent/dashscope-config.json`:

```json
{
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "include": ["^qwen3\\.7-"],
  "exclude": ["-preview$"]
}
```

- **`baseUrl`** — override the API endpoint. Useful for long-term moves
  (e.g. an Alibaba Cloud workspace-id private endpoint).
- **`include`** — regex sources; an id is kept when **any** matches. Empty or
  omitted = keep all.
- **`exclude`** — regex sources; an id is dropped when **any** matches. Empty
  or omitted = drop none.

`baseUrl` precedence: `DASHSCOPE_BASE_URL` env var > config file `baseUrl` >
built-in default. Use the env var for quick temporary swaps (e.g. routing
through a proxy) and the config file for long-term moves.

A malformed config file logs a warning and falls back to defaults, so pi still
starts. Note: broadening the filter (e.g. `^qwen3`) may surface models whose
context/pricing heuristics are tuned for `qwen3.7-*` only — they still work
but with conservative fallback parameters.

### Cache files

| Path | Scope | Read/Write |
|------|-------|------------|
| `~/.pi/agent/dashscope-models.cache.json` | user (global) | read + write |
| `<project>/.pi/dashscope-models.cache.json` | project (override) | read only |

To pin a specific model set for a project, drop a cache file at the project
path; it takes precedence and is never overwritten by background refresh.

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
pi install https://github.com/Traveler0014/pi-providers.git

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
