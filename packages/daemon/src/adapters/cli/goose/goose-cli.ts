// Goose (`goose`): the runtime-specific pieces of the adapter.
//
// Pure (or injected read-only I/O) so it tests without a real binary. Facts
// were verified against goose 1.53.0 (aaif-goose/goose release asset) with
// `--help`, `goose info`, its sessions database, and live TUI runs in an
// isolated tmux server with a throwaway HOME and no credentials:
// - `goose session --name <name>` starts a NEW interactive session and
//   records the name with user_set_name = 1; the same name again makes
//   another session (names do not dedupe), so capture keys on the seat's
//   name plus the launch time. The session row exists from startup, before
//   any prompt, and `--resume --session-id <id>` reopens it.
// - Session ids look like 20261003_3 (UTC date, underscore, counter).
// - `--resume --session-id <id>` reopens an exact session; an unknown id
//   prints "Cannot resume session <id> - no such session exists" and exits.
//   Bare `--resume` would reopen the most recent session, so a managed
//   launch never uses it.
// - `--resume --session-id <parent> --fork` copies the parent into a new
//   session. `--name` cannot be combined with `--session-id`, so the copy
//   keeps the parent's name with user_set_name = 0 and no parent link.
// - Sessions live in one SQLite database per user:
//   $GOOSE_PATH_ROOT/data/sessions/sessions.db, else
//   $XDG_DATA_HOME/goose/sessions/sessions.db, else
//   ~/.local/share/goose/sessions/sessions.db (also on macOS).
//   created_at is UTC text "YYYY-MM-DD HH:MM:SS".
// - There is no permission flag. GOOSE_MODE (auto, approve, smart_approve,
//   chat) selects tool approval; goose's own default is auto, so a launch
//   always sets it. smart_approve asks before risky tool calls; a session
//   records its mode (sessions.goose_mode).
// - GOOSE_TELEMETRY_OFF=1 turns usage-data reporting off and skips the
//   first-run question about it.
// - The TUI is inline (no alternate screen). Hints come from .goosehints and
//   AGENTS.md; project skills from .agents/skills.
// - In approve mode a tool call asks "Goose would like to call the above
//   tool, do you allow?"; while working the spinner reads "(Ctrl+C to
//   interrupt)".

import nodePath from "node:path";
import Database from "better-sqlite3";
import type { ForkSource } from "../../../domain/runtime-adapter.js";
import type { TuiCliErrorPattern, TuiCliGatePattern } from "../tui-cli-runtime-adapter.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";
import { compactUsage, usageNumber, type RuntimeUsageSnapshot } from "../usage-snapshot.js";

export const GOOSE_RUNTIME_ID = "goose";
export const GOOSE_BINARY = "goose";
export const GOOSE_RESUME_TYPE = "goose_session_id";
export const GOOSE_GUIDANCE_FILE = "AGENTS.md";
export const GOOSE_SKILLS_SUBDIR = [".agents", "skills"] as const;
/** Discovery program match: the release binary is a single native `goose`. */
export const GOOSE_PROCESS_MATCH = /(?:^|\/)goose$/;

const SESSION_ID_RE = /^\d{8}_\d+$/;

export type TokenFormatResult = { ok: true; token: string } | { ok: false; error: string };

/** Goose session ids are YYYYMMDD_N. The error never quotes the token. */
export function validateGooseSessionId(token: string): TokenFormatResult {
  const trimmed = token.trim();
  if (!SESSION_ID_RE.test(trimmed)) {
    return { ok: false, error: "Goose session id must look like YYYYMMDD_N (for example 20261003_3)." };
  }
  return { ok: true, token: trimmed };
}

// ── launch argv ─────────────────────────────────────────────────────────────

/** GOOSE_MODE for full_bypass: approve every tool call without asking. */
export const GOOSE_FULL_BYPASS_MODE = "auto";
/** GOOSE_MODE for the floor: ask before risky tool calls. Always set, since
 *  goose's own default (auto) would make the floor equal full_bypass. */
export const GOOSE_FLOOR_MODE = "smart_approve";

