// Token, cost, and context usage a registry CLI runtime reports about one seat,
// read from the CLI's own on-disk records. Every metric is optional: a CLI
// that does not record something leaves it absent (never zero-filled), and a
// reader that finds nothing returns null.

export type { RuntimeUsageSnapshot } from "../../domain/runtime-capabilities.js";
import type { RuntimeUsageSnapshot } from "../../domain/runtime-capabilities.js";

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
