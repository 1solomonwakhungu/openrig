// Runtime fallback (rig spec member `fallback_runtimes`). At a fresh launch, a
// seat whose runtime cannot start for an operator-fixable reason is relaunched
// on the next runtime in the member's list:
// - the runtime's CLI binary is not on the launch PATH (checked before
//   launching, the same way managed launches resolve executables), or
// - the launch or readiness stops at a sign-in gate (login_required: not
//   signed in, no provider configured) or reports the binary missing
//   (runtime_missing).
// Every attempt is a fresh session: a resume token never crosses runtimes.
// Restore never falls back; it resumes on the runtime the seat actually ran.
//
// Rate limits are deliberately not a fallback trigger: no runtime reports a
// rate limit at launch through a signal OpenRig can detect honestly and test.

import fs from "node:fs";
import nodePath from "node:path";

/** Attention codes that move a fresh launch to the next fallback runtime. */
export const FALLBACK_ATTENTION_CODES: ReadonlySet<string> = new Set(["login_required", "runtime_missing"]);

export function isFallbackAttentionCode(code: string | undefined): boolean {
  return !!code && FALLBACK_ATTENTION_CODES.has(code);
}

/**
 * Whether `binary` resolves to an executable file on `pathValue`. Relative or
 * empty PATH entries resolve against `cwd`, matching how managed launches
 * search the seat's PATH. A name containing a slash is checked as a path.
 */
export function isCommandOnPath(binary: string, pathValue: string | undefined, cwd: string): boolean {
  const candidates = binary.includes("/")
    ? [nodePath.resolve(cwd, binary)]
    : (pathValue ?? "").split(nodePath.delimiter).map((dir) => nodePath.join(nodePath.resolve(cwd, dir), binary));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** One runtime tried for a seat, for the attempt log and evidence. */
export interface FallbackAttempt {
  runtime: string;
  outcome: "launched" | "skipped" | "failed" | "attention_required";
  reason?: string;
}

/** Operator-facing summary of a seat's runtime attempts, in order. */
export function describeFallbackAttempts(attempts: readonly FallbackAttempt[]): string {
  return attempts
    .map((attempt) => `${attempt.runtime}: ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ""}`)
    .join("; ");
}
