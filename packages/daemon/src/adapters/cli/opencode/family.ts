// Shared, runtime-specific pieces for the OpenCode family of TUI CLIs:
// OpenCode (`opencode`) and its fork Kilo CLI (`kilo`). Both take the same
// flags, render the same TUI, and keep sessions in a SQLite database whose
// location an env var overrides (OPENCODE_DB / KILO_DB). The per-CLI
// differences are data in OpencodeFamilyVariant.
//
// Verified 2026-09-29 against opencode 1.18.33 (Homebrew binary and source tag
// v1.18.33) and kilo 7.8.1 (npm @kilocode/cli and Kilo-Org/kilocode main).
// See docs/reference/runtimes/opencode.md and kilo.md for what was verified
// live and what came from source.
//
// Everything here is pure: no tmux, no filesystem, no process env.

import nodePath from "node:path";

export interface OpencodeFamilyVariant {
  /** The rig-spec `runtime:` value. */
  readonly id: "opencode" | "kilo";
  readonly displayName: string;
  /** Command typed into the pane. */
  readonly binary: string;
  /** Native executable names that show up as the pane's foreground command.
   *  npm installs run behind a `node` launcher, which is never identity. */
  readonly paneCommands: readonly string[];
  /** Matches the program path of the CLI process: the native binary, or the
   *  script an npm `node` launcher runs (`.../bin/<binary>`). */
  readonly processMatch: RegExp;
  /** Env var that overrides the session database path. */
  readonly dbEnvVar: string;
  /** Env var that turns off the TUI's startup self-update. */
  readonly disableAutoUpdateEnvVar: string;
  /** Database file name inside the seat state dir. */
  readonly dbFileName: string;
  /** Project config dir whose `skills/<name>/SKILL.md` the CLI loads. */
  readonly projectConfigDir: string;
  readonly installHint: string;
}

export const OPENCODE_VARIANT: OpencodeFamilyVariant = {
  id: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  paneCommands: ["opencode"],
  processMatch: /(?:^|\/)opencode$/,
  dbEnvVar: "OPENCODE_DB",
  disableAutoUpdateEnvVar: "OPENCODE_DISABLE_AUTOUPDATE",
  dbFileName: "opencode.db",
  projectConfigDir: ".opencode",
  installHint: "Install OpenCode: brew install anomalyco/tap/opencode, or npm i -g opencode-ai (https://opencode.ai/docs/)",
};

export const KILO_VARIANT: OpencodeFamilyVariant = {
  id: "kilo",
  displayName: "Kilo CLI",
  binary: "kilo",
  // The npm package's native binary is `.kilo`, spawned by a node launcher.
  paneCommands: ["kilo", "kilocode", ".kilo"],
  processMatch: /(?:^|\/)(?:kilo|kilocode|\.kilo)$/,
  dbEnvVar: "KILO_DB",
  disableAutoUpdateEnvVar: "KILO_DISABLE_AUTOUPDATE",
  dbFileName: "kilo.db",
  projectConfigDir: ".kilo",
  installHint: "Install Kilo CLI: npm i -g @kilocode/cli (https://kilo.ai/docs/code-with-ai/platforms/cli)",
};

// ── Resume token ─────────────────────────────────────────────────────────────

/** Session ids are "ses_" + 12 hex time digits + 14 base62 characters
 *  (packages/schema/src/identifier.ts); Kilo keeps the same scheme. */
const SESSION_ID_RE = /^ses_[0-9A-Za-z]{26}$/;

export type OpencodeSessionIdResult = { ok: true; token: string } | { ok: false; error: string };

/** Format floor for a trimmed session id. Never quotes the token in the error. */
export function validateOpencodeSessionId(token: string): OpencodeSessionIdResult {
  if (!SESSION_ID_RE.test(token)) {
    return { ok: false, error: "Session id must be 'ses_' followed by 26 letters or digits." };
  }
  return { ok: true, token };
}

// ── Launch ───────────────────────────────────────────────────────────────────

export interface OpencodeFamilyLaunchInput {
  model?: string;
  posture: "floor" | "full_bypass";
  resumeToken?: string;
  forkSource?: { kind: string; value?: string };
}

/** `provider/model`, e.g. `anthropic/claude-sonnet-5` or `openrouter/x-ai/grok-4`. */
const MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._:@+/-]+$/;

