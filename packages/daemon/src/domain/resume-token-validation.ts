// OPR.0.4.0.22 FR-2 — per-runtime resume-token validation.
// OPR.0.4.6.PI1 FR-6 — validation is PER-RESUME-TYPE: id-shaped tokens
// (claude/codex) keep the original rules unchanged; pi_session_file is a
// PATH-shaped token (an absolute session-file path) with its own floor.
// The per-runtime rules now live on runtime-registry descriptors; the format
// floors themselves are in resume-token-formats.ts.
//
// The floor is FORMAT validation: reject malformed input, never fabricate a
// token, and NEVER quote the raw token in an error message (it is
// credential-class — the redaction contract spans CLI output, route
// responses, route errors, logs, and the audit event). A deep "does it
// actually resume" probe is intentionally out of scope (heavy + must not
// mutate live state); format validation is the safe, side-effect-free floor.

import { getRuntimeDescriptor, listRuntimeDescriptors, formatRuntimeIdList } from "./runtime-registry.js";

/** Built-in resume types; registered runtimes may declare their own. */
export type BuiltinResumeType = "claude_id" | "codex_id" | "pi_session_file";
export type ResumeType = BuiltinResumeType | (string & {});

export interface ResumeTokenValidationOk {
  ok: true;
  resumeType: ResumeType;
  /** The trimmed token to persist. Internal value, never logged/echoed. */
  token: string;
}
export interface ResumeTokenValidationErr {
  ok: false;
  /** Describes the FORMAT problem; NEVER contains the token value. */
  error: string;
}

/** Resume-id type for a runtime, or null when the runtime has no resume token
 *  (terminal / unknown). Driven by the runtime registry. */
export function resumeTypeForRuntime(runtime: string | null): ResumeType | null {
  return getRuntimeDescriptor(runtime)?.resumeType ?? null;
}

export function validateResumeToken(
  runtime: string | null,
  rawToken: unknown,
): ResumeTokenValidationOk | ResumeTokenValidationErr {
  const descriptor = getRuntimeDescriptor(runtime);
  if (!descriptor?.resumeType || !descriptor.validateResumeToken) {
    const resumable = listRuntimeDescriptors().filter((d) => d.resumeType).map((d) => d.id);
    return {
      ok: false,
      error: `set-resume-token is not supported for runtime "${runtime ?? "unknown"}" (only ${formatRuntimeIdList(resumable)} have resume tokens).`,
    };
  }
  if (typeof rawToken !== "string") {
    return { ok: false, error: "Resume token is missing or not a string." };
  }
  const token = rawToken.trim();
  if (token.length === 0) {
    return { ok: false, error: "Resume token is empty." };
  }
  const format = descriptor.validateResumeToken(token);
  if (!format.ok) return format;
  return { ok: true, resumeType: descriptor.resumeType, token: format.token };
}
