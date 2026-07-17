import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kimi (Moonshot AI / 月之暗面) Provider Extension — runtime model discovery
 * on the OpenAI-compatible endpoint.
 *
 * ## Why this exists
 *
 * pi ships built-in Kimi providers:
 *   - `moonshotai`     → https://api.moonshot.ai/v1   (international)
 *   - `moonshotai-cn`  → https://api.moonshot.cn/v1   (China)
 *   - `kimi-coding`    → https://api.kimi.com/coding  (Anthropic-style coding plan)
 *
 * All three ship a **static** model catalog that only updates when pi itself is
 * upgraded. This extension registers a `kimi` provider (distinct id, so all
 * four coexist) that **discovers the model list at runtime** from
 * `https://api.moonshot.cn/v1/models`. New Kimi releases (e.g. `kimi-k4`)
 * then appear without waiting on a pi upgrade.
 *
 * Kimi's `/v1/models` is richer than most OpenAI-compatible endpoints: it
 * returns `context_length`, `supports_image_in`, `supports_video_in`, and
 * `supports_reasoning` per model, so context window and input modalities come
 * straight from the API. Only max output tokens, pricing, and a few model
 * quirks (K3's `reasoning_effort`/deferred-tools behavior, K2.7-Code's
 * always-on thinking) need static profiles below.
 *
 * Provider id: `kimi`.
 *
 * ## Discovery control
 *
 *   export KIMI_DISCOVERY=off   # skip network, use cache/fallback
 *
 * ## Provider config
 *
 * Override the endpoint and/or model filter via `~/.pi/agent/kimi-config.json`:
 *
 *   {
 *     "baseUrl": "https://...",         // override the API endpoint
 *     "include": ["^kimi-k"],           // regex sources; any match keeps an id
 *     "exclude": ["-preview$"]          // regex sources; any match drops an id
 *   }
 *
 * `baseUrl` precedence: `KIMI_BASE_URL` env var > config file `baseUrl` >
 * built-in default. Use the env var for quick temporary swaps (e.g. proxy)
 * and the config file for long-term moves.
 *
 * `include`/`exclude` default to empty (keep all). The filter applies to
 * discovered models. A malformed config file logs a warning and falls back to
 * defaults.
 *
 * ## Compat
 *
 * Mirrors pi's built-in `moonshotai-cn` provider so request shaping is
 * identical:
 * - `thinkingFormat: "deepseek"` → pi sends `thinking: { type: "enabled" }`
 *   when reasoning is on, `{ type: "disabled" }` when off (K2.x semantics).
 * - `supportsDeveloperRole: false` → uses `system`, not `developer`.
 * - `maxTokensField: "max_tokens"`.
 * - K3 additionally sets `requiresReasoningContentOnAssistantMessages: true`
 *   and `deferredToolsMode: "kimi"` (matches built-in).
 * - `thinkingLevelMap` pins which pi thinking levels each model supports:
 *   K3 → only `max` (always reasons, can't disable); K2.7-Code → always on
 *   (`off: null`); K2.6/K2.5 → on/off via the deepseek default.
 *
 * ## Setup
 *
 * 1. Get an API key at https://platform.kimi.com/console/api-keys
 * 2. /login → "Use an API key" → kimi
 *    (or: export KIMI_API_KEY="..."  /  export MOONSHOT_API_KEY="...")
 *
 * ## Usage
 *
 *   pi
 *   /model kimi/kimi-k3
 */

const DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";
const API_KEY_REF = "$KIMI_API_KEY";
const DISCOVERY_TIMEOUT_MS = 8000;
const CACHE_FILENAME = "kimi-models.cache.json";
const CONFIG_FILENAME = "kimi-config.json";

// Default filter: keep all. Kimi's /v1/models already returns a curated list;
// deprecated models (kimi-k2-*preview, kimi-latest, kimi-thinking-preview) are
// offline and won't appear, so no prefix filtering is needed by default.
const DEFAULT_INCLUDE: string[] = [];
const DEFAULT_EXCLUDE: string[] = [];

// ── Discovery control ────────────────────────────────────────────────────────

function discoveryEnabled(): boolean {
  const v = (process.env.KIMI_DISCOVERY ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

// ── Provider config (user-configurable) ─────────────────────────────────────

interface ProviderConfigFile {
  /** Override the API endpoint. Takes precedence over the default but is itself
   * overridden by the KIMI_BASE_URL env var (for quick proxy swaps). */
  baseUrl?: string;
  /** Regex source strings; an id is kept when any matches. Empty/omitted = keep all. */
  include?: string[];
  /** Regex source strings; an id is dropped when any matches. Empty/omitted = drop none. */
  exclude?: string[];
}

interface ResolvedConfig {
  baseUrl: string;
  include: RegExp[];
  exclude: RegExp[];
}

/**
 * Resolve provider config with precedence:
 *   1. KIMI_BASE_URL env var (quick temporary override, e.g. proxy)
 *   2. ~/.pi/agent/kimi-config.json `baseUrl` (long-term override)
 *   3. DEFAULT_BASE_URL
 *
 * `include`/`exclude` come from the config file only; absent/invalid file
 * falls back to defaults so pi still starts.
 */
function loadConfig(): ResolvedConfig {
  let file: ProviderConfigFile = {};
  let fileWarn: string | undefined;
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", CONFIG_FILENAME), "utf8");
    file = JSON.parse(raw) as ProviderConfigFile;
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT")) {
      fileWarn = e instanceof Error ? e.message : String(e);
    }
  }
  if (fileWarn) {
    // stderr so we don't corrupt pi's TUI (which renders on stdout).
    process.stderr.write(`[kimi] malformed ${CONFIG_FILENAME}, using defaults: ${fileWarn}\n`);
  }
  const baseUrl = process.env.KIMI_BASE_URL || file.baseUrl || DEFAULT_BASE_URL;
  const inc = Array.isArray(file.include) ? file.include : DEFAULT_INCLUDE;
  const exc = Array.isArray(file.exclude) ? file.exclude : DEFAULT_EXCLUDE;
  return {
    baseUrl,
    include: inc.map((s) => new RegExp(s)),
    exclude: exc.map((s) => new RegExp(s)),
  };
}

function applyFilter(ids: string[], filter: { include: RegExp[]; exclude: RegExp[] }): string[] {
  return ids.filter((id) => {
    const included = filter.include.length === 0 || filter.include.some((re) => re.test(id));
    const excluded = filter.exclude.length > 0 && filter.exclude.some((re) => re.test(id));
    return included && !excluded;
  });
}

// ── Static per-model profiles (quirks the endpoint does not expose) ──────────

type InputType = "text" | "image";

/** pi thinking levels: off | minimal | low | medium | high | xhigh | max.
 * A level maps to a provider value, or `null` to mark it unsupported. */
type ThinkingLevelMap = Partial<Record<string, string | null>>;

interface ModelProfile {
  /** Override display name. */
  name?: string;
  /** Override input types; otherwise derived from the endpoint's supports_image_in. */
  input?: InputType[];
  /** Override reasoning flag (endpoint usually provides this). */
  reasoning?: boolean;
  /** Override context window (endpoint usually provides this). */
  contextWindow?: number;
  /** Override max output tokens. Endpoint does not expose this. */
  maxTokens?: number;
  /** Per-million-token cost (USD). Endpoint does not expose pricing. */
  cost?: { input: number; output: number; cacheRead: number };
  /** Thinking-level map. */
  thinkingLevelMap?: ThinkingLevelMap;
  /** Extra compat merged onto the computed base. */
  compat?: Record<string, unknown>;
}

/**
 * Per-model overrides for things Kimi's /v1/models does not report: max output
 * tokens, pricing, thinking-level constraints, and K3's deferred-tools quirk.
 * Values aligned with pi's built-in moonshotai-cn provider (verified against
 * Kimi docs, Jul 2026).
 */
const PROFILES: Record<string, ModelProfile> = {
  // K3: flagship. 1M context, always reasons, reasoning_effort "max" only.
  "kimi-k3": {
    maxTokens: 131072,
    cost: { input: 3, output: 15, cacheRead: 0.3 },
    thinkingLevelMap: {
      off: null, minimal: null, low: null, medium: null, high: null, xhigh: null,
      max: "max",
    },
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      deferredToolsMode: "kimi",
    },
  },
  // K2.7 Code: coding model, always-on thinking (can't disable), 256K.
  "kimi-k2.7-code": {
    maxTokens: 262144,
    cost: { input: 0.95, output: 4, cacheRead: 0.19 },
    thinkingLevelMap: { off: null },
  },
  // K2.7 Code HighSpeed: same model, faster (and pricier) output.
  "kimi-k2.7-code-highspeed": {
    name: "Kimi K2.7 Code HighSpeed",
    maxTokens: 262144,
    cost: { input: 1.9, output: 8, cacheRead: 0.38 },
    thinkingLevelMap: { off: null },
  },
  // K2.6: general model, thinking on/off, 256K, vision.
  "kimi-k2.6": {
    maxTokens: 262144,
    cost: { input: 0.95, output: 4, cacheRead: 0.16 },
  },
  // K2.5: predecessor, being phased out for new users (offline Aug 31).
  "kimi-k2.5": {
    maxTokens: 262144,
    cost: { input: 0.6, output: 3, cacheRead: 0.1 },
  },
  // Moonshot V1: legacy generation models (offline Aug 31). No reasoning.
  "moonshot-v1-8k": {
    maxTokens: 8192,
    cost: { input: 0.28, output: 1.4, cacheRead: 0 },
  },
  "moonshot-v1-32k": {
    maxTokens: 32768,
    cost: { input: 0.7, output: 2.8, cacheRead: 0 },
  },
  "moonshot-v1-128k": {
    maxTokens: 131072,
    cost: { input: 1.4, output: 4.3, cacheRead: 0 },
  },
  "moonshot-v1-8k-vision-preview": {
    input: ["text", "image"],
    maxTokens: 8192,
    cost: { input: 0.28, output: 1.4, cacheRead: 0 },
  },
  "moonshot-v1-32k-vision-preview": {
    input: ["text", "image"],
    maxTokens: 32768,
    cost: { input: 0.7, output: 2.8, cacheRead: 0 },
  },
  "moonshot-v1-128k-vision-preview": {
    input: ["text", "image"],
    maxTokens: 131072,
    cost: { input: 1.4, output: 4.3, cacheRead: 0 },
  },
};

