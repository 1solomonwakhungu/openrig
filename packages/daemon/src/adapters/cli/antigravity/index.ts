// Antigravity CLI (`agy`, google-antigravity/antigravity-cli, closed source)
// runtime adapter.
//
// Verified against agy 1.1.27 (`agy --help` and strings in the binary; the TUI
// was NOT launched, because agy authenticates through the OS keyring, which a
// throwaway HOME does not isolate from the owner's account); see
// docs/reference/runtimes/antigravity.md for what was verified and how.
//
// Session identity: agy has no flag to choose a conversation id. Each
// conversation is stored at <app data>/conversations/<uuid>.db and the most
// recent conversation per workspace is recorded in
// <app data>/cache/last_conversations.json ({ "<workspace path>": "<uuid>" }),
// where <app data> is ~/.gemini/antigravity-cli. Resume is
// `--conversation <uuid>`. There is no fork.

import fs from "node:fs";
import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import { anyPanePhrase, panePhrase, panePhraseSource } from "../pane-phrase.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import { LAUNCH_RECORD_FILE } from "../../../domain/runtime-capture.js";
import type { ResumeTokenFormatResult } from "../../../domain/resume-token-formats.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Two seats launched in the same cwd within this window make capture ambiguous. */
const SIBLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function validateAntigravityConversationId(token: string): ResumeTokenFormatResult {
  return UUID_RE.test(token)
    ? { ok: true, token: token.toLowerCase() }
    : { ok: false, error: "Antigravity conversation id must be a UUID." };
}

/** agy's app data dir. */
export function antigravityAppDir(homedir: string): string {
  return nodePath.join(homedir, ".gemini", "antigravity-cli");
}

