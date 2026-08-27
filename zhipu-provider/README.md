# zhipu-provider

[Zhipu (智谱AI / BigModel)](https://bigmodel.cn/) provider for pi — GLM models via the OpenAI-compatible API on the **general** (non-coding) endpoint, with runtime model discovery.

## Why this exists

pi ships two built-in Zhipu providers, both on the **coding** plan endpoint:

| Built-in | Endpoint |
|----------|----------|
| `zai` | `https://api.z.ai/api/coding/paas/v4` (international) |
| `zai-coding-cn` | `https://open.bigmodel.cn/api/coding/paas/v4` (China) |

This extension targets the **general** endpoint `https://open.bigmodel.cn/api/paas/v4`, which is what most users have access to via a standard BigModel API key (not enrolled in the coding plan). It also discovers the model list at runtime instead of shipping a static catalog.

Provider id: `zhipu` (distinct from the built-ins, so all three can coexist).

## Features

- **Runtime model discovery** — fetches the live model list from BigModel's `/v1/models` endpoint at startup. Verified 2026-08: the list/detail endpoints return only `id`/`object`/`created`/`owned_by`, so parameters come from **generation-matched heuristics** — glm-5.3 and future 5.x/6.x flagship releases are picked up automatically with correct specs, no per-model code changes.
- **Extra models** — merges in vision (`glm-5v-turbo`, `glm-4.6v*`) and free (`glm-4.7-flash`, `glm-4-flash-250414`) variants that the endpoint omits but that are usable on the general endpoint.
- **Discovery cache** — `~/.pi/agent/zhipu-models.cache.json`; a warm cache lets pi start instantly and refresh in the background.
- **Graceful fallback** — on endpoint failure, uses cache, then a static snapshot.
- **Discovery toggle** — `ZHIPU_DISCOVERY=off` skips all network calls.
- **Provider config** — `~/.pi/agent/zhipu-config.json` to override `baseUrl` and include/exclude models by regex.

## Models

The list is discovered at runtime. The endpoint returns the base text models; this extension additionally surfaces vision and free variants:

| Model | Context | Max Output | Image | Reasoning | Notes |
|-------|---------|------------|-------|-----------|-------|
| `glm-5.3` | 1M | 128K | ✗ | ✓ | flagship; multi-level effort (verified) |
| `glm-5.3-flash` | 1M | 128K | ✓ | ✓ | multimodal flash; always thinks (verified) |
| `glm-5.2` | 1M | 128K | ✗ | ✓ | flagship; multi-level effort (verified) |
| `glm-5.1` | 200K | 128K | ✗ | ✓ | |
| `glm-5` | 200K | 128K | ✗ | ✓ | |
| `glm-5-turbo` | 200K | 128K | ✗ | ✓ | |
| `glm-5v-turbo` | 200K | 128K | ✓ | ✓ | vision (extra) |
| `glm-4.7` | 200K | 128K | ✗ | ✓ | |
| `glm-4.7-flash` | 200K | 128K | ✗ | ✓ | free (extra) |
| `glm-4.7-flashx` | 200K | 128K | ✗ | ✗ | lightweight (extra) |
| `glm-4.6` | 200K | 128K | ✗ | ✓ | |
| `glm-4.6v` | 128K | 32K | ✓ | ✓ | vision (extra) |
| `glm-4.6v-flash` | 128K | 32K | ✓ | ✓ | free (extra) |
| `glm-4.5-air` | 128K | 96K | ✗ | ✗ | cost-efficient |
| `glm-4-flash-250414` | 128K | 16K | ✗ | ✗ | free (extra) |

> **Verified specs (2026-08)**: `glm-5.2` and `glm-5.3` are both 1M ctx with
> official pricing ¥8 in / ¥28 out / ¥2 cache-hit per million tokens (cache
> store currently free). The provider does not encode CNY pricing into the
> model cost (consistent with dashscope/kimi), so cost displays as 0.
> Context/max values are heuristics verified against the official pricing page.

## Setup

Get an API key at the [BigModel console](https://bigmodel.cn/usercenter/proj-mgmt/apikeys).

### Option A: `/login` command (recommended)

```
/login → "Use an API key" → zhipu → paste key
```

### Option B: Environment variable

```bash
export ZHIPU_API_KEY="..."
```

> **Precedence (mirrors pi's own resolution)**: a `/login`-stored credential in
> `~/.pi/agent/auth.json` wins over `ZHIPU_API_KEY` for both requests and model
> discovery; the env var is the fallback. The provider never writes to
> `process.env`, so a stale exported key can't shadow a refreshed auth.json.
> Backward compat: if neither exists, the legacy `zai_china` auth entry is
> used, so users upgrading from the old `zai-china` extension keep working.

## Usage

```bash
/model zhipu/glm-5.3
```

## Discovery

Same pipeline as `dashscope-provider`: cache-first startup (warm cache registers instantly, refreshes in background), cold start fetches synchronously (8s timeout), failure falls back to cache then static snapshot.

### Toggling discovery

```bash
export ZHIPU_DISCOVERY=off   # use cache/fallback only
```

### Model filter

`~/.pi/agent/zhipu-filter.json`:

```json
{
  "include": ["^glm-5"],
  "exclude": ["-preview$"]
}
```

- `include` — regex sources; an id is kept when **any** matches. Empty/omitted = keep all.
- `exclude` — regex sources; an id is dropped when **any** matches. Empty/omitted = drop none.

The filter applies to both discovered and extra models.

## Compat

Mirrors pi's built-in `zai` provider so request shaping is identical:

```typescript
{
  supportsStore: false,
  supportsDeveloperRole: false,        // uses "system" role
  supportsReasoningEffort: true,       // flagship glm-5.2+ / glm-6+ only
  thinkingFormat: "zai",               // thinking: { type: "enabled"|"disabled" }
  zaiToolStream: true,                 // tool_stream: true (thinking models only)
}
```

## Install

```bash
pi install https://github.com/Traveler0014/pi-providers.git
```

## License

MIT
