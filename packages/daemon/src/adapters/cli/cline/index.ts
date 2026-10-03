// Cline CLI runtime registration (`runtime: cline`).
// Reference: docs/reference/runtimes/cline.md.

import { activityMarkers } from "../activity-markers.js";
import { guidanceTargetDeps } from "../../../domain/guidance-target.js";
import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import {
  CLINE_BINARY, CLINE_GUIDANCE_FILE, CLINE_INSTALL_HINT, CLINE_LAUNCH_ENV, CLINE_PERMISSION_VALUES, CLINE_RESUME_TYPE, CLINE_RUNTIME_ID,
  buildClineArgv, clineVersionFloorError, validateClineSessionId,
} from "./launch.js";
import { checkClineResumeTarget, clineLaunchEnv, clineSessionsDir, findClineSessionForLaunch } from "./sessions.js";
import { CLINE_ERROR_PATTERNS, CLINE_GATE_PATTERNS, CLINE_READY_PATTERNS } from "./patterns.js";
import { readClineUsage } from "./usage.js";
import { readClineTranscript } from "./transcript.js";
import { clineSeatHubEnv, prepareClineSeatHub, recordClineVersion, type ClineHubFs, type ClineSeatHubDeps } from "./hub.js";
import { clineAuthStatus } from "../auth-status.js";
import { CLINE_MODEL_SHAPE } from "../model-shapes.js";

export const CLINE_DESCRIPTOR: RuntimeDescriptor = {
  id: CLINE_RUNTIME_ID,
  displayName: "Cline CLI",
  kind: "agent",
  binary: CLINE_BINARY,
  installHint: CLINE_INSTALL_HINT,
  authStatus: clineAuthStatus,
  docsPath: "docs/reference/runtimes/cline.md",
  modelShape: CLINE_MODEL_SHAPE,
  // The per-seat hub and the stop reap need cline >= CLINE_MIN_VERSION.
  verify: async ({ version }) => (version
    ? clineVersionFloorError(version)
    : `could not read the cline version; OpenRig needs cline >= the verified floor (install: ${CLINE_INSTALL_HINT})`),
  resumeType: CLINE_RESUME_TYPE,
  validateResumeToken: validateClineSessionId,
  // Sessions appear only after the first prompt, so this usually finds nothing
  // at launch and the refresher or restore captures the token later. Without a
  // launch time there is no safe attribution (sessions carry the hub's pid, not
  // the TUI's), so capture waits for launch.json.
  captureResumeToken: ({ cwd, launchStartedAt, homedir }) => {
    if (!cwd || !launchStartedAt) return null;
    const found = findClineSessionForLaunch({
      fs: createNodeFsOps(),
      sessionsDir: clineSessionsDir(clineLaunchEnv(), homedir),
      cwd,
      launchStartedAt,
    });
    return found.ok ? found.sessionId : null;
  },
  // Usage (feature 1): the seat session's record, keyed by its resume token.
  readUsage: ({ resumeToken, homedir }) => readClineUsage({
    fs: createNodeFsOps(),
    sessionsDir: clineSessionsDir(clineLaunchEnv(), homedir),
    sessionId: resumeToken,
  }),
  // Native transcript (feature 5): cline draws on the alternate screen, so
  // `rig transcript` reads the session's messages record instead of the pane.
  readTranscript: ({ cwd, launchStartedAt, homedir, resumeToken, since }) => readClineTranscript({
    fs: createNodeFsOps(),
    sessionsDir: clineSessionsDir(clineLaunchEnv(), homedir),
    resumeToken,
    cwd,
    launchStartedAt,
    since,
  }),
  supportsFork: false,
  // Each posture maps to distinct launch flags, so a seat may select either.
  permissionModes: ["floor", "full_bypass"],
  guidanceFile: CLINE_GUIDANCE_FILE,
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".cline", "skills"),
  // Cline reads AGENTS.md and its rules from the workspace root: the git top level of the
  // cwd, else the cwd (cli-v3.0.65 apps/cli/src/utils/helpers.ts resolveWorkspaceRoot, used
  // for rules at main.ts; AGENTS.md at sdk/packages/shared/src/storage/paths.ts
  // resolveRulesConfigSearchPaths). A seat in a repo subdirectory therefore gets its blocks
  // at the repo root, where cline actually reads them.
  guidanceRoot: ({ cwd }) => guidanceTargetDeps.toplevel(cwd) ?? cwd,
  // guidance.tracked_file redirect: a distinct rule file in .cline/rules, which cline loads
  // wholesale from the git top level (the cwd outside a repository), keyed by file name.
  trackedGuidanceRedirect: ({ cwd }) => nodePath.join(guidanceTargetDeps.toplevel(cwd) ?? cwd, ".cline", "rules", "openrig.md"),
  // The pane runs `node .../cline/bin/cline` (script path), which spawns the
  // native `.../bin/.cline` (program path); "node" alone is not identity.
  processMatch: /(?:^|\/)\.?cline$/,
  // Reaped on stop: each seat runs its own hub (hub.ts), a child of the seat's
  // TUI, which cline detaches so it would otherwise outlive `rig down`. The
  // reaper is PID-scoped and start-time checked, so it stops exactly this
  // seat's TUI and hub, never the owner's shared hub or another seat's.
  reapProcessTreeOnStop: true,
  // Permission drift: both postures pass `--auto-approve` explicitly, so both
  // observations map back to a posture.
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === CLINE_PERMISSION_VALUES.full_bypass ? "full_bypass"
      : observedValue === CLINE_PERMISSION_VALUES.floor ? "floor"
      : null,
};

/** The cline spec for an adapter env (the env the daemon launches seats
 *  from; process.env in production) and the adapter's file ops. */
export function createClineSpec(
  env: NodeJS.ProcessEnv = process.env,
  fsOps: ClineHubFs = createNodeFsOps(),
  hubDeps: ClineSeatHubDeps = {},
): TuiCliRuntimeSpec {
  return {
    descriptor: CLINE_DESCRIPTOR,
    buildLaunchCommand: ({ binding, posture, resumeToken, forkSource }) =>
      buildClineArgv({ model: binding.model, posture, resumeToken, forkSource }),
    // Every launch (fresh and resume) gets the seat's own hub.
    prepareLaunch: async ({ seatStateDir, fs }) => {
      await recordClineVersion(fs, seatStateDir, hubDeps);
      await prepareClineSeatHub(fs, seatStateDir, hubDeps);
    },
    env: { set: ({ seatStateDir }) => ({ ...CLINE_LAUNCH_ENV, ...clineSeatHubEnv(fsOps, seatStateDir) }) },
    validateResumeTarget: ({ token, homedir, fs }) => {
      const checked = checkClineResumeTarget(token, { fs, env, homedir });
      return checked.ok ? { ok: true } : { ok: false, reason: checked.error, recovery: checked.recovery };
    },
    ...activityMarkers(CLINE_RUNTIME_ID),
    readyPatterns: CLINE_READY_PATTERNS,
    gatePatterns: CLINE_GATE_PATTERNS,
    errorPatterns: CLINE_ERROR_PATTERNS,
    observeLaunch: ({ posture }): AppliedLaunchObservation => ({
      runtime: CLINE_DESCRIPTOR.id,
      axis: "permission",
      state: "observed",
      value: CLINE_PERMISSION_VALUES[posture],
      reason: "emitted_launch_arguments",
    }),
  };
}

export const CLINE_REGISTRATION: CliRuntimeRegistration = {
  descriptor: CLINE_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(createClineSpec(deps.env, deps.fsOps), deps),
};
