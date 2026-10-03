// What a valid `model:` looks like for each registry CLI runtime (feature 7).
// Preflight uses these for a WARN-ONLY advisory: a seat whose model does not fit
// gets one warning with an example, and `rig up` continues. Shapes check the
// form of a name, not a list of current models, so they do not go stale when a
// provider ships a new model. Sources: each CLI's docs page under
// docs/reference/runtimes/ and the adapters' own argv builders.

import type { RuntimeModelShape } from "../../domain/runtime-capabilities.js";

/** A model id with no spaces or shell metacharacters. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;

/** opencode and kilo: `provider/model` (their argv builder refuses anything else). */
export const PROVIDER_SLASH_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._:@+/-]+$/,
  example: "anthropic/claude-sonnet-5",
  note: "provider/model",
};

/** gemini: a gemini-* model id or one of the CLI's aliases (auto, pro, flash,
 *  flash-lite: GEMINI_MODEL_ALIAS_* in the 0.61 source). */
export const GEMINI_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /^gemini-[a-z0-9][a-z0-9.-]*$/i,
  example: "pro",
  note: "a gemini-* model id or an alias (auto, pro, flash, flash-lite)",
  aliases: ["auto", "pro", "flash", "flash-lite"],
};

/** qwen: a model id of whichever provider is configured (any provider's naming). */
export const QWEN_MODEL_SHAPE: RuntimeModelShape = {
  pattern: PLAIN_ID,
  example: "qwen3-coder-plus",
  note: "a model id of the configured provider, without spaces",
};

/** copilot: a Copilot model id; no provider prefix (Copilot routes it). */
export const COPILOT_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  example: "gpt-5.4",
  note: "a Copilot model id without a provider prefix (see /model in copilot)",
};

/** cursor: a Cursor model id, optionally with bracketed overrides. */
export const CURSOR_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]\s]+\])?$/,
  example: "gpt-5",
  note: "a Cursor model id without a provider prefix (bracket overrides allowed)",
};

/** aider: any LiteLLM model name or one of aider's aliases (sonnet, opus, ...). */
export const AIDER_MODEL_SHAPE: RuntimeModelShape = {
  pattern: PLAIN_ID,
  example: "sonnet",
  note: "an aider alias such as sonnet, or a provider model name such as anthropic/<model>",
};

/** grok: an xAI grok-* model id. */
export const GROK_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /^grok-[a-z0-9][a-z0-9.-]*$/i,
  example: "grok-4",
  note: "a grok-* model id",
};

/** antigravity: a model slug from `agy models`. */
export const ANTIGRAVITY_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /^[a-z0-9][a-z0-9.-]*$/,
  example: "gemini-3.5-flash-medium",
  note: "a model slug from `agy models`",
};

/** cline: no per-seat model. Its launch refuses `model:` because `cline -m`
 *  would rewrite the operator's default (adapters/cli/cline/launch.ts), so
 *  every value gets the advisory before launch. */
export const CLINE_MODEL_SHAPE: RuntimeModelShape = {
  pattern: /(?!)/,
  example: "omit model: and run `cline auth <provider> -m <model>`",
  note: "no model: for cline seats (set the model in Cline itself)",
};
