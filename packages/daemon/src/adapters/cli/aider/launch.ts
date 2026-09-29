// Aider (PyPI `aider-chat`, 0.86.x) launch argv, launch env, and resume rules.
//
// Verified live against aider 0.86.2 in an isolated prefix (see
// docs/reference/runtimes/aider.md):
// - `aider` opens the interactive prompt; there is no seed-and-stay flag.
// - Session-scoped flags only: `--no-check-update`, `--no-show-release-notes`,
//   and `--no-analytics` avoid first-run prompts and network checks without
//   writing global config (`--analytics-disable` would persist to ~/.aider).
//   `--no-gitignore` stops aider asking to add .aider* to the repo .gitignore;
//   the seat's history files live in the seat state dir, not the repo.
// - Aider has no session ids. Its only continuation is the chat history file
//   plus `--restore-chat-history`, so each seat gets its own history file and
//   that file's absolute path is the resume token.
// - Aider never reads AGENTS.md on its own; `--read AGENTS.md` loads the
//   managed guidance file as read-only context. A missing file prints
//   "Read-only file ... does not exist. Skipping." and aider carries on.
// - `--yes-always` is the auto-approve flag. No fork primitive.

import nodePath from "node:path";

export const AIDER_RUNTIME_ID = "aider";
export const AIDER_BINARY = "aider";
export const AIDER_RESUME_TYPE = "aider_chat_history_file";
export const AIDER_GUIDANCE_FILE = "AGENTS.md";
export const AIDER_INSTALL_HINT =
  "python -m pip install aider-install && aider-install (or: uv tool install --python 3.12 aider-chat)";

export const AIDER_CHAT_HISTORY_FILE = "aider.chat.history.md";
export const AIDER_INPUT_HISTORY_FILE = "aider.input.history";

export type AiderLaunchPosture = "floor" | "full_bypass";

export interface AiderForkRef {
  kind: string;
  value?: string;
}

export interface AiderArgvInput {
  model?: string | null;
  posture: AiderLaunchPosture;
  /** <stateRoot>/aider/<session name>, created before launch. */
  seatStateDir: string;
  /** A validated chat history file path (resume). */
  resumeToken?: string;
  forkSource?: AiderForkRef;
}

export function aiderSeatPaths(seatStateDir: string): { chatHistoryFile: string; inputHistoryFile: string } {
  return {
    chatHistoryFile: nodePath.join(seatStateDir, AIDER_CHAT_HISTORY_FILE),
    inputHistoryFile: nodePath.join(seatStateDir, AIDER_INPUT_HISTORY_FILE),
  };
}

export function buildAiderArgv(input: AiderArgvInput): string[] {
  if (input.forkSource) {
    throw new Error("aider has no native fork primitive; remove session_source for aider members");
  }
  const seat = aiderSeatPaths(input.seatStateDir);
  let chatHistoryFile = seat.chatHistoryFile;
  if (input.resumeToken !== undefined) {
    const validation = validateAiderChatHistoryToken(input.resumeToken);
    if (!validation.ok) throw new Error(validation.error);
    chatHistoryFile = validation.token;
  }
  const argv = [
    AIDER_BINARY,
    "--no-check-update",
    "--no-show-release-notes",
    "--no-analytics",
    "--no-gitignore",
    "--chat-history-file", chatHistoryFile,
    "--input-history-file", seat.inputHistoryFile,
    "--read", AIDER_GUIDANCE_FILE,
  ];
  const model = input.model?.trim();
  if (model) argv.push("--model", model);
  if (input.posture === "full_bypass") argv.push("--yes-always");
  if (input.resumeToken !== undefined) argv.push("--restore-chat-history");
  return argv;
}

/** Additive launch env. Under full_bypass, `--yes-always` also answers yes to
 *  aider's "Open documentation url for more info?" offers (for example after
 *  a missing API key warning), which calls Python's webbrowser.open. BROWSER=true
 *  makes that a no-op so a managed seat never opens a browser. */
export function aiderLaunchEnv(posture: AiderLaunchPosture): Record<string, string> {
  return posture === "full_bypass" ? { BROWSER: "true" } : {};
}

export type AiderTokenResult = { ok: true; token: string } | { ok: false; error: string };

// Same floor shape as the Pi session-file token: absolute, no ".." segment,
// shell-inert charset ("@" included because seat names are pod-member@rig).
const CHAT_HISTORY_CHARSET_RE = /^[A-Za-z0-9._/@-]+$/;
const MAX_CHAT_HISTORY_LEN = 1024;

/** Format floor for an aider chat history token. Never echoes the token. */
export function validateAiderChatHistoryToken(raw: string): AiderTokenResult {
  const token = raw.trim();
  if (!token) return { ok: false, error: "Resume token is empty." };
  if (token.length > MAX_CHAT_HISTORY_LEN) {
    return { ok: false, error: `Aider chat history token is too long (max ${MAX_CHAT_HISTORY_LEN} characters).` };
  }
  if (!token.startsWith("/")) {
    return { ok: false, error: "Aider chat history token must be an absolute path (starting with '/')." };
  }
  if (token.split("/").includes("..")) {
    return { ok: false, error: "Aider chat history token must not contain a '..' path segment." };
  }
  if (!CHAT_HISTORY_CHARSET_RE.test(token)) {
    return { ok: false, error: "Aider chat history token contains disallowed characters (allowed: letters, digits, '.', '_', '/', '@', '-')." };
  }
  if (!token.endsWith(".md")) {
    return { ok: false, error: "Aider chat history token must name a .md chat history file." };
  }
  return { ok: true, token };
}

export interface AiderFsOps {
  exists(path: string): boolean;
}

export type AiderResumeTargetResult =
  | { ok: true }
  | { ok: false; error: string; recovery: "retry_fresh" };

/** Pre-launch resume check. `--restore-chat-history` on a missing file starts
 *  an empty chat, which would be a silent fresh start; report retry_fresh. */
export function checkAiderResumeTarget(token: string, ctx: { fs: AiderFsOps }): AiderResumeTargetResult {
  const validation = validateAiderChatHistoryToken(token);
  if (!validation.ok) return { ok: false, error: validation.error, recovery: "retry_fresh" };
  if (!ctx.fs.exists(validation.token)) {
    return { ok: false, error: "the persisted aider chat history file no longer exists", recovery: "retry_fresh" };
  }
  return { ok: true };
}

/** Token capture: the seat's history file, once aider has written it (aider
 *  writes the "# aider chat started at" header at startup). */
export function captureAiderChatHistory(ctx: { fs: AiderFsOps; seatStateDir: string }): string | undefined {
  const { chatHistoryFile } = aiderSeatPaths(ctx.seatStateDir);
  if (!ctx.fs.exists(chatHistoryFile)) return undefined;
  return validateAiderChatHistoryToken(chatHistoryFile).ok ? chatHistoryFile : undefined;
}