/**
 * argv for an interactive TUI launch. Throws an Error to refuse the launch.
 *
 * - model: `-m provider/model`, validated so a malformed value fails here with
 *   a clear message instead of inside the TUI.
 * - posture: `full_bypass` adds `--auto` ("auto-approve permissions that are
 *   not explicitly denied"); `floor` never passes it, leaving the CLI's own
 *   permission config in charge.
 * - resume: `-s <session id>`. The session must exist in the seat's database;
 *   a missing one prints "Session not found" and exits (never a fresh start).
 * - fork: refused. `--fork` only works on a session in the same database, and
 *   each seat has its own database, so a parent from another seat is never
 *   visible to the child.
 */
export function buildOpencodeFamilyArgv(variant: OpencodeFamilyVariant, input: OpencodeFamilyLaunchInput): string[] {
  if (input.resumeToken && input.forkSource) {
    throw new Error(`${variant.id}: resumeToken and forkSource are mutually exclusive`);
  }
  if (input.forkSource) {
    throw new Error(
      `${variant.id} fork is not supported: each ${variant.displayName} seat keeps its sessions in its own database, so a parent session from another seat cannot be forked`,
    );
  }

  const argv = [variant.binary];
  if (input.model !== undefined) {
    const model = input.model.trim();
    if (!MODEL_REF_RE.test(model)) {
      throw new Error(`${variant.id}: model must be in provider/model form (for example anthropic/claude-sonnet-5)`);
    }
    argv.push("-m", model);
  }
  if (input.resumeToken !== undefined) {
    const validation = validateOpencodeSessionId(input.resumeToken.trim());
    if (!validation.ok) throw new Error(`${variant.id} resume: ${validation.error}`);
    argv.push("-s", validation.token);
  }
  if (input.posture === "full_bypass") argv.push("--auto");
  return argv;
}

/** Per-seat launch env: an isolated session database, so the seat's current
 *  session is unambiguous even when pod-mates share a cwd. Provider
 *  credentials (auth.json, provider env vars) stay shared. */
export function opencodeFamilySeatEnv(variant: OpencodeFamilyVariant, seatStateDir: string): Record<string, string> {
  return {
    [variant.dbEnvVar]: opencodeFamilyDbPath(variant, seatStateDir),
    // The TUI checks for a new release at startup and installs a patch
    // release in place through the detected method (npm -g, brew, the curl
    // script), which rewrites the owner's global installation from inside a
    // managed seat. The env var only affects this seat's process.
    [variant.disableAutoUpdateEnvVar]: "1",
  };
}

export function opencodeFamilyDbPath(variant: OpencodeFamilyVariant, seatStateDir: string): string {
  return nodePath.join(seatStateDir, variant.dbFileName);
}

// ── Guidance and skills ──────────────────────────────────────────────────────

/** Both CLIs read the nearest project AGENTS.md (falling back to CLAUDE.md
 *  only when AGENTS.md is absent), so managed blocks go to AGENTS.md. */
export const OPENCODE_FAMILY_GUIDANCE_FILE = "AGENTS.md";

/** Project skills: `<cwd>/<.opencode|.kilo>/skills/<name>/SKILL.md`. */
export function opencodeFamilySkillsDir(variant: OpencodeFamilyVariant, cwd: string): string {
  return nodePath.join(cwd, variant.projectConfigDir, "skills");
}

// ── Pane patterns ────────────────────────────────────────────────────────────

/**
 * Ready markers. The home screen shows the placeholder `Ask anything`
 * (OpenCode ends it with a Unicode ellipsis, Kilo with three dots). A resumed
 * session opens on the session route, which has no placeholder, so the prompt
 * footer `ctrl+p commands` (default palette key, rendered on every route in
 * normal mode) is the second marker.
 */
export const OPENCODE_FAMILY_READY_PATTERNS: readonly RegExp[] = [
  /Ask anything/,
  /ctrl\+p\s+commands/,
];

export interface OpencodeFamilyErrorPattern {
  pattern: RegExp;
  reason: string;
  recovery: "retry_fresh" | "attention_required";
}

/** `-s <id>` for a session that is not in the database prints
 *  `Error: Session not found: ses_...` and exits to the shell (verified live
 *  on opencode 1.18.33; same TUI source in Kilo). */
export const OPENCODE_FAMILY_ERROR_PATTERNS: readonly OpencodeFamilyErrorPattern[] = [
  {
    pattern: /Session not found: ses_/,
    reason: "the resumed session is not in this seat's session database",
    recovery: "retry_fresh",
  },
];
