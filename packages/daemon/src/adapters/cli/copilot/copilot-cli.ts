// GitHub Copilot CLI (`copilot`): the runtime-specific pieces of the adapter.
//
// Everything here is pure (or takes an injected read-only fs) so it can be
// tested without a real binary. Facts were verified against @github/copilot
// 1.0.89 (`--help`, `help environment`, `help config`, and a live TUI run in an
// isolated tmux server with a throwaway HOME, unauthenticated):
// - `--session-id <uuid>` sets the UUID of a NEW session and creates
//   <COPILOT_HOME>/session-state/<uuid>/workspace.yaml at startup, so the
//   adapter mints the resume token itself instead of scraping it.
// - `--resume=<id>` reopens an exact session (bare `--resume` opens a picker,
//   which a managed launch must never do).
// - `--yolo` (= `--allow-all`) auto-approves tools, paths, and URLs, but does
//   NOT skip the folder-trust modal. `trustedFolders` in settings.json does,
//   but Copilot moves that list into its self-managed config.json at startup
//   and concurrent launches lose entries in that move, so OpenRig never writes
//   it: the adapter answers the modal with "1. Yes" (this session only) under
//   the base's guarded gate answer.
// - There is no fork flag.

import nodePath from "node:path";
import type { ForkSource } from "../../../domain/runtime-adapter.js";
import { unwrapBoxedLines, type TuiCliGatePattern } from "../tui-cli-runtime-adapter.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";

export const COPILOT_RUNTIME_ID = "copilot";
export const COPILOT_BINARY = "copilot";
export const COPILOT_RESUME_TYPE = "copilot_session_id";
export const COPILOT_GUIDANCE_FILE = "AGENTS.md";
/** Copilot's project skill roots are .github/skills, .agents/skills and
 *  .claude/skills (`copilot skill --help`); .agents/skills is the shared
 *  cross-runtime location the Codex adapter already projects into. */
export const COPILOT_SKILLS_SUBDIR = [".agents", "skills"] as const;

/** Discovery program match: basename `copilot` (standalone binary, npm
 *  `.bin/copilot` launcher) or a path inside @github/copilot or its
 *  per-platform package (@github/copilot-darwin-arm64/...). */
export const COPILOT_PROCESS_MATCH = /(?:^|\/)copilot$|\/@github\/copilot(?:-[a-z0-9-]+)?\//;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TokenFormatResult = { ok: true; token: string } | { ok: false; error: string };

/** Copilot session ids are lowercase UUIDs. The error never quotes the token. */
export function validateCopilotSessionId(token: string): TokenFormatResult {
  const trimmed = token.trim();
  if (!UUID_RE.test(trimmed)) {
    return { ok: false, error: "Copilot session id must be a lowercase UUID (8-4-4-4-12 hex)." };
  }
  return { ok: true, token: trimmed };
}

// ── launch argv ─────────────────────────────────────────────────────────────

export interface CopilotLaunchInput {
  model?: string | null;
  posture: ResolvedLaunchPosture;
  /** Fresh launch: the UUID minted for the new session. */
  newSessionId?: string;
  /** Resume launch: the persisted session id. */
  resumeToken?: string;
  forkSource?: ForkSource;
  binary?: string;
}

/**
 * argv for an interactive Copilot launch. Throws (refusing the launch) on a
 * fork request, a malformed token, or an ambiguous fresh/resume mix.
 * - full_bypass: `--yolo`. floor: no permission flag, so Copilot keeps its
 *   own default (prompt for writes and commands).
 * - Always `--no-auto-update`: a managed seat never updates the CLI.
 */
export function buildCopilotArgv(input: CopilotLaunchInput): string[] {
  if (input.forkSource) {
    throw new Error("copilot has no native fork primitive; remove session_source for copilot members");
  }
  if (input.resumeToken && input.newSessionId) {
    throw new Error("copilot launch: a resume token and a new session id are mutually exclusive");
  }
  // Every managed launch pins the installed version: without this a
  // standalone install downloads newer packages into its per-user cache and
  // switches to them on a later launch (`copilot help config`, autoUpdate).
  const argv = [input.binary ?? COPILOT_BINARY, "--no-auto-update"];
  if (input.resumeToken !== undefined) {
    const token = validateCopilotSessionId(input.resumeToken);
    if (!token.ok) throw new Error(`copilot resume: ${token.error}`);
    argv.push(`--resume=${token.token}`);
  } else if (input.newSessionId !== undefined) {
    const id = validateCopilotSessionId(input.newSessionId);
    if (!id.ok) throw new Error(`copilot launch: ${id.error}`);
    argv.push("--session-id", id.token);
  }
  const model = input.model?.trim();
  if (model) {
    if (model.startsWith("-")) throw new Error("copilot launch: model must not start with '-'");
    argv.push("--model", model);
  }
  if (input.posture === "full_bypass") argv.push("--yolo");
  return argv;
}

// ── pane patterns (live captures in test/fixtures/cli-panes/copilot-*.txt) ───

export const COPILOT_READY_PATTERNS: readonly RegExp[] = [
  // Idle footer under the input box: "← open sidebar · / commands · ? help · tab next tab".
  /\/ commands\s*·\s*\? help/,
];

/** The folder a "Confirm folder trust" dialog names: the first path in the
 *  boxed text after its title, with the CLI's hard wraps joined (at 80
 *  columns a long path wraps mid-word inside the box). */
export function copilotTrustDialogPath(screen: string): string | null {
  const lines = screen.split("\n");
  const title = lines.findIndex((line) => line.includes("Confirm folder trust"));
  if (title < 0) return null;
  const path = unwrapBoxedLines(lines.slice(title + 1)).find((text) => text.startsWith("/") || text.startsWith("~"));
  return path ?? null;
}

