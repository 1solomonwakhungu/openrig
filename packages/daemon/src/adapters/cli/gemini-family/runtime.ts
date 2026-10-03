// Shared TUI CLI spec and descriptor helpers for the Gemini CLI family
// (gemini, qwen). Each runtime module under adapters/cli/<id>/ supplies its
// dialect, pane patterns, and session-store lookups; this file wires them into
// the TuiCliRuntimeAdapter base.
//
// Runtime imports stay off domain/runtime-registry.ts (import discipline note
// there); descriptor types are type-only.

import fs from "node:fs";
import nodePath from "node:path";
import { LAUNCH_RECORD_FILE, type LaunchRecord } from "../../../domain/runtime-capture.js";
import type { RuntimeTokenCaptureInput, RuntimeVerifyContext } from "../../../domain/runtime-registry.js";
import type { TuiCliRuntimeSpec, TuiCliPrepareContext } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeAdapterDeps } from "../types.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import {
  buildGeminiFamilyArgv, mintSessionToken, validateSessionToken, type GeminiFamilyDialect,
} from "./launch-args.js";
import type { GeminiFamilyPanePatterns } from "./pane-patterns.js";
import {
  buildSeatSystemDefaults, npmContainmentEnv, operatorSystemDefaultsPath, seatNpmCache, seatNpmPrefix, seatSystemDefaultsPath,
  type AutoUpdateGuard,
} from "./auto-update.js";
import type { ResumeTargetCheck, SessionStoreContext, SessionStoreFs } from "./session-store.js";

/** Read-only node fs for descriptor hooks, which run outside any adapter
 *  instance (refresher, restore, adoption). */
export const NODE_SESSION_STORE_FS: SessionStoreFs = {
  readFile: (path) => fs.readFileSync(path, "utf-8"),
  exists: (path) => fs.existsSync(path),
  listFiles: (dir) => fs.readdirSync(dir),
};

export interface GeminiFamilyRuntime {
  dialect: GeminiFamilyDialect;
  patterns: GeminiFamilyPanePatterns;
  /** Resume precheck against the CLI's own session store. */
  checkResumeTarget(ctx: SessionStoreContext, sessionId: string): ResumeTargetCheck;
  /** Owner-state-safe provisioning before typing (e.g. a trust entry). */
  prepareLaunch?(ctx: TuiCliPrepareContext, store: SessionStoreContext): void;
  /** Literal env added to every launch (the pane env is otherwise inherited,
   *  so auth variables reach the CLI unchanged). */
  launchEnv?: Record<string, string>;
  /** Disables self-update via a seat system-defaults copy (auto-update.ts).
   *  Absent = the CLI ignores that layer (gemini); npm containment still applies. */
  autoUpdateGuard?: AutoUpdateGuard;
}

/** Write the seat's system-defaults file: the operator's defaults (read-only
 *  copy, when present) with auto-update off. Only the seat state dir is written. */
export function writeSeatSystemDefaults(ctx: TuiCliPrepareContext, guard: AutoUpdateGuard): void {
  const source = operatorSystemDefaultsPath(guard, ctx.env);
  let operatorText: string | null = null;
  try {
    if (ctx.fs.exists(source)) operatorText = ctx.fs.readFile(source);
  } catch {
    operatorText = null; // unreadable: the seat gets only the guard settings
  }
  const { content, copied } = buildSeatSystemDefaults(guard, operatorText);
  if (copied === "operator_defaults_unparseable") {
    console.log(`[openrig] ${guard.envVar}: operator system defaults at ${source} did not parse as JSON; the seat copy carries only the auto-update guard`);
  }
  ctx.fs.mkdirp(ctx.seatStateDir);
  ctx.fs.writeFile(seatSystemDefaultsPath(ctx.seatStateDir), content);
}

/** Build the TUI CLI spec for one runtime of the family. `deps` supplies the
 *  env the session-store lookups honor (GEMINI_CLI_HOME, QWEN_HOME, ...). */
