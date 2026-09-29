// Cursor CLI runtime registration (`runtime: cursor`).
//
// Cursor assigns the chat id itself, so prepareLaunch snapshots the chat ids
// that already exist for the seat cwd and capture takes the single chat that
// appeared since (null when none or several did). Every launch passes
// `--trust`; it never launches the bare `agent` name. See cursor-cli.ts for
// the verified CLI facts.

import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../../node-fs-ops.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { CliRuntimeRegistration } from "../types.js";
import {
  CURSOR_BINARY, CURSOR_GATE_PATTERNS, CURSOR_GUIDANCE_FILE, CURSOR_READY_PATTERNS, CURSOR_RESUME_TYPE,
  CURSOR_RUNTIME_ID, CURSOR_SKILLS_SUBDIR, buildCursorArgv, cursorChatsDirForCwd, cursorConfigDir,
  cursorResumeTargetExists, listCursorChatIds, parseCursorChatSnapshot, pickNewCursorChat,
  serializeCursorChatSnapshot, validateCursorChatId, verifyCursorVersionOutput,
} from "./cursor-cli.js";

/** Pre-launch chat ids for the seat cwd, kept in the seat state dir. */
export const CURSOR_CHAT_SNAPSHOT_FILE = "cursor-chats-before-launch.json";

export const CURSOR_DESCRIPTOR: RuntimeDescriptor = {
  id: CURSOR_RUNTIME_ID,
  displayName: "Cursor CLI",
  kind: "agent",
  binary: CURSOR_BINARY,
  installHint: "curl https://cursor.com/install -fsS | bash (it replaces ~/.local/bin/agent; see docs/reference/runtimes/cursor.md)",
  verify: async ({ exec }) => {
    try {
      return verifyCursorVersionOutput(await exec(`${CURSOR_BINARY} --version`));
    } catch (err) {
      return `\`${CURSOR_BINARY} --version\` failed: ${(err as Error).message}`;
    }
  },
  resumeType: CURSOR_RESUME_TYPE,
  validateResumeToken: validateCursorChatId,
  captureResumeToken: ({ cwd, seatStateDir, homedir }) => {
    if (!cwd) return null;
    const nodeFs = createNodeFsOps();
    try {
      const snapshotFile = nodePath.join(seatStateDir, CURSOR_CHAT_SNAPSHOT_FILE);
      if (!nodeFs.exists(snapshotFile)) return null;
      const before = parseCursorChatSnapshot(nodeFs.readFile(snapshotFile));
      if (!before) return null;
      const chatsDir = cursorChatsDirForCwd(cursorConfigDir(process.env, homedir), cwd);
      return pickNewCursorChat(before, listCursorChatIds(nodeFs, chatsDir));
    } catch {
      return null;
    }
  },
  supportsFork: false,
  guidanceFile: CURSOR_GUIDANCE_FILE,
  skillsDir: ({ cwd }) => nodePath.join(cwd, ...CURSOR_SKILLS_SUBDIR),
  // The `cursor-agent` wrapper execs its bundled node under its own name
  // (`exec -a "$0"`), so the pane command is `node` while argv[0] stays
  // `cursor-agent`.
  processMatch: CURSOR_BINARY,
  reapProcessTreeOnStop: true,
};

export const CURSOR_SPEC: TuiCliRuntimeSpec = {
  descriptor: CURSOR_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource }) =>
    buildCursorArgv({ model: binding.model, posture, resumeToken, forkSource }),
  prepareLaunch: ({ binding, seatStateDir, fs: fsOps, env, homedir }) => {
    const chatsDir = cursorChatsDirForCwd(cursorConfigDir(env, homedir), binding.cwd);
    fsOps.mkdirp(seatStateDir);
    fsOps.writeFile(
      nodePath.join(seatStateDir, CURSOR_CHAT_SNAPSHOT_FILE),
      serializeCursorChatSnapshot(listCursorChatIds(fsOps, chatsDir)),
    );
  },
  validateResumeTarget: ({ token, cwd, fs: fsOps, homedir }) =>
    cursorResumeTargetExists(fsOps, cursorChatsDirForCwd(cursorConfigDir(process.env, homedir), cwd), token)
      ? { ok: true }
      : { ok: false, reason: "the Cursor chat no longer exists for this workspace" },
  readyPatterns: CURSOR_READY_PATTERNS,
  gatePatterns: CURSOR_GATE_PATTERNS,
};

export const CURSOR_REGISTRATION: CliRuntimeRegistration = {
  descriptor: CURSOR_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(CURSOR_SPEC, deps),
};
