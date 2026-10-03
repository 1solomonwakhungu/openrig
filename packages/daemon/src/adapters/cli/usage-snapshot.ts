// Token, cost, and context usage a registry CLI runtime reports about one seat,
// read from the CLI's own on-disk records. Every metric is optional: a CLI
// that does not record something leaves it absent (never zero-filled), and a
// reader that finds nothing returns null.

export interface RuntimeUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Total cost in USD as the CLI computed it. */
  costUsd?: number;
  /** Tokens in the model's context for the latest request. */
  contextUsedTokens?: number;
  /** The model's context window, only when the CLI records it. */
  contextWindowTokens?: number;
  model?: string;
  /** ISO time of the CLI's own record when it has one, else the read time. */
  observedAt: string;
  /** Stable id of the record this came from, e.g. "cline_session_json". */
  source: string;
  /** True when the CLI only reports rounded figures (aider's "2.1k sent"). */
  approximate?: boolean;
}

/** A finite, non-negative number, else undefined. */
export function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Drop absent metrics; null when nothing but the bookkeeping fields is left. */
export function compactUsage(snapshot: RuntimeUsageSnapshot): RuntimeUsageSnapshot | null {
  const out = Object.fromEntries(Object.entries(snapshot).filter(([, v]) => v !== undefined)) as RuntimeUsageSnapshot;
  const metrics = Object.keys(out).filter((k) => !["observedAt", "source", "approximate", "model"].includes(k));
  return metrics.length > 0 ? out : null;
}
