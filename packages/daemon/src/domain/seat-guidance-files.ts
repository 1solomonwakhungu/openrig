// The one resolver for which guidance files a seat's launch merges managed
// blocks into: the runtime's guidance file (under its guidanceRoot, such as
// Cline's git top level) and its guidance.tracked_file redirect alternate.
// Rig teardown and the runtime-fallback residue undo both read it, so they
// agree with each other and with delivery about where blocks can be.

import nodePath from "node:path";
import { CLAUDE_TRACKED_GUIDANCE_REDIRECT, guidanceTeardownTargets, type TrackedGuidancePolicy } from "./guidance-target.js";
import { DEFAULT_CLAUDE_MANAGED_BLOCK_FILE } from "./managed-blocks.js";
import { getRuntimeDescriptor } from "./runtime-registry.js";

export interface SeatGuidanceFiles {
  /** The guidance file delivery merges into, or null when the runtime has none. */
  targetPath: string | null;
  /** Where guidance.tracked_file: redirect writes instead, or null when none. */
  redirectPath: string | null;
}

export function seatGuidanceFiles(runtime: string, cwd: string, opts: { claudeManagedBlockFile?: string | null } = {}): SeatGuidanceFiles {
  if (runtime === "claude-code") {
    return {
      targetPath: nodePath.join(cwd, opts.claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE),
      redirectPath: nodePath.join(cwd, CLAUDE_TRACKED_GUIDANCE_REDIRECT),
    };
  }
  const descriptor = getRuntimeDescriptor(runtime);
  return {
    targetPath: descriptor?.guidanceFile ? nodePath.join(descriptor.guidanceRoot?.({ cwd }) ?? cwd, descriptor.guidanceFile) : null,
    redirectPath: descriptor?.trackedGuidanceRedirect?.({ cwd }) ?? null,
  };
}

/** The files a launch can have merged managed blocks into under the rig's
 *  tracked-file policy (a tracked file under skip/redirect is never written). */
export function seatGuidanceWriteTargets(runtime: string, cwd: string, opts: {
  claudeManagedBlockFile?: string | null;
  trackedFile?: TrackedGuidancePolicy | null;
} = {}): string[] {
  const files = seatGuidanceFiles(runtime, cwd, opts);
  if (!files.targetPath) return [];
  return guidanceTeardownTargets({ targetPath: files.targetPath, policy: opts.trackedFile, redirectPath: files.redirectPath });
}