export function createGeminiFamilySpec(
  descriptor: TuiCliRuntimeSpec["descriptor"],
  runtime: GeminiFamilyRuntime,
  deps: CliRuntimeAdapterDeps,
): TuiCliRuntimeSpec {
  const env = deps.env ?? process.env;
  const store = (cwd: string, fsOps: SessionStoreFs, homedir: string): SessionStoreContext => ({ cwd, homedir, fs: fsOps, env });
  const { dialect, patterns } = runtime;
  return {
    descriptor,
    buildLaunchCommand: ({ binding, posture, resumeToken, forkSource, sessionToken }) => {
      let forkParent: string | undefined;
      if (forkSource) {
        if (forkSource.kind !== "native_id" || !forkSource.value?.trim()) {
          throw new Error(`fork ref.kind="${forkSource.kind}" is not supported; use ref.kind="native_id" with the parent session id`);
        }
        forkParent = forkSource.value;
      }
      return buildGeminiFamilyArgv(dialect, { model: binding.model, posture, resumeToken, forkParent, sessionToken });
    },
    // Fresh launches only: both CLIs reject --session-id with --resume, and
    // qwen picks a fork child's id itself (captured late from its store).
    mintSessionToken: ({ forkSource }) => (forkSource ? undefined : mintSessionToken()),
    validateResumeTarget: ({ token, cwd, fs: fsOps, homedir }) => {
      const check = runtime.checkResumeTarget(store(cwd, fsOps, homedir), token);
      return check.ok ? { ok: true } : { ok: false, reason: check.reason, recovery: "retry_fresh" };
    },
    // Every launch (fresh, fork, resume) reads the seat's system-defaults copy.
    env: {
      set: ({ seatStateDir }) => ({
        ...runtime.launchEnv,
        ...npmContainmentEnv(seatStateDir),
        ...(runtime.autoUpdateGuard ? { [runtime.autoUpdateGuard.envVar]: seatSystemDefaultsPath(seatStateDir) } : {}),
      }),
    },
    // Independent steps: a failure in one never skips the other; the base logs
    // a thrown error and still launches.
    prepareLaunch: (ctx: TuiCliPrepareContext) => {
      const errors: unknown[] = [];
      const guard = runtime.autoUpdateGuard;
      const steps = [() => {
        ctx.fs.mkdirp(seatNpmPrefix(ctx.seatStateDir));
        ctx.fs.mkdirp(seatNpmCache(ctx.seatStateDir));
      }];
      if (guard) steps.push(() => writeSeatSystemDefaults(ctx, guard));
      if (runtime.prepareLaunch) steps.push(() => runtime.prepareLaunch!(ctx, store(ctx.binding.cwd, ctx.fs, ctx.homedir)));
      for (const step of steps) {
        try { step(); } catch (err) { errors.push(err); }
      }
      if (errors.length > 0) throw errors[0];
    },
    readyPatterns: patterns.readyPatterns,
    gatePatterns: patterns.gatePatterns,
    errorPatterns: patterns.errorPatterns,
    // Node startup plus the first screen takes a few seconds on a warm cache.
    launchTimeoutMs: 45_000,
    // Permission-drift observation of the approval mode actually passed on the
    // command line (buildGeminiFamilyArgv always passes one).
    observeLaunch: ({ posture }): AppliedLaunchObservation => ({
      runtime: descriptor.id,
      axis: "permission",
      state: "observed",
      value: posture === "full_bypass" ? "yolo" : dialect.floorApprovalMode,
      reason: "emitted_launch_arguments",
    }),
  };
}

