// Goose runtime registration (`runtime: goose`).
//
// A fresh launch names the goose session after the seat (`--name <seat>`),
// and capture reads the seat's session id back from goose's sessions
// database, keyed to that name and the launch time; resume and fork use the
// exact id. OpenRig writes no goose config. See goose-cli.ts for the verified
// CLI facts.

import fs from "node:fs";
import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import type { CliAdapterFsOps, CliRuntimeRegistration } from "../types.js";
import {
  GOOSE_BINARY, GOOSE_BUSY_PATTERNS, GOOSE_ERROR_PATTERNS, GOOSE_FLOOR_MODE, GOOSE_FULL_BYPASS_MODE, GOOSE_GATE_PATTERNS, GOOSE_GUIDANCE_FILE,
  GOOSE_PROCESS_MATCH, GOOSE_READY_PATTERNS, GOOSE_RESUME_TYPE, GOOSE_RUNTIME_ID, GOOSE_SKILLS_SUBDIR,
  buildGooseArgv, captureGooseSessionId, readGooseUsage, gooseLaunchEnv, gooseModeFor, gooseSessionPresence, gooseSessionsDbPath,
  validateGooseSessionId, verifyGooseVersionOutput,
} from "./goose-cli.js";

/** Per-seat record of where this launch's goose keeps its sessions and, for
 *  a fork, the parent id, so capture reads the right database and rows. */
export const GOOSE_SEAT_FILE = "goose-seat.json";

interface GooseSeatRecord {
  sessionsDb?: string;
  forkParent?: string;
}

function readSeatRecord(fsOps: Pick<CliAdapterFsOps, "exists" | "readFile">, seatStateDir: string): GooseSeatRecord {
  const file = nodePath.join(seatStateDir, GOOSE_SEAT_FILE);
  try {
    if (!fsOps.exists(file)) return {};
    const record = JSON.parse(fsOps.readFile(file)) as Record<string, unknown>;
    return {
      sessionsDb: typeof record.sessionsDb === "string" && record.sessionsDb.trim() ? record.sessionsDb : undefined,
      forkParent: typeof record.forkParent === "string" && validateGooseSessionId(record.forkParent).ok ? record.forkParent : undefined,
    };
  } catch {
    return {};
  }
}

/** The recorded database; the daemon env only when the seat has not recorded one. */
function seatSessionsDb(fsOps: Pick<CliAdapterFsOps, "exists" | "readFile">, seatStateDir: string, homedir: string): string {
  return readSeatRecord(fsOps, seatStateDir).sessionsDb ?? gooseSessionsDbPath(process.env, homedir);
}

const nodeReadFs = {
  exists: (path: string) => fs.existsSync(path),
  readFile: (path: string) => fs.readFileSync(path, "utf-8"),
};

export const GOOSE_DESCRIPTOR: RuntimeDescriptor = {
  id: GOOSE_RUNTIME_ID,
  displayName: "Goose",
  kind: "agent",
  binary: GOOSE_BINARY,
  installHint: "brew install block-goose-cli (or download a release from https://github.com/aaif-goose/goose/releases)",
  verify: async ({ exec }) => {
    try {
      return verifyGooseVersionOutput(await exec(`${GOOSE_BINARY} --version`));
    } catch (err) {
      return `\`${GOOSE_BINARY} --version\` failed: ${(err as Error).message}`;
    }
  },
  resumeType: GOOSE_RESUME_TYPE,
  validateResumeToken: validateGooseSessionId,
  // Keyed to the seat: a fresh session carries the seat's own name, and a
  // fork copy must be the only one created since this seat's launch.
  captureIsSessionScoped: true,
  captureResumeToken: ({ sessionName, cwd, seatStateDir, launchStartedAt, homedir }) => {
    if (!cwd) return null;
    const record = readSeatRecord(nodeReadFs, seatStateDir);
    return captureGooseSessionId({
      dbPath: record.sessionsDb ?? gooseSessionsDbPath(process.env, homedir),
      deps: { exists: nodeReadFs.exists },
      seatName: sessionName,
      cwd,
      launchStartedAt,
      forkParent: record.forkParent,
    });
  },
  // Usage (feature 1): the session row's running totals and goose's own cost.
  readUsage: ({ seatStateDir, homedir, resumeToken }) => readGooseUsage({
    dbPath: seatSessionsDb(nodeReadFs, seatStateDir, homedir),
    deps: { exists: nodeReadFs.exists },
    sessionId: resumeToken,
  }),
  // Each posture sets its own GOOSE_MODE, so a seat may select either.
  permissionModes: ["floor", "full_bypass"],
  // All of a user's goose sessions share one database, so any seat can fork
  // another seat's session by id.
  supportsFork: true,
  guidanceFile: GOOSE_GUIDANCE_FILE,
  skillsDir: ({ cwd }) => nodePath.join(cwd, ...GOOSE_SKILLS_SUBDIR),
  paneCommands: [GOOSE_BINARY],
  processMatch: GOOSE_PROCESS_MATCH,
  // Permission drift: both postures set GOOSE_MODE, so both are observed.
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === `GOOSE_MODE=${GOOSE_FULL_BYPASS_MODE}` ? "full_bypass"
      : observedValue === `GOOSE_MODE=${GOOSE_FLOOR_MODE}` ? "floor"
        : null,
};

export const GOOSE_SPEC: TuiCliRuntimeSpec = {
  descriptor: GOOSE_DESCRIPTOR,
  buildLaunchCommand: ({ binding, resumeToken, forkSource }) =>
    buildGooseArgv({ seatName: binding.tmuxSession ?? "", model: binding.model, resumeToken, forkSource }),
  env: { set: ({ posture }) => gooseLaunchEnv(posture) },
  // Records where this launch's goose keeps its sessions; no goose config is written.
  prepareLaunch: ({ seatStateDir, fs: fsOps, env, homedir, mode, forkSource }) => {
    fsOps.mkdirp(seatStateDir);
    const record: GooseSeatRecord = { sessionsDb: gooseSessionsDbPath(env, homedir) };
    if (mode === "fork" && forkSource?.value) record.forkParent = forkSource.value.trim();
    fsOps.writeFile(nodePath.join(seatStateDir, GOOSE_SEAT_FILE), `${JSON.stringify(record)}\n`);
  },
  validateResumeTarget: ({ token, seatStateDir, fs: fsOps, homedir }) =>
    gooseSessionPresence(seatSessionsDb(fsOps, seatStateDir, homedir), token, { exists: (path) => fsOps.exists(path) }) !== "missing"
      ? { ok: true }
      : { ok: false, reason: "the goose session is not in goose's sessions database" },
  readyPatterns: GOOSE_READY_PATTERNS,
  busyPatterns: GOOSE_BUSY_PATTERNS,
  gatePatterns: GOOSE_GATE_PATTERNS,
  errorPatterns: GOOSE_ERROR_PATTERNS,
  observeLaunch: ({ posture }): AppliedLaunchObservation => ({
    runtime: GOOSE_DESCRIPTOR.id, axis: "permission", state: "observed", value: `GOOSE_MODE=${gooseModeFor(posture)}`, reason: "emitted_launch_env",
  }),
};

export const GOOSE_REGISTRATION: CliRuntimeRegistration = {
  descriptor: GOOSE_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(GOOSE_SPEC, deps),
};
