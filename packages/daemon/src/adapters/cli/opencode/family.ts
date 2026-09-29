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
  /** Database file name inside the seat state dir. */
  readonly dbFileName: string;
  /** Project config dir whose `skills/<name>/SKILL.md` the CLI loads. */
  readonly projectConfigDir: string;
  /** Bare install command. Preflight renders "install <name> (<hint>)" and
   *  the verifier "<binary> not found (install: <hint>)". */
  readonly installHint: string;
}

export const OPENCODE_VARIANT: OpencodeFamilyVariant = {
  id: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  paneCommands: ["opencode"],
  processMatch: /(?:^|\/)opencode$/,
  dbEnvVar: "OPENCODE_DB",
  dbFileName: "opencode.db",
  projectConfigDir: ".opencode",
  installHint: "brew install anomalyco/tap/opencode, or npm i -g opencode-ai",
};

export const KILO_VARIANT: OpencodeFamilyVariant = {
  id: "kilo",
  displayName: "Kilo CLI",
  binary: "kilo",
  // The npm package's native binary is `.kilo`, spawned by a node launcher.
  paneCommands: ["kilo", "kilocode", ".kilo"],
  processMatch: /(?:^|\/)(?:kilo|kilocode|\.kilo)$/,
  dbEnvVar: "KILO_DB",
  dbFileName: "kilo.db",
  projectConfigDir: ".kilo",
  installHint: "npm i -g @kilocode/cli",
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
  return { [variant.dbEnvVar]: opencodeFamilyDbPath(variant, seatStateDir) };
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
 * A dialog is open. Every OpenCode and Kilo dialog (command palette, model and
 * session pickers, alerts, confirms, help) draws a header row with its title
 * on the left and `esc` (help: `esc/enter`) on the right. The prompt footer's
 * busy hint `esc interrupt` / `esc again to interrupt` is not a dialog.
 */
export const OPENCODE_FAMILY_DIALOG_PATTERN = /\S {4,}esc(?:\/enter)?(?! +(?:again to )?interrupt)(?=[ \r\n]|$)/;

/** `marker`, but only on a screen with no dialog open: the prompt box stays
 *  drawn underneath a dialog, so a bare marker would call it ready. */
function readyWithoutDialog(marker: RegExp): RegExp {
  // No "m" flag: ^ is the start of the whole capture, so the lookahead scans
  // every line for a dialog header before the marker is tried.
  return new RegExp(`^(?![\\s\\S]*${OPENCODE_FAMILY_DIALOG_PATTERN.source})[\\s\\S]*${marker.source}`);
}

/**
 * Ready markers, each refused while a dialog is open. The home screen shows
 * the placeholder `Ask anything` (OpenCode ends it with a Unicode ellipsis,
 * Kilo with three dots). A resumed session opens on the session route, which
 * has no placeholder; there the prompt box's bottom border (`╹▀▀▀...`, drawn
 * on every route) is the marker. The footer `ctrl+p commands` is kept as a
 * third marker, but it wraps across two lines in an 80-column pane when the
 * cwd is long (seen live on restore) and its key can be rebound, so it is
 * never the only one. Verified on 80x24 captures of both CLIs.
 */
export const OPENCODE_FAMILY_READY_PATTERNS: readonly RegExp[] = [
  /Ask anything/,
  /╹▀{8,}/,
  /ctrl\+p\s+commands/,
].map(readyWithoutDialog);

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
