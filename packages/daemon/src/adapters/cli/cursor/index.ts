// Cursor CLI runtime registration (`runtime: cursor`).
//
// Cursor assigns the chat id itself, so prepareLaunch snapshots the chat ids
// that already exist for the seat cwd (and the config dir the launch env
// resolves), and capture takes the single chat created since that launch
// started (see pickNewCursorChat for the rule and its limit). Every launch
// passes `--trust`; it never launches the bare `agent` name. See cursor-cli.ts
// for the verified CLI facts.

import { activityMarkers } from "../activity-markers.js";
import fs from "node:fs";
import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import type { CliAdapterFsOps, CliRuntimeRegistration } from "../types.js";
import { cursorAuthStatus } from "../auth-status.js";
import {
  CURSOR_BINARY, CURSOR_GATE_PATTERNS, CURSOR_GUIDANCE_FILE, CURSOR_READY_PATTERNS, CURSOR_RESUME_TYPE,
  CURSOR_RUNTIME_ID, CURSOR_SKILLS_SUBDIR, buildCursorArgv, cursorChatsDirForCwd, cursorConfigDir,
  cursorResumeTargetExists, listCursorChatIds, parseCursorChatSnapshot, pickNewCursorChat,
  serializeCursorChatSnapshot, validateCursorChatId, verifyCursorVersionOutput, type CursorChatSnapshot,
  CURSOR_FULL_BYPASS_PERMISSION_VALUE,
} from "./cursor-cli.js";

/** Pre-launch chat ids for the seat cwd, kept in the seat state dir. */
export const CURSOR_CHAT_SNAPSHOT_FILE = "cursor-chats-before-launch.json";

function readSnapshot(fsOps: Pick<CliAdapterFsOps, "exists" | "readFile">, seatStateDir: string): CursorChatSnapshot | null {
  const file = nodePath.join(seatStateDir, CURSOR_CHAT_SNAPSHOT_FILE);
  try {
    return fsOps.exists(file) ? parseCursorChatSnapshot(fsOps.readFile(file)) : null;
  } catch {
    return null;
  }
}

/** The config dir this seat's launch resolved; the daemon env only when the
 *  seat has not recorded one (it is also the default launch env). */
function seatConfigDir(snapshot: CursorChatSnapshot | null, homedir: string): string {
  return snapshot?.configDir ?? cursorConfigDir(process.env, homedir);
}

/** When the chat's store was created: the birth time where the filesystem
 *  reports one (macOS, most Linux filesystems via statx). Where it is 0 this
 *  falls back to the change time, which moves on every write, so there the
 *  check only proves the store was touched after launch start: a chat created
 *  before launch and written to afterward can pass. The snapshot diff still
 *  excludes every chat that existed when the seat launched. */
function storeCreatedAt(chatsDir: string, chatId: string): Date | null {
  try {
    const stat = fs.statSync(nodePath.join(chatsDir, chatId, "store.db"));
    return new Date(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs);
  } catch {
    return null;
  }
}

export const CURSOR_DESCRIPTOR: RuntimeDescriptor = {
  id: CURSOR_RUNTIME_ID,
  displayName: "Cursor CLI",
  kind: "agent",
  binary: CURSOR_BINARY,
  installHint: "curl https://cursor.com/install -fsS | bash (it replaces ~/.local/bin/agent; see docs/reference/runtimes/cursor.md)",
  authStatus: cursorAuthStatus,
  docsPath: "docs/reference/runtimes/cursor.md",
  verify: async ({ exec }) => {
    try {
      return verifyCursorVersionOutput(await exec(`${CURSOR_BINARY} --version`));
    } catch (err) {
      return `\`${CURSOR_BINARY} --version\` failed: ${(err as Error).message}`;
    }
  },
  resumeType: CURSOR_RESUME_TYPE,
  validateResumeToken: validateCursorChatId,
  captureResumeToken: ({ cwd, seatStateDir, launchStartedAt, homedir }) => {
    if (!cwd) return null;
    const nodeFs = createNodeFsOps();
    const snapshot = readSnapshot(nodeFs, seatStateDir);
    if (!snapshot) return null;
    const chatsDir = cursorChatsDirForCwd(seatConfigDir(snapshot, homedir), cwd);
    return pickNewCursorChat({
      before: snapshot.chatIds,
      after: listCursorChatIds(nodeFs, chatsDir),
      launchStartedAt,
      createdAt: (chatId) => storeCreatedAt(chatsDir, chatId),
    });
  },
  supportsFork: false,
  // Each posture maps to distinct launch flags, so a seat may select either.
  permissionModes: ["floor", "full_bypass"],
  guidanceFile: CURSOR_GUIDANCE_FILE,
  skillsDir: ({ cwd }) => nodePath.join(cwd, ...CURSOR_SKILLS_SUBDIR),
  // The `cursor-agent` wrapper execs its bundled node under its own name
  // (`exec -a "$0"`), so the pane command is `node` while argv[0] stays
  // `cursor-agent`.
  processMatch: CURSOR_BINARY,
  reapProcessTreeOnStop: true,
  // Permission drift: only full_bypass emits a permission flag; the floor's
  // observation is state unknown (the CLI's own config governs) and never compared.
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === CURSOR_FULL_BYPASS_PERMISSION_VALUE ? "full_bypass" : null,
};

export const CURSOR_SPEC: TuiCliRuntimeSpec = {
  descriptor: CURSOR_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource }) =>
    buildCursorArgv({ model: binding.model, posture, resumeToken, forkSource }),
  prepareLaunch: ({ binding, seatStateDir, fs: fsOps, env, homedir }) => {
    const configDir = cursorConfigDir(env, homedir);
    const chatsDir = cursorChatsDirForCwd(configDir, binding.cwd);
    fsOps.mkdirp(seatStateDir);
    fsOps.writeFile(
      nodePath.join(seatStateDir, CURSOR_CHAT_SNAPSHOT_FILE),
      serializeCursorChatSnapshot({ chatIds: listCursorChatIds(fsOps, chatsDir), configDir }),
    );
  },
  // Runs before prepareLaunch rewrites the snapshot, so it reads the config
  // dir recorded by the launch that created the chat.
  validateResumeTarget: ({ token, cwd, seatStateDir, fs: fsOps, homedir }) =>
    cursorResumeTargetExists(fsOps, cursorChatsDirForCwd(seatConfigDir(readSnapshot(fsOps, seatStateDir), homedir), cwd), token)
      ? { ok: true }
      : { ok: false, reason: "the Cursor chat no longer exists for this workspace" },
  ...activityMarkers(CURSOR_RUNTIME_ID),
  readyPatterns: CURSOR_READY_PATTERNS,
  gatePatterns: CURSOR_GATE_PATTERNS,
  observeLaunch: ({ posture }): AppliedLaunchObservation => posture === "full_bypass"
    ? { runtime: CURSOR_DESCRIPTOR.id, axis: "permission", state: "observed", value: CURSOR_FULL_BYPASS_PERMISSION_VALUE, reason: "emitted_launch_arguments" }
    // The floor passes no permission flag: the CLI's own config governs.
    : { runtime: CURSOR_DESCRIPTOR.id, axis: "permission", state: "unknown", value: null, reason: "cli_config_governs" },
};

export const CURSOR_REGISTRATION: CliRuntimeRegistration = {
  descriptor: CURSOR_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(CURSOR_SPEC, deps),
};
