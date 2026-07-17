import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Zhipu (智谱AI / BigModel) Provider Extension — general endpoint with
 * runtime model discovery.
 *
 * ## Why this exists
 *
 * pi ships two built-in Zhipu providers, both on the **coding** plan endpoint:
 *   - `zai`            → https://api.z.ai/api/coding/paas/v4        (intl)
 *   - `zai-coding-cn`  → https://open.bigmodel.cn/api/coding/paas/v4 (CN)
 *
 * This extension targets the **general** (non-coding) endpoint
 * `https://open.bigmodel.cn/api/paas/v4`, which is what most users have
 * access to via a standard BigModel API key. It also discovers the model
 * list at runtime instead of shipping a static catalog.
 *
 * Provider id: `zhipu` (distinct from the built-in `zai` / `zai-coding-cn`).
 *
 * ## Discovery
 *
 * At startup the factory fetches the live model list from `/v1/models`.
 * BigModel's `/v1/models` returns ids only — no context window, max output,
 * pricing, or input modalities — so those come from PARAM_HEURISTICS /
 * INPUT_HEURISTICS / PROFILES below. A static EXTRA_MODELS table supplies
 * vision/free variants that the endpoint omits (see comment there).
 *
 * See the dashscope-provider for the full discovery pipeline description
 * (cache-first startup, background refresh, fallback); this provider uses
 * the same pattern.
 *
 * ## Discovery control
 *
 *   export ZHIPU_DISCOVERY=off   # skip network, use cache/fallback
 *
 * ## Provider config
 *
 * Override the endpoint and/or model filter via `~/.pi/agent/zhipu-config.json`:
 *
 *   {
 *     "baseUrl": "https://...",         // override the API endpoint
 *     "include": ["^glm-5"],           // regex sources; any match keeps an id
 *     "exclude": ["-preview$"]          // regex sources; any match drops an id
 *   }
 *
 * `baseUrl` precedence: `ZHIPU_BASE_URL` env var > config file `baseUrl` >
 * built-in default. Use the env var for quick temporary swaps (e.g. proxy)
 * and the config file for long-term moves.
 *
 * `include`/`exclude` default to empty (keep all) since the endpoint already
 * returns a curated subset; the filter applies to both discovered and extra
 * models. A malformed config file logs a warning and falls back to defaults.
 *
 * ## Compat
 *
 * Mirrors the built-in `zai` provider so request shaping is identical:
 * - `thinkingFormat: "zai"` → pi sends `thinking: { type: "enabled"|"disabled" }`
 *   (binary on/off; reasoning_effort only honored for models with
 *   `supportsReasoningEffort: true`, currently only glm-5.2).
 * - `zaiToolStream: true` (thinking models) → pi sends `tool_stream: true`.
 * - `supportsDeveloperRole: false` → uses `system`, not `developer`.
 * - `supportsReasoningEffort: false` for all but glm-5.2 (binary thinking).
 *
 * ## Setup
 *
 * 1. Get an API key at https://bigmodel.cn/usercenter/proj-mgmt/apikeys
 * 2. /login → "Use an API key" → zhipu
 *    (or: export ZHIPU_API_KEY="...")
 *
 * ## Usage
 *
 *   pi
 *   /model zhipu/glm-5.2
 */

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const API_KEY_REF = "$ZHIPU_API_KEY";
const DISCOVERY_TIMEOUT_MS = 8000;
const CACHE_FILENAME = "zhipu-models.cache.json";
const CONFIG_FILENAME = "zhipu-config.json";

// Default filter: keep all. BigModel's /v1/models already returns a curated
// subset (8 base models), so no prefix filtering is needed by default.
const DEFAULT_INCLUDE: string[] = [];
const DEFAULT_EXCLUDE: string[] = [];

// ── Discovery control ────────────────────────────────────────────────────────

