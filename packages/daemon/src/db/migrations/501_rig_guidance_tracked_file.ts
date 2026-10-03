import type { Migration } from "../migrate.js";

/**
 * rigs.guidance_tracked_file: the rig's `guidance.tracked_file` policy
 * (managed_block, skip, or redirect), written at instantiate time and read by
 * startup delivery, teardown, and export. NULL = managed_block (merge into
 * the runtime's guidance file as before). Mirrors migration 085.
 */
export const rigGuidanceTrackedFileSchema: Migration = {
  name: "501_rig_guidance_tracked_file.sql",
  sql: "ALTER TABLE rigs ADD COLUMN guidance_tracked_file TEXT;",
};
