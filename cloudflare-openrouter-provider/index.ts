/**
 * Cloudflare AI Gateway → OpenRouter Provider Extension
 *
 * Routes OpenRouter models through Cloudflare AI Gateway's OpenAI passthrough,
 * enabling unified billing or stored BYOK for all OpenRouter models.
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
 *
 * ## Auth Details
 *
 * - Base URL: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openrouter/v1
 * - API format: OpenAI Chat Completions (OpenRouter passthrough)
 * - Gateway auth: Authorization: Bearer header (CF AI Gateway Stored BYOK mode)
 * - Model IDs: OpenRouter format (e.g., anthropic/claude-opus-4.6)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Model Definitions
// =============================================================================

interface OpenRouterModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Model definitions from OpenRouter API (queried via CF AI Gateway).
 * Pricing: USD per million tokens.
 */
const MODELS: OpenRouterModelDef[] = [
  // ── Anthropic ──────────────────────────────────────────────────────
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  // ── OpenAI ─────────────────────────────────────────────────────────
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  // ── Google ─────────────────────────────────────────────────────────
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0.0833 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  // ── Moonshot (Kimi) ────────────────────────────────────────────────
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.375, output: 2.025, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 256000,
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.66, output: 3.41, cacheRead: 0.144, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 262144,
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.68, output: 3.41, cacheRead: 0.144, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 262144,
  },
  // ── MiniMax ────────────────────────────────────────────────────────
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.24, output: 0.96, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 196608,
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 512000,
  },
  // ── Qwen ───────────────────────────────────────────────────────────
  {
    id: "qwen/qwen3.7-plus",
    name: "Qwen3.7 Plus",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.32, output: 1.28, cacheRead: 0.064, cacheWrite: 0.4 },
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "qwen/qwen3.7-max",
    name: "Qwen3.7 Max",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.5625 },
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  // ── Z.ai (GLM) ─────────────────────────────────────────────────────
  {
    id: "z-ai/glm-5.1",
    name: "GLM 5.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.98, output: 3.08, cacheRead: 0.49, cacheWrite: 0 },
    contextWindow: 202752,
    maxTokens: 65535,
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.98, output: 3.08, cacheRead: 0.182, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 1048576,
  },
];

// =============================================================================
// Compat Settings
// =============================================================================

/**
 * Base compat for OpenRouter via Cloudflare AI Gateway.
 * OpenRouter uses OpenAI-compatible API with some specifics:
 * - Supports developer role (OpenAI-style)
 * - Uses max_completion_tokens (not max_tokens)
 */
const BASE_COMPAT = {
  supportsDeveloperRole: true,
  maxTokensField: "max_completion_tokens" as const,
};

/**
 * Reasoning compat: adds `thinkingFormat: "openrouter"` so pi sends
 * `reasoning: { effort: "high" }` in the request body for thinking models.
 */
const REASONING_COMPAT = {
  ...BASE_COMPAT,
  thinkingFormat: "openrouter" as const,
};

// =============================================================================
// Extension Entry Point
// =============================================================================

// Read account/gateway IDs from environment at load time
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "PLACEHOLDER";
const CLOUDFLARE_GATEWAY_ID = process.env.CLOUDFLARE_GATEWAY_ID || "PLACEHOLDER";
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/openrouter/v1`;

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cloudflare-openrouter", {
    name: "Cloudflare AI Gateway (OpenRouter)",
    baseUrl: BASE_URL,
    // Resolved from auth.json (via /login) or env var
    apiKey: "$CLOUDFLARE_API_KEY",
    api: "openai-completions",
    authHeader: true,

    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: m.reasoning ? REASONING_COMPAT : BASE_COMPAT,
    })),
  });
}
