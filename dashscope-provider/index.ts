import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * DashScope (阿里云百炼) Provider Extension — with runtime model discovery.
 *
 * ## Overview
 *
 * At startup the factory fetches the live model list from DashScope's
 * OpenAI-compatible `/v1/models` endpoint and keeps only `qwen3.7-*` entries.
 * DashScope's `/v1/models` exposes IDs only — no context window, max output,
 * or pricing — so those come from INPUT_HEURISTICS / PARAM_HEURISTICS below.
 * New dated variants (e.g. `qwen3.7-max-2026-xx`) are picked up automatically
 * without touching this file.
 *
 * ## Discovery control
 *
 * Discovery is on by default. Set `DASHSCOPE_DISCOVERY=off` to disable it and
 * rely on the cached or fallback model list (useful when startup latency
 * matters or the network is known-flaky):
 *
 *   export DASHSCOPE_DISCOVERY=off
 *
 * ## Provider config
 *
 * Override the endpoint and/or model filter via a user-level config file at
 * `~/.pi/agent/dashscope-config.json`:
 *
 *   {
 *     "baseUrl": "https://...",         // override the API endpoint
 *     "include": ["^qwen3\\.7-"],       // regex sources; any match keeps an id
 *     "exclude": ["-preview$"]          // regex sources; any match drops an id
 *   }
 *
 * `baseUrl` precedence: `DASHSCOPE_BASE_URL` env var > config file `baseUrl`
 * > built-in default. Use the env var for quick temporary swaps (e.g. routing
 * through a proxy) and the config file for long-term moves (e.g. an Alibaba
 * Cloud workspace-id private endpoint).
 *
 * `include` empty/omitted = keep all; `exclude` empty/omitted = drop none.
 * A malformed config file logs a warning and falls back to defaults so pi
 * still starts.
 *
 * ## Caching
 *
 * Discovered models are cached to `~/.pi/agent/dashscope-models.cache.json`.
 *
 * Startup sequence:
 *   1. Read cache. If present, register those models immediately so pi is
 *      ready without waiting on the network.
 *   2. If discovery is on:
 *      - Cache hit  → refresh in the background; on success, update the cache
 *        (the current session keeps the cached list; the next startup picks
 *        up the fresh list). On failure, keep the cache.
 *      - Cache miss → fetch synchronously (bounded by DISCOVERY_TIMEOUT_MS);
 *        on success register + cache, on failure register FALLBACK_MODELS.
 *   3. If discovery is off: use cache if present, else FALLBACK_MODELS.
 *
 * This guarantees pi never fails to start because of a flaky endpoint, and a
 * warm cache keeps startup fast while still staying fresh.
 *
 * ## Compat
 *
 * DashScope:
 * - Never supports the `developer` role (uses `system`).
 * - Requires a `name` field on tool results.
 * - Uses `max_tokens` (not `max_completion_tokens`).
 * - Thinking is controlled by the top-level `enable_thinking` parameter, so
 *   reasoning models set `thinkingFormat: "qwen"`.
 *
 * ## Setup
 *
 * 1. Get an API key from https://bailian.console.aliyun.com/
 * 2. Either set env var or use /login inside pi:
 *    export DASHSCOPE_API_KEY="sk-..."
 *    # or: /login → "Use an API key" → dashscope
 *
 * ## Usage
 *
 *   pi
 *   /model dashscope/qwen3.7-max
 */

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY_REF = "$DASHSCOPE_API_KEY";
const DISCOVERY_TIMEOUT_MS = 8000;
const CACHE_FILENAME = "dashscope-models.cache.json";
const CONFIG_FILENAME = "dashscope-config.json";

// Default filter: keep qwen3.7-* only. Overridable via ~/.pi/agent/dashscope-config.json.
const DEFAULT_INCLUDE = ["^qwen3\\.7-"];
const DEFAULT_EXCLUDE: string[] = [];

// ── Discovery control ────────────────────────────────────────────────────────

function discoveryEnabled(): boolean {
  const v = (process.env.DASHSCOPE_DISCOVERY ?? "").trim().toLowerCase();
  // Default on. Explicit "off" / "0" / "false" disables.
  return v !== "off" && v !== "0" && v !== "false";
}

// ── Provider config (user-configurable) ─────────────────────────────────────

interface ProviderConfigFile {
  /** Override the API endpoint. Takes precedence over the default but is itself
   * overridden by the DASHSCOPE_BASE_URL env var (for quick proxy swaps). */
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
 *   1. DASHSCOPE_BASE_URL env var (quick temporary override, e.g. proxy)
 *   2. ~/.pi/agent/dashscope-config.json `baseUrl` (long-term, e.g. workspace-id private endpoint)
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
    process.env.DASHSCOPE_BASE_URL || file.baseUrl || DEFAULT_BASE_URL;
  const inc = Array.isArray(file.include) ? file.include : DEFAULT_INCLUDE;
  const exc = Array.isArray(file.exclude) ? file.exclude : DEFAULT_EXCLUDE;
  return {
    baseUrl,
    include: inc.map((s) => new RegExp(s)),
    exclude: exc.map((s) => new RegExp(s)),
  };
}