function discoveryEnabled(): boolean {
  const v = (process.env.ZHIPU_DISCOVERY ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

// ── Provider config (user-configurable) ─────────────────────────────────────

interface ProviderConfigFile {
  /** Override the API endpoint. Takes precedence over the default but is itself
   * overridden by the ZHIPU_BASE_URL env var (for quick proxy swaps). */
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
 *   1. ZHIPU_BASE_URL env var (quick temporary override, e.g. proxy)
 *   2. ~/.pi/agent/zhipu-config.json `baseUrl` (long-term override)
 *   3. DEFAULT_BASE_URL
 *
 * `include`/`exclude` come from the config file only (env vars can't carry
 * regex arrays); absent/invalid file falls back to defaults so pi still starts.
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
  // Config-file warnings are intentionally silent: any terminal output
  // (stdout *or* stderr) corrupts pi's TUI render. A malformed file simply
  // falls back to defaults so pi still starts.
  const baseUrl =
    process.env.ZHIPU_BASE_URL || file.baseUrl || DEFAULT_BASE_URL;
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

interface ModelProfile {
  /** Override input types; otherwise derived from INPUT_HEURISTICS. */
  input?: InputType[];
  /** Override reasoning flag. */
  reasoning?: boolean;
  /** Override context window. */
  contextWindow?: number;
  /** Override max output tokens. */
  maxTokens?: number;
  /** Override compat (merged onto the computed base). */
  compat?: Record<string, unknown>;
}

const PROFILES: Record<string, ModelProfile> = {
  // glm-5.2 is the only model supporting multi-level reasoning effort.
  "glm-5.2": {
    contextWindow: 1048576,
    maxTokens: 131072,
    compat: { supportsReasoningEffort: true },
  },
};

// Input-type heuristic — first match wins.
const INPUT_HEURISTICS: [RegExp, InputType[]][] = [
  [/glm-5v/, ["text", "image"]],
  [/glm-4\.6v/, ["text", "image"]],
  [/glm/, ["text"]],
];

function guessInput(id: string): InputType[] {
  for (const [re, types] of INPUT_HEURISTICS) {
    if (re.test(id)) return types;
  }
  return ["text"];
}

// Param heuristic — BigModel /v1/models exposes neither ctx nor pricing.
// Values aligned with pi's built-in zai provider (verified against BigModel docs).
const PARAM_HEURISTICS: [RegExp, { ctx: number; max: number; costIn: number; costOut: number }][] = [
  [/glm-5\.2/, { ctx: 1048576, max: 131072, costIn: 0, costOut: 0 }],
  [/glm-5/, { ctx: 200000, max: 131072, costIn: 0, costOut: 0 }],
  [/glm-4\.7/, { ctx: 204800, max: 131072, costIn: 0, costOut: 0 }],
  [/glm-4\.6v/, { ctx: 131072, max: 32768, costIn: 0, costOut: 0 }],
  [/glm-4\.6/, { ctx: 204800, max: 131072, costIn: 0, costOut: 0 }],
  [/glm-4\.5-air/, { ctx: 131072, max: 98304, costIn: 0, costOut: 0 }],
  [/glm/, { ctx: 131072, max: 131072, costIn: 0, costOut: 0 }],
];

function guessParams(id: string): { ctx: number; max: number; costIn: number; costOut: number } {
  for (const [re, p] of PARAM_HEURISTICS) {
    if (re.test(id)) return p;
  }
  return { ctx: 131072, max: 131072, costIn: 0, costOut: 0 };
}

// Reasoning heuristic: all glm models support thinking except the explicit
// non-thinking text variants (air/flashx/flash-free). Vision-flash variants
// (glm-4.6v-flash) DO support thinking, so exclude them from the non-reasoning
// set by requiring a leading text-only context (no 'v' before the suffix).
const NON_REASONING = [/air$/, /flashx$/, /flash-250414$/, /(?<!v)-flash$/];
function guessReasoning(id: string): boolean {
  return !NON_REASONING.some((re) => re.test(id));
}

function displayName(id: string): string {
  // glm-5v-turbo → GLM-5V Turbo, glm-4.6v-flash → GLM-4.6V Flash
  return id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// ── Compat ───────────────────────────────────────────────────────────────────

/**
 * Base compat for all Zhipu models. Matches pi's built-in `zai` provider.
 * - supportsDeveloperRole: false — uses `system`.
 * - supportsStore: false.
 * - supportsReasoningEffort: false (overridden to true for glm-5.2).
 */
function baseCompat(reasoning: boolean, profile?: ModelProfile): Record<string, unknown> {
  const compat: Record<string, unknown> = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    thinkingFormat: "zai",
  };
  // zaiToolStream applies to thinking models (matches built-in zai: glm-4.5-air
  // lacks it, all other thinking models have it).
  if (reasoning) compat.zaiToolStream = true;
  if (profile?.compat) Object.assign(compat, profile.compat);
  return compat;
}

// ── API key resolution ───────────────────────────────────────────────────────

function resolveApiKey(): string {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  // Fall back to the legacy zai_china auth entry so existing users keep working.
  for (const key of ["zhipu", "zai_china"]) {
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
      // ignore
    }
  }
  return "";
}

// ── Live discovery ───────────────────────────────────────────────────────────

async function fetchLiveModelIds(config: ResolvedConfig): Promise<string[]> {
  const key = resolveApiKey();
  const resp = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: Array<{ id?: string }> };
  const all = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  const ids = applyFilter(all, config);
  if (ids.length === 0) throw new Error(`no models after filter (got ${all.length} from endpoint)`);
  return [...new Set(ids)].sort();
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
  compat?: Record<string, unknown>;
}

function buildModel(id: string): ModelConfig {
  const p = PROFILES[id] ?? {};
  const params = guessParams(id);
  const reasoning = p.reasoning ?? guessReasoning(id);
  return {
    id,
    name: displayName(id),
    reasoning,
    input: p.input ?? guessInput(id),
    cost: {
      input: params.costIn,
      output: params.costOut,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: p.contextWindow ?? params.ctx,
    maxTokens: p.maxTokens ?? params.max,
    compat: baseCompat(reasoning, p),
  };
}

function buildModelsFromLive(ids: string[]): ModelConfig[] {
  return ids.map(buildModel);
}

// ── Extra models (vision/free variants the endpoint omits) ───────────────────

/**
 * BigModel's /v1/models returns ~8 base text models but omits vision and free
 * variants that are nonetheless usable on the general endpoint. These are
 * merged into the discovered list (deduped by id; discovered entries win).
 *
 * Verified usable Apr–Jun 2026. ctx/maxTokens aligned with pi's built-in zai
 * provider. Remove or extend this table as the endpoint evolves.
 */
const EXTRA_MODELS: ModelConfig[] = [
  // ── Vision ──
  buildModel("glm-5v-turbo"),
  buildModel("glm-4.6v"),
  buildModel("glm-4.6v-flash"),
  // ── Free ──
  buildModel("glm-4.7-flash"),
  buildModel("glm-4.7-flashx"),
  buildModel("glm-4-flash-250414"),
];

function mergeExtra(discovered: ModelConfig[], filter: { include: RegExp[]; exclude: RegExp[] }): ModelConfig[] {
  const seen = new Set(discovered.map((m) => m.id));
  const extras = EXTRA_MODELS.filter((m) => !seen.has(m.id));
  // Apply the same user filter to extras so a narrow include (e.g. ^glm-5)
  // doesn't pull in glm-4.6v.
  const extraIds = applyFilter(extras.map((m) => m.id), filter);
  const extraSet = new Set(extraIds);
  return [...discovered, ...extras.filter((m) => extraSet.has(m.id))].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

// ── Static fallback snapshot ─────────────────────────────────────────────────
// Used only when discovery is off AND no cache is available.

const FALLBACK_MODELS: ModelConfig[] = mergeExtra(
  [
    "glm-4.5",
    "glm-4.5-air",
    "glm-4.6",
    "glm-4.7",
    "glm-5",
    "glm-5-turbo",
    "glm-5.1",
    "glm-5.2",
  ].map(buildModel),
  { include: [], exclude: [] },
);

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

function register(pi: ExtensionAPI, baseUrl: string, models: ModelConfig[]): void {
  pi.registerProvider("zhipu", {
    name: "Zhipu (智谱)",
    baseUrl,
    apiKey: API_KEY_REF,
    api: "openai-completions",
    authHeader: true,
    models,
  });
}

export default async function (pi: ExtensionAPI) {
  // Migration: if ZHIPU_API_KEY is unset, seed it from the legacy `zai_china`
  // auth entry (or `zhipu` entry) so the provider's `apiKey: "$ZHIPU_API_KEY"`
  // resolves at request time without requiring users to re-/login.
  if (!process.env.ZHIPU_API_KEY) {
    const legacy = resolveApiKey();
    if (legacy) process.env.ZHIPU_API_KEY = legacy;
  }

  const config = loadConfig();
  const enabled = discoveryEnabled();
  const cached = readCache();

  let models: ModelConfig[];
  let source: string;

  if (cached) {
    models = cached;
    source = `cache (${models.length} models)`;
    register(pi, config.baseUrl, models);

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
      const ids = await fetchLiveModelIds(config);
      const discovered = buildModelsFromLive(ids);
      models = mergeExtra(discovered, config);
      source = `live (${discovered.length} discovered + ${models.length - discovered.length} extra)`;
      writeCache(models);
    } catch (e) {
      models = FALLBACK_MODELS;
      source = `fallback (${models.length} models) — ${e instanceof Error ? e.message : String(e)}`;
    }
    register(pi, config.baseUrl, models);
  } else {
    models = FALLBACK_MODELS;
    source = `fallback (${models.length} models) (discovery off)`;
    register(pi, config.baseUrl, models);
  }

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`[zhipu] model source: ${source}`, "info");
  });

  // Fix: Ensure message sequence starts with "user" role.
  // After compaction the sequence may start with an assistant message, causing
  // errors on providers that require a leading user turn.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "zhipu") return;

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
    const ids = await fetchLiveModelIds(config);
    const discovered = buildModelsFromLive(ids);
    const live = mergeExtra(discovered, config);
    writeCache(live);
    // Silent: this runs as a fire-and-forget background task with no ctx,
    // so any terminal output (stdout/stderr) would corrupt pi's TUI. The
    // next session_start notify reflects the refreshed cache.
  } catch (e) {
    // Silent on failure: keep the existing cache (see note above).
  }
}
