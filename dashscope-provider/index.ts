/**
 * DashScope (阿里云百炼) Provider Extension
 *
 * Provides access to Alibaba Cloud DashScope models (Qwen3.7 Max, Qwen3.7 Plus)
 * via the OpenAI-compatible API.
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
 * Copy this extension to ~/.pi/agent/extensions/ or .pi/extensions/, then:
 *   pi
 *   /login   (choose "Use an API key" → dashscope, or set DASHSCOPE_API_KEY env)
 *   /model dashscope/qwen3.7-max
 *
 * Or test directly:
 *   pi -e /path/to/dashscope-provider/index.ts
 *
 * ## Model Specifications (source: bailian console 2026-06)
 *
 * | Model         | Context  | Max Out | Image | Pricing (CNY in/out per 1M) |
 * |---------------|----------|---------|-------|-----------------------------|
 * | qwen3.7-max   | 991K     | 64K     | No    | ¥12 / ¥36                  |
 * | qwen3.7-plus  | 991K     | 64K     | Yes   | ¥2  / ¥8                   |
 *
 * ## API Details
 *
 * - Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
 * - API format: OpenAI Chat Completions compatible
 * - Auth: Bearer token via Authorization header
 * - Thinking: DashScope uses top-level `enable_thinking` parameter (thinkingFormat: "qwen")
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Model Definitions
// =============================================================================

/**
 * DashScope models.
 *
 * Pricing is approximate (USD per million tokens). Verify against
 * https://bailian.console.aliyun.com/ for current rates.
 */

interface DashScopeModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

// Qwen thinking format is binary (on/off) — pi sends `enable_thinking: true/false`.
// For binary-thinking models, all non-off levels map to the same "on" state,
// so we don't need a custom thinkingLevelMap. pi's default behavior handles it.

// Pricing: CNY → USD converted at ~0.14 rate (source: bailian console 2026-06)

const MODELS: DashScopeModel[] = [
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    reasoning: true,
    // Input: text only (official: 文本)
    input: ["text"],
    // Pricing: ¥12/¥36 per 1M tokens (cache read ¥2.4, explicit cache write ¥15)
    cost: { input: 1.67, output: 5.0, cacheRead: 0.33, cacheWrite: 2.08 },
    contextWindow: 1014784,  // 991K
    maxTokens: 65536,         // 64K
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    reasoning: true,
    // Input: text, image, video (official: 文本、图像、视频)
    input: ["text", "image"],
    // Pricing: ¥2/¥8 per 1M tokens (cache read ¥0.4, explicit cache write ¥2.5)
    cost: { input: 0.28, output: 1.11, cacheRead: 0.06, cacheWrite: 0.35 },
    contextWindow: 1014784,  // 991K
    maxTokens: 65536,         // 64K
  },
];

// =============================================================================
// Compat settings
// =============================================================================

/**
 * Base compat for all DashScope models.
 *
 * - supportsDeveloperRole: false — Qwen uses `system` role, not `developer`.
 * - requiresToolResultName: true — Qwen requires `name` field in tool results.
 * - maxTokensField: "max_tokens" — DashScope accepts `max_tokens`.
 */
const BASE_COMPAT = {
  supportsDeveloperRole: false,
  requiresToolResultName: true,
  maxTokensField: "max_tokens" as const,
} as const;

/**
 * Reasoning compat: adds `thinkingFormat: "qwen"` so pi sends
 * `enable_thinking: true/false` as a top-level request parameter.
 */
const REASONING_COMPAT = {
  ...BASE_COMPAT,
  thinkingFormat: "qwen" as const,
} as const;

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider("dashscope", {
    name: "DashScope (阿里云百炼)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // Falls back to DASHSCOPE_API_KEY env var when not configured via /login
    apiKey: "$DASHSCOPE_API_KEY",
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
