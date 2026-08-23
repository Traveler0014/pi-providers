# cloudflare-openrouter-provider

[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) provider for pi — access [OpenRouter](https://openrouter.ai) models via Cloudflare AI Gateway's OpenAI passthrough, with runtime model discovery.

## Features

- **Runtime model discovery** — fetches the live model list from OpenRouter's
  `/v1/models` endpoint (through the gateway) at startup, so new flagship
  releases from Anthropic / OpenAI / Google / Moonshot / MiniMax / Qwen / Z.ai
  appear automatically without a code change. OpenRouter's response is richer
  than DashScope's — `context_length`, per-token `pricing`,
  `architecture.input_modalities` and `supported_parameters` are read directly,
  so discovered models carry accurate context windows, pricing and modality.
- **Discovery cache** — discovered models are cached to
  `~/.pi/agent/cloudflare-openrouter-models.cache.json` (project-level override
  at `.pi/cloudflare-openrouter-models.cache.json`). A warm cache lets pi start
  instantly and refresh in the background, instead of blocking startup on the
  network.
- **Graceful fallback** — if the endpoint is unreachable, the provider falls
  back to the cached list, then to a static snapshot, so pi never fails to
  start because of a flaky endpoint.
- **Discovery toggle** — set `CLOUDFLARE_DISCOVERY=off` to skip network calls
  entirely and rely on cache/fallback (useful when startup latency matters).

## Models

The model list is discovered at runtime. The default filter keeps
current-and-future flagship generations from the supported vendors:

| Vendor | Families (default include) |
|--------|----------------------------|
| Anthropic | `claude-(opus\|sonnet)-[4-9]` |
| OpenAI | `gpt-[5-9]`, `o[3-9]` |
| Google | `gemini-[3-9]` |
| Moonshot | `kimi-k[2-9]` |
| MiniMax | `minimax-m[2-9]` |
| Qwen | `qwen3` |
| Z.ai | `glm-[5-9]` |

OpenRouter routing variants (`:free`, `:nitro`) are excluded by default. The
static fallback (used only when discovery is off and no cache exists) includes
a curated snapshot of the same families.

## Discovery

### How it works

At startup the provider:

1. Reads the cache (project-level `.pi/` overrides user-level `~/.pi/agent/`).
   If present, registers those models immediately (no network wait).
2. If discovery is on (default):
   - **Cache hit** → refreshes in the background; on success updates the cache
     (the current session keeps the cached list; the next startup picks up the
     fresh list). On failure, keeps the cache.
   - **Cache miss** → fetches synchronously (bounded to 10s); on success
     registers + caches, on failure registers the static fallback.
3. If discovery is off: uses cache if present, else the static fallback.

### Toggling discovery

```bash
# Disable discovery (use cache/fallback only)
export CLOUDFLARE_DISCOVERY=off
```

Accepted values: `off`, `0`, `false` disable it; anything else (including
unset) leaves it on.

### Provider config

Override the endpoint and/or model filter via a user-level config file at
`~/.pi/agent/cloudflare-openrouter-config.json`:

```json
{
  "baseUrl": "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openrouter/v1",
  "include": ["^anthropic/claude-opus", "^openai/gpt-5"],
  "exclude": [":free$", ":nitro$", "-preview$"]
}
```

- **`baseUrl`** — override the API endpoint. Useful when you want to hard-code
  the gateway URL instead of composing it from env vars.
- **`include`** — regex sources; an id is kept when **any** matches. Empty or
  omitted = keep all.
- **`exclude`** — regex sources; an id is dropped when **any** matches. Empty
  or omitted = drop none.

`baseUrl` precedence: `CLOUDFLARE_BASE_URL` env var > config file `baseUrl` >
default composed from `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID`. Use
the env var for quick temporary swaps and the config file for long-term moves.

A malformed config file falls back to defaults, so pi still starts.

### Cache files

| Path | Scope | Read/Write |
|------|-------|------------|
| `~/.pi/agent/cloudflare-openrouter-models.cache.json` | user (global) | read + write |
| `<project>/.pi/cloudflare-openrouter-models.cache.json` | project (override) | read only |

To pin a specific model set for a project, drop a cache file at the project
path; it takes precedence and is never overwritten by background refresh.

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

## Compat Settings

```typescript
{
  supportsDeveloperRole: true,              // OpenAI-style developer role
  maxTokensField: "max_completion_tokens",  // OpenRouter accepts max_completion_tokens
  thinkingFormat: "openrouter",             // reasoning: { effort: "high" }
}
```

## Install

```bash
# Via pi (recommended)
pi install https://github.com/Traveler0014/pi-providers.git

# Manual
cp index.ts ~/.pi/agent/extensions/cloudflare-openrouter-provider.ts
```

## License

MIT
