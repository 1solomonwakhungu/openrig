// Gemini CLI runtime (`runtime: gemini`). See docs/reference/runtimes/gemini.md.
//
// Interactive TUI in the seat pane, launched with an OpenRig-minted
// `--session-id` so the resume token is known up front. No fork primitive.

import nodePath from "node:path";
import { TuiCliRuntimeAdapter } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import { GEMINI_DIALECT, validateSessionToken } from "../gemini-family/launch-args.js";
import { GEMINI_PANE_PATTERNS } from "../gemini-family/pane-patterns.js";
import { checkGeminiResumeTarget, findGeminiSessionFile, geminiSessionIsResumable } from "../gemini-family/session-store.js";
import { readGeminiUsage } from "../gemini-family/usage.js";
import { readSessionText } from "../gemini-family/runtime.js";
import { createGeminiFamilyCapture, createGeminiFamilySpec, geminiFamilyPermissionPosture, nodeEngineFloorVerify } from "../gemini-family/runtime.js";

/**
 * Launch env that keeps gemini's env-triggered first-run dialogs off seat
 * launches. A tmux server passes its starting shell's env to every pane, so a
 * server started from an IDE terminal would otherwise trigger:
 * - the IDE connection nudge (detect-ide.ts: JetBrains TERMINAL_EMULATOR,
 *   ZED_SESSION_ID, XCODE_VERSION_ACTUAL, or TERM_PROGRAM vscode/sublime/Zed);
 * - the terminal keybinding consent prompt (terminalSetup.ts: CURSOR_TRACE_ID,
 *   VSCODE_GIT_ASKPASS_MAIN, VSCODE_GIT_IPC_HANDLE, or TERM_PROGRAM=vscode),
 *   whose preselected "Yes" writes the owner's editor keybindings.json.
 * Every check is a truthiness or equality test, so an empty value disables it.
 * TERM_PROGRAM is pinned to tmux, which tmux itself sets in panes. Managed
 * seats are never IDE-integrated; nothing is written.
 */
export const GEMINI_LAUNCH_ENV: Record<string, string> = {
  CURSOR_TRACE_ID: "",
  TERMINAL_EMULATOR: "",
  TERM_PROGRAM: "tmux",
  VSCODE_GIT_ASKPASS_MAIN: "",
  VSCODE_GIT_IPC_HANDLE: "",
  XCODE_VERSION_ACTUAL: "",
  ZED_SESSION_ID: "",
};

export const GEMINI_DESCRIPTOR: RuntimeDescriptor = {
  id: "gemini",
  displayName: "Gemini CLI",
  kind: "agent",
  binary: "gemini",
  installHint: "npm install -g @google/gemini-cli",
  // @google/gemini-cli engines: node >= 20.
  verify: nodeEngineFloorVerify("Gemini CLI", 20),
  resumeType: "gemini_session_id",
  validateResumeToken: validateSessionToken,
  // Reported only once the session is resumable (the same test as the resume
  // precheck), so a seat that never got a prompt has no token; restore then stops
  // for an explicit --fresh (the no-token policy) and never resumes a wrong conversation.
  captureResumeToken: createGeminiFamilyCapture({ sessionExists: geminiSessionIsResumable }),
  // Maps the recorded approval mode back to a posture for permission drift.
  permissionPostureFor: geminiFamilyPermissionPosture(GEMINI_DIALECT),
  // Usage (feature 1): per-reply tokens from the seat session's file.
  readUsage: ({ resumeToken, cwd, homedir }) => {
    if (!resumeToken || !cwd) return null;
    return readGeminiUsage(readSessionText((ctx) => findGeminiSessionFile(ctx, resumeToken.trim()), { cwd, homedir }));
  },
  supportsFork: false,
  // Each posture maps to distinct launch flags, so a seat may select either.
  permissionModes: ["floor", "full_bypass"],
  // Gemini reads GEMINI.md by default, not AGENTS.md.
  guidanceFile: "GEMINI.md",
  // Project skills; read because managed launches pass --skip-trust.
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".gemini", "skills"),
  // The pane shows `node`; the script basename is the identity (`node .../bin/gemini`).
  processMatch: "gemini",
  // The bin's parent ignores SIGHUP/SIGTERM and waits on a child that never
  // finishes its SIGHUP cleanup, so both outlive kill-session (verified live).
  reapProcessTreeOnStop: true,
};

export const GEMINI_REGISTRATION: CliRuntimeRegistration = {
  descriptor: GEMINI_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(createGeminiFamilySpec(GEMINI_DESCRIPTOR, {
    dialect: GEMINI_DIALECT,
    patterns: GEMINI_PANE_PATTERNS,
    checkResumeTarget: checkGeminiResumeTarget,
    launchEnv: GEMINI_LAUNCH_ENV,
    // No autoUpdateGuard: gemini ignores non-root system defaults files; the
    // npm containment (seat NPM_CONFIG_PREFIX) is the defense (auto-update.ts).
  }, deps), deps),
};
