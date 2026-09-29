// Launch argv for the Gemini CLI family: Gemini CLI (`gemini`) and its fork
// Qwen Code (`qwen`). Both share the yargs flag surface for model, approval
// mode, session id, and resume; they differ in the `auto-edit` spelling, the
// trust flag, and fork support. Verified against `--help` and source of
// gemini 0.61.0 and qwen 0.24.7 (see docs/reference/runtimes/gemini.md and
// docs/reference/runtimes/qwen.md).
//
// Rules both CLIs enforce, mirrored here so a bad combination is refused
// before anything is typed:
// - `--session-id` is rejected together with `--resume` (and, for qwen, with
//   `--fork-session`), so it is only passed on fresh launches.
// - A positional prompt is never passed: `qwen "x"` runs one shot and exits.

import { randomUUID } from "node:crypto";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";

export interface GeminiFamilyDialect {
  /** Executable name typed into the pane. */
  binary: string;
  /** `--approval-mode` value for the floor posture: edits auto-approved,
   *  shell and other tools still ask (the Claude acceptEdits analog). */
  floorApprovalMode: string;
  /** Flag that trusts the workspace for this session without writing config,
   *  or null when the CLI has none. Passed on every managed launch because an
   *  untrusted folder silently drops the cwd guidance file and skills and
   *  downgrades `--yolo` to the default mode. Same stance as the Claude
   *  adapter pre-accepting its trust dialog for the managed cwd. */
  trustFlag: string | null;
  /** Whether `--resume <parent> --fork-session` creates a child session. */
  supportsFork: boolean;
}

export const GEMINI_DIALECT: GeminiFamilyDialect = {
  binary: "gemini",
  floorApprovalMode: "auto_edit",
  trustFlag: "--skip-trust",
  supportsFork: false,
};

export const QWEN_DIALECT: GeminiFamilyDialect = {
  binary: "qwen",
  floorApprovalMode: "auto-edit",
  trustFlag: null,
  supportsFork: true,
};

export interface GeminiFamilyLaunchInput {
  model?: string;
  posture: ResolvedLaunchPosture;
  /** Fresh launch: the OpenRig-minted session id (`--session-id`). */
  sessionToken?: string;
  /** Resume an existing session by id (`--resume <id>`). */
  resumeToken?: string;
  /** Fork: the parent session id (`--resume <parent> --fork-session`). */
  forkParent?: string;
}

/** Session ids OpenRig mints and accepts: RFC 4122 versions 1-5. Qwen rejects
 *  any other shape for `--session-id` and treats it as a title for
 *  `--resume`; Gemini accepts a superset. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resume-token format floor for both runtimes (same result shape as
 *  domain/resume-token-formats.ts; never echoes the token). */
export function validateSessionToken(token: string): { ok: true; token: string } | { ok: false; error: string } {
  const trimmed = token.trim();
  if (!SESSION_ID_RE.test(trimmed)) {
    return { ok: false, error: "Resume token must be a session UUID (8-4-4-4-12 hex, version 1-5)." };
  }
  return { ok: true, token: trimmed.toLowerCase() };
}

/** A fresh session id for `--session-id` (UUID v4). */
export function mintSessionToken(): string {
  return randomUUID();
}

function requireSessionId(value: string, what: string): string {
  const trimmed = value.trim();
  if (!SESSION_ID_RE.test(trimmed)) throw new Error(`${what} must be a session UUID`);
  return trimmed.toLowerCase();
}

/**
 * Build the argv for a fresh, resumed, or forked launch. Throws an Error with
 * an operator-facing message when the combination is invalid (the TUI base
 * turns a throw into a refused launch).
 */
export function buildGeminiFamilyArgv(dialect: GeminiFamilyDialect, input: GeminiFamilyLaunchInput): string[] {
  if (input.resumeToken !== undefined && input.forkParent !== undefined) {
    throw new Error("resumeToken and forkSource are mutually exclusive; pick one");
  }
  if (input.forkParent !== undefined && !dialect.supportsFork) {
    throw new Error(`${dialect.binary} has no native fork primitive; remove session_source for ${dialect.binary} members`);
  }

  const argv = [dialect.binary];
  const model = input.model?.trim();
  if (model) argv.push("--model", model);
  if (input.posture === "full_bypass") argv.push("--yolo");
  else argv.push("--approval-mode", dialect.floorApprovalMode);
  if (dialect.trustFlag) argv.push(dialect.trustFlag);

  if (input.resumeToken !== undefined) {
    argv.push("--resume", requireSessionId(input.resumeToken, "resume token"));
  } else if (input.forkParent !== undefined) {
    // The child id is chosen by qwen (random) and captured afterwards.
    argv.push("--resume", requireSessionId(input.forkParent, "fork parent"), "--fork-session");
  } else if (input.sessionToken !== undefined) {
    argv.push("--session-id", requireSessionId(input.sessionToken, "session token"));
  }
  return argv;
}
