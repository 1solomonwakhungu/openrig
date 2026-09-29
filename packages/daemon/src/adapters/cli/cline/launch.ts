// Cline CLI (npm `cline`, 3.x) launch argv, launch env, and resume token rules.
//
// Verified live against cline 3.0.65 in an isolated prefix (see
// docs/reference/runtimes/cline.md):
// - Bare `cline` in a TTY opens the interactive TUI. A positional prompt would
//   run one-shot, so the managed launch never passes one.
// - `--auto-approve <boolean>` DEFAULTS TO TRUE, so the floor posture must pass
//   `--auto-approve false` explicitly; full_bypass passes `--auto-approve true`.
//   (The hidden `-y/--yolo` forces headless plain output and is never used.)
// - `-m <model-id>` is NOT per-launch: cline saves it as the provider's default
//   model in ~/.cline/data/settings/providers.json (verified). CLINE_MODEL does
//   not reach the TUI, and a per-seat CLINE_PROVIDER_SETTINGS_PATH would need a
//   copy of the operator's provider secrets. So a seat never passes -m, and a
//   seat that declares `model:` is refused rather than silently rewriting the
//   operator's default (and racing pod-mates).
// - `--id <session-id>` resumes an existing session and stays interactive.
//   There is no fork primitive.

import { validateIdShapedToken, type ResumeTokenFormatResult } from "../../../domain/resume-token-formats.js";

export const CLINE_RUNTIME_ID = "cline";
export const CLINE_BINARY = "cline";
export const CLINE_RESUME_TYPE = "cline_session_id";
export const CLINE_GUIDANCE_FILE = "AGENTS.md";
export const CLINE_INSTALL_HINT = "npm install -g cline (then `cline auth` to configure a provider)";

/** Additive env for every managed launch (fresh and resume).
 *  - CLINE_DISABLE_CLINE_PASS_NOTICE=1 suppresses the one-shot launch notices
 *    ("Try ClinePass", "Introducing Cline Desktop"). They open as a modal that
 *    swallows the first keystroke and opens a browser on Enter, which would
 *    corrupt startup delivery typed into the pane.
 *  - CLINE_NO_AUTO_UPDATE=1: Cline releases up to 3.0.54 killed live sessions
 *    when they auto-updated; a managed seat updates through the operator. */
export const CLINE_LAUNCH_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLINE_DISABLE_CLINE_PASS_NOTICE: "1",
  CLINE_NO_AUTO_UPDATE: "1",
});

export const CLINE_MODEL_UNSUPPORTED_ERROR =
  "cline cannot set a per-seat model without changing the operator default; set the model in Cline or omit model:";

export type ClineLaunchPosture = "floor" | "full_bypass";

export interface ClineForkRef {
  kind: string;
  value?: string;
}

export interface ClineArgvInput {
  model?: string | null;
  posture: ClineLaunchPosture;
  resumeToken?: string;
  forkSource?: ClineForkRef;
}

export function buildClineArgv(input: ClineArgvInput): string[] {
  if (input.forkSource) {
    throw new Error("cline has no native fork primitive; remove session_source for cline members");
  }
  if (input.model?.trim()) throw new Error(CLINE_MODEL_UNSUPPORTED_ERROR);
  const argv = [CLINE_BINARY, "--auto-approve", input.posture === "full_bypass" ? "true" : "false"];
  if (input.resumeToken !== undefined) {
    const validation = validateClineSessionId(input.resumeToken);
    if (!validation.ok) throw new Error(validation.error);
    argv.push("--id", validation.token);
  }
  return argv;
}

export type ClineTokenResult = ResumeTokenFormatResult;

/** Format floor for a Cline session id (observed shape: `<epoch ms>_<5 chars>`,
 *  e.g. 1790702191676_lovnf): the shared id-shaped floor (shell- and path-inert
 *  charset, length cap) plus no bare "." or "..", since the id names a
 *  directory. It is not the exact observed shape, so a future id format change
 *  degrades to a visible "Unknown session" instead of a silent refusal. Never
 *  echoes the token (resume tokens are credential-class). */
export function validateClineSessionId(raw: string): ClineTokenResult {
  const token = raw.trim();
  if (!token) return { ok: false, error: "Resume token is empty." };
  if (token === "." || token === "..") {
    return { ok: false, error: "Resume token contains disallowed characters (allowed: letters, digits, '.', '_', '-')." };
  }
  return validateIdShapedToken(token);
}
