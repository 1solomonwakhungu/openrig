// Cline's native transcript (feature 5): <sessions dir>/<id>/<id>.messages.json.
//
// Cline draws its TUI on the alternate screen, so the pane capture is thin.
// Its session record is the transcript. Format, from the cline 3.0.65 bundle
// (persistSessionMessages and its reader):
//   { version: 1, updated_at, agent, sessionId, origin, messages: [...],
//     system_prompt? }   (the reader also accepts a bare messages array)
// Each message is { role, content, ts?, metadata? } where content is a string
// or a list of blocks: text, thinking, redacted_thinking, tool_use
// ({ name, input }), tool_result ({ content }), and others (image, file, ...).
// `ts` is epoch ms on assistant messages.
//
// Read-only, size-capped (NATIVE_TRANSCRIPT_MAX_BYTES, async stat then read), and never throws (the F1 runner adds the deadline
// and the error logging).

import nodePath from "node:path";
import type { RuntimeTranscript, RuntimeTranscriptEntry } from "../../../domain/runtime-capabilities.js";
import type { CliAdapterFsOps } from "../types.js";
import { findClineSessionForLaunch } from "./sessions.js";
import { validateClineSessionId } from "./launch.js";
import { noteSkippedTranscript, readTranscriptFile, transcriptPreview as preview, type TranscriptFileOps } from "../transcript-text.js";

export const CLINE_TRANSCRIPT_SOURCE = "cline_messages_json";

export function clineMessagesPath(sessionsDir: string, sessionId: string): string {
  return nodePath.join(sessionsDir, sessionId, `${sessionId}.messages.json`);
}

function blockTexts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) texts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) texts.push(b.text);
  }
  return texts;
}

/** Map one cline message to transcript entries: its text, then one tool entry
 *  per tool call or result. Thinking blocks are left out. */
function entriesOf(message: unknown): RuntimeTranscriptEntry[] {
  if (!message || typeof message !== "object") return [];
  const m = message as Record<string, unknown>;
  const role = m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : null;
  if (!role) return [];
  const at = typeof m.ts === "number" && Number.isFinite(m.ts) ? new Date(m.ts).toISOString() : undefined;
  const entries: RuntimeTranscriptEntry[] = [];
  const text = blockTexts(m.content).join("\n");
  if (text) entries.push({ role, text, ...(at ? { at } : {}) });
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if ((b.type === "tool_use" || b.type === "mcp_tool_use" || b.type === "server_tool_use") && typeof b.name === "string") {
        entries.push({ role: "tool", text: `${b.name}(${preview(b.input)})`, ...(at ? { at } : {}) });
      } else if (b.type === "tool_result" || b.type === "mcp_tool_result") {
        const result = blockTexts(b.content).join("\n") || preview(b.content);
        if (result) entries.push({ role: "tool", text: `${b.is_error === true ? "error: " : ""}${result}`, ...(at ? { at } : {}) });
      }
    }
  }
  return entries;
}

/** Parse a messages record (either envelope); null when it is not one. */
export function parseClineMessages(text: string): RuntimeTranscriptEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const messages = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : null;
  if (!messages) return null;
  return messages.flatMap(entriesOf);
}

export interface ClineTranscriptInput {
  /** Session lookup (metadata files); the record itself is read through fileOps. */
  fs: Pick<CliAdapterFsOps, "exists" | "readFile" | "listFiles">;
  /** Bounded async record read; defaults to node fs. */
  fileOps?: TranscriptFileOps;
  sessionsDir: string;
  /** The seat's persisted session id, when captured. */
  resumeToken: string | null;
  cwd: string | null;
  launchStartedAt?: Date;
  since?: Date;
}

/**
 * The seat's cline transcript. The session is the seat's resume token, else
 * the one session this launch created (the same attribution as capture).
 * Null when there is no such session, no readable record, or the record is
 * over NATIVE_TRANSCRIPT_MAX_BYTES (logged).
 */
export async function readClineTranscript(input: ClineTranscriptInput): Promise<RuntimeTranscript | null> {
  let sessionId = input.resumeToken && validateClineSessionId(input.resumeToken).ok ? input.resumeToken : null;
  if (!sessionId && input.cwd && input.launchStartedAt) {
    const found = findClineSessionForLaunch({ fs: input.fs as CliAdapterFsOps, sessionsDir: input.sessionsDir, cwd: input.cwd, launchStartedAt: input.launchStartedAt });
    sessionId = found.ok ? found.sessionId : null;
  }
  if (!sessionId) return null;
  const path = clineMessagesPath(input.sessionsDir, sessionId);
  const read = await readTranscriptFile(path, { ops: input.fileOps });
  if (!read.ok) {
    noteSkippedTranscript("cline", path, read);
    return null;
  }
  const entries = parseClineMessages(read.text);
  if (!entries) return null;
  const since = input.since?.getTime();
  const kept = since === undefined ? entries : entries.filter((entry) => !entry.at || Date.parse(entry.at) >= since);
  return { source: CLINE_TRANSCRIPT_SOURCE, entries: kept };
}
