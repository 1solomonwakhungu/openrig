// OPR.0.4.3.04 B2 — the PURE, reusable resume-token DERIVE helper.
//
// This is the shared derivation core behind FR-3's adoption-boundary capture
// (ClaimService.captureResumeTokenOnAdoption) AND the seat-handover discovered-
// mode capture. It performs REUSE-ONLY, PURE READ derivation — no pane writes,
// no launch, no persistence, no event emission. The CALLER owns persistence
// (updateResumeToken) and event emission (captured / preserved / skipped), so
// each caller keeps its own provenance + audit semantics.
//
// The derived token is credential-class: it is NEVER logged, echoed, or placed
// in any returned message/error. Only the caller's redacted persistence path
// ever touches it. Honest failure = a structured skip reason (no token), never
// a fabricated value.
//
// FR-3's scope is UNCHANGED: this helper is derive-only and does not alter
// which lifecycle ops adopt. It only removes the duplication between the two
// derive sites the ruling asked us to share.

import { validateResumeToken, type ResumeType } from "./resume-token-validation.js";
import { getRuntimeDescriptor, runtimeSeatStateDir } from "./runtime-registry.js";
import { runDescriptorTokenCapture } from "./runtime-capture.js";

export interface ResumeTokenCaptureDeps {
  /** Whether another live seat of this runtime shares this cwd (session
   *  registry). Present = the sibling-seat guard applies to CLI runtimes whose
   *  capture is not session-scoped (runtime-capture.ts). */
  hasLiveSiblingSeat?: ((input: { runtime: string; cwd: string; sessionName: string }) => string | null) | null;
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string; sampled_at?: string } } | { ok: false; reason: string };
  } | null;
  /** Start time (`ps` lstart) of the Claude process now in the seat's pane, or null when unknown. */
  claudeProcessStartedAt?: ((sessionName: string) => Promise<string | null>) | null;
  resumeTokenCapturer?: {
    captureCodexThreadId(sessionName: string): Promise<string | undefined>;
  } | null;
  /** OPR.0.4.6.PI1 FR-6 — reads the pi-runner's session-state sidecar (the
   *  runner persists sessionFile/sessionId from RPC get_state; a file read,
   *  same posture as the claude-code status-line sidecar). */
  piRunnerStateStore?: {
    readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
  } | null;
  /** Reads the separately rooted OMP runner sidecar; never reads Pi seat state. */
  ompRunnerStateStore?: {
    readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
  } | null;
}

export type ResumeTokenDeriveResult =
  /** Runtime has no resume token (terminal / unknown) — not a failure, no event. */
  | { outcome: "exempt" }
  /** A required derive dependency is absent (older wiring / test) — silent no-op. */
  | { outcome: "noop" }
  /** A live token was derived + format-validated. The caller persists it. */
  | { outcome: "captured"; resumeType: ResumeType; token: string }
  /** Derivation ran but produced no usable token — the caller emits a skip event. */
  | { outcome: "skipped"; reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "process_unreadable" | "invalid_token" | "stale_sidecar" | "capture_error" | "ambiguous_seat" };

/**
 * A Claude sidecar outlives the process that wrote it (#421: a seat that keeps a user's own status
 * line never refreshes it). A sample taken before the pane's current Claude process started can
 * only come from an earlier process, so its session id is not this process's. True only when both
 * times are known; unknown never reads as stale.
 */
export async function isClaudeSidecarFromEarlierProcess(
  sampledAt: unknown,
  sessionName: string,
  claudeProcessStartedAt: ResumeTokenCaptureDeps["claudeProcessStartedAt"],
): Promise<boolean> {
  if (typeof sampledAt !== "string" || !claudeProcessStartedAt) return false;
  const sampled = Date.parse(sampledAt);
  if (Number.isNaN(sampled)) return false;
  let startedAt: string | null;
  try { startedAt = await claudeProcessStartedAt(sessionName); } catch { return false; }
  // `ps` lstart is local time to the second, so a sample from the current process is never earlier.
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return !Number.isNaN(started) && sampled < started;
}

/**
 * Derive a runtime's resume token from live, read-only sources, via the
 * runtime descriptor's captureResumeToken hook (runtime-registry.ts):
 *   claude-code → the status-line sidecar's session_id (a file read)
 *   codex       → the thread id derived from live pid-keyed logs
 *   pi          → the pi-runner state sidecar's sessionFile (a file read)
 *   omp         → the OMP runner state sidecar's sessionFile (separate root)
 * Returns a structured outcome; never throws for a missing/invalid token
 * (those are honest skips). ANY unexpected throw from a dependency is the
 * caller's to swallow (capture must never fail or block its lifecycle op).
 */
export async function deriveResumeToken(
  input: { runtime: string | null; sessionName: string; cwd?: string | null; stateRoot?: string },
  deps: ResumeTokenCaptureDeps,
): Promise<ResumeTokenDeriveResult> {
  const descriptor = getRuntimeDescriptor(input.runtime);
  if (!descriptor?.resumeType) return { outcome: "exempt" }; // terminal / unknown: exempt, not a failure

  const captured = await runDescriptorTokenCapture(descriptor, {
    sessionName: input.sessionName,
    cwd: input.cwd,
    seatStateDir: runtimeSeatStateDir(descriptor.id, input.sessionName, input.stateRoot),
  }, deps);
  if (captured.outcome !== "token") {
    // Codex: a process listing that throws is upstream's process_unreadable (the
    // exception text stays out of the event).
    if (descriptor.id === "codex" && captured.outcome === "skipped" && captured.reason === "capture_error") {
      return { outcome: "skipped", reason: "process_unreadable" };
    }
    return captured;
  }
  // Claude: a sidecar sampled before the pane's current Claude process started
  // names an earlier process's session (#421), so its id is not this seat's.
  if (descriptor.id === "claude-code" && deps.contextUsageStore) {
    const sidecar = deps.contextUsageStore.readSidecar(input.sessionName);
    if (sidecar.ok && await isClaudeSidecarFromEarlierProcess(sidecar.data.sampled_at, input.sessionName, deps.claudeProcessStartedAt)) {
      return { outcome: "skipped", reason: "stale_sidecar" };
    }
  }

  // Defensive format validation before the caller persists: a malformed token
  // is an honest skip, never a bad write (validity-before-rank).
  const validation = validateResumeToken(descriptor.id, captured.token);
  if (!validation.ok) return { outcome: "skipped", reason: "invalid_token" };

  return { outcome: "captured", resumeType: validation.resumeType, token: validation.token };
}