export interface GooseLaunchInput {
  /** The seat's session name, recorded as the goose session name. */
  seatName: string;
  model?: string | null;
  resumeToken?: string;
  forkSource?: ForkSource;
  binary?: string;
}

/**
 * argv for an interactive goose launch. Throws (refusing the launch) on a
 * malformed token, an unsupported fork source, or a fresh/resume/fork mix.
 * Posture is applied through the launch env (gooseLaunchEnv), not argv.
 */
export function buildGooseArgv(input: GooseLaunchInput): string[] {
  if (input.resumeToken !== undefined && input.forkSource) {
    throw new Error("goose launch: a resume token and a fork source are mutually exclusive");
  }
  const argv = [input.binary ?? GOOSE_BINARY, "session"];
  if (input.resumeToken !== undefined) {
    const token = validateGooseSessionId(input.resumeToken);
    if (!token.ok) throw new Error(`goose resume: ${token.error}`);
    argv.push("--resume", "--session-id", token.token);
  } else if (input.forkSource) {
    if (input.forkSource.kind !== "native_id" || !input.forkSource.value) {
      throw new Error("goose fork needs a native session id (session_source with a goose session id)");
    }
    const parent = validateGooseSessionId(input.forkSource.value);
    if (!parent.ok) throw new Error(`goose fork: ${parent.error}`);
    argv.push("--resume", "--session-id", parent.token, "--fork");
  } else {
    const name = input.seatName.trim();
    if (!name || name.startsWith("-")) throw new Error("goose launch: the seat name must be non-empty and must not start with '-'");
    argv.push("--name", name);
  }
  const model = input.model?.trim();
  if (model) {
    if (model.startsWith("-")) throw new Error("goose launch: model must not start with '-'");
    argv.push("--model", model);
  }
  return argv;
}

/** The GOOSE_MODE a posture sets. */
export function gooseModeFor(posture: ResolvedLaunchPosture): string {
  return posture === "full_bypass" ? GOOSE_FULL_BYPASS_MODE : GOOSE_FLOOR_MODE;
}

/** Launch env: telemetry off on every launch (owner privacy), and the
 *  posture's GOOSE_MODE. */
export function gooseLaunchEnv(posture: ResolvedLaunchPosture): Record<string, string> {
  return { GOOSE_TELEMETRY_OFF: "1", GOOSE_MODE: gooseModeFor(posture) };
}

// ── pane patterns (live captures in test/fixtures/cli-panes/goose-80-*.txt) ──

export const GOOSE_READY_PATTERNS: readonly RegExp[] = [
  // Input footer: "> Enter to send · Ctrl+J newline" (the newline key is
  // configurable with GOOSE_CLI_NEWLINE_KEY).
  /Enter to send · \S+ newline/,
];

export const GOOSE_GATE_PATTERNS: readonly TuiCliGatePattern[] = [
  {
    // First run of a goose that has not recorded a telemetry choice. Managed
    // launches set GOOSE_TELEMETRY_OFF=1, which skips it; kept as a backstop.
    pattern: /Share anonymous usage data to help improve goose\?/,
    code: "startup_dialog",
    reason: "goose is asking whether to share anonymous usage data; answer it once by running `goose` in a terminal",
  },
  {
    // Resuming a session recorded in another directory.
    pattern: /Do you want to switch back to the original working directory\?/,
    code: "startup_dialog",
    reason: "goose is resuming a session recorded in another directory and asks whether to switch back",
  },
];

export const GOOSE_ERROR_PATTERNS: readonly TuiCliErrorPattern[] = [
  {
    pattern: /Cannot resume session \S+ - no such session exists/,
    reason: "goose could not find the session to resume",
    recovery: "retry_fresh",
    code: "session_missing",
  },
  {
    pattern: /No provider configured\. Run 'goose configure' first/,
    reason: "goose has no provider configured (run `goose configure`)",
    code: "login_required",
  },
  {
    pattern: /Configuration value not found: [A-Z][A-Z0-9_]*/,
    reason: "goose's provider key is not set (run `goose configure` or set the provider's key in the environment)",
    code: "login_required",
  },
];

// ── identity / version ──────────────────────────────────────────────────────