/** Apply include/exclude regexes to a list of model ids. */
function applyFilter(ids: string[], filter: { include: RegExp[]; exclude: RegExp[] }): string[] {
  return ids.filter((id) => {
    const included = filter.include.length === 0 || filter.include.some((re) => re.test(id));
    const excluded = filter.exclude.length > 0 && filter.exclude.some((re) => re.test(id));
    return included && !excluded;
  });
}

// ── Static per-model profiles (quirks DashScope does not expose) ─────────────

type InputType = "text" | "image";

interface ModelProfile {
  /** Override input types; otherwise derived from INPUT_HEURISTICS. */
  input?: InputType[];
}

const PROFILES: Record<string, ModelProfile> = {
  // qwen3.7-plus supports vision; max is text-only.
  "qwen3.7-plus": { input: ["text", "image"] },
};

// Input-type heuristic — first match wins. Extend when new model families appear.
const INPUT_HEURISTICS: [RegExp, InputType[]][] = [
  [/qwen3\.7-plus/, ["text", "image"]],
  [/qwen3\.[56]-plus/, ["text", "image"]],
  [/qwen3\.6-local/, ["text", "image"]],
  [/qwen3/, ["text"]],
  [/qwen/, ["text"]],
];

function guessInput(id: string): InputType[] {
  for (const [re, types] of INPUT_HEURISTICS) {
    if (re.test(id)) return types;
  }
  return ["text"];
}

// Param heuristic — DashScope exposes neither ctx nor pricing via /v1/models.
const PARAM_HEURISTICS: [RegExp, { ctx: number; max: number; costIn: number; costOut: number }][] = [
  // qwen3.7-max/plus: 991K context, 64K output (bailian console 2026-06).
  [/qwen3\.7/, { ctx: 1014784, max: 65536, costIn: 0, costOut: 0 }],
  [/qwen3/, { ctx: 131072, max: 8192, costIn: 0, costOut: 0 }],
  [/qwen/, { ctx: 131072, max: 8192, costIn: 0, costOut: 0 }],
];

function guessParams(id: string): { ctx: number; max: number; costIn: number; costOut: number } {
  for (const [re, p] of PARAM_HEURISTICS) {
    if (re.test(id)) return p;
  }
  return { ctx: 131072, max: 8192, costIn: 0, costOut: 0 };
}

function displayName(id: string): string {
  return id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// ── Compat (see header comment) ──────────────────────────────────────────────

/**
 * Base compat for all DashScope models.
 * - supportsDeveloperRole: false — Qwen uses `system`, not `developer`.
 * - requiresToolResultName: true — Qwen requires `name` in tool results.
 * - maxTokensField: "max_tokens".
 */
const BASE_COMPAT = {
  supportsDeveloperRole: false,
  requiresToolResultName: true,
  maxTokensField: "max_tokens" as const,
};

/**
 * Reasoning compat: adds `thinkingFormat: "qwen"` so pi sends the top-level
 * `enable_thinking` parameter.
 */
const REASONING_COMPAT = {
  ...BASE_COMPAT,
  thinkingFormat: "qwen" as const,
};

// ── API key resolution (factory runs before pi injects auth) ─────────────────

function resolveApiKey(): string {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const v = data["dashscope"];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.key === "string") return o.key;
      if (typeof o.apiKey === "string") return o.apiKey;
    }
  } catch {
    // ignore — fall through to empty key (discovery will 401, fallback used)
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
  if (ids.length === 0) throw new Error(`no models after filter (include=${JSON.stringify(config.include.map((r) => r.source))})`);
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
  compat?: typeof REASONING_COMPAT;
}

function buildModel(id: string): ModelConfig {
  const p = PROFILES[id] ?? {};
  const params = guessParams(id);
  // All qwen3.7-* models support thinking; use the reasoning compat.
  const reasoning = true;
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
    contextWindow: params.ctx,
    maxTokens: params.max,
    compat: reasoning ? REASONING_COMPAT : BASE_COMPAT,
  };
}

function buildModelsFromLive(ids: string[]): ModelConfig[] {
  return ids.map(buildModel);
}

// ── Static fallback snapshot ─────────────────────────────────────────────────
// Used only when discovery is off AND no cache is available. Regenerate the
// reference by running `python3 probe-providers.py dashscope` against a local
// copy of this provider, then merge findings here.

