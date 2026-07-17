# kimi-provider

[Kimi (Moonshot AI / 月之暗面)](https://platform.kimi.com/) provider for pi — Kimi K3 / K2.7 Code / K2.6 models via the OpenAI-compatible API, with runtime model discovery.

## Why this exists

pi ships built-in Kimi providers — `moonshotai` (intl), `moonshotai-cn` (China), and `kimi-coding` (Anthropic-style coding plan) — but all three ship a **static** model catalog that only updates when pi itself is upgraded. This extension registers a `kimi` provider (distinct id, so all four coexist) that **discovers the model list at runtime** from Kimi's `/v1/models` endpoint, so new releases (e.g. `kimi-k4`) appear without waiting on a pi upgrade.

Provider id: `kimi` (distinct from the built-ins).

## Features

- **Runtime model discovery** — fetches the live model list from Kimi's `/v1/models` at startup. Kimi's endpoint is richer than most OpenAI-compatible APIs: it returns `context_length`, `supports_image_in`, `supports_video_in`, and `supports_reasoning` per model, so context window and input modalities come straight from the API.
- **Discovery cache** — `~/.pi/agent/kimi-models.cache.json`; a warm cache lets pi start instantly and refresh in the background.
- **Graceful fallback** — on endpoint failure, uses cache, then a static snapshot.
- **Discovery toggle** — `KIMI_DISCOVERY=off` skips all network calls.
- **Provider config** — `~/.pi/agent/kimi-config.json` to override `baseUrl` and include/exclude models by regex.
- **Compat parity** — mirrors pi's built-in `moonshotai-cn` (`thinkingFormat: "deepseek"`, K3 deferred-tools quirk, K2.7-Code always-on thinking).

## Models

The list is discovered at runtime. Current Kimi lineup:

| Model | Context | Max Output | Image | Reasoning | Notes |
|-------|---------|------------|-------|-----------|-------|
| `kimi-k3` | 1M | 128K | ✓ | ✓ | flagship; `reasoning_effort: "max"` only; always reasons |
| `kimi-k2.7-code` | 256K | 256K | ✓ | ✓ | coding model; thinking always on (can't disable) |
| `kimi-k2.7-code-highspeed` | 256K | 256K | ✓ | ✓ | faster output, pricier |
| `kimi-k2.6` | 256K | 256K | ✓ | ✓ | thinking on/off |
| `kimi-k2.5` | 256K | 256K | ✓ | ✓ | being phased out (offline Aug 31) |
| `moonshot-v1-8k` | 8K | 8K | ✗ | ✗ | legacy generation (offline Aug 31) |
| `moonshot-v1-32k` | 32K | 32K | ✗ | ✗ | legacy generation |
| `moonshot-v1-128k` | 128K | 128K | ✗ | ✗ | legacy generation |
| `moonshot-v1-*-vision-preview` | 8K/32K/128K | — | ✓ | ✗ | legacy vision |

Max output tokens, pricing, and thinking-level constraints come from static profiles (the endpoint doesn't expose them); everything else comes from the live API.

## Setup

Get an API key at the [Kimi console](https://platform.kimi.com/console/api-keys).

### Option A: `/login` command (recommended)

```
/login → "Use an API key" → kimi → paste key
```

### Option B: Environment variable

```bash
export KIMI_API_KEY="..."
# or reuse the built-in moonshotai key:
export MOONSHOT_API_KEY="..."
```

> Backward compat: if `KIMI_API_KEY` is unset, the provider falls back to `MOONSHOT_API_KEY`, then to the legacy `moonshotai-cn` / `moonshotai` auth entries, so users upgrading from the built-in providers keep working.

## Usage

```bash
/model kimi/kimi-k3
/model kimi/kimi-k2.7-code
```

## Discovery

Same pipeline as `dashscope-provider` / `zhipu-provider`: cache-first startup (warm cache registers instantly, refreshes in background), cold start fetches synchronously (8s timeout), failure falls back to cache then static snapshot.

### Toggling discovery

```bash
export KIMI_DISCOVERY=off   # use cache/fallback only
```

### Model filter & endpoint override

`~/.pi/agent/kimi-config.json`:

```json
{
  "baseUrl": "https://api.moonshot.cn/v1",
  "include": ["^kimi-k"],
  "exclude": ["-preview$"]
}
```

- `baseUrl` — override the API endpoint. `KIMI_BASE_URL` env var takes precedence (quick proxy swaps).
- `include` — regex sources; an id is kept when **any** matches. Empty/omitted = keep all.
- `exclude` — regex sources; an id is dropped when **any** matches. Empty/omitted = drop none.

## Compat

Mirrors pi's built-in `moonshotai-cn` provider so request shaping is identical:

```typescript
{
  supportsStore: false,
  supportsDeveloperRole: false,   // uses "system" role
  supportsReasoningEffort: false, // reasoning_effort only sent when true (K3 leaves it to the API default)
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  thinkingFormat: "deepseek",     // thinking: { type: "enabled"|"disabled" } (K2.x)
}
// kimi-k3 additionally:
{
  requiresReasoningContentOnAssistantMessages: true,
  deferredToolsMode: "kimi",
}
```

Thinking levels (`thinkingLevelMap`):

| Model | off | minimal..xhigh | max |
|-------|-----|----------------|-----|
| `kimi-k3` | ✗ (always reasons) | ✗ | ✓ `"max"` |
| `kimi-k2.7-code` / `-highspeed` | ✗ (always reasons) | — | — |
| `kimi-k2.6` / `k2.5` | ✓ (default off) | — | — |

## Install

```bash
pi install https://github.com/Traveler0014/pi-providers.git
```

## License

MIT
