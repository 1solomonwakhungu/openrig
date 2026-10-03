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
// Read-only, size-capped, and never throws (the F1 runner adds the deadline
// and the error logging).

import nodePath from "node:path";
import type { RuntimeTranscript, RuntimeTranscriptEntry } from "../../../domain/runtime-capabilities.js";
import type { CliAdapterFsOps } from "../types.js";
import { findClineSessionForLaunch } from "./sessions.js";
import { validateClineSessionId } from "./launch.js";

export const CLINE_TRANSCRIPT_SOURCE = "cline_messages_json";
/** Larger records are not read (the route would not render them usefully). */
export const CLINE_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
/** Tool inputs are summarized, never dumped whole. */
const TOOL_INPUT_PREVIEW = 300;

export function clineMessagesPath(sessionsDir: string, sessionId: string): string {
  return nodePath.join(sessionsDir, sessionId, `${sessionId}.messages.json`);
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  return text.length > TOOL_INPUT_PREVIEW ? `${text.slice(0, TOOL_INPUT_PREVIEW)}...` : text;
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
  fs: Pick<CliAdapterFsOps, "exists" | "readFile" | "listFiles">;
  /** Size of a file in bytes, or null when unknown. */
  fileSize(path: string): number | null;
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
 * Null when there is no such session or no readable record.
 */
export function readClineTranscript(input: ClineTranscriptInput): RuntimeTranscript | null {
  let sessionId = input.resumeToken && validateClineSessionId(input.resumeToken).ok ? input.resumeToken : null;
  if (!sessionId && input.cwd && input.launchStartedAt) {
    const found = findClineSessionForLaunch({ fs: input.fs as CliAdapterFsOps, sessionsDir: input.sessionsDir, cwd: input.cwd, launchStartedAt: input.launchStartedAt });
    sessionId = found.ok ? found.sessionId : null;
  }
  if (!sessionId) return null;
  const path = clineMessagesPath(input.sessionsDir, sessionId);
  if (!input.fs.exists(path)) return null;
  const size = input.fileSize(path);
  if (size === null || size > CLINE_TRANSCRIPT_MAX_BYTES) return null;
  const entries = parseClineMessages(input.fs.readFile(path));
  if (!entries) return null;
  const since = input.since?.getTime();
  const kept = since === undefined ? entries : entries.filter((entry) => !entry.at || Date.parse(entry.at) >= since);
  return { source: CLINE_TRANSCRIPT_SOURCE, entries: kept };
}
