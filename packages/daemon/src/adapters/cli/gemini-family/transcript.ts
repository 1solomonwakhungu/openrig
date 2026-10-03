// Native transcripts (feature 5) for gemini and qwen seats, read from each
// CLI's own session file (located by session-store.ts, like usage.ts).
//
// - gemini 0.61.0 (packages/core/src/services/chatRecordingTypes.ts): message
//   records { id, timestamp, type: user | gemini | info | error | warning,
//   content: PartListUnion, toolCalls?: { name, args, result?, status }[],
//   thoughts? }, replayed with geminiSessionMessages ($set and $rewindTo
//   lines included).
// - qwen 0.24.7 (packages/core/src/services/chatRecordingService.ts):
//   ChatRecord lines { timestamp, type: user | assistant | tool_result |
//   system, message: { role, parts } } where parts carry text (thought
//   parts have thought: true), functionCall { name, args }, or
//   functionResponse { name, response }.
//
// Thoughts are left out. Read-only; never throws.

import type { RuntimeTranscript, RuntimeTranscriptEntry } from "../../../domain/runtime-capabilities.js";
import { noteSkippedTranscript, readTranscriptFile, toolCallText, transcriptPreview, transcriptTime, type TranscriptFileOps } from "../transcript-text.js";
import { NODE_SESSION_STORE_FS } from "./runtime.js";
import type { SessionStoreContext } from "./session-store.js";
import { geminiSessionMessages } from "./session-store.js";

export const GEMINI_TRANSCRIPT_SOURCE = "gemini_session_jsonl";
export const QWEN_TRANSCRIPT_SOURCE = "qwen_chat_jsonl";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Text of a PartListUnion (string | Part | (string | Part)[]), thoughts left out. */
function partText(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim()) texts.push(part);
    } else if (isRecord(part) && part.thought !== true && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text);
    }
  }
  return texts.join("\n");
}

/** A functionResponse's output (`response.output` or `response.error`), else a preview. */
function functionResponseText(response: unknown): string {
  if (isRecord(response) && typeof response.output === "string") return response.output;
  if (isRecord(response) && typeof response.error === "string") return `error: ${response.error}`;
  return transcriptPreview(response);
}

/** Text of a tool result (PartListUnion): text parts, else functionResponse outputs. */
function resultText(result: unknown): string {
  const text = partText(result);
  if (text) return text;
  const parts = Array.isArray(result) ? result : [result];
  const outputs = parts
    .filter((part): part is Record<string, unknown> => isRecord(part) && isRecord(part.functionResponse))
    .map((part) => functionResponseText((part.functionResponse as Record<string, unknown>).response))
    .filter((out) => out !== "");
  return outputs.length > 0 ? transcriptPreview(outputs.join("\n")) : transcriptPreview(result);
}

function sinceFilter(entries: RuntimeTranscriptEntry[], since: Date | undefined): RuntimeTranscriptEntry[] {
  if (!since) return entries;
  const floor = since.getTime();
  return entries.filter((entry) => !entry.at || Date.parse(entry.at) >= floor);
}

/** gemini: the session file's text (session-store.ts findGeminiSessionFile). */
export function readGeminiTranscript(text: string | null, since?: Date): RuntimeTranscript | null {
  if (!text) return null;
  const entries: RuntimeTranscriptEntry[] = [];
  for (const message of geminiSessionMessages(text)) {
    const at = transcriptTime(message.timestamp);
    const stamp = at ? { at } : {};
    const body = partText(message.content);
    if (message.type === "user") {
      if (body) entries.push({ role: "user", text: body, ...stamp });
    } else if (message.type === "gemini") {
      if (body) entries.push({ role: "assistant", text: body, ...stamp });
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        if (!isRecord(call) || typeof call.name !== "string") continue;
        const callAt = transcriptTime(call.timestamp);
        const callStamp = callAt ? { at: callAt } : stamp;
        entries.push({ role: "tool", text: toolCallText(call.name, call.args), ...callStamp });
        const result = call.result === undefined || call.result === null ? "" : resultText(call.result);
        if (result) entries.push({ role: "tool", text: `${call.status === "error" ? "error: " : ""}${result}`, ...callStamp });
      }
    } else if (message.type === "info" || message.type === "error" || message.type === "warning") {
      if (body) entries.push({ role: "system", text: message.type === "info" ? body : `${message.type}: ${body}`, ...stamp });
    }
  }
  return { source: GEMINI_TRANSCRIPT_SOURCE, entries: sinceFilter(entries, since) };
}

/** qwen: the conversation file's text (<id>.jsonl, session-store.ts findQwenSessionFile). */
export function readQwenTranscript(text: string | null, since?: Date): RuntimeTranscript | null {
  if (!text) return null;
  const entries: RuntimeTranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn last line while qwen is writing
    }
    if (!isRecord(record) || !isRecord(record.message) || !Array.isArray(record.message.parts)) continue;
    const at = transcriptTime(record.timestamp);
    const stamp = at ? { at } : {};
    const parts = record.message.parts as unknown[];
    if (record.type === "user" || record.type === "assistant") {
      const body = partText(parts);
      if (body) entries.push({ role: record.type, text: body, ...stamp });
    }
    if (record.type === "assistant" || record.type === "tool_result") {
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
          entries.push({ role: "tool", text: toolCallText(part.functionCall.name, part.functionCall.args), ...stamp });
        } else if (isRecord(part.functionResponse)) {
          const out = functionResponseText(part.functionResponse.response);
          if (out) entries.push({ role: "tool", text: transcriptPreview(out), ...stamp });
        }
      }
    }
  }
  return { source: QWEN_TRANSCRIPT_SOURCE, entries: sinceFilter(entries, since) };
}

/**
 * Locate a seat's session file (gemini or qwen finder) and read it with the
 * shared async, size-capped read. Null when there is no file, it is over
 * NATIVE_TRANSCRIPT_MAX_BYTES (logged), or it cannot be read.
 */
export async function readSessionTranscript(
  runtime: string,
  find: (ctx: SessionStoreContext) => string | null,
  input: { cwd: string; homedir: string; env?: NodeJS.ProcessEnv; fileOps?: TranscriptFileOps },
  parse: (text: string) => RuntimeTranscript | null,
): Promise<RuntimeTranscript | null> {
  let path: string | null;
  try {
    path = find({ cwd: input.cwd, homedir: input.homedir, fs: NODE_SESSION_STORE_FS, env: input.env ?? process.env });
  } catch {
    return null;
  }
  if (!path) return null;
  const read = await readTranscriptFile(path, { ops: input.fileOps });
  if (!read.ok) {
    noteSkippedTranscript(runtime, path, read);
    return null;
  }
  return parse(read.text);
}

