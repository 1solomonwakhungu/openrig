// GitHub Copilot CLI runtime registration (`runtime: copilot`).
//
// The adapter mints the session UUID (`--session-id`), so the resume token is
// known at launch and never ambiguous between pod-mates sharing a cwd. Folder
// trust is answered in the dialog for the session only (a guarded gate answer
// in the base); OpenRig writes no Copilot config. See copilot-cli.ts for the
// verified CLI facts.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import { LAUNCH_RECORD_FILE } from "../../../domain/runtime-capture.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import type { CliAdapterFsOps, CliRuntimeRegistration } from "../types.js";
import {
  COPILOT_BINARY, COPILOT_ERROR_PATTERNS, COPILOT_GATE_PATTERNS, COPILOT_GUIDANCE_FILE, COPILOT_PROCESS_MATCH, COPILOT_READY_PATTERNS,
  COPILOT_RESUME_TYPE, COPILOT_RUNTIME_ID, COPILOT_SKILLS_SUBDIR, buildCopilotArgv, captureCopilotSessionId,
  copilotHome, copilotResumeTargetExists, validateCopilotSessionId, verifyCopilotVersionOutput,
  type ReadOnlyFs,
  COPILOT_FULL_BYPASS_PERMISSION_VALUE,
} from "./copilot-cli.js";

/** The token minted for the seat's current launch, from its launch.json. */
function presetTokenFor(fsOps: ReadOnlyFs, seatStateDir: string): string | undefined {
  const file = nodePath.join(seatStateDir, LAUNCH_RECORD_FILE);
  try {
    if (!fsOps.exists(file)) return undefined;
    const token = (JSON.parse(fsOps.readFile(file)) as { presetToken?: unknown }).presetToken;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The COPILOT_HOME this seat's launch resolved, kept in the seat state dir
 *  so capture and the resume check look where the seat's Copilot writes. */
export const COPILOT_SEAT_FILE = "copilot-seat.json";

/** The recorded home; the daemon env only when the seat has not recorded one
 *  (it is also the default launch env). */
function seatCopilotHome(fsOps: Pick<CliAdapterFsOps, "exists" | "readFile">, seatStateDir: string, homedir: string): string {
  const file = nodePath.join(seatStateDir, COPILOT_SEAT_FILE);
  try {
    if (fsOps.exists(file)) {
      const home = (JSON.parse(fsOps.readFile(file)) as { copilotHome?: unknown }).copilotHome;
      if (typeof home === "string" && home.trim()) return home;
    }
  } catch {
    // Fall through to the daemon env.
  }
  return copilotHome(process.env, homedir);
}

export const COPILOT_DESCRIPTOR: RuntimeDescriptor = {
  id: COPILOT_RUNTIME_ID,
  displayName: "GitHub Copilot CLI",
  kind: "agent",
  binary: COPILOT_BINARY,
  installHint: "npm install -g @github/copilot (or brew install --cask copilot-cli)",
  verify: async ({ exec }) => {
    try {
      return verifyCopilotVersionOutput(await exec(`${COPILOT_BINARY} --version`));
    } catch (err) {
      return `\`${COPILOT_BINARY} --version\` failed: ${(err as Error).message}`;
    }
  },
  resumeType: COPILOT_RESUME_TYPE,
  validateResumeToken: validateCopilotSessionId,
  captureResumeToken: ({ cwd, seatStateDir, launchStartedAt, homedir }) => {
    if (!cwd) return null;
    const nodeFs = createNodeFsOps();
    return captureCopilotSessionId({
      fs: nodeFs,
      home: seatCopilotHome(nodeFs, seatStateDir, homedir),
      cwd,
      mintedSessionId: presetTokenFor(nodeFs, seatStateDir),
      launchStartedAt,
    });
  },
  supportsFork: false,
  guidanceFile: COPILOT_GUIDANCE_FILE,
  skillsDir: ({ cwd }) => nodePath.join(cwd, ...COPILOT_SKILLS_SUBDIR),
  // Standalone installs run as `copilot`; the npm install shows `node`, so
  // discovery matches a program named `copilot` or one inside the
  // @github/copilot packages (not any script under a `copilot` directory).
  paneCommands: [COPILOT_BINARY],
  processMatch: COPILOT_PROCESS_MATCH,
  // The npm launcher spawns the native binary as a child.
  reapProcessTreeOnStop: true,
  // Permission drift: only full_bypass emits a permission flag; the floor's
  // observation is state unknown (the CLI's own config governs) and never compared.
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === COPILOT_FULL_BYPASS_PERMISSION_VALUE ? "full_bypass" : null,
};

export const COPILOT_SPEC: TuiCliRuntimeSpec = {
  descriptor: COPILOT_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource, sessionToken }) =>
    buildCopilotArgv({ model: binding.model, posture, resumeToken, newSessionId: sessionToken, forkSource }),
  mintSessionToken: ({ forkSource }) => (forkSource ? undefined : randomUUID()),
  // Records where this launch's Copilot keeps its state; no Copilot config is written.
  prepareLaunch: ({ seatStateDir, fs: fsOps, env, homedir }) => {
    fsOps.mkdirp(seatStateDir);
    fsOps.writeFile(nodePath.join(seatStateDir, COPILOT_SEAT_FILE), `${JSON.stringify({ copilotHome: copilotHome(env, homedir) })}\n`);
  },
  // Runs before prepareLaunch rewrites the seat file, so it reads the home
  // recorded by the launch that created the session.
  validateResumeTarget: ({ token, seatStateDir, fs: fsOps, homedir }) =>
    copilotResumeTargetExists(fsOps, seatCopilotHome(fsOps, seatStateDir, homedir), token)
      ? { ok: true }
      : { ok: false, reason: "the Copilot session no longer exists under session-state" },
  readyPatterns: COPILOT_READY_PATTERNS,
  gatePatterns: COPILOT_GATE_PATTERNS,
  errorPatterns: COPILOT_ERROR_PATTERNS,
  observeLaunch: ({ posture }): AppliedLaunchObservation => posture === "full_bypass"
    ? { runtime: COPILOT_DESCRIPTOR.id, axis: "permission", state: "observed", value: COPILOT_FULL_BYPASS_PERMISSION_VALUE, reason: "emitted_launch_arguments" }
    // The floor passes no permission flag: the CLI's own config governs.
    : { runtime: COPILOT_DESCRIPTOR.id, axis: "permission", state: "unknown", value: null, reason: "cli_config_governs" },
};

export const COPILOT_REGISTRATION: CliRuntimeRegistration = {
  descriptor: COPILOT_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(COPILOT_SPEC, deps),
};