/** Heuristics for ids without an explicit profile. First match wins. */
const PARAM_HEURISTICS: [RegExp, { max: number; costIn: number; costOut: number; cacheRead: number }][] = [
  [/kimi-k3/, { max: 131072, costIn: 3, costOut: 15, cacheRead: 0.3 }],
  [/kimi-k2\.7/, { max: 262144, costIn: 0.95, costOut: 4, cacheRead: 0.19 }],
  [/kimi-k2/, { max: 262144, costIn: 0.95, costOut: 4, cacheRead: 0.16 }],
  [/moonshot-v1-128k/, { max: 131072, costIn: 1.4, costOut: 4.3, cacheRead: 0 }],
  [/moonshot-v1-32k/, { max: 32768, costIn: 0.7, costOut: 2.8, cacheRead: 0 }],
  [/moonshot-v1-8k/, { max: 8192, costIn: 0.28, costOut: 1.4, cacheRead: 0 }],
  [/kimi|moonshot/, { max: 262144, costIn: 1, costOut: 4, cacheRead: 0 }],
];

function guessParams(id: string): { max: number; costIn: number; costOut: number; cacheRead: number } {
  for (const [re, p] of PARAM_HEURISTICS) {
    if (re.test(id)) return p;
  }
  return { max: 131072, costIn: 0, costOut: 0, cacheRead: 0 };
}

