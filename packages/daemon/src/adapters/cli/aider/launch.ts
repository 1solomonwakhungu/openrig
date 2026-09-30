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
//   plus `--restore-chat-history`. Each fresh launch gets its own history file
//   in the seat state dir (minted before launch, so a later restore never
//   brings back a conversation from before a fresh start), and that file's
//   absolute path is the resume token.
// - Aider never reads AGENTS.md on its own; `--read AGENTS.md` loads the
//   managed guidance file as read-only context. A missing file prints
//   "Read-only file ... does not exist. Skipping." and aider carries on.
// - `--yes-always` is the auto-approve flag. No fork primitive.
// - Self-update and auto-install: with the update check on, aider offers
//   `pip install --upgrade aider-chat` at launch; it also offers pip installs
//   for bedrock/ and vertex_ai/ model deps (launch), Playwright plus Chromium
//   (`/web` or a URL in chat, `playwright install --with-deps`), and /help
//   extras. `--yes-always` accepts every one. Managed seats pass
//   `--no-check-update` and `--disable-playwright`, and launch with
//   PIP_REQUIRE_VIRTUALENV=true so any remaining pip install can only touch a
//   virtualenv (aider's own tool venv), never the owner's global Python.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";

export const AIDER_RUNTIME_ID = "aider";
export const AIDER_BINARY = "aider";
export const AIDER_RESUME_TYPE = "aider_chat_history_file";
export const AIDER_GUIDANCE_FILE = "AGENTS.md";
export const AIDER_INSTALL_HINT =
  "python -m pip install aider-install && aider-install (or: uv tool install --python 3.12 aider-chat)";

/** Fallback history file when no per-launch file was minted (pure argv use). */
export const AIDER_CHAT_HISTORY_FILE = "aider.chat.history.md";
/** Prompt recall (up-arrow) history, shared across the seat's launches. */
export const AIDER_INPUT_HISTORY_FILE = "aider.input.history";

const LAUNCH_RECORD_FILE = "launch.json";

export type AiderLaunchPosture = "floor" | "full_bypass";

/** The permission value full_bypass emits (`--yes-always`), as recorded for
 *  permission drift. The floor emits no permission flag: `--yes-always` has no
 *  negation, so aider's own config (.aider.conf.yml, AIDER_YES_ALWAYS) governs. */
export const AIDER_FULL_BYPASS_PERMISSION_VALUE = "yes-always";

/**
 * Whether full_bypass may pass `--yes-always` for this launch. aider has no
 * knob that disables its OpenRouter onboarding, which offers "Login to
 * OpenRouter or create a free account?" and runs an OAuth sign-in (a local
 * callback server, then a key saved to ~/.aider/oauth-keys.env) when accepted.
 * It is offered when no --model is given and no provider key is found, and for
 * an openrouter/ model when OPENROUTER_API_KEY is missing (aider onboarding.py
 * select_default_model, main.py). `--yes-always` would accept it unattended, so
 * it is withheld in those cases; the offer then waits in the pane as a
 * login_required gate.
 */
export function aiderBypassAllowed(input: { model?: string | null; env: NodeJS.ProcessEnv }): boolean {
  const model = input.model?.trim();
  if (!model) return false;
  if (model.startsWith("openrouter/")) return !!input.env.OPENROUTER_API_KEY?.trim();
  return true;
}

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
  /** The per-launch history file minted for a fresh launch. */
  sessionToken?: string;
  /** full_bypass only: false withholds `--yes-always` (see aiderBypassAllowed). */
  bypassAllowed?: boolean;
  forkSource?: AiderForkRef;
}

export function aiderSeatPaths(seatStateDir: string): { chatHistoryFile: string; inputHistoryFile: string } {
  return {
    chatHistoryFile: nodePath.join(seatStateDir, AIDER_CHAT_HISTORY_FILE),
    inputHistoryFile: nodePath.join(seatStateDir, AIDER_INPUT_HISTORY_FILE),
  };
}

/** A new history file for one fresh launch: <seat>/aider.chat.history.<id>.md. */
export function mintAiderChatHistoryFile(seatStateDir: string, id: string = randomUUID()): string {
  return nodePath.join(seatStateDir, `aider.chat.history.${id}.md`);
}