const FALLBACK_MODELS: ModelConfig[] = [
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.67, output: 5.0, cacheRead: 0.33, cacheWrite: 2.08 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen3.7-max-2026-05-17",
    name: "Qwen3.7 Max 2026 05 17",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.67, output: 5.0, cacheRead: 0.33, cacheWrite: 2.08 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen3.7-max-2026-05-20",
    name: "Qwen3.7 Max 2026 05 20",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.67, output: 5.0, cacheRead: 0.33, cacheWrite: 2.08 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen3.7-max-2026-06-08",
    name: "Qwen3.7 Max 2026 06 08",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.67, output: 5.0, cacheRead: 0.33, cacheWrite: 2.08 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen3.7-max-preview",
    name: "Qwen3.7 Max Preview",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.67, output: 5.0, cacheRead: 0.33, cacheWrite: 2.08 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.28, output: 1.11, cacheRead: 0.06, cacheWrite: 0.35 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen3.7-plus-2026-05-26",
    name: "Qwen3.7 Plus 2026 05 26",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.28, output: 1.11, cacheRead: 0.06, cacheWrite: 0.35 },
    contextWindow: 1014784,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
];

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: string;
  models: ModelConfig[];
}

/** User-level cache dir: ~/.pi/agent/ */
function userCacheDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** Project-level cache dir: <cwd>/.pi/ */
function projectCacheDir(): string {
  return join(process.cwd(), ".pi");
}

/**
 * Read cached models. Project-level takes precedence over user-level.
 * Returns undefined when neither exists or the payload is malformed.
 */
function readCache(): ModelConfig[] | undefined {
  const candidates = [
    join(projectCacheDir(), CACHE_FILENAME),
    join(userCacheDir(), CACHE_FILENAME),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const entry = JSON.parse(raw) as Partial<CacheEntry>;
      if (Array.isArray(entry.models) && entry.models.length > 0) {
        return entry.models as ModelConfig[];
      }
    } catch {
      // ignore malformed cache, try next / fall back
    }
  }
  return undefined;
}

/**
 * Persist discovered models to the user-level cache. Project-level cache is
 * read-only (user-managed pin), so we never overwrite it.
 */
function writeCache(models: ModelConfig[]): void {
  try {
    const dir = userCacheDir();
    mkdirSync(dir, { recursive: true });
    const entry: CacheEntry = { fetchedAt: new Date().toISOString(), models };
    writeFileSync(join(dir, CACHE_FILENAME), JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch {
    // cache write is best-effort; never fail startup because of it
  }
}

// ── Extension entry ──────────────────────────────────────────────────────────

function register(pi: ExtensionAPI, baseUrl: string, models: ModelConfig[]): void {
  pi.registerProvider("dashscope", {
    name: "DashScope (阿里云百炼)",
    baseUrl,
    apiKey: API_KEY_REF,
    api: "openai-completions",
    authHeader: true,
    models,
  });
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  const enabled = discoveryEnabled();
  const cached = readCache();

  let models: ModelConfig[];
  let source: string;

  if (cached) {
    // Register the cache immediately so pi is ready without waiting on network.
    models = cached;
    source = `cache (${models.length} models)`;
    register(pi, config.baseUrl, models);

    if (enabled) {
      // Warm cache: refresh in the background and update the cache file so the
      // *next* startup picks up new models. The current session keeps using
      // the cached list (re-registering mid-session is unsafe — the captured
      // `pi` goes stale after session replacement/reload). On failure, the
      // cache is left untouched.
      refreshInBackground(config).catch(() => {
        /* logged in refreshInBackground */
      });
      source += " + background refresh";
    } else {
      source += " (discovery off)";
    }
  } else if (enabled) {
    // No cache: fetch synchronously so pi has a model list this session.
    try {
      const ids = await fetchLiveModelIds(config);
      models = buildModelsFromLive(ids);
      source = `live (${models.length} models)`;
      writeCache(models);
    } catch (e) {
      models = FALLBACK_MODELS;
      source = `fallback (${models.length} models) — ${e instanceof Error ? e.message : String(e)}`;
    }
    register(pi, config.baseUrl, models);
  } else {
    // Discovery off, no cache: use the static snapshot.
    models = FALLBACK_MODELS;
    source = `fallback (${models.length} models) (discovery off)`;
    register(pi, config.baseUrl, models);
  }

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`[dashscope] model source: ${source}`, "info");
  });

  // Fix: Ensure message sequence starts with "user" role.
  // After compaction the sequence may start with an assistant message, causing
  // "Cannot continue from message role: assistant" on providers that require a
  // leading user turn. Insert a placeholder user message when needed.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "dashscope") return;

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

/**
 * Background refresh: fetch the live model list and persist it to the cache
 * so the next startup picks up new models. The current session is not
 * re-registered (the captured `pi` would be stale after session replacement
 * or reload; re-registering mid-session is unsafe). Failures are logged and
 * leave the existing cache untouched.
 */
async function refreshInBackground(config: ResolvedConfig): Promise<void> {
  try {
    const ids = await fetchLiveModelIds(config);
    const live = buildModelsFromLive(ids);
    writeCache(live);
    // Silent: this runs as a fire-and-forget background task with no ctx,
    // so any terminal output (stdout/stderr) would corrupt pi's TUI. The
    // next session_start notify reflects the refreshed cache.
  } catch (e) {
    // Silent on failure: keep the existing cache (see note above).
  }
}
