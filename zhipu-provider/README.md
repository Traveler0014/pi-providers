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

- **Runtime model discovery** — fetches the live model list from BigModel's `/v1/models` endpoint at startup.
- **Extra models** — merges in vision (`glm-5v-turbo`, `glm-4.6v*`) and free (`glm-4.7-flash`, `glm-4-flash-250414`) variants that the endpoint omits but that are usable on the general endpoint.
- **Discovery cache** — `~/.pi/agent/zhipu-models.cache.json`; a warm cache lets pi start instantly and refresh in the background.
- **Graceful fallback** — on endpoint failure, uses cache, then a static snapshot.
- **Discovery toggle** — `ZHIPU_DISCOVERY=off` skips all network calls.
- **Provider config** — `~/.pi/agent/zhipu-config.json` to override `baseUrl` and include/exclude models by regex.

## Models

The list is discovered at runtime. The endpoint returns ~8 base text models; this extension additionally surfaces vision and free variants:

| Model | Context | Max Output | Image | Reasoning | Notes |
|-------|---------|------------|-------|-----------|-------|
| `glm-5.2` | 1M | 128K | ✗ | ✓ | flagship; multi-level effort |
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

> Backward compat: if `ZHIPU_API_KEY` is unset and no `zhipu` auth entry exists, the provider falls back to the legacy `zai_china` auth entry, so users upgrading from the old `zai-china` extension keep working.

## Usage

```bash
/model zhipu/glm-5.2
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
  supportsDeveloperRole: false,   // uses "system" role
  supportsReasoningEffort: false, // true only for glm-5.2
  thinkingFormat: "zai",          // thinking: { type: "enabled"|"disabled" }
  zaiToolStream: true,            // tool_stream: true (thinking models only)
}
```

## Install

```bash
pi install https://github.com/Traveler0014/pi-providers.git
```

## License

MIT
