// Shared helpers for native transcript readers (feature 5): bounded async
// reads of a CLI's session record, and short, readable text for tool inputs
// and results.

import { promises as fsp } from "node:fs";
import nodePath from "node:path";

/** Tool inputs and results are summarized, never dumped whole. */
export const TRANSCRIPT_PREVIEW_CHARS = 300;

/** A string as is, anything else as JSON, cut to `max` characters. */
export function transcriptPreview(value: unknown, max = TRANSCRIPT_PREVIEW_CHARS): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** "name(input preview)" for a tool call. */
export function toolCallText(name: string, input: unknown): string {
  return `${name}(${input === undefined ? "" : transcriptPreview(input)})`;
}

/** ISO time from an ISO string or epoch milliseconds; undefined otherwise. */
export function transcriptTime(value: unknown): string | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Session records larger than this are not read: a transcript read runs on
 *  the request path, and a whole-file read of a huge record would stall the
 *  daemon. Over the cap the reader returns null and logs why. */
export const NATIVE_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

export type TranscriptFileRead =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "too_large" | "unreadable"; bytes?: number };

export interface TranscriptFileOps {
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string): Promise<string>;
}

const NODE_TRANSCRIPT_FILE_OPS: TranscriptFileOps = {
  stat: (path) => fsp.stat(path),
  readFile: (path) => fsp.readFile(path, "utf-8"),
};

/** Stat, then read asynchronously, only when the file is within `maxBytes`. */
export async function readTranscriptFile(
  path: string,
  opts: { maxBytes?: number; ops?: TranscriptFileOps } = {},
): Promise<TranscriptFileRead> {
  const ops = opts.ops ?? NODE_TRANSCRIPT_FILE_OPS;
  const maxBytes = opts.maxBytes ?? NATIVE_TRANSCRIPT_MAX_BYTES;
  let size: number;
  try {
    size = (await ops.stat(path)).size;
  } catch (err) {
    return { ok: false, reason: (err as { code?: unknown }).code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (size > maxBytes) return { ok: false, reason: "too_large", bytes: size };
  try {
    return { ok: true, text: await ops.readFile(path) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** Log why a record was skipped (never its contents); missing is quiet. */
export function noteSkippedTranscript(runtime: string, path: string, read: TranscriptFileRead): void {
  if (read.ok || read.reason === "missing") return;
  const detail = read.reason === "too_large"
    ? `${Math.round((read.bytes ?? 0) / (1024 * 1024))} MiB is over the ${NATIVE_TRANSCRIPT_MAX_BYTES / (1024 * 1024)} MiB cap`
    : "unreadable";
  console.warn(`[openrig] ${runtime} native transcript skipped: ${nodePath.basename(path)} ${detail}; use --source pane`);
}
