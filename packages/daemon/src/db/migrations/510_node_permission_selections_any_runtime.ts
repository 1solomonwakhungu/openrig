import type { Migration } from "../migrate.js";

// Per-seat permission selection for every runtime that declares permissionModes:
// drop the claude-code/codex CHECK on runtime and keep every existing row. The
// runtime and mode pair is validated against the registry on read and write.
export const nodePermissionSelectionsAnyRuntimeSchema: Migration = {
  name: "510_node_permission_selections_any_runtime.sql",
  sql: `
    CREATE TABLE node_permission_selections_next (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL,
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO node_permission_selections_next (node_id, runtime, mode, actor, reason, updated_at)
      SELECT node_id, runtime, mode, actor, reason, updated_at FROM node_permission_selections;
    DROP TABLE node_permission_selections;
    ALTER TABLE node_permission_selections_next RENAME TO node_permission_selections;
  `,
};
