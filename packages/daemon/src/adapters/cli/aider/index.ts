// Aider runtime registration (`runtime: aider`).
// Reference: docs/reference/runtimes/aider.md.

import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import { seatStateDirFor } from "../../../domain/runtime-capture.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import {
  AIDER_BINARY, AIDER_FULL_BYPASS_PERMISSION_VALUE, AIDER_GUIDANCE_FILE, AIDER_INSTALL_HINT, AIDER_RESUME_TYPE, AIDER_RUNTIME_ID,
  aiderBypassDecision, aiderLaunchEnv, buildAiderArgv, captureAiderChatHistory, checkAiderResumeTarget, mintAiderChatHistoryFile,
  validateAiderChatHistoryToken,
} from "./launch.js";
import { AIDER_ERROR_PATTERNS, AIDER_GATE_PATTERNS, AIDER_READY_PATTERNS } from "./patterns.js";

export const AIDER_DESCRIPTOR: RuntimeDescriptor = {
  id: AIDER_RUNTIME_ID,
  displayName: "Aider",
  kind: "agent",
  binary: AIDER_BINARY,
  installHint: AIDER_INSTALL_HINT,
  resumeType: AIDER_RESUME_TYPE,
  validateResumeToken: validateAiderChatHistoryToken,
  // The history file minted for the seat's latest fresh launch (launch.json
  // presetToken). The base already reports the minted token at launch; this
  // covers late capture (refresher, restore). It reads only this seat's own
  // state dir, so pod-mates sharing a cwd cannot confuse it.
  captureIsSessionScoped: true,
  captureResumeToken: ({ seatStateDir }) =>
    captureAiderChatHistory({ fs: createNodeFsOps(), seatStateDir }) ?? null,
  supportsFork: false,
  guidanceFile: AIDER_GUIDANCE_FILE,
  // No skillsDir: aider has no skills location (honest skip).
  // The pane runs the Python interpreter (`Python` on macOS) with the aider
  // entry script, or `python -m aider`; matched on the script, never "python".
  processMatch: "aider",
  // Permission drift: only full_bypass emits a permission flag; the floor's
  // observation is state unknown (aider's config governs) and never compared.
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === AIDER_FULL_BYPASS_PERMISSION_VALUE ? "full_bypass" : null,
};

/** The aider spec for a daemon state root. `newId` is injectable for tests. */
export function createAiderSpec(stateRoot: string, newId?: () => string): TuiCliRuntimeSpec {
  return {
    descriptor: AIDER_DESCRIPTOR,
    buildLaunchCommand: ({ binding, posture, resumeToken, sessionToken, forkSource, seatStateDir }) =>
      buildAiderArgv({ model: binding.model, posture, seatStateDir, resumeToken, sessionToken, forkSource }),
    // Every fresh launch writes a new history file, so "fresh" stays fresh on
    // a later restore; the minted path is the launch's resume token.
    mintSessionToken: ({ binding }) => binding.tmuxSession
      ? mintAiderChatHistoryFile(seatStateDirFor(stateRoot, AIDER_DESCRIPTOR.id, binding.tmuxSession), newId?.())
      : undefined,
    env: { set: ({ posture }) => aiderLaunchEnv(posture) },
    validateResumeTarget: ({ token, fs }) => {
      const checked = checkAiderResumeTarget(token, { fs });
      return checked.ok ? { ok: true } : { ok: false, reason: checked.error, recovery: checked.recovery };
    },
    readyPatterns: AIDER_READY_PATTERNS,
    gatePatterns: AIDER_GATE_PATTERNS,
    errorPatterns: AIDER_ERROR_PATTERNS,
    observeLaunch: ({ posture, binding }): AppliedLaunchObservation => {
      const unknown = (reason: string): AppliedLaunchObservation =>
        ({ runtime: AIDER_DESCRIPTOR.id, axis: "permission", state: "unknown", value: null, reason });
      // The floor passes no permission flag: aider's own config governs.
      if (posture !== "full_bypass") return unknown("cli_config_governs");
      switch (aiderBypassDecision(binding.model)) {
        case "always":
          return { runtime: AIDER_DESCRIPTOR.id, axis: "permission", state: "observed", value: AIDER_FULL_BYPASS_PERMISSION_VALUE, reason: "emitted_launch_arguments" };
        // --yes-always withheld so it cannot accept aider's OpenRouter sign-in.
        case "never": return unknown("yes_always_withheld_onboarding");
        // The pane's shell decides from OPENROUTER_API_KEY; OpenRig cannot see which.
        case "in_pane": return unknown("yes_always_decided_in_pane");
      }
    },
  };
}

export const AIDER_REGISTRATION: CliRuntimeRegistration = {
  descriptor: AIDER_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(createAiderSpec(deps.stateRoot), deps),
};
