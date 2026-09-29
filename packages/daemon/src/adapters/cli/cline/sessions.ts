// Read-only access to Cline's on-disk session store, for resume-token capture
// and the pre-launch resume check.
//
// Layout (cline 3.0.65, verified live):
//   <sessions dir>/<id>/<id>.json            session metadata
//   <sessions dir>/<id>/<id>.messages.json   transcript
// where <sessions dir> is CLINE_SESSION_DATA_DIR, else CLINE_DATA_DIR/sessions,
// else CLINE_DIR/data/sessions, else ~/.cline/data/sessions.
//
// Sessions are written by Cline's shared background hub daemon, not by the
// TUI process: the metadata `pid` is the hub's pid and a per-seat
// CLINE_SESSION_DATA_DIR on the TUI is ignored. A session also exists only
// after the first prompt. So the only safe attribution is: an interactive CLI
// session whose cwd is the seat cwd and which started at or after this launch.
// Several matches mean pod-mates share the cwd (or one seat started a second
// task); capture then returns nothing rather than guess.

import nodePath from "node:path";
import { validateClineSessionId } from "./launch.js";

export interface ClineSessionFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
  /** Recursive listing relative to dirPath. */
  listFiles?(dirPath: string): string[];
}

/** Tolerated clock skew between the daemon's launch timestamp and the hub's
 *  started_at (both are local wall clock; the hub may round). */
export const CLINE_CAPTURE_SKEW_MS = 5_000;

export function clineSessionsDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const sessionDir = env.CLINE_SESSION_DATA_DIR?.trim();
  if (sessionDir) return sessionDir;
  const dataDir = env.CLINE_DATA_DIR?.trim();
  if (dataDir) return nodePath.join(dataDir, "sessions");
  const clineDir = env.CLINE_DIR?.trim();
  return nodePath.join(clineDir || nodePath.join(homedir, ".cline"), "data", "sessions");
}

export function clineSessionMetadataPath(sessionsDir: string, sessionId: string): string {
  return nodePath.join(sessionsDir, sessionId, `${sessionId}.json`);
}

export type ClineResumeTargetResult =
  | { ok: true }
  | { ok: false; error: string; recovery: "retry_fresh" };

/** Pre-launch resume check: the session's metadata file must still exist.
 *  A missing session is `retry_fresh` (stop and ask), never a silent fresh
 *  start: `cline --id <gone>` would open an empty TUI with an error line. */
export function checkClineResumeTarget(
  sessionId: string,
  ctx: { fs: ClineSessionFsOps; env: NodeJS.ProcessEnv; homedir: string },
): ClineResumeTargetResult {
  const validation = validateClineSessionId(sessionId);
  if (!validation.ok) return { ok: false, error: validation.error, recovery: "retry_fresh" };
  const metadata = clineSessionMetadataPath(clineSessionsDir(ctx.env, ctx.homedir), validation.token);
  if (!ctx.fs.exists(metadata)) {
    return { ok: false, error: "the persisted cline session no longer exists", recovery: "retry_fresh" };
  }
  return { ok: true };
}

export type ClineCaptureResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "no_store" | "no_match" | "ambiguous" };

export interface ClineCaptureInput {
  fs: ClineSessionFsOps;
  sessionsDir: string;
  cwd: string;
  launchStartedAt: Date;
}

interface ClineSessionMetadata {
  session_id?: unknown;
  source?: unknown;
  interactive?: unknown;
  cwd?: unknown;
  started_at?: unknown;
}

const METADATA_REL_RE = /^([^/\\]+)[/\\]([^/\\]+)\.json$/;

/** Find the session this seat's launch created. Read-only; never throws. */
export function findClineSessionForLaunch(input: ClineCaptureInput): ClineCaptureResult {
  const { fs, sessionsDir } = input;
  if (!fs.listFiles || !fs.exists(sessionsDir)) return { ok: false, reason: "no_store" };
  let files: string[];
  try {
    files = fs.listFiles(sessionsDir);
  } catch {
    return { ok: false, reason: "no_store" };
  }
  const floor = input.launchStartedAt.getTime() - CLINE_CAPTURE_SKEW_MS;
  const cwd = nodePath.resolve(input.cwd);
  const matches: string[] = [];
  for (const rel of files) {
    const m = rel.match(METADATA_REL_RE);
    // Only <id>/<id>.json; <id>/<id>.messages.json has a different basename.
    if (!m || m[1] !== m[2]) continue;
    const id = m[1]!;
    // Ids start with the creation time in epoch ms: skip old sessions without
    // reading them. Ids of another shape fall through to the metadata check.
    const idMs = /^(\d{12,})_/.exec(id)?.[1];
    if (idMs && Number(idMs) < floor) continue;
    const meta = readMetadata(fs, nodePath.join(sessionsDir, rel));
    if (!meta) continue;
    if (meta.session_id !== id || meta.source !== "cli" || meta.interactive !== true) continue;
    if (typeof meta.cwd !== "string" || nodePath.resolve(meta.cwd) !== cwd) continue;
    const startedAt = typeof meta.started_at === "string" ? Date.parse(meta.started_at) : NaN;
    if (!Number.isFinite(startedAt) || startedAt < floor) continue;
    if (!validateClineSessionId(id).ok) continue;
    matches.push(id);
  }
  if (matches.length === 0) return { ok: false, reason: "no_match" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, sessionId: matches[0]! };
}

function readMetadata(fs: ClineSessionFsOps, path: string): ClineSessionMetadata | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFile(path));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ClineSessionMetadata) : null;
  } catch {
    return null;
  }
}
