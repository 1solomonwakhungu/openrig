// Native transcripts (feature 5) for opencode and kilo seats, read from the
// seat's own session database (OPENCODE_DB / KILO_DB, opened read-only).
//
// Schema (opencode v1.18.33, packages/core/src/session/sql.ts): `message`
// (id, session_id, time_created, data JSON with `role`) and `part` (id,
// message_id, session_id, data JSON). Part shapes (packages/opencode/src/
// session/message-v2.ts): text { text, ignored?, synthetic? }, tool { tool,
// callID, state: { status, input, output?, error? } }, reasoning, file, and
// bookkeeping parts. Text and tool parts become entries; reasoning, ignored,
// and synthetic text are left out. Kilo is an opencode fork with the same
// schema. Read-only; never throws.

import type { RuntimeTranscript, RuntimeTranscriptEntry } from "../../../domain/runtime-capabilities.js";
import { toolCallText, transcriptPreview, transcriptTime } from "../transcript-text.js";
import type { SessionDbReader } from "./session-store.js";

/** The newest `?` parts, newest first (the SQL bounds the read; the reader
 *  reverses them into conversation order). */
export const OPENCODE_TRANSCRIPT_PARTS_SQL =
  "SELECT json_extract(m.data, '$.role') AS role, m.time_created AS at, p.data AS part "
  + "FROM part p JOIN message m ON m.id = p.message_id "
  + "WHERE p.session_id = ? ORDER BY m.time_created DESC, m.id DESC, p.id DESC LIMIT ?";

/** Parts read when the caller names no bound (the route passes its own). */
export const OPENCODE_TRANSCRIPT_DEFAULT_PARTS = 5_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readOpencodeTranscript(input: {
  db: SessionDbReader | null;
  sessionId: string | null | undefined;
  source: string;
  since?: Date;
  /** At most this many parts, the newest. */
  maxParts?: number;
}): RuntimeTranscript | null {
  if (!input.db?.all || !input.sessionId) return null;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = input.db.all(OPENCODE_TRANSCRIPT_PARTS_SQL, [input.sessionId, input.maxParts ?? OPENCODE_TRANSCRIPT_DEFAULT_PARTS]).reverse();
  } catch {
    return null;
  }
  const floor = input.since?.getTime();
  const entries: RuntimeTranscriptEntry[] = [];
  for (const row of rows) {
    const role = row.role === "user" || row.role === "assistant" ? row.role : null;
    if (!role) continue;
    let part: unknown;
    try {
      part = typeof row.part === "string" ? JSON.parse(row.part) : null;
    } catch {
      continue;
    }
    if (!isRecord(part)) continue;
    const at = transcriptTime(row.at);
    if (floor !== undefined && at && Date.parse(at) < floor) continue;
    const stamp = at ? { at } : {};
    if (part.type === "text" && typeof part.text === "string" && part.text.trim() && part.ignored !== true && part.synthetic !== true) {
      entries.push({ role, text: part.text, ...stamp });
    } else if (part.type === "tool" && typeof part.tool === "string" && isRecord(part.state)) {
      entries.push({ role: "tool", text: toolCallText(part.tool, part.state.input), ...stamp });
      if (part.state.status === "completed" && part.state.output !== undefined) {
        const out = transcriptPreview(part.state.output);
        if (out) entries.push({ role: "tool", text: out, ...stamp });
      } else if (part.state.status === "error" && typeof part.state.error === "string") {
        entries.push({ role: "tool", text: `error: ${transcriptPreview(part.state.error)}`, ...stamp });
      }
    }
  }
  return { source: input.source, entries };
}
