// Token, cost, and context usage for an opencode or kilo seat, read from the
// seat's own session database (OPENCODE_DB / KILO_DB, opened read-only).
//
// opencode keeps running totals on the `session` row (migration
// 20260510033149_session_usage): `cost`, `tokens_input`, `tokens_output`,
// `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, and a JSON
// `model` ({ id, providerID }). The context size of the latest request is the
// latest assistant message's `$.tokens.input + $.tokens.cache.read` (message
// `data` JSON). No context window is stored, so it stays absent. A database
// from an opencode older than that migration has no such columns: the query
// fails and the reader returns null. Read-only; never throws.

import { compactUsage, usageNumber, type RuntimeUsageSnapshot } from "../usage-snapshot.js";
import type { SessionDbReader } from "./session-store.js";

export const OPENCODE_USAGE_SESSION_SQL =
  "SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model, time_updated FROM session WHERE id = ? LIMIT 1";

export const OPENCODE_USAGE_CONTEXT_SQL =
  "SELECT json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.cache.read') AS cache_read "
  + "FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' "
  + "ORDER BY time_created DESC, id DESC LIMIT 1";

export function readOpencodeUsage(input: {
  db: SessionDbReader | null;
  sessionId: string | null | undefined;
  source: string;
  now?: () => Date;
}): RuntimeUsageSnapshot | null {
  if (!input.db || !input.sessionId) return null;
  let row: Record<string, unknown> | undefined;
  let latest: Record<string, unknown> | undefined;
  try {
    row = input.db.get(OPENCODE_USAGE_SESSION_SQL, [input.sessionId]);
    if (!row) return null;
    latest = input.db.get(OPENCODE_USAGE_CONTEXT_SQL, [input.sessionId]);
  } catch {
    return null;
  }
  let model: string | undefined;
  try {
    const parsed = typeof row.model === "string" ? JSON.parse(row.model) as { id?: unknown; providerID?: unknown } : null;
    if (parsed && typeof parsed.id === "string") model = typeof parsed.providerID === "string" ? `${parsed.providerID}/${parsed.id}` : parsed.id;
  } catch {
    model = undefined;
  }
  const contextInput = usageNumber(latest?.input);
  const contextCache = usageNumber(latest?.cache_read);
  const updated = usageNumber(row.time_updated);
  return compactUsage({
    inputTokens: usageNumber(row.tokens_input),
    outputTokens: usageNumber(row.tokens_output),
    reasoningTokens: usageNumber(row.tokens_reasoning),
    cacheReadTokens: usageNumber(row.tokens_cache_read),
    cacheWriteTokens: usageNumber(row.tokens_cache_write),
    costUsd: usageNumber(row.cost),
    // opencode computes cost itself from its model price data.
    costSource: usageNumber(row.cost) !== undefined ? "cli_reported" : undefined,
    contextUsedTokens: contextInput !== undefined ? contextInput + (contextCache ?? 0) : undefined,
    model,
    observedAt: updated ? new Date(updated).toISOString() : (input.now ?? (() => new Date()))().toISOString(),
    source: input.source,
  });
}