/** `goose --version` prints " 1.53.0". */
export function parseGooseVersion(output: string): string | null {
  return output.trim().match(/^(\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

/** null = the binary looks like goose; otherwise the reason it is not. */
export function verifyGooseVersionOutput(output: string): string | null {
  return parseGooseVersion(output)
    ? null
    : "`goose --version` did not print a goose version; install goose from https://github.com/aaif-goose/goose/releases or `brew install block-goose-cli`";
}

// ── sessions database ───────────────────────────────────────────────────────

/** Where goose keeps its sessions database for this environment. */
export function gooseSessionsDbPath(env: NodeJS.ProcessEnv, homedir: string): string {
  const root = env.GOOSE_PATH_ROOT?.trim();
  if (root) return nodePath.join(root, "data", "sessions", "sessions.db");
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && nodePath.isAbsolute(xdg)) return nodePath.join(xdg, "goose", "sessions", "sessions.db");
  return nodePath.join(homedir, ".local", "share", "goose", "sessions", "sessions.db");
}

export interface GooseSessionRow {
  id: string;
  name: string;
  userSetName: boolean;
  workingDir: string;
  /** UTC "YYYY-MM-DD HH:MM:SS". */
  createdAt: string;
}

export interface GooseDbReader {
  all(sql: string, params: readonly unknown[]): Array<Record<string, unknown>>;
  close(): void;
}

export interface GooseStoreDeps {
  exists(path: string): boolean;
  /** Opens the database read-only. Defaults to better-sqlite3. */
  openReadonly?: (path: string) => GooseDbReader;
}

export function openGooseDbReadonly(path: string): GooseDbReader {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2_000 });
  return {
    all: (sql, params) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    close: () => db.close(),
  };
}

function readRows(dbPath: string, deps: GooseStoreDeps, sql: string, params: readonly unknown[]): Array<Record<string, unknown>> | null {
  if (!deps.exists(dbPath)) return null;
  let reader: GooseDbReader | undefined;
  try {
    reader = (deps.openReadonly ?? openGooseDbReadonly)(dbPath);
    return reader.all(sql, params);
  } catch {
    return null;
  } finally {
    try { reader?.close(); } catch { /* already closed or never opened */ }
  }
}

function toRow(raw: Record<string, unknown>): GooseSessionRow | null {
  const { id, name, user_set_name: userSet, working_dir: workingDir, created_at: createdAt } = raw;
  if (typeof id !== "string" || !validateGooseSessionId(id).ok) return null;
  if (typeof name !== "string" || typeof workingDir !== "string" || typeof createdAt !== "string") return null;
  return { id, name, userSetName: userSet === 1 || userSet === true, workingDir, createdAt };
}

/** goose's created_at format for a time, floored to the second. */
export function gooseTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

const ROWS_SINCE_SQL =
  "SELECT id, name, user_set_name, working_dir, created_at FROM sessions WHERE session_type = 'user' AND created_at >= ? ORDER BY created_at DESC, id DESC";
const NAME_BY_ID_SQL = "SELECT name FROM sessions WHERE id = ? LIMIT 1";
const ID_SQL = "SELECT id FROM sessions WHERE id = ? LIMIT 1";

export interface GooseCaptureInput {
  dbPath: string;
  deps: GooseStoreDeps;
  /** The seat's session name (the `--name` a fresh launch passed). */
  seatName: string;
  cwd: string;
  launchStartedAt?: Date;
  /** The parent id when this launch forked. */
  forkParent?: string;
}

/**
 * Read-only token capture from the sessions database, keyed to this seat's
 * launch:
 * - fresh: the newest session named after the seat (user-set), in the seat's
 *   cwd, created at or after the launch start;
 * - fork: the one session created since the launch start in the seat's cwd
 *   that carries the parent's name without a user-set name (goose's fork
 *   copy). Zero or several candidates return null rather than a guess.
 * Without a launch start time nothing is captured. Never throws.
 */