function displayName(id: string, profile?: ModelProfile): string {
  if (profile?.name) return profile.name;
  // kimi-k2.7-code → Kimi K2.7 Code, moonshot-v1-8k → Moonshot V1 8k
  return id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// ── Compat ───────────────────────────────────────────────────────────────────

/**
 * Base compat for all Kimi models. Matches pi's built-in `moonshotai-cn`.
 * - supportsDeveloperRole: false — uses `system`.
 * - thinkingFormat: "deepseek" — sends `thinking: { type: "enabled"|"disabled" }`
 *   (K2.x semantics); K3 always reasons.
 * - maxTokensField: "max_tokens".
 */
function baseCompat(profile?: ModelProfile): Record<string, unknown> {
  const compat: Record<string, unknown> = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    thinkingFormat: "deepseek",
  };
  if (profile?.compat) Object.assign(compat, profile.compat);
  return compat;
}

// ── API key resolution ───────────────────────────────────────────────────────

/**
 * Resolve an API key for discovery. Precedence:
 *   1. KIMI_API_KEY env var
 *   2. MOONSHOT_API_KEY env var (shared with the built-in moonshotai providers)
 *   3. ~/.pi/agent/auth.json entries: kimi, moonshotai-cn, moonshotai
 *
 * The resolved key is passed to pi as a literal `apiKey` config value. We
 * deliberately do NOT seed `process.env.KIMI_API_KEY`: pi's built-in
 * `kimi-coding` provider activates on that env var, so exporting it would
 * make an unwanted provider appear. (When the user explicitly exports
 * KIMI_API_KEY themselves we keep the `$KIMI_API_KEY` reference instead.)
 *
 * Note: pi prefers a stored auth.json credential for provider `kimi` over
 * this static `apiKey`, so /login keeps working regardless.
 */
