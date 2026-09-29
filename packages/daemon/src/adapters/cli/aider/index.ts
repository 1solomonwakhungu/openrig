// Aider runtime registration (`runtime: aider`).
// Reference: docs/reference/runtimes/aider.md.

import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import {
  AIDER_BINARY, AIDER_GUIDANCE_FILE, AIDER_INSTALL_HINT, AIDER_RESUME_TYPE, AIDER_RUNTIME_ID,
  aiderLaunchEnv, buildAiderArgv, captureAiderChatHistory, checkAiderResumeTarget, validateAiderChatHistoryToken,
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
  // The seat's own chat history file: aider writes its header at startup, so
  // this normally succeeds right after launch readiness.
  captureResumeToken: ({ seatStateDir }) =>
    captureAiderChatHistory({ fs: createNodeFsOps(), seatStateDir }) ?? null,
  supportsFork: false,
  guidanceFile: AIDER_GUIDANCE_FILE,
  // No skillsDir: aider has no skills location (honest skip).
  // The pane runs the Python interpreter (`Python` on macOS) with the aider
  // entry script, or `python -m aider`; matched on the script, never "python".
  processMatch: "aider",
};

export const AIDER_SPEC: TuiCliRuntimeSpec = {
  descriptor: AIDER_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource, seatStateDir }) =>
    buildAiderArgv({ model: binding.model, posture, seatStateDir, resumeToken, forkSource }),
  env: { set: ({ posture }) => aiderLaunchEnv(posture) },
  validateResumeTarget: ({ token, fs }) => {
    const checked = checkAiderResumeTarget(token, { fs });
    return checked.ok ? { ok: true } : { ok: false, reason: checked.error, recovery: checked.recovery };
  },
  readyPatterns: AIDER_READY_PATTERNS,
  gatePatterns: AIDER_GATE_PATTERNS,
  errorPatterns: AIDER_ERROR_PATTERNS,
};

export const AIDER_REGISTRATION: CliRuntimeRegistration = {
  descriptor: AIDER_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(AIDER_SPEC, deps),
};
