// OpenCode-family runtime registration: one descriptor and TUI spec per
// variant (opencode, kilo), built from the shared pieces in family.ts and
// session-store.ts on the TuiCliRuntimeAdapter base.
//
// Runtime imports stay off domain/runtime-registry.ts (import discipline, see
// adapters/cli/types.ts): the registry imports this module through the index.

import fs from "node:fs";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import {
  OPENCODE_FAMILY_ERROR_PATTERNS,
  OPENCODE_FAMILY_GUIDANCE_FILE,
  OPENCODE_FAMILY_READY_PATTERNS,
  buildOpencodeFamilyArgv,
  opencodeFamilyDbPath,
  opencodeFamilySeatEnv,
  opencodeFamilySkillsDir,
  validateOpencodeSessionId,
  type OpencodeFamilyVariant,
} from "./family.js";
import { readCurrentSessionId, sessionPresence } from "./session-store.js";

export function createOpencodeFamilyDescriptor(variant: OpencodeFamilyVariant): RuntimeDescriptor {
  return {
    id: variant.id,
    displayName: variant.displayName,
    kind: "agent",
    binary: variant.binary,
    installHint: variant.installHint,
    resumeType: `${variant.id.replace(/-/g, "_")}_session_id`,
    validateResumeToken: validateOpencodeSessionId,
    // Sessions appear on the first prompt, so this usually finds nothing right
    // after launch; the refresher and restore call it again later. Read-only.
    captureResumeToken: ({ seatStateDir, launchStartedAt }) => {
      const current = readCurrentSessionId(
        opencodeFamilyDbPath(variant, seatStateDir),
        { exists: (path) => fs.existsSync(path) },
        launchStartedAt,
      );
      return current.ok ? current.token : null;
    },
    // Capture reads this seat's own session database (OPENCODE_DB / KILO_DB
    // under the seat state dir), so pod-mates in the same cwd cannot confuse
    // it and the sibling-seat guard does not apply.
    captureIsSessionScoped: true,
    // Each seat has its own session database, so a parent session from
    // another seat is not visible to `--fork`.
    supportsFork: false,
    guidanceFile: OPENCODE_FAMILY_GUIDANCE_FILE,
    skillsDir: ({ cwd }) => opencodeFamilySkillsDir(variant, cwd),
    paneCommands: variant.paneCommands,
    processMatch: variant.processMatch,
    // LSP servers and MCP servers run as child processes of the TUI.
    reapProcessTreeOnStop: true,
  };
}

export function createOpencodeFamilySpec(variant: OpencodeFamilyVariant, descriptor: RuntimeDescriptor): TuiCliRuntimeSpec {
  return {
    descriptor,
    buildLaunchCommand: ({ binding, posture, resumeToken, forkSource }) =>
      buildOpencodeFamilyArgv(variant, { model: binding.model, posture, resumeToken, forkSource }),
    // The pane env is inherited (provider keys, auth), plus the per-seat
    // session database on fresh and resume launches alike.
    env: { set: ({ seatStateDir }) => opencodeFamilySeatEnv(variant, seatStateDir) },
    validateResumeTarget: ({ token, seatStateDir }) => {
      const dbPath = opencodeFamilyDbPath(variant, seatStateDir);
      if (sessionPresence(dbPath, token, { exists: (path) => fs.existsSync(path) }) !== "missing") return { ok: true };
      return {
        ok: false,
        reason: `${variant.id} resume: the session is not in this seat's session database`,
        recovery: "retry_fresh",
      };
    },
    readyPatterns: OPENCODE_FAMILY_READY_PATTERNS,
    // Neither CLI shows a trust or login modal (unauthenticated launches use
    // free models), so there are no gate patterns.
    errorPatterns: OPENCODE_FAMILY_ERROR_PATTERNS.map(({ pattern, reason, recovery }) => ({
      pattern,
      reason,
      recovery,
      code: recovery === "retry_fresh" ? "session_missing" : undefined,
    })),
    observeLaunch: ({ posture }): AppliedLaunchObservation => posture === "full_bypass"
      ? { runtime: variant.id, axis: "permission", state: "observed", value: "auto", reason: "emitted_launch_arguments" }
      // The floor passes no permission flag: the CLI's own permission config governs.
      : { runtime: variant.id, axis: "permission", state: "unknown", value: null, reason: "cli_config_governs" },
  };
}

export function createOpencodeFamilyRegistration(variant: OpencodeFamilyVariant): CliRuntimeRegistration {
  const descriptor = createOpencodeFamilyDescriptor(variant);
  const spec = createOpencodeFamilySpec(variant, descriptor);
  return { descriptor, createAdapter: (deps) => new TuiCliRuntimeAdapter(spec, deps) };
}