export function buildAiderArgv(input: AiderArgvInput): string[] {
  if (input.forkSource) {
    throw new Error("aider has no native fork primitive; remove session_source for aider members");
  }
  const seat = aiderSeatPaths(input.seatStateDir);
  let chatHistoryFile = seat.chatHistoryFile;
  const token = input.resumeToken ?? input.sessionToken;
  if (token !== undefined) {
    const validation = validateAiderChatHistoryToken(token);
    if (!validation.ok) throw new Error(validation.error);
    chatHistoryFile = validation.token;
  }
  const argv = [
    AIDER_BINARY,
    "--no-check-update",
    "--no-show-release-notes",
    "--no-analytics",
    "--no-gitignore",
    "--disable-playwright",
    "--chat-history-file", chatHistoryFile,
    "--input-history-file", seat.inputHistoryFile,
    "--read", AIDER_GUIDANCE_FILE,
  ];
  const model = input.model?.trim();
  if (model) argv.push("--model", model);
  if (input.posture === "full_bypass" && input.bypassAllowed !== false) argv.push(`--${AIDER_FULL_BYPASS_PERMISSION_VALUE}`);
  if (input.resumeToken !== undefined) argv.push("--restore-chat-history");
  return argv;
}

/** Additive launch env, applied on every launch (fresh and resume).
 *  - PIP_REQUIRE_VIRTUALENV=true: pip refuses to install outside a virtualenv,
 *    so an aider-offered pip install (model deps, /help extras) can never write
 *    into the owner's global or Homebrew Python (verified live). A uv or pipx
 *    install is a virtualenv and is unaffected.
 *  - BROWSER=true (full_bypass only): `--yes-always` also answers yes to
 *    aider's "Open documentation url for more info?" offers (for example after
 *    a missing API key warning), which call Python's webbrowser.open; this
 *    makes that a no-op so a managed seat never opens a browser. */
export function aiderLaunchEnv(posture: AiderLaunchPosture): Record<string, string> {
  return {
    PIP_REQUIRE_VIRTUALENV: "true",
    ...(posture === "full_bypass" ? { BROWSER: "true" } : {}),
  };
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
  readFile(path: string): string;
}

/** aider writes each user message to the chat history as a "#### <text>" line
 *  (the startup header and tool output are "#" and "> " lines). */
const USER_MESSAGE_RE = /^#### \S/m;

/** Whether a chat history file holds a real exchange (at least one user
 *  message). A seat that never got a prompt has only the startup header, and
 *  restoring it would bring nothing back. Never throws. */
export function hasAiderExchange(fs: AiderFsOps, file: string): boolean {
  try {
    return fs.exists(file) && USER_MESSAGE_RE.test(fs.readFile(file));
  } catch {
    return false;
  }
}

export type AiderResumeTargetResult =
  | { ok: true }
  | { ok: false; error: string; recovery: "retry_fresh" };

/** Pre-launch resume check. `--restore-chat-history` on a missing file, or on
 *  one with no exchange, restores nothing, which would be a silent fresh start;
 *  report retry_fresh (the same test capture uses, as for gemini and qwen). */
export function checkAiderResumeTarget(token: string, ctx: { fs: AiderFsOps }): AiderResumeTargetResult {
  const validation = validateAiderChatHistoryToken(token);
  if (!validation.ok) return { ok: false, error: validation.error, recovery: "retry_fresh" };
  if (!ctx.fs.exists(validation.token)) {
    return { ok: false, error: "the persisted aider chat history file no longer exists", recovery: "retry_fresh" };
  }
  if (!hasAiderExchange(ctx.fs, validation.token)) {
    return { ok: false, error: "the persisted aider chat history has no exchange to restore", recovery: "retry_fresh" };
  }
  return { ok: true };
}

export type AiderCaptureFsOps = AiderFsOps;

/** Token capture: the history file minted for the seat's latest fresh launch
 *  (the base records it as launch.json presetToken), once it holds a real
 *  exchange (the resume precheck's test), so a seat that never got a prompt is
 *  never resumed; restore stops at awaiting-decision instead.
 *  Only a file inside the seat's own state dir is accepted. Read-only; never
 *  throws. */
export function captureAiderChatHistory(ctx: { fs: AiderCaptureFsOps; seatStateDir: string }): string | undefined {
  let preset: unknown;
  try {
    preset = (JSON.parse(ctx.fs.readFile(nodePath.join(ctx.seatStateDir, LAUNCH_RECORD_FILE))) as { presetToken?: unknown }).presetToken;
  } catch {
    return undefined;
  }
  if (typeof preset !== "string") return undefined;
  const validation = validateAiderChatHistoryToken(preset);
  if (!validation.ok || nodePath.dirname(validation.token) !== nodePath.resolve(ctx.seatStateDir)) return undefined;
  return hasAiderExchange(ctx.fs, validation.token) ? validation.token : undefined;
}
