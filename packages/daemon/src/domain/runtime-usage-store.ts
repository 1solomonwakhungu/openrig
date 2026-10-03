// Feature 1: the latest usage a registry CLI runtime reports for a seat
// (runtime_usage, migration 505). Written by the context monitor's registry
// pass from the descriptor readUsage hook; read by the node inventory for
// `rig ps` (cost) and by consumers that need tokens. Absent metrics stay NULL.

import type Database from "better-sqlite3";
import type { RuntimeUsageSnapshot } from "./runtime-capabilities.js";

/** A stored reading; `approximate` and `reasoningTokens` are optional extras
 *  some readers report (aider's rounded counts, reasoning models). */
export type RuntimeUsageReading = RuntimeUsageSnapshot & { reasoningTokens?: number; approximate?: boolean };

export interface RuntimeUsageRecord extends RuntimeUsageReading {
  runtime: string;
  sessionName: string;
  /** When OpenRig read it (observedAt is the CLI's own record time). */
  readAt: string;
}

interface RuntimeUsageRow {
  node_id: string;
  session_name: string;
  runtime: string;
  source: string;
  observed_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  context_used_tokens: number | null;
  context_window_tokens: number | null;
  model: string | null;
  approximate: number;
  read_at: string;
}

const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

export class RuntimeUsageStore {
  constructor(private readonly db: Database.Database) {}

  persist(input: { nodeId: string; sessionName: string; runtime: string; reading: RuntimeUsageReading; readAt: string }): void {
    const r = input.reading;
    this.db.prepare(`
      INSERT INTO runtime_usage (
        node_id, session_name, runtime, source, observed_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd,
        context_used_tokens, context_window_tokens, model, approximate, read_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        session_name = excluded.session_name, runtime = excluded.runtime, source = excluded.source,
        observed_at = excluded.observed_at, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens, reasoning_tokens = excluded.reasoning_tokens,
        cost_usd = excluded.cost_usd, context_used_tokens = excluded.context_used_tokens,
        context_window_tokens = excluded.context_window_tokens, model = excluded.model,
        approximate = excluded.approximate, read_at = excluded.read_at
    `).run(
      input.nodeId, input.sessionName, input.runtime, r.source, r.observedAt,
      r.inputTokens ?? null, r.outputTokens ?? null, r.cacheReadTokens ?? null, r.cacheWriteTokens ?? null,
      r.reasoningTokens ?? null, r.costUsd ?? null, r.contextUsedTokens ?? null, r.contextWindowTokens ?? null,
      r.model ?? null, r.approximate ? 1 : 0, input.readAt,
    );
  }

  /** Latest reading per node, only when it belongs to the node's current session. */
  getForNodes(entries: Array<{ nodeId: string; currentSessionName: string | null }>): Map<string, RuntimeUsageRecord> {
    const result = new Map<string, RuntimeUsageRecord>();
    const wanted = entries.filter((e) => e.nodeId && e.currentSessionName);
    if (wanted.length === 0) return result;
    const rows = this.db.prepare(
      `SELECT * FROM runtime_usage WHERE node_id IN (${wanted.map(() => "?").join(",")})`,
    ).all(...wanted.map((e) => e.nodeId)) as RuntimeUsageRow[];
    const current = new Map(wanted.map((e) => [e.nodeId, e.currentSessionName]));
    for (const row of rows) {
      if (row.session_name !== current.get(row.node_id)) continue;
      const record: RuntimeUsageRecord = {
        runtime: row.runtime,
        sessionName: row.session_name,
        source: row.source,
        observedAt: row.observed_at,
        readAt: row.read_at,
        inputTokens: optional(row.input_tokens),
        outputTokens: optional(row.output_tokens),
        cacheReadTokens: optional(row.cache_read_tokens),
        cacheWriteTokens: optional(row.cache_write_tokens),
        reasoningTokens: optional(row.reasoning_tokens),
        costUsd: optional(row.cost_usd),
        contextUsedTokens: optional(row.context_used_tokens),
        contextWindowTokens: optional(row.context_window_tokens),
        model: optional(row.model),
        ...(row.approximate ? { approximate: true } : {}),
      };
      result.set(row.node_id, Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as RuntimeUsageRecord);
    }
    return result;
  }
}
