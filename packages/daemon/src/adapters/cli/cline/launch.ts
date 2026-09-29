// Cline CLI (npm `cline`, 3.x) launch argv, launch env, and resume token rules.
//
// Verified live against cline 3.0.65 in an isolated prefix (see
// docs/reference/runtimes/cline.md):
// - Bare `cline` in a TTY opens the interactive TUI. A positional prompt would
//   run one-shot, so the managed launch never passes one.
// - `--auto-approve <boolean>` DEFAULTS TO TRUE, so the floor posture must pass
//   `--auto-approve false` explicitly; full_bypass passes `--auto-approve true`.
//   (The hidden `-y/--yolo` forces headless plain output and is never used.)
// - `-m <model-id>` selects a model for the provider configured with
//   `cline auth`. Provider ids are not split out of the model string because
//   OpenRouter-style model ids contain "/" themselves.
// - `--id <session-id>` resumes an existing session and stays interactive.
//   There is no fork primitive.

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
  const argv = [CLINE_BINARY, "--auto-approve", input.posture === "full_bypass" ? "true" : "false"];
  const model = input.model?.trim();
  if (model) argv.push("-m", model);
  if (input.resumeToken !== undefined) {
    const validation = validateClineSessionId(input.resumeToken);
    if (!validation.ok) throw new Error(validation.error);
    argv.push("--id", validation.token);
  }
  return argv;
}

export type ClineTokenResult = { ok: true; token: string } | { ok: false; error: string };

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SESSION_ID_LEN = 200;

/** Format floor for a Cline session id (observed shape: `<epoch ms>_<5 chars>`,
 *  e.g. 1790702191676_lovnf). The floor is the shell- and path-inert id
 *  charset rather than the exact observed shape, so a future id format change
 *  degrades to a visible "Unknown session" instead of a silent refusal. Never
 *  echoes the token (resume tokens are credential-class). */
export function validateClineSessionId(raw: string): ClineTokenResult {
  const token = raw.trim();
  if (!token) return { ok: false, error: "Resume token is empty." };
  if (token.length > MAX_SESSION_ID_LEN) {
    return { ok: false, error: `Resume token is too long (max ${MAX_SESSION_ID_LEN} characters).` };
  }
  if (!SESSION_ID_RE.test(token) || token === "." || token === "..") {
    return { ok: false, error: "Resume token contains disallowed characters (allowed: letters, digits, '.', '_', '-')." };
  }
  return { ok: true, token };
}