export function antigravityConversationPath(homedir: string, conversationId: string): string {
  return nodePath.join(antigravityAppDir(homedir), "conversations", `${conversationId}.db`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Another agy seat launched in the same cwd around the same time: agy keeps
 * one "last conversation" per workspace, so the entry could be either seat's.
 */
function siblingSharesCwd(seatStateDir: string, cwd: string, launchStartedAt: Date | undefined): boolean {
  const runtimeDir = nodePath.dirname(seatStateDir);
  let seats: string[];
  try {
    seats = fs.readdirSync(runtimeDir);
  } catch {
    return false;
  }
  const since = (launchStartedAt?.getTime() ?? Date.now()) - SIBLING_WINDOW_MS;
  return seats.some((seat) => {
    const dir = nodePath.join(runtimeDir, seat);
    if (dir === seatStateDir) return false;
    const record = readJson(nodePath.join(dir, LAUNCH_RECORD_FILE)) as { cwd?: unknown; launchStartedAt?: unknown } | null;
    if (!record || record.cwd !== cwd || typeof record.launchStartedAt !== "string") return false;
    const at = new Date(record.launchStartedAt).getTime();
    return Number.isFinite(at) && at >= since;
  });
}

/**
 * Screen text that means a dialog, prompt, or onboarding panel is up, even if
 * the `? for shortcuts` footer is visible. All from agy 1.1.27 binary strings.
 * Residual risk: the live screens were never observed (see the runtime doc);
 * a dialog agy words differently is not caught here and would read as ready.
 */
export const ANTIGRAVITY_NOT_READY_RE = anyPanePhrase(
  ["initializing...", "esc to cancel", "to navigate", "(y/n)", "Yes, allow", "No, deny", "Welcome to", "Action required"],
  "i",
);

/** Ready: the `? for shortcuts` status line with no dialog marker on screen.
 *  Both tolerate the wrapping and box borders of an 80x24 pane (pane-phrase.ts). */
export const ANTIGRAVITY_READY_RE = new RegExp(
  `^(?![\\s\\S]*(?:${ANTIGRAVITY_NOT_READY_RE.source}))[\\s\\S]*${panePhraseSource("? for shortcuts")}`,
  "i",
);

/** The permission argument each posture emits, as recorded for permission
 *  drift: `--mode accept-edits` (floor) or `--dangerously-skip-permissions`
 *  (full_bypass). Both postures pass one explicitly. */
export const ANTIGRAVITY_PERMISSION_VALUES: Readonly<Record<ResolvedLaunchPosture, string>> = Object.freeze({
  floor: "accept-edits",
  full_bypass: "dangerously-skip-permissions",
});

export const ANTIGRAVITY_DESCRIPTOR: RuntimeDescriptor = {
  id: "antigravity",
  displayName: "Antigravity CLI",
  kind: "agent",
  binary: "agy",
  installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  resumeType: "antigravity_conversation_id",
  validateResumeToken: validateAntigravityConversationId,
  // Read-only late capture. The conversation is created lazily, so launch-time
  // capture usually finds nothing and the refresher or restore picks it up.
  // Returns null unless the workspace's last conversation was written after
  // this seat's launch and no other agy seat shares the cwd (ambiguous).
  captureResumeToken: ({ cwd, seatStateDir, launchStartedAt, homedir }) => {
    if (!cwd) return null;
    const last = readJson(nodePath.join(antigravityAppDir(homedir), "cache", "last_conversations.json"));
    if (!last || typeof last !== "object") return null;
    const id = (last as Record<string, unknown>)[cwd];
    if (typeof id !== "string" || !UUID_RE.test(id)) return null;
    let modified: number;
    try {
      modified = fs.statSync(antigravityConversationPath(homedir, id)).mtimeMs;
    } catch {
      return null;
    }
    if (launchStartedAt && modified < launchStartedAt.getTime()) return null;
    if (siblingSharesCwd(seatStateDir, cwd, launchStartedAt)) return null;
    return id;
  },
  supportsFork: false,
  // agy reads workspace AGENTS.md and GEMINI.md; AGENTS.md is shared with Codex.
  guidanceFile: "AGENTS.md",
  // Workspace skills.
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".agents", "skills"),
  // A native (Go) binary: the pane's foreground command is `agy`.
  paneCommands: ["agy"],
  // Survival after kill-session is unverified, so reap the pane's process
  // tree on stop (PID-scoped; never by name).
  reapProcessTreeOnStop: true,
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === ANTIGRAVITY_PERMISSION_VALUES.full_bypass ? "full_bypass"
      : observedValue === ANTIGRAVITY_PERMISSION_VALUES.floor ? "floor"
      : null,
};

export const ANTIGRAVITY_SPEC: TuiCliRuntimeSpec = {
  descriptor: ANTIGRAVITY_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken }) => {
    const argv = ["agy"];
    if (binding.model) argv.push("--model", binding.model);
    // The floor matches Claude's acceptEdits; agy has no --yolo spelling.
    argv.push(...(posture === "full_bypass" ? [`--${ANTIGRAVITY_PERMISSION_VALUES.full_bypass}`] : ["--mode", ANTIGRAVITY_PERMISSION_VALUES.floor]));
    if (resumeToken) argv.push("--conversation", resumeToken);
    return argv;
  },
  env: {
    // Sign-in prints a URL in the pane; never open a tab on the operator's desktop.
    // AGY_CLI_DISABLE_AUTO_UPDATE turns off agy's background self-updater so a
    // managed seat never replaces the operator's agy install. Source-derived:
    // the variable and its log line ("Auto-update disabled via environment
    // variable %s") are in the agy 1.1.27 binary; not behavior-proven live.
    set: () => ({ AGY_CLI_DISABLE_AUTO_UPDATE: "1", BROWSER: "true" }),
  },
  validateResumeTarget: ({ token, homedir }) => fs.existsSync(antigravityConversationPath(homedir, token))
    ? { ok: true }
    : { ok: false, reason: "no local Antigravity conversation with that id" },
  // The idle screen was not observed live (see the runtime doc), so readiness
  // is strict: the status line must show and the TUI must not still be
  // initializing. Anything else runs out the wait as attention_required with
  // pane evidence, never a false ready.
  readyPatterns: [ANTIGRAVITY_READY_RE],
  gatePatterns: [
    { pattern: panePhrase("Do you trust the contents of this project?"), code: "trust_gate", reason: "agy is asking to trust the project" },
    {
      pattern: anyPanePhrase([
        "Select login method:", "Other sign-in options", "Authentication required. Please visit the URL to log in",
        "Waiting for authentication", "Paste the authorization code", "Enter the authorization code",
      ]),
      code: "login_required",
      reason: "agy needs a sign-in (run `agy` once interactively for this account)",
    },
  ],
  errorPatterns: [
    { pattern: panePhrase("conversation not found", "i"), reason: "agy could not find the conversation to resume", recovery: "retry_fresh", code: "session_missing" },
    { pattern: /\[Auth Error\]/, reason: "agy reported an authentication error" },
  ],
  observeLaunch: ({ posture }): AppliedLaunchObservation => ({
    runtime: ANTIGRAVITY_DESCRIPTOR.id,
    axis: "permission",
    state: "observed",
    value: ANTIGRAVITY_PERMISSION_VALUES[posture],
    reason: "emitted_launch_arguments",
  }),
};

export const ANTIGRAVITY_REGISTRATION: CliRuntimeRegistration = {
  descriptor: ANTIGRAVITY_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(ANTIGRAVITY_SPEC, deps),
};