function resolveApiKey(): string {
  if (process.env.KIMI_API_KEY) return process.env.KIMI_API_KEY;
  if (process.env.MOONSHOT_API_KEY) return process.env.MOONSHOT_API_KEY;
  for (const key of ["kimi", "moonshotai-cn", "moonshotai"]) {
    try {
      const raw = readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const v = data[key];
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.key === "string") return o.key;
        if (typeof o.apiKey === "string") return o.apiKey;
      }
    } catch {
      // ignore — try next / fall through
    }
  }
  return "";
}

// ── Live discovery ───────────────────────────────────────────────────────────

interface LiveModel {
  id: string;
  context_length?: number;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
  supports_reasoning?: boolean;
}

async function fetchLiveModels(config: ResolvedConfig): Promise<LiveModel[]> {
  const key = resolveApiKey();
  const resp = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: LiveModel[] };
  const all = (data.data ?? []).filter((m) => m && typeof m.id === "string" && m.id);
  const ids = applyFilter(all.map((m) => m.id), config);
  if (ids.length === 0) throw new Error(`no models after filter (got ${all.length} from endpoint)`);
  const idSet = new Set(ids);
  // Preserve endpoint order, deduped.
  const seen = new Set<string>();
  const out: LiveModel[] = [];
  for (const m of all) {
    if (idSet.has(m.id) && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

// ── Model construction ───────────────────────────────────────────────────────

interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: InputType[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
}

/** Build a ModelConfig from a discovered LiveModel, applying profiles/heuristics. */
function buildModelFromLive(m: LiveModel): ModelConfig {
  const id = m.id;
  const profile = PROFILES[id];
  const params = guessParams(id);
  const reasoning = profile?.reasoning ?? !!m.supports_reasoning;
  const multimodal = !!(m.supports_image_in || m.supports_video_in);
  const input: InputType[] =
    profile?.input ?? (multimodal ? ["text", "image"] : ["text"]);
  const contextWindow = profile?.contextWindow ?? (m.context_length && m.context_length > 0 ? m.context_length : params.max);
  const cost = profile?.cost
    ? { input: profile.cost.input, output: profile.cost.output, cacheRead: profile.cost.cacheRead, cacheWrite: 0 }
    : { input: params.costIn, output: params.costOut, cacheRead: params.cacheRead, cacheWrite: 0 };
  return {
    id,
    name: displayName(id, profile),
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens: profile?.maxTokens ?? params.max,
    ...(profile?.thinkingLevelMap ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
    compat: baseCompat(profile),
  };
}

function buildModelsFromLive(models: LiveModel[]): ModelConfig[] {
  return models.map(buildModelFromLive);
}

/** Build a ModelConfig from a bare id (used by the fallback snapshot). */
function buildModel(id: string): ModelConfig {
  return buildModelFromLive({ id });
}

// ── Static fallback snapshot ─────────────────────────────────────────────────
// Used only when discovery is off AND no cache is available. Mirrors the
// built-in moonshotai-cn catalog (Jul 2026).

const FALLBACK_MODELS: ModelConfig[] = [
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "moonshot-v1-128k",
  "moonshot-v1-8k-vision-preview",
  "moonshot-v1-32k-vision-preview",
  "moonshot-v1-128k-vision-preview",
].map(buildModel);

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: string;
  models: ModelConfig[];
}

function userCacheDir(): string {
  return join(homedir(), ".pi", "agent");
}

function readCache(): ModelConfig[] | undefined {
  try {
    const p = join(userCacheDir(), CACHE_FILENAME);
    if (!existsSync(p)) return undefined;
    const raw = readFileSync(p, "utf8");
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (Array.isArray(entry.models) && entry.models.length > 0) {
      return entry.models as ModelConfig[];
    }
  } catch {
    // ignore malformed cache
  }
  return undefined;
}

function writeCache(models: ModelConfig[]): void {
  try {
    const dir = userCacheDir();
    mkdirSync(dir, { recursive: true });
    const entry: CacheEntry = { fetchedAt: new Date().toISOString(), models };
    writeFileSync(join(dir, CACHE_FILENAME), JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch {
    // best-effort
  }
}

// ── Extension entry ──────────────────────────────────────────────────────────

/**
 * Wrap a resolved key as a literal pi config value. pi's config-value parser
 * treats `$VAR`/`${VAR}` as env references and `$$` as an escaped literal
 * `$`, so a key starting with `$` must be escaped. (Kimi keys are `sk-...`,
 * but guard anyway.)
 */
function asLiteralConfigValue(key: string): string {
  return key.startsWith("$") ? `$${key}` : key;
}

function register(pi: ExtensionAPI, baseUrl: string, apiKey: string, models: ModelConfig[]): void {
  pi.registerProvider("kimi", {
    name: "Kimi (Moonshot AI)",
    baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models,
  });
}

export default async function (pi: ExtensionAPI) {
  // Resolve the API key WITHOUT seeding process.env.KIMI_API_KEY — exporting
  // that var would also activate pi's built-in `kimi-coding` provider. If the
  // user explicitly exported KIMI_API_KEY, keep the request-time `$KIMI_API_KEY`
  // reference; otherwise pass the key resolved from MOONSHOT_API_KEY /
  // auth.json as a literal. A stored auth.json credential for `kimi` takes
  // precedence over this static value at request time either way.
  const apiKey = process.env.KIMI_API_KEY
    ? API_KEY_REF
    : asLiteralConfigValue(resolveApiKey()) || API_KEY_REF;

  const config = loadConfig();
  const enabled = discoveryEnabled();
  const cached = readCache();

  let models: ModelConfig[];
  let source: string;

  if (cached) {
    models = cached;
    source = `cache (${models.length} models)`;
    register(pi, config.baseUrl, apiKey, models);

    if (enabled) {
      // Warm cache: refresh in the background and update the cache file so the
      // *next* startup picks up new models. The current session keeps using
      // the cached list (re-registering mid-session is unsafe — the captured
      // `pi` goes stale after session replacement/reload).
      refreshInBackground(config).catch(() => {
        /* logged in refreshInBackground */
      });
      source += " + background refresh";
    } else {
      source += " (discovery off)";
    }
  } else if (enabled) {
    try {
      const live = await fetchLiveModels(config);
      models = buildModelsFromLive(live);
      source = `live (${models.length} models)`;
      writeCache(models);
    } catch (e) {
      models = FALLBACK_MODELS;
      source = `fallback (${models.length} models) — ${e instanceof Error ? e.message : String(e)}`;
    }
    register(pi, config.baseUrl, apiKey, models);
  } else {
    models = FALLBACK_MODELS;
    source = `fallback (${models.length} models) (discovery off)`;
    register(pi, config.baseUrl, apiKey, models);
  }

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`[kimi] model source: ${source}`, "info");
  });

  // Fix: Ensure message sequence starts with a "user" role.
  // After compaction the sequence may start with an assistant message, which
  // some OpenAI-compatible providers reject. Insert a placeholder user message
  // when the first message is an assistant turn.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "kimi") return;

    const payload = event.payload as { messages?: Array<{ role: string }> };
    const messages = payload?.messages;
    if (!messages || messages.length === 0) return;

    const firstMsg = messages[0];
    if (firstMsg.role === "assistant") {
      const fixedMessages = [
        { role: "user", content: "(continuing from previous context)" },
        ...messages,
      ];
      return { ...payload, messages: fixedMessages };
    }

    return undefined;
  });
}

async function refreshInBackground(config: ResolvedConfig): Promise<void> {
  try {
    const live = await fetchLiveModels(config);
    const models = buildModelsFromLive(live);
    writeCache(models);
    process.stderr.write(
      `[kimi] background refresh: cached ${models.length} models (live) for next startup\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[kimi] background refresh failed, keeping cache: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}
