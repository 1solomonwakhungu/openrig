import type { Migration } from "../migrate.js";

// Runtime fallback (rig spec member fallback_runtimes). nodes.runtime holds the
// runtime actually running; declared_runtime keeps the spec's runtime when a
// fallback runs instead (NULL otherwise); fallback_runtimes is the member's
// ordered list as JSON (NULL when none). Both nullable: existing nodes are unchanged.
export const nodeRuntimeFallbackSchema: Migration = {
  name: "502_node_runtime_fallback.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN declared_runtime TEXT;
    ALTER TABLE nodes ADD COLUMN fallback_runtimes TEXT;
  `,
};
