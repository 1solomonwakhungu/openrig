// Token and cost usage for a cline seat, read from cline's own session record
// (<sessions dir>/<id>/<id>.json). Verified against cline 3.0.65: the record's
// `metadata` carries `usage` and `aggregateUsage` objects ({ inputTokens,
// outputTokens, cacheReadTokens, cacheWriteTokens, totalCost }), `totalCost`,
// and `model`. `usage` is this session's own requests; `aggregateUsage` adds
// any agents it spawned, so it is what the seat actually spent. cline records
// no context window and no per-request context size, so those stay absent.
// Read-only; never throws.

import { clineSessionMetadataPath, type ClineSessionFsOps } from "./sessions.js";
import { validateClineSessionId } from "./launch.js";
import { compactUsage, usageNumber, type RuntimeUsageSnapshot } from "../usage-snapshot.js";

export const CLINE_USAGE_SOURCE = "cline_session_json";

interface ClineUsageRecord {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  totalCost?: unknown;
}

export function readClineUsage(input: {
  fs: ClineSessionFsOps;
  sessionsDir: string;
  sessionId: string | null | undefined;
  now?: () => Date;
}): RuntimeUsageSnapshot | null {
  if (!input.sessionId || !validateClineSessionId(input.sessionId).ok) return null;
  const path = clineSessionMetadataPath(input.sessionsDir, input.sessionId.trim());
  let record: { metadata?: Record<string, unknown>; model?: unknown; started_at?: unknown };
  try {
    if (!input.fs.exists(path)) return null;
    record = JSON.parse(input.fs.readFile(path)) as typeof record;
  } catch {
    return null;
  }
  const metadata = record.metadata ?? {};
  const usage = (metadata.aggregateUsage ?? metadata.usage) as ClineUsageRecord | undefined;
  if (!usage || typeof usage !== "object") return null;
  const model = typeof metadata.model === "string" ? metadata.model : typeof record.model === "string" ? record.model : undefined;
  return compactUsage({
    inputTokens: usageNumber(usage.inputTokens),
    outputTokens: usageNumber(usage.outputTokens),
    cacheReadTokens: usageNumber(usage.cacheReadTokens),
    cacheWriteTokens: usageNumber(usage.cacheWriteTokens),
    costUsd: usageNumber(usage.totalCost) ?? usageNumber(metadata.totalCost),
    model,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    source: CLINE_USAGE_SOURCE,
  });
}
