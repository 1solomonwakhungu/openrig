// Cline CLI runtime registration (`runtime: cline`).
// Reference: docs/reference/runtimes/cline.md.

import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import {
  CLINE_BINARY, CLINE_GUIDANCE_FILE, CLINE_INSTALL_HINT, CLINE_LAUNCH_ENV, CLINE_RESUME_TYPE, CLINE_RUNTIME_ID,
  buildClineArgv, validateClineSessionId,
} from "./launch.js";
import { checkClineResumeTarget, clineSessionsDir, findClineSessionForLaunch } from "./sessions.js";
import { CLINE_ERROR_PATTERNS, CLINE_GATE_PATTERNS, CLINE_READY_PATTERNS } from "./patterns.js";

export const CLINE_DESCRIPTOR: RuntimeDescriptor = {
  id: CLINE_RUNTIME_ID,
  displayName: "Cline CLI",
  kind: "agent",
  binary: CLINE_BINARY,
  installHint: CLINE_INSTALL_HINT,
  resumeType: CLINE_RESUME_TYPE,
  validateResumeToken: validateClineSessionId,
  // Sessions appear only after the first prompt, so this usually finds nothing
  // at launch and the refresher or restore captures the token later. Without a
  // launch time there is no safe attribution (sessions carry the shared hub's
  // pid), so capture waits for launch.json.
  captureResumeToken: ({ cwd, launchStartedAt, homedir }) => {
    if (!cwd || !launchStartedAt) return null;
    const found = findClineSessionForLaunch({
      fs: createNodeFsOps(),
      sessionsDir: clineSessionsDir(process.env, homedir),
      cwd,
      launchStartedAt,
    });
    return found.ok ? found.sessionId : null;
  },
  supportsFork: false,
  guidanceFile: CLINE_GUIDANCE_FILE,
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".cline", "skills"),
  // The pane runs `node .../cline/bin/cline` (script path), which spawns the
  // native `.../bin/.cline` (program path); "node" alone is not identity.
  processMatch: /(?:^|\/)\.?cline$/,
  // Not reaped on stop: while the TUI runs, cline's shared hub daemon is its
  // child, and reaping the pane's tree would kill the hub for every cline seat
  // on the host. tmux kill-session ends the TUI itself (verified).
  reapProcessTreeOnStop: false,
};

export const CLINE_SPEC: TuiCliRuntimeSpec = {
  descriptor: CLINE_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource }) =>
    buildClineArgv({ model: binding.model, posture, resumeToken, forkSource }),
  env: { set: () => ({ ...CLINE_LAUNCH_ENV }) },
  validateResumeTarget: ({ token, homedir, fs }) => {
    const checked = checkClineResumeTarget(token, { fs, env: process.env, homedir });
    return checked.ok ? { ok: true } : { ok: false, reason: checked.error, recovery: checked.recovery };
  },
  readyPatterns: CLINE_READY_PATTERNS,
  gatePatterns: CLINE_GATE_PATTERNS,
  errorPatterns: CLINE_ERROR_PATTERNS,
};

export const CLINE_REGISTRATION: CliRuntimeRegistration = {
  descriptor: CLINE_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(CLINE_SPEC, deps),
};
