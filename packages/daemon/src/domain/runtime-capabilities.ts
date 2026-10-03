// Runtime capability hooks (F1): optional, read-only descriptor hooks that
// feature work implements per runtime and consumes from core.
//
// Contract for every hook:
//   - read-only: local files and environment only; no network, no login, no
//     keychain, never writes;
//   - never throws to the caller: the runners below turn a throw into the
//     hook's "unknown" value and log the reason (never a secret value);
//   - honest when unsure: null, absent fields, or state "unknown".
//
// Dependency leaf like runtime-capture.ts: adapters/cli/ modules import these
// types, and the registry imports the adapters, so this module must not import
// runtime-registry.ts at runtime (type imports only).

import os from "node:os";
import type { RuntimeDescriptor } from "./runtime-registry.js";
import { readLaunchStartedAt } from "./runtime-capture.js";

// ── Shared seat context ──────────────────────────────────────────────────────

/** What a seat-scoped read hook gets. Runners fill launchStartedAt from the
 *  seat's launch.json and homedir from os.homedir() when the caller omits them. */
export interface RuntimeSeatReadInput {
  sessionName: string;
  cwd: string | null;
  /** <OPENRIG_HOME>/state/<runtime id>/<session name>. */
  seatStateDir: string;
  homedir: string;
  /** The seat's persisted resume token, or null (some CLIs key data by session id). */
  resumeToken: string | null;
  /** When the current launch started (from launch.json). */
  launchStartedAt?: Date;
}

// ── Usage and context (features 1 and 4) ─────────────────────────────────────

export type RuntimeUsageInput = RuntimeSeatReadInput;

/** One reading of a seat's usage. Every metric is optional: absent = unknown. */
export interface RuntimeUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  contextUsedTokens?: number;
  /** Only when the CLI reports its context window. */
  contextWindowTokens?: number;
  model?: string;
  /** ISO time from the CLI's own record when it has one, else the read time. */
  observedAt: string;
  /** Stable id of where the numbers came from, e.g. "cline_session_json". */
  source: string;
}

// ── Sign-in status (feature 6) ───────────────────────────────────────────────

export interface RuntimeAuthContext {
  homedir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  cwd?: string;
  /** Read-only, size-capped file access. */
  fs: {
    exists(path: string): boolean;
    /** Null when missing or unreadable; at most maxBytes when given. */
    readFile(path: string, maxBytes?: number): string | null;
  };
  /** Present ONLY under `rig runtimes --probe`, for a documented read-only
   *  status command of the CLI. Null result = could not run. */
  probe?: {
    exec(argv: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string } | null>;
  };
}

export interface RuntimeAuthStatus {
  state: "signed_in" | "missing" | "unknown";
  /** What decided it, by NAME only (never a value): "env ANTHROPIC_API_KEY",
   *  "~/.local/share/opencode/auth.json". */
  source?: string;
  /** How to sign in, e.g. "run `opencode auth login` or set ANTHROPIC_API_KEY". */
  hint?: string;
  detail?: string;
}

// ── Model names (feature 7) ──────────────────────────────────────────────────

/** The shape of a valid `model:` for a runtime. Warn-only: never blocks. */
export interface RuntimeModelShape {
  pattern: RegExp;
  example: string;
  /** What a valid name looks like, in words ("provider/model"). */
  note?: string;
  /** Exact names that are valid even though they miss `pattern`. */
  aliases?: readonly string[];
}

export type ModelShapeCheck = { ok: true } | { ok: false; expected: string; example: string };

/** Pure check of a model name against a runtime's shape. */
export function checkModelShape(shape: RuntimeModelShape, model: string): ModelShapeCheck {
  const name = model.trim();
  if (shape.aliases?.includes(name) || shape.pattern.test(name)) return { ok: true };
  return { ok: false, expected: shape.note ?? shape.pattern.source, example: shape.example };
}

// ── Activity (feature 2) ─────────────────────────────────────────────────────

/** A registry runtime's activity read from its pane. Null = no confident read
 *  (pane at a shell, or no pattern matched): callers keep their generic source,
 *  so a wrong guess never suppresses a wake. */
export type RuntimeActivityState = "working" | "idle" | "needs_input";

// ── Native transcripts (feature 5) ───────────────────────────────────────────

export interface RuntimeTranscriptInput extends RuntimeSeatReadInput {
  /** Only entries at or after this time, when the CLI records times. */
  since?: Date;
  /** Upper bound on returned entries (newest kept). */
  maxEntries?: number;
}

export interface RuntimeTranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** ISO time when the CLI records it. */
  at?: string;
}

/** A transcript read from the CLI's own session record, for full-screen CLIs
 *  whose pane scrollback is thin. Callers apply transcript redaction. */
export interface RuntimeTranscript {
  /** Stable id of the record read, e.g. "cline_ui_messages_json". */
  source: string;
  entries: RuntimeTranscriptEntry[];
  /** True when older entries were dropped to honor maxEntries. */
  truncated?: boolean;
}

// ── Runners: the one path every consumer and test calls ──────────────────────

function withLaunchTime<T extends RuntimeSeatReadInput>(input: T): T {
  return {
    ...input,
    homedir: input.homedir || os.homedir(),
    launchStartedAt: input.launchStartedAt ?? readLaunchStartedAt(input.seatStateDir) ?? undefined,
  };
}

function logged(descriptor: RuntimeDescriptor, hook: string, sessionName: string | null, err: unknown): void {
  const seat = sessionName ? ` for ${sessionName}` : "";
  console.warn(`[openrig] ${descriptor.id} ${hook} failed${seat}: ${(err as Error)?.message ?? String(err)}`);
}

/** Read a seat's usage. Null when the runtime has no reader, has no data, or
 *  the reader throws (logged). */
export async function runDescriptorUsageRead(
  descriptor: RuntimeDescriptor,
  input: RuntimeUsageInput,
): Promise<RuntimeUsageSnapshot | null> {
  if (!descriptor.readUsage) return null;
  try {
    return (await descriptor.readUsage(withLaunchTime(input))) ?? null;
  } catch (err) {
    logged(descriptor, "readUsage", input.sessionName, err);
    return null;
  }
}

/** A runtime's sign-in status. "unknown" when it has no check or the check
 *  throws (logged, detail carries the reason). */
export async function runDescriptorAuthStatus(
  descriptor: RuntimeDescriptor,
  ctx: RuntimeAuthContext,
): Promise<RuntimeAuthStatus> {
  if (!descriptor.authStatus) return { state: "unknown" };
  try {
    return (await descriptor.authStatus(ctx)) ?? { state: "unknown" };
  } catch (err) {
    logged(descriptor, "authStatus", null, err);
    return { state: "unknown", detail: `sign-in check failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** Read a seat's native transcript. Null when the runtime has no source, the
 *  record is absent, or the reader throws (logged). */
export async function runDescriptorTranscriptRead(
  descriptor: RuntimeDescriptor,
  input: RuntimeTranscriptInput,
): Promise<RuntimeTranscript | null> {
  if (!descriptor.readTranscript) return null;
  try {
    const transcript = await descriptor.readTranscript(withLaunchTime(input));
    if (!transcript) return null;
    if (input.maxEntries !== undefined && transcript.entries.length > input.maxEntries) {
      return { ...transcript, entries: transcript.entries.slice(-input.maxEntries), truncated: true };
    }
    return transcript;
  } catch (err) {
    logged(descriptor, "readTranscript", input.sessionName, err);
    return null;
  }
}