/** The text of a session file located by `find`, or null. Read-only; never throws. */
export function readSessionText(
  find: (ctx: SessionStoreContext) => string | null,
  input: { cwd: string; homedir: string; env?: NodeJS.ProcessEnv; fs?: SessionStoreFs },
): string | null {
  const fsOps = input.fs ?? NODE_SESSION_STORE_FS;
  try {
    const path = find({ cwd: input.cwd, homedir: input.homedir, fs: fsOps, env: input.env ?? process.env });
    return path && fsOps.exists(path) ? fsOps.readFile(path) : null;
  } catch {
    return null;
  }
}

/** The launch record the TUI base wrote before typing, or null. */
export function readLaunchRecord(seatStateDir: string, fsOps: SessionStoreFs = NODE_SESSION_STORE_FS): Partial<LaunchRecord> | null {
  try {
    const record: unknown = JSON.parse(fsOps.readFile(nodePath.join(seatStateDir, LAUNCH_RECORD_FILE)));
    return typeof record === "object" && record !== null ? record as Partial<LaunchRecord> : null;
  } catch {
    return null;
  }
}

export interface GeminiFamilyCaptureOptions {
  /** Whether the CLI's store holds a session with this id (created at launch
   *  for gemini, at launch via runtime.json for qwen). */
  sessionExists(ctx: SessionStoreContext, sessionId: string): boolean;
  /** Fork launches: the child id the CLI picked, or null when ambiguous. */
  captureForkChild?(ctx: SessionStoreContext, launchStartedAt: Date): string | null;
  env?: NodeJS.ProcessEnv;
  fs?: SessionStoreFs;
}

/**
 * Descriptor capture hook (refresher, restore, adoption). It only ever reports
 * a token it can tie to THIS seat's launch, so it never replaces a good token
 * with a pod-mate's session in a shared cwd:
 * - fresh launch: the id minted into launch.json, once the CLI stored it;
 * - fork launch: the single child session started after the launch;
 * - resume launch or anything else: null (the persisted token stands).
 */
export function createGeminiFamilyCapture(options: GeminiFamilyCaptureOptions) {
  return (input: RuntimeTokenCaptureInput): string | null => {
    const fsOps = options.fs ?? NODE_SESSION_STORE_FS;
    const record = readLaunchRecord(input.seatStateDir, fsOps);
    const cwd = input.cwd ?? record?.cwd;
    if (!record || !cwd) return null;
    const ctx: SessionStoreContext = { cwd, homedir: input.homedir, fs: fsOps, env: options.env ?? process.env };
    if (record.mode === "fresh" && typeof record.presetToken === "string") {
      const validated = validateSessionToken(record.presetToken);
      return validated.ok && options.sessionExists(ctx, validated.token) ? validated.token : null;
    }
    if (record.mode === "fork" && options.captureForkChild && input.launchStartedAt) {
      return options.captureForkChild(ctx, input.launchStartedAt);
    }
    return null;
  };
}

/** Descriptor `permissionPostureFor`: the approval mode observeLaunch records,
 *  mapped back to the OpenRig posture that emits it. */
export function geminiFamilyPermissionPosture(dialect: GeminiFamilyDialect) {
  return (observedValue: string): ResolvedLaunchPosture | null => {
    if (observedValue === "yolo") return "full_bypass";
    if (observedValue === dialect.floorApprovalMode) return "floor";
    return null;
  };
}

/** `verify` hook: the CLI's Node engine floor, checked against the `node` the
 *  seat will run. An unresolvable `node` leaves the binary verification
 *  standing (the CLI itself reports the real problem at launch). */
export function nodeEngineFloorVerify(displayName: string, floorMajor: number) {
  return async ({ exec }: RuntimeVerifyContext): Promise<string | null> => {
    try {
      const match = (await exec("node --version")).match(/v?(\d+)\.(\d+)/);
      if (match && Number(match[1]) < floorMajor) {
        return `${displayName} requires Node >= ${floorMajor}; found ${match[0]}. Upgrade Node on the seat PATH.`;
      }
    } catch { /* see above */ }
    return null;
  };
}
