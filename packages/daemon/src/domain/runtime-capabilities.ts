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

/** Where a snapshot's costUsd came from. */
export type RuntimeUsageCostSource = "cli_reported" | "estimated";

/**
 * One reading of a seat's usage. Every metric is optional: absent = unknown.
 *
 * Semantics every reader and consumer shares:
 *   - token counts and costUsd are cumulative totals for the CLI session the
 *     seat is on (the one resumeToken names, else the current launch's
 *     session), never per turn: a consumer REPLACES its previous snapshot
 *     with the newer one and never sums successive snapshots;
 *   - contextUsedTokens is the current context fill (what the next request
 *     carries), not a running total, so it can go down after compaction;
 *   - model and contextWindowTokens come from the CLI's own record or
 *     screen for this session, never from a table OpenRig keeps.
 */
export interface RuntimeUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Reasoning or thinking tokens, when the CLI records them separately. */
  reasoningTokens?: number;
  /** Session total in US dollars. Set together with costSource. */
  costUsd?: number;
  /** "cli_reported" when the CLI itself recorded or printed the cost;
   *  "estimated" when the reader computed it (e.g. tokens times a price), so
   *  displays label it as an estimate. Required whenever costUsd is set. */
  costSource?: RuntimeUsageCostSource;
  /** Current context fill, not cumulative. */
  contextUsedTokens?: number;
  /** Only when the CLI reports its context window for this session. */
  contextWindowTokens?: number;
  /** The model the CLI says this session uses. */
  model?: string;
  /** ISO time from the CLI's own record when it has one, else the read time. */
  observedAt: string;
  /** Stable id of where the numbers came from, e.g. "cline_session_json". */
  source: string;
  /** True when the CLI only reports rounded counts (e.g. "2.1k sent"), so
   *  displays must show the numbers as estimates. Absent = exact. */
  approximate?: boolean;
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

/** Pure check of a model name against a runtime's shape. The pattern is
 *  copied without the g and y flags, whose lastIndex would make repeated
 *  checks of the same name disagree. */
export function checkModelShape(shape: RuntimeModelShape, model: string): ModelShapeCheck {
  const name = model.trim();
  const pattern = new RegExp(shape.pattern.source, shape.pattern.flags.replace(/[gy]/g, ""));
  if (shape.aliases?.includes(name) || pattern.test(name)) return { ok: true };
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

/** Default runner deadlines: a hung hook must never hang rig ps, rig runtimes,
 *  or rig transcript. Callers may pass a different timeoutMs. */
export const CAPABILITY_TIMEOUTS_MS = { auth: 2_000, usage: 5_000, transcript: 5_000 } as const;

export interface CapabilityRunOptions {
  timeoutMs?: number;
}

function withLaunchTime<T extends RuntimeSeatReadInput>(input: T): T {
  return {
    ...input,
    homedir: input.homedir || os.homedir(),
    launchStartedAt: input.launchStartedAt ?? readLaunchStartedAt(input.seatStateDir) ?? undefined,
  };
}

/**
 * What a failure may say: the error's name and code only. Never the message:
 * a JSON.parse error quotes the file's text, so a malformed credential file
 * would otherwise leak key material into logs and user-facing detail.
 */
export function describeCapabilityError(err: unknown): string {
  if (err instanceof CapabilityTimeout) return `timed out after ${err.timeoutMs}ms`;
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? `${name} (${code})` : name;
}

class CapabilityTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super("capability hook timed out");
    this.name = "CapabilityTimeout";
  }
}

/** Run a hook against a deadline. A synchronous hook runs to completion before
 *  the deadline can apply; only async waits are bounded. */
async function withDeadline<T>(run: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CapabilityTimeout(timeoutMs)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logged(descriptor: RuntimeDescriptor, hook: string, sessionName: string | null, err: unknown): string {
  const reason = describeCapabilityError(err);
  console.warn(`[openrig] ${descriptor.id} ${hook} failed${sessionName ? ` for ${sessionName}` : ""}: ${reason}`);
  return reason;
}

/** A cost without its provenance is dropped, so no display can show an
 *  unlabeled estimate as a reported figure. */
function withCostProvenance(snapshot: RuntimeUsageSnapshot): RuntimeUsageSnapshot {
  if (snapshot.costUsd === undefined || snapshot.costSource) return snapshot;
  const { costUsd: _dropped, ...rest } = snapshot;
  return rest;
}

/** Read a seat's usage. Null when the runtime has no reader, has no data, the
 *  reader throws, or it misses the deadline (both logged). A costUsd without
 *  costSource is dropped. */
export async function runDescriptorUsageRead(
  descriptor: RuntimeDescriptor,
  input: RuntimeUsageInput,
  opts: CapabilityRunOptions = {},
): Promise<RuntimeUsageSnapshot | null> {
  const hook = descriptor.readUsage;
  if (!hook) return null;
  try {
    const snapshot = await withDeadline(() => hook(withLaunchTime(input)), opts.timeoutMs ?? CAPABILITY_TIMEOUTS_MS.usage);
    return snapshot ? withCostProvenance(snapshot) : null;
  } catch (err) {
    logged(descriptor, "readUsage", input.sessionName, err);
    return null;
  }
}

/** A runtime's sign-in status. "unknown" when it has no check, the check
 *  throws, or it misses the deadline; detail names the error kind only. */
export async function runDescriptorAuthStatus(
  descriptor: RuntimeDescriptor,
  ctx: RuntimeAuthContext,
  opts: CapabilityRunOptions = {},
): Promise<RuntimeAuthStatus> {
  const hook = descriptor.authStatus;
  if (!hook) return { state: "unknown" };
  try {
    return (await withDeadline(() => hook(ctx), opts.timeoutMs ?? CAPABILITY_TIMEOUTS_MS.auth)) ?? { state: "unknown" };
  } catch (err) {
    return { state: "unknown", detail: `sign-in check failed: ${logged(descriptor, "authStatus", null, err)}` };
  }
}

/** Read a seat's native transcript. Null when the runtime has no source, the
 *  record is absent, the reader throws, or it misses the deadline. */
export async function runDescriptorTranscriptRead(
  descriptor: RuntimeDescriptor,
  input: RuntimeTranscriptInput,
  opts: CapabilityRunOptions = {},
): Promise<RuntimeTranscript | null> {
  const hook = descriptor.readTranscript;
  if (!hook) return null;
  try {
    const transcript = await withDeadline(() => hook(withLaunchTime(input)), opts.timeoutMs ?? CAPABILITY_TIMEOUTS_MS.transcript);
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
