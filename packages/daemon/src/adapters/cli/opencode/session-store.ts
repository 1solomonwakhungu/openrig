// Read-only access to an OpenCode-family seat's session database.
//
// OpenCode and Kilo create the session row lazily, on the first prompt, so a
// fresh launch has no token at readiness. The seat's database (OPENCODE_DB /
// KILO_DB, one per seat) is the source of truth afterwards: its current
// session is the most recently updated top-level session. Sub-agent sessions
// carry a parent_id and archived sessions a time_archived; both are excluded.
//
// Same posture as codex-thread-id.ts: open read-only, never write, and turn
// every failure into a structured outcome instead of a throw. Tokens are never
// placed in a reason string.

import Database from "better-sqlite3";
import { validateOpencodeSessionId } from "./family.js";

export interface SessionDbReader {
  /** First row of a read-only query, or undefined. */
  get(sql: string, params: readonly unknown[]): Record<string, unknown> | undefined;
  close(): void;
}

export interface SessionStoreDeps {
  exists(path: string): boolean;
  /** Opens the database read-only. Defaults to better-sqlite3. */
  openReadonly?: (path: string) => SessionDbReader;
}

export type CurrentSessionResult =
  | { ok: true; token: string }
  | { ok: false; reason: "missing_db" | "no_session" | "read_error" | "invalid_token" };

export type SessionPresence = "present" | "missing" | "unknown";

const CURRENT_SESSION_SQL =
  "SELECT id FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC, id DESC LIMIT 1";
const SESSION_BY_ID_SQL = "SELECT id FROM session WHERE id = ? LIMIT 1";

export function openSessionDbReadonly(path: string): SessionDbReader {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2_000 });
  return {
    get: (sql, params) => db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
    close: () => db.close(),
  };
}

function withReader<T>(
  dbPath: string,
  deps: SessionStoreDeps,
  read: (reader: SessionDbReader) => T,
): { ok: true; value: T } | { ok: false } {
  let reader: SessionDbReader | undefined;
  try {
    reader = (deps.openReadonly ?? openSessionDbReadonly)(dbPath);
    return { ok: true, value: read(reader) };
  } catch {
    return { ok: false };
  } finally {
    try { reader?.close(); } catch { /* already closed or never opened */ }
  }
}

/** The seat's current top-level session id. */
export function readCurrentSessionId(dbPath: string, deps: SessionStoreDeps): CurrentSessionResult {
  if (!deps.exists(dbPath)) return { ok: false, reason: "missing_db" };
  const row = withReader(dbPath, deps, (reader) => reader.get(CURRENT_SESSION_SQL, []));
  if (!row.ok) return { ok: false, reason: "read_error" };
  const id = row.value?.id;
  if (typeof id !== "string") return { ok: false, reason: "no_session" };
  const validation = validateOpencodeSessionId(id);
  return validation.ok ? { ok: true, token: validation.token } : { ok: false, reason: "invalid_token" };
}

/**
 * Whether a resume target exists in the seat's database, checked before a
 * resume command is typed. "missing" (no database, or no such row) means the
 * resume cannot succeed and the caller must not start fresh silently.
 * "unknown" (unreadable database) lets the launch proceed; the CLI's own
 * "Session not found" output is the backstop.
 */
export function sessionPresence(dbPath: string, token: string, deps: SessionStoreDeps): SessionPresence {
  if (!deps.exists(dbPath)) return "missing";
  const row = withReader(dbPath, deps, (reader) => reader.get(SESSION_BY_ID_SQL, [token]));
  if (!row.ok) return "unknown";
  return row.value ? "present" : "missing";
}