export function captureGooseSessionId(input: GooseCaptureInput): string | null {
  try {
    if (!input.launchStartedAt) return null;
    const since = gooseTimestamp(input.launchStartedAt);
    const rows = readRows(input.dbPath, input.deps, ROWS_SINCE_SQL, [since]);
    if (!rows) return null;
    const cwd = nodePath.resolve(input.cwd);
    const candidates = rows
      .map(toRow)
      .filter((row): row is GooseSessionRow => row !== null && nodePath.resolve(row.workingDir) === cwd);
    if (input.forkParent) {
      const parentRows = readRows(input.dbPath, input.deps, NAME_BY_ID_SQL, [input.forkParent]);
      const parentName = parentRows?.[0]?.name;
      if (typeof parentName !== "string") return null;
      const copies = candidates.filter((row) => !row.userSetName && row.name === parentName && row.id !== input.forkParent);
      return copies.length === 1 ? copies[0]!.id : null;
    }
    return candidates.find((row) => row.userSetName && row.name === input.seatName)?.id ?? null;
  } catch {
    return null;
  }
}

export type GooseSessionPresence = "present" | "missing" | "unknown";

/** Whether a resume target exists, checked before typing a resume. "unknown"
 *  (unreadable database) lets the launch proceed; goose's own "no such
 *  session" output is the backstop. */
export function gooseSessionPresence(dbPath: string, token: string, deps: GooseStoreDeps): GooseSessionPresence {
  if (!deps.exists(dbPath)) return "missing";
  const rows = readRows(dbPath, deps, ID_SQL, [token]);
  if (!rows) return "unknown";
  return rows.length > 0 ? "present" : "missing";
}

// ── usage (feature 1) ───────────────────────────────────────────────────────

/** Session totals and the latest context fill for one goose session (sessions
 *  table, goose 1.53.0 schema): accumulated_* are the session's running totals
 *  and accumulated_cost goose's own cost; total_tokens is the latest request's
 *  total, which goose shows as context use. */
export const GOOSE_USAGE_SQL =
  "SELECT accumulated_input_tokens, accumulated_output_tokens, accumulated_cache_read_tokens, accumulated_cache_write_tokens, "
  + "accumulated_cost, total_tokens, provider_name, model_config_json, updated_at FROM sessions WHERE id = ? LIMIT 1";

/** "YYYY-MM-DD HH:MM:SS" (UTC, as goose stores it) to ISO; undefined otherwise. */
function gooseTimeToIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * A goose seat's usage from its session row. Null when the session is not in
 * the database, the database is unreadable, or the row has no numbers yet.
 * Read-only; never throws.
 */
export function readGooseUsage(input: { dbPath: string; deps: GooseStoreDeps; sessionId: string | null | undefined; now?: () => Date }): RuntimeUsageSnapshot | null {
  if (!input.sessionId || !validateGooseSessionId(input.sessionId).ok) return null;
  const rows = readRows(input.dbPath, input.deps, GOOSE_USAGE_SQL, [input.sessionId.trim()]);
  const row = rows?.[0];
  if (!row) return null;
  let modelName: string | undefined;
  try {
    const config = typeof row.model_config_json === "string" ? JSON.parse(row.model_config_json) as { model_name?: unknown } : null;
    if (config && typeof config.model_name === "string" && config.model_name.trim()) modelName = config.model_name.trim();
  } catch {
    modelName = undefined;
  }
  const provider = typeof row.provider_name === "string" && row.provider_name.trim() ? row.provider_name.trim() : undefined;
  const cost = usageNumber(row.accumulated_cost);
  return compactUsage({
    inputTokens: usageNumber(row.accumulated_input_tokens),
    outputTokens: usageNumber(row.accumulated_output_tokens),
    cacheReadTokens: usageNumber(row.accumulated_cache_read_tokens),
    cacheWriteTokens: usageNumber(row.accumulated_cache_write_tokens),
    costUsd: cost,
    // goose computes the cost itself from its provider pricing.
    costSource: cost !== undefined ? "cli_reported" : undefined,
    contextUsedTokens: usageNumber(row.total_tokens),
    model: modelName ? (provider ? `${provider}/${modelName}` : modelName) : undefined,
    observedAt: gooseTimeToIso(row.updated_at) ?? (input.now ?? (() => new Date()))().toISOString(),
    source: GOOSE_USAGE_SOURCE,
  });
}

export const GOOSE_USAGE_SOURCE = "goose_sessions_db";

