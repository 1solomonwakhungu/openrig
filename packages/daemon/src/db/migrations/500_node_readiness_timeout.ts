import type { Migration } from "../migrate.js";

// Per-seat launch readiness window (rig spec member readiness_timeout_ms).
// Nullable: null means the built-in defaults, so existing nodes are unchanged.
export const nodeReadinessTimeoutSchema: Migration = {
  name: "500_node_readiness_timeout.sql",
  sql: "ALTER TABLE nodes ADD COLUMN readiness_timeout_ms INTEGER;",
};
