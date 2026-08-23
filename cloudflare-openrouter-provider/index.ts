import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Cloudflare AI Gateway → OpenRouter Provider Extension — with runtime model
 * discovery.
 *
 * ## Overview
 *
 * Routes OpenRouter models through Cloudflare AI Gateway's OpenAI passthrough,
 * enabling unified billing or stored BYOK for all OpenRouter models. At
 * startup the factory fetches the live model list from OpenRouter's
 * OpenAI-compatible `/v1/models` endpoint (via the gateway) and keeps only
 * the configured provider prefixes (anthropic/openai/google/... by default).
 *
 * OpenRouter's `/v1/models` is richer than DashScope's — it exposes
 * `context_length`, per-token `pricing`, `architecture.input_modalities` and
 * `supported_parameters` — so those are read directly when present and only
 * max-output / fallback values come from heuristics below. New model releases
 * from the included vendors are picked up automatically without touching this
 * file.
 *
 * ## Discovery control
 *
 * Discovery is on by default. Set `CLOUDFLARE_DISCOVERY=off` to disable it
 * and rely on the cached or fallback model list (useful when startup latency
 * matters or the network is known-flaky):
 *
 *   export CLOUDFLARE_DISCOVERY=off
 *
 * ## Provider config
 *
 * Override the endpoint and/or model filter via a user-level config file at
 * `~/.pi/agent/cloudflare-openrouter-config.json`:
 *
 *   {
 *     "baseUrl": "https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/openrouter/v1",
 *     "include": ["^anthropic/", "^openai/"],
 *     "exclude": [":free$", ":nitro$"]
 *   }
 *
 * `baseUrl` precedence: `CLOUDFLARE_BASE_URL` env var > config file `baseUrl`
 * > built-in default (composed from `CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_GATEWAY_ID`). Use the env var for quick temporary swaps and the
 * config file for long-term moves.
 *
 * `include` empty/omitted = keep all; `exclude` empty/omitted = drop none.
 * A malformed config file falls back to defaults so pi still starts.
 *
 * ## Caching
 *
 * Discovered models are cached to
 * `~/.pi/agent/cloudflare-openrouter-models.cache.json`.
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
 * OpenRouter (via CF AI Gateway passthrough):
 * - Supports the `developer` role (OpenAI-style).
 * - Uses `max_completion_tokens` (not `max_tokens`).
 * - Reasoning is controlled by the top-level `reasoning` object, so reasoning
 *   models set `thinkingFormat: "openrouter"`.
 *
 * ## Setup
 *
 * 1. Create an AI Gateway at dash.cloudflare.com → AI → AI Gateway
 * 2. Add an OpenRouter upstream (Stored BYOK or Unified Billing)
 * 3. Set environment variables:
 *    export CLOUDFLARE_ACCOUNT_ID="..."
 *    export CLOUDFLARE_GATEWAY_ID="..."
 * 4. Use /login inside pi:
 *    /login → "Use an API key" → Cloudflare AI Gateway (OpenRouter)
 *
 * ## Usage
 *
 *   pi
 *   /model cloudflare-openrouter/anthropic/claude-opus-4.6
 */

const API_KEY_REF = "$CLOUDFLARE_API_KEY";
const DISCOVERY_TIMEOUT_MS = 10000;
const CACHE_FILENAME = "cloudflare-openrouter-models.cache.json";
const CONFIG_FILENAME = "cloudflare-openrouter-config.json";

// Default base URL composed from the CF account + gateway env vars.
function defaultBaseUrl(): string {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID || "PLACEHOLDER";
  const gw = process.env.CLOUDFLARE_GATEWAY_ID || "PLACEHOLDER";
  return `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/openrouter/v1`;
}