// ── native transcript (feature 5) ───────────────────────────────────────────

/** goose 1.53.0 messages table: role, content_json (MessageContentBlock[],
 *  tagged by `type` in camelCase), created_timestamp (unix seconds), and
 *  metadata_json ({ userVisible, agentVisible }). */
/** The newest `?` messages, newest first: the SQL bounds the read on the
 *  request path, and the reader reverses them into conversation order. */
export const GOOSE_TRANSCRIPT_SQL =
  "SELECT role, content_json, created_timestamp, metadata_json FROM messages WHERE session_id = ? ORDER BY created_timestamp DESC, id DESC LIMIT ?";
/** Messages read when the caller names no bound (the route passes its own). */
export const GOOSE_TRANSCRIPT_DEFAULT_MESSAGES = 5_000;
export const GOOSE_TRANSCRIPT_SOURCE = "goose_messages_db";
const TRANSCRIPT_PREVIEW_CHARS = 300;

function gooseRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function gooseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function gooseClip(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  return text.length > TRANSCRIPT_PREVIEW_CHARS ? `${text.slice(0, TRANSCRIPT_PREVIEW_CHARS)}...` : text;
}

/**
 * A goose session's transcript from the messages table. Text blocks keep the
 * message role; tool requests (`toolCall: { status, value: { name,
 * arguments } }`) and responses (`toolResult: { status, value: { content,
 * isError } }` or `{ status: "error", error }`) become tool entries; thinking
 * and messages marked not user-visible are left out. Read-only; never throws.
 */
export function readGooseTranscript(input: { dbPath: string; deps: GooseStoreDeps; sessionId: string | null; since?: Date; maxMessages?: number }): { source: string; entries: Array<{ role: "user" | "assistant" | "tool"; text: string; at?: string }> } | null {
  if (!input.sessionId || !validateGooseSessionId(input.sessionId).ok) return null;
  const newestFirst = readRows(input.dbPath, input.deps, GOOSE_TRANSCRIPT_SQL, [input.sessionId.trim(), input.maxMessages ?? GOOSE_TRANSCRIPT_DEFAULT_MESSAGES]);
  if (!newestFirst) return null;
  const rows = newestFirst.reverse();
  const floor = input.since?.getTime();
  const entries: Array<{ role: "user" | "assistant" | "tool"; text: string; at?: string }> = [];
  for (const row of rows) {
    const role = row.role === "user" || row.role === "assistant" ? row.role : null;
    if (!role) continue;
    const metadata = gooseJson(row.metadata_json);
    if (gooseRecord(metadata) && metadata.userVisible === false) continue;
    const seconds = typeof row.created_timestamp === "number" ? row.created_timestamp : NaN;
    const at = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
    if (floor !== undefined && at && Date.parse(at) < floor) continue;
    const stamp = at ? { at } : {};
    const blocks = gooseJson(row.content_json);
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!gooseRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        entries.push({ role, text: block.text, ...stamp });
      } else if (block.type === "toolRequest" && gooseRecord(block.toolCall)) {
        const call = block.toolCall;
        if (call.status === "success" && gooseRecord(call.value) && typeof call.value.name === "string") {
          entries.push({ role: "tool", text: `${call.value.name}(${call.value.arguments === undefined ? "" : gooseClip(call.value.arguments)})`, ...stamp });
        }
      } else if (block.type === "toolResponse" && gooseRecord(block.toolResult)) {
        const result = block.toolResult;
        if (result.status === "error") {
          entries.push({ role: "tool", text: `error: ${gooseClip(result.error)}`, ...stamp });
        } else if (gooseRecord(result.value)) {
          const content = Array.isArray(result.value.content) ? result.value.content : [];
          const text = content
            .filter((item): item is Record<string, unknown> => gooseRecord(item) && item.type === "text" && typeof item.text === "string")
            .map((item) => item.text as string)
            .join("\n");
          const out = gooseClip(text || content);
          if (out) entries.push({ role: "tool", text: `${result.value.isError === true ? "error: " : ""}${out}`, ...stamp });
        }
      }
    }
  }
  return { source: GOOSE_TRANSCRIPT_SOURCE, entries };
}

