// GitHub Copilot CLI runtime registration (`runtime: copilot`).
//
// The adapter mints the session UUID (`--session-id`), so the resume token is
// known at launch and never ambiguous between pod-mates sharing a cwd. Folder
// trust is provisioned by adding the seat cwd to `trustedFolders` in the
// owner's Copilot settings (merge-only), because `--yolo` does not skip the
// trust modal. See copilot-cli.ts for the verified CLI facts.

import fs from "node:fs";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import { LAUNCH_RECORD_FILE } from "../../../domain/runtime-capture.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { CliAdapterFsOps, CliRuntimeRegistration } from "../types.js";
import {
  COPILOT_BINARY, COPILOT_ERROR_PATTERNS, COPILOT_PROCESS_MATCH, COPILOT_GATE_PATTERNS, COPILOT_GUIDANCE_FILE, COPILOT_READY_PATTERNS,
  COPILOT_RESUME_TYPE, COPILOT_RUNTIME_ID, COPILOT_SKILLS_SUBDIR, buildCopilotArgv, captureCopilotSessionId,
  copilotHome, copilotResumeTargetExists, copilotSettingsPath, validateCopilotSessionId, verifyCopilotVersionOutput,
  type ReadOnlyFs,
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

/** The seat cwd as given plus its realpath, so a symlinked cwd is trusted too
 *  (same keys as the Claude adapter's workspace trust). */
function trustKeys(cwd: string): string[] {
  const keys = new Set([nodePath.resolve(cwd)]);
  try {
    keys.add(fs.realpathSync.native(cwd));
  } catch {
    // Best effort: a cwd that does not exist yet keeps the resolved key only.
  }
  return [...keys];
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
};

export const COPILOT_SPEC: TuiCliRuntimeSpec = {
  descriptor: COPILOT_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource, sessionToken }) =>
    buildCopilotArgv({ model: binding.model, posture, resumeToken, newSessionId: sessionToken, forkSource }),
  mintSessionToken: ({ forkSource }) => (forkSource ? undefined : randomUUID()),
  prepareLaunch: ({ binding, seatStateDir, fs: fsOps, env, homedir, mergeOwnerConfig }) => {
    const home = copilotHome(env, homedir);
    fsOps.mkdirp(seatStateDir);
    fsOps.writeFile(nodePath.join(seatStateDir, COPILOT_SEAT_FILE), `${JSON.stringify({ copilotHome: home })}\n`);
    mergeOwnerConfig(copilotSettingsPath(home), "json", (config) => {
      for (const key of trustKeys(binding.cwd)) config.addToList(["trustedFolders"], key);
    });
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
};

export const COPILOT_REGISTRATION: CliRuntimeRegistration = {
  descriptor: COPILOT_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(COPILOT_SPEC, deps),
};