// Default filter: keep current-and-future flagship generations from the
// vendors shipped in the fallback snapshot. Each pattern matches a family
// *and* its successors (e.g. `claude-(opus|sonnet)-[4-9]` also catches a
// future claude-opus-5), so new flagship releases are picked up without a
// code change, while legacy generations (gpt-3/4, gemini-1/2, claude-3,
// moonshot-v1, qwen2, glm-4, ...) are excluded. Narrow further via config.
const DEFAULT_INCLUDE = [
  "^anthropic/claude-(opus|sonnet)-[4-9]",
  "^openai/gpt-[5-9]",
  "^openai/o[3-9]",
  "^google/gemini-[3-9]",
  "^moonshotai/kimi-k[2-9]",
  "^minimax/minimax-m[2-9]",
  "^qwen/qwen3",
  "^z-ai/glm-[5-9]",
];
// Drop OpenRouter routing variants that duplicate a base model id.
const DEFAULT_EXCLUDE = [":free$", ":nitro$"];

// ── Discovery control ────────────────────────────────────────────────────────

function discoveryEnabled(): boolean {
  const v = (process.env.CLOUDFLARE_DISCOVERY ?? "").trim().toLowerCase();
  // Default on. Explicit "off" / "0" / "false" disables.
  return v !== "off" && v !== "0" && v !== "false";
}

// ── Provider config (user-configurable) ─────────────────────────────────────

