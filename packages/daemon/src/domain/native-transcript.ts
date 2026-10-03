// Native transcripts (feature 5): the transcript a CLI keeps in its own
// session record, for runtimes whose pane scrollback is thin (full-screen
// TUIs on the alternate screen). The route consumer is routes/transcripts.ts;
// each runtime supplies a reader through the F1 `readTranscript` hook.
//
// The rendered text always goes through transcript redaction before it leaves
// the daemon.

import type Database from "better-sqlite3";
import os from "node:os";
import { runDescriptorTranscriptRead, type RuntimeTranscriptEntry } from "./runtime-capabilities.js";
import { getRuntimeDescriptor, runtimeSeatStateDir } from "./runtime-registry.js";
import { redactTranscriptContent } from "./transcript-redaction.js";

/** Which transcript a read uses: the CLI's own record when the runtime has
 *  one ("auto", the default), only the pane capture, or only the record. */
export type TranscriptSourcePreference = "auto" | "pane" | "native";

export function parseTranscriptSource(value: string | undefined): TranscriptSourcePreference | null {
  if (value === undefined || value === "") return "auto";
  return value === "auto" || value === "pane" || value === "native" ? value : null;
}

/** Upper bound on entries read for one request; the newest are kept. */
export const NATIVE_TRANSCRIPT_MAX_ENTRIES = 5_000;

const ROLE_LABELS: Record<RuntimeTranscriptEntry["role"], string> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "system",
};

/** One block per entry: "[time] role ▸ first line", continuation lines as
 *  written. Lines, not entries, are what tail and grep count. */
export function renderTranscriptEntries(entries: readonly RuntimeTranscriptEntry[]): string {
  return entries
    .map((entry) => `${entry.at ? `[${entry.at}] ` : ""}${ROLE_LABELS[entry.role]} ▸ ${entry.text.replace(/\r\n/g, "\n").trimEnd()}`)
    .join("\n");
}

export interface NativeSeatTranscript {
  /** The record read, e.g. "cline_messages_json". */
  source: string;
  /** Rendered and redacted. */
  text: string;
  entries: number;
  truncated: boolean;
}

/**
 * The seat's native transcript, rendered and redacted. Null when the runtime
 * has no reader, the record is absent or empty, or the reader fails (the
 * runner logs it and never throws).
 */
export async function readNativeSeatTranscript(
  db: Database.Database,
  input: { runtime: string | null; nodeId: string; sessionName: string; stateRoot?: string; homedir?: string },
): Promise<NativeSeatTranscript | null> {
  const descriptor = getRuntimeDescriptor(input.runtime);
  if (!descriptor?.readTranscript) return null;
  const node = db.prepare("SELECT cwd FROM nodes WHERE id = ?").get(input.nodeId) as { cwd: string | null } | undefined;
  const session = db
    .prepare("SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1")
    .get(input.nodeId, input.sessionName) as { resume_token: string | null } | undefined;
  const transcript = await runDescriptorTranscriptRead(descriptor, {
    sessionName: input.sessionName,
    cwd: node?.cwd ?? null,
    seatStateDir: runtimeSeatStateDir(descriptor.id, input.sessionName, input.stateRoot),
    homedir: input.homedir ?? os.homedir(),
    resumeToken: session?.resume_token ?? null,
    maxEntries: NATIVE_TRANSCRIPT_MAX_ENTRIES,
  });
  if (!transcript || transcript.entries.length === 0) return null;
  return {
    source: transcript.source,
    text: redactTranscriptContent(renderTranscriptEntries(transcript.entries)),
    entries: transcript.entries.length,
    truncated: transcript.truncated === true,
  };
}