export const COPILOT_GATE_PATTERNS: readonly TuiCliGatePattern[] = [
  {
    pattern: /Do you trust the files in this folder\?|Confirm folder trust/,
    code: "trust_gate",
    reason: "copilot is asking to trust the workspace folder",
    // "1. Yes" trusts the folder for this session only; nothing is persisted.
    answer: {
      keys: ["Enter"],
      expectOptionText: "Yes",
      selectionMarker: "❯",
      dialogPath: copilotTrustDialogPath,
      describe: "trusted the seat's cwd for this Copilot session only",
    },
  },
  {
    // Printed as the last message above the prompt (cwd line, rule, `❯`). It
    // must win over the ready footer, but only while nothing has printed after
    // it: once `/login` runs, later lines push it off that position and the
    // stale text no longer gates.
    pattern: /Please use \/login to sign in to use Copilot[ \t]*\r?\n[^\n]*\r?\n[ \t]*─+[ \t]*\r?\n[ \t]*❯/,
    code: "login_required",
    reason: "copilot is not signed in (run `copilot login` or set COPILOT_GITHUB_TOKEN)",
  },
];

export const COPILOT_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string; recovery?: "retry_fresh"; code?: string }> = [
  {
    // Live: `copilot --resume=<unknown id>` prints this and exits 1.
    pattern: /No session, task, or name matched/,
    reason: "copilot could not find the session to resume",
    recovery: "retry_fresh",
    code: "session_missing",
  },
];

// ── identity / version ──────────────────────────────────────────────────────

/** `copilot --version` prints "GitHub Copilot CLI 1.0.89." */
export function parseCopilotVersion(output: string): string | null {
  const match = output.match(/GitHub Copilot CLI (\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

/** null = the binary is Copilot CLI; otherwise the reason it is not. */
export function verifyCopilotVersionOutput(output: string): string | null {
  return parseCopilotVersion(output)
    ? null
    : "`copilot --version` did not identify GitHub Copilot CLI; install it with `npm install -g @github/copilot` or `brew install --cask copilot-cli`";
}

// ── on-disk session store and settings ──────────────────────────────────────

export interface ReadOnlyFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Recursive relative file listing. */
  listFiles?(dirPath: string): string[];
}

/** COPILOT_HOME overrides the default $HOME/.copilot (`help environment`). */
export function copilotHome(env: NodeJS.ProcessEnv, homedir: string): string {
  const override = env.COPILOT_HOME?.trim();
  return override ? override : nodePath.join(homedir, ".copilot");
}

export function copilotWorkspaceFile(home: string, sessionId: string): string {
  return nodePath.join(home, "session-state", sessionId, "workspace.yaml");
}

export interface CopilotWorkspaceRecord {
  id: string;
  cwd?: string;
  createdAt?: string;
}

/** workspace.yaml is flat `key: value` lines; only the fields we need are read. */
export function parseCopilotWorkspaceYaml(content: string): CopilotWorkspaceRecord | null {
  const fields = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (match) fields.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  const id = fields.get("id");
  if (!id || !validateCopilotSessionId(id).ok) return null;
  return { id, cwd: fields.get("cwd"), createdAt: fields.get("created_at") };
}

/** Resume target check: the session must still exist on disk, otherwise the
 *  honest outcome is retry_fresh (never a silent new session). */
export function copilotResumeTargetExists(fs: ReadOnlyFs, home: string, sessionId: string): boolean {
  const id = validateCopilotSessionId(sessionId);
  if (!id.ok) return false;
  const file = copilotWorkspaceFile(home, id.token);
  if (!fs.exists(file)) return false;
  try {
    return parseCopilotWorkspaceYaml(fs.readFile(file))?.id === id.token;
  } catch {
    return false;
  }
}

export interface CopilotCaptureInput {
  fs: ReadOnlyFs;
  home: string;
  cwd: string;
  /** The id minted for this launch, when there was one. */
  mintedSessionId?: string;
  launchStartedAt?: Date;
}

/**
 * Read-only token capture. A minted id is confirmed on disk. Without one
 * (a seat adopted from a manual launch), the unique session whose cwd matches
 * and that was created at or after launch start is returned; zero or several
 * candidates return null rather than a guess.
 */
export function captureCopilotSessionId(input: CopilotCaptureInput): string | null {
  try {
    if (input.mintedSessionId) {
      return copilotResumeTargetExists(input.fs, input.home, input.mintedSessionId) ? input.mintedSessionId : null;
    }
    const stateDir = nodePath.join(input.home, "session-state");
    if (!input.fs.listFiles || !input.fs.exists(stateDir)) return null;
    const cwd = nodePath.resolve(input.cwd);
    const since = input.launchStartedAt?.getTime();
    const matches: string[] = [];
    for (const rel of input.fs.listFiles(stateDir)) {
      const parts = rel.split(/[\\/]/);
      if (parts.length !== 2 || parts[1] !== "workspace.yaml" || !UUID_RE.test(parts[0]!)) continue;
      const record = parseCopilotWorkspaceYaml(input.fs.readFile(nodePath.join(stateDir, rel)));
      if (!record || record.id !== parts[0] || !record.cwd || nodePath.resolve(record.cwd) !== cwd) continue;
      if (since !== undefined) {
        const created = record.createdAt ? Date.parse(record.createdAt) : NaN;
        if (!Number.isFinite(created) || created < since) continue;
      }
      matches.push(record.id);
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch {
    return null;
  }
}