interface ProviderConfigFile {
  /** Override the API endpoint. Takes precedence over the composed default but
   * is itself overridden by the CLOUDFLARE_BASE_URL env var. */
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
 *   1. CLOUDFLARE_BASE_URL env var (quick temporary override, e.g. proxy)
 *   2. ~/.pi/agent/cloudflare-openrouter-config.json `baseUrl`
 *   3. default composed from CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_GATEWAY_ID
 *
 * `include`/`exclude` come from the config file only; absent/invalid file
 * falls back to defaults so pi still starts.
 */
function loadConfig(): ResolvedConfig {
  let file: ProviderConfigFile = {};
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", CONFIG_FILENAME), "utf8");
    file = JSON.parse(raw) as ProviderConfigFile;
  } catch {
    // Config-file errors are intentionally silent: any terminal output
    // (stdout *or* stderr) corrupts pi's TUI render. A malformed/missing
    // file simply falls back to defaults so pi still starts.
  }
  const baseUrl = process.env.CLOUDFLARE_BASE_URL || file.baseUrl || defaultBaseUrl();
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

// ── Static per-model profiles (overrides for quirks) ────────────────────────

type InputType = "text" | "image";

interface ModelProfile {
  /** Override input types; otherwise derived from the live response or heuristics. */
  input?: InputType[];
  /** Override reasoning flag; otherwise derived from supported_parameters / heuristics. */
  reasoning?: boolean;
  /** Override max output tokens (OpenRouter does not expose this reliably). */
  maxTokens?: number;
}

const PROFILES: Record<string, ModelProfile> = {
  // minimax-m3 is a non-reasoning multimodal model.
  "minimax/minimax-m3": { reasoning: false },
};

// Input-type heuristic — first match wins. Used only when the live response
// omits architecture.input_modalities.
const INPUT_HEURISTICS: [RegExp, InputType[]][] = [
  [/^anthropic\//, ["text", "image"]],
  [/^openai\//, ["text", "image"]],
  [/^google\//, ["text", "image"]],
  [/^moonshotai\//, ["text", "image"]],
  [/^minimax\/minimax-m3/, ["text", "image"]],
  [/^qwen\/qwen.*plus/, ["text", "image"]],
  [/^z-ai\//, ["text"]],
];

function guessInput(id: string): InputType[] {
  for (const [re, types] of INPUT_HEURISTICS) {
    if (re.test(id)) return types;
  }
  return ["text"];
}

// Reasoning heuristic — first match wins. Used only when the live response
// omits supported_parameters (or lacks "reasoning").
const REASONING_HEURISTICS: [RegExp, boolean][] = [
  [/^minimax\/minimax-m3$/, false],
  [/^minimax\/minimax-m2\./, true],
  [/^anthropic\/claude-(opus|sonnet)-[4-9]/, true],
  [/^openai\/(gpt-[5-9]|o[3-9])/, true],
  [/^google\/gemini-[3-9]/, true],
  [/^moonshotai\/kimi-k[2-9]/, true],
  [/^qwen\/qwen3/, true],
  [/^z-ai\/glm-[5-9]/, true],
];

function guessReasoning(id: string): boolean {
  for (const [re, v] of REASONING_HEURISTICS) {
    if (re.test(id)) return v;
  }
  return false;
}

// Max-output heuristic — OpenRouter does not expose max output tokens via
// /v1/models, so this supplies a per-vendor cap. Generous defaults avoid
// truncating reasoning output; pi clamps to contextWindow downstream.
const MAX_OUTPUT_HEURISTICS: [RegExp, number][] = [
  [/^anthropic\//, 128000],
  [/^openai\//, 128000],
  [/^google\//, 65536],
  [/^moonshotai\//, 262144],
  [/^minimax\//, 512000],
  [/^qwen\//, 65536],
  [/^z-ai\//, 1048576],
];

function guessMaxOutput(id: string): number {
  for (const [re, n] of MAX_OUTPUT_HEURISTICS) {
    if (re.test(id)) return n;
  }
  return 32768;
}

// Context-window heuristic — fallback only; OpenRouter exposes context_length.
const CONTEXT_HEURISTICS: [RegExp, number][] = [
  [/^anthropic\//, 200000],
  [/^openai\//, 128000],
  [/^google\//, 1048576],
  [/^moonshotai\//, 262144],
  [/^minimax\//, 1048576],
  [/^qwen\//, 1000000],
  [/^z-ai\//, 1048576],
];

function guessContext(id: string): number {
  for (const [re, n] of CONTEXT_HEURISTICS) {
    if (re.test(id)) return n;
  }
  return 128000;
}

// Pricing heuristic — fallback only; OpenRouter exposes per-token pricing.
// Values are USD per million tokens. 0 = unknown.
const PRICING_HEURISTICS: [RegExp, { in: number; out: number; cacheRead: number; cacheWrite: number }][] = [
  [/^anthropic\/claude-opus/, { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/^anthropic\/claude-sonnet/, { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/^openai\/gpt-[5-9]/, { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0 }],
  [/^google\/gemini.*pro/, { in: 2, out: 12, cacheRead: 0.2, cacheWrite: 0.375 }],
  [/^google\/gemini.*flash/, { in: 1.5, out: 9, cacheRead: 0.15, cacheWrite: 0.0833 }],
  [/^moonshotai\/kimi-k2\.[5-9]/, { in: 0.66, out: 3.41, cacheRead: 0.144, cacheWrite: 0 }],
  [/^minimax\/minimax-m3/, { in: 0.3, out: 1.2, cacheRead: 0.06, cacheWrite: 0 }],
  [/^qwen\/qwen3\.7-plus/, { in: 0.32, out: 1.28, cacheRead: 0.064, cacheWrite: 0.4 }],
  [/^qwen\/qwen3\.7-max/, { in: 1.25, out: 3.75, cacheRead: 0.25, cacheWrite: 1.5625 }],
  [/^z-ai\/glm-5\.[2-9]/, { in: 0.98, out: 3.08, cacheRead: 0.182, cacheWrite: 0 }],
  [/^z-ai\/glm-5\.1/, { in: 0.98, out: 3.08, cacheRead: 0.49, cacheWrite: 0 }],
];

function guessPricing(id: string): { in: number; out: number; cacheRead: number; cacheWrite: number } {
  for (const [re, p] of PRICING_HEURISTICS) {
    if (re.test(id)) return p;
  }
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
}

function displayName(id: string, name?: string): string {
  if (name && name.trim()) return name;
  // Turn "anthropic/claude-opus-4.6" into "Claude Opus 4.6" (drop vendor prefix).
  const tail = id.includes("/") ? id.split("/").slice(1).join("/") : id;
  return tail
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// ── Compat (see header comment) ──────────────────────────────────────────────

const BASE_COMPAT = {
  supportsDeveloperRole: true,
  maxTokensField: "max_completion_tokens" as const,
};

const REASONING_COMPAT = {
  ...BASE_COMPAT,
  thinkingFormat: "openrouter" as const,
};

// ── API key resolution (factory runs before pi injects auth) ─────────────────

function resolveApiKey(): string {
  if (process.env.CLOUDFLARE_API_KEY) return process.env.CLOUDFLARE_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const v = data["cloudflare-openrouter"];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.key === "string") return o.key;
      if (typeof o.apiKey === "string") return o.apiKey;
    }
  } catch {
    // ignore — fall through to empty key (discovery will fail, fallback used)
  }
  return "";
}

// ── Live discovery ───────────────────────────────────────────────────────────

/** Subset of OpenRouter's /v1/models entry that we parse. */
interface LiveModelEntry {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    cache_read?: string;
    cache_write?: string;
  };
  architecture?: {
    input_modalities?: string[];
  };
  supported_parameters?: string[];
}

/** Parse a per-token USD price string into USD per million tokens. */
function perTokenToPerMillion(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return n * 1_000_000;
}

async function fetchLiveModelIds(config: ResolvedConfig): Promise<LiveModelEntry[]> {
  const key = resolveApiKey();
  const resp = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: LiveModelEntry[] };
  const all = (data.data ?? []).filter((m) => typeof m.id === "string" && m.id);
  const ids = new Set(applyFilter(all.map((m) => m.id as string), config));
  if (ids.size === 0) {
    throw new Error(
      `no models after filter (include=${JSON.stringify(config.include.map((r) => r.source))})`,
    );
  }
  // Keep the full entries (deduped, filtered, sorted) so buildModel can read
  // the rich fields from the live response.
  const seen = new Set<string>();
  const out: LiveModelEntry[] = [];
  for (const m of all) {
    const id = m.id as string;
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
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
  // Loose on purpose: non-reasoning models carry BASE_COMPAT (no thinkingFormat)
  // while reasoning ones carry REASONING_COMPAT. Matches the pattern used by
  // the other providers in this repo.
  compat?: Record<string, unknown>;
}

function buildModelFromLive(entry: LiveModelEntry): ModelConfig {
  const id = entry.id as string;
  const profile = PROFILES[id] ?? {};

  // Input modalities: prefer live architecture.input_modalities, then profile, then heuristic.
  let input: InputType[];
  if (profile.input) {
    input = profile.input;
  } else if (entry.architecture?.input_modalities && entry.architecture.input_modalities.length > 0) {
    const mods = entry.architecture.input_modalities.map((m) => m.toLowerCase());
    input = mods.includes("image") ? ["text", "image"] : ["text"];
  } else {
    input = guessInput(id);
  }

  // Reasoning: prefer profile, then supported_parameters, then heuristic.
  let reasoning: boolean;
  if (profile.reasoning !== undefined) {
    reasoning = profile.reasoning;
  } else if (entry.supported_parameters && entry.supported_parameters.length > 0) {
    reasoning = entry.supported_parameters.some((p) => p.toLowerCase() === "reasoning");
  } else {
    reasoning = guessReasoning(id);
  }

  // Context window: prefer live context_length, then heuristic.
  const contextWindow =
    typeof entry.context_length === "number" && entry.context_length > 0
      ? entry.context_length
      : guessContext(id);

  // Max output: OpenRouter doesn't expose this; use profile, then heuristic,
  // clamped to contextWindow.
  const maxRaw = profile.maxTokens ?? guessMaxOutput(id);
  const maxTokens = Math.min(maxRaw, contextWindow);

  // Pricing: prefer live per-token pricing (converted to per-million),
  // then heuristic. Live zeros (free/unknown) fall back to heuristic.
  const liveIn = perTokenToPerMillion(entry.pricing?.prompt);
  const liveOut = perTokenToPerMillion(entry.pricing?.completion);
  const liveCR = perTokenToPerMillion(entry.pricing?.cache_read);
  const liveCW = perTokenToPerMillion(entry.pricing?.cache_write);
  const hp = guessPricing(id);
  const cost = {
    input: liveIn > 0 ? liveIn : hp.in,
    output: liveOut > 0 ? liveOut : hp.out,
    cacheRead: liveCR > 0 ? liveCR : hp.cacheRead,
    cacheWrite: liveCW > 0 ? liveCW : hp.cacheWrite,
  };

  return {
    id,
    name: displayName(id, entry.name),
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    compat: reasoning ? REASONING_COMPAT : BASE_COMPAT,
  };
}

function buildModelsFromLive(entries: LiveModelEntry[]): ModelConfig[] {
  return entries.map(buildModelFromLive);
}

// ── Static fallback snapshot ─────────────────────────────────────────────────
// Used only when discovery is off AND no cache is available. Kept in sync with
// the flagship models shipped at last release; live discovery supersedes it.

const FALLBACK_MODELS: ModelConfig[] = [
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: REASONING_COMPAT,
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
    compat: REASONING_COMPAT,
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
    contextWindow: 1048576,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0.0833 },
    contextWindow: 1048576,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.375, output: 2.025, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 256000,
    compat: REASONING_COMPAT,
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.66, output: 3.41, cacheRead: 0.144, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 262144,
    compat: REASONING_COMPAT,
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.68, output: 3.41, cacheRead: 0.144, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 262144,
    compat: REASONING_COMPAT,
  },
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.24, output: 0.96, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 196608,
    compat: REASONING_COMPAT,
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 512000,
    compat: BASE_COMPAT,
  },
  {
    id: "qwen/qwen3.7-plus",
    name: "Qwen3.7 Plus",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.32, output: 1.28, cacheRead: 0.064, cacheWrite: 0.4 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "qwen/qwen3.7-max",
    name: "Qwen3.7 Max",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.5625 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: REASONING_COMPAT,
  },
  {
    id: "z-ai/glm-5.1",
    name: "GLM 5.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.98, output: 3.08, cacheRead: 0.49, cacheWrite: 0 },
    contextWindow: 202752,
    maxTokens: 65535,
    compat: REASONING_COMPAT,
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.98, output: 3.08, cacheRead: 0.182, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 1048576,
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
  pi.registerProvider("cloudflare-openrouter", {
    name: "Cloudflare AI Gateway (OpenRouter)",
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
        /* silent */
      });
      source += " + background refresh";
    } else {
      source += " (discovery off)";
    }
  } else if (enabled) {
    // No cache: fetch synchronously so pi has a model list this session.
    try {
      const entries = await fetchLiveModelIds(config);
      models = buildModelsFromLive(entries);
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
    ctx.ui.notify(`[cloudflare-openrouter] model source: ${source}`, "info");
  });
}

/**
 * Background refresh: fetch the live model list and persist it to the cache
 * so the next startup picks up new models. The current session is not
 * re-registered (the captured `pi` would be stale after session replacement
 * or reload; re-registering mid-session is unsafe). Failures leave the
 * existing cache untouched.
 */
async function refreshInBackground(config: ResolvedConfig): Promise<void> {
  try {
    const entries = await fetchLiveModelIds(config);
    const live = buildModelsFromLive(entries);
    writeCache(live);
    // Silent: this runs as a fire-and-forget background task with no ctx,
    // so any terminal output (stdout/stderr) would corrupt pi's TUI. The
    // next session_start notify reflects the refreshed cache.
  } catch {
    // Silent on failure: keep the existing cache (see note above).
  }
}
