import type { Migration } from "../migrate.js";

// Feature 1: the latest token, cost, and context usage a registry CLI runtime
// reports for a seat (read from the CLI's own records through the descriptor
// readUsage hook). One row per node, replaced on each read; absent metrics are
// NULL, never zero.
export const runtimeUsageSchema: Migration = {
  name: "505_runtime_usage.sql",
  sql: `
    CREATE TABLE runtime_usage (
      node_id                TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      session_name           TEXT NOT NULL,
      runtime                TEXT NOT NULL,
      source                 TEXT NOT NULL,
      observed_at            TEXT NOT NULL,
      input_tokens           INTEGER,
      output_tokens          INTEGER,
      cache_read_tokens      INTEGER,
      cache_write_tokens     INTEGER,
      reasoning_tokens       INTEGER,
      cost_usd               REAL,
      context_used_tokens    INTEGER,
      context_window_tokens  INTEGER,
      model                  TEXT,
      approximate            INTEGER NOT NULL DEFAULT 0,
      read_at                TEXT NOT NULL
    );
  `,
};
