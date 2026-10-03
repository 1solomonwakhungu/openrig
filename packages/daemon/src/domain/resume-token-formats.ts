// Resume-token FORMAT floors, shared by the runtime registry descriptors.
//
// This module is a dependency leaf on purpose: runtime descriptors (built-in
// and third-party CLI registrations) import these validators, and the
// registry-driven resume-token-validation.ts imports the registry. Keeping the
// format rules here avoids an import cycle between the two.
//
// Every validator returns a structured result and NEVER quotes the raw token
// in an error message (tokens are credential-class; see
// resume-token-validation.ts for the full redaction contract).

export type ResumeTokenFormatResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const MAX_TOKEN_LEN = 200;

/** Id-shaped tokens (claude/codex session ids and similar opaque ids). */
export function validateIdShapedToken(token: string): ResumeTokenFormatResult {
  if (token.length > MAX_TOKEN_LEN) {
    return { ok: false, error: `Resume token is too long (max ${MAX_TOKEN_LEN} characters).` };
  }
  if (!SAFE_TOKEN_RE.test(token)) {
    return {
      ok: false,
      error: "Resume token contains disallowed characters (allowed: letters, digits, '.', '_', '-').",
    };
  }
  return { ok: true, token };
}

// pi_session_file floor: absolute path, no ".." segment (checked on the raw
// operand; normalization collapses "..", so a post-normalize check would be
// dead code; same posture as the shipped `rig file` traversal guard), the
// shell-inert path charset, a 1024 cap, and the Pi session-file suffix (one
// constant if Pi ever renames its session format).
//
// "@" is in the set deliberately (a delta from the PRD's literal
// [A-Za-z0-9._/-], caught by the VM hermetic run): the Pi seat state layout
// keys on the CANONICAL session name (pod-member@rig), so every real Pi
// session-file path contains "@". It is shell-inert here: the token is
// always argv/shellQuote-passed, never a remote scp/rsync operand where
// user@host parsing would matter (that ambiguity is why `rig file` excludes
// it; this surface has no such parse).
const PI_SESSION_FILE_CHARSET_RE = /^[A-Za-z0-9._/@-]+$/;
const MAX_PI_SESSION_FILE_LEN = 1024;
const PI_SESSION_FILE_SUFFIX = ".jsonl";

/** The Pi-family session-file floor: absolute path, no ".." segment, the
 *  shell-inert charset, the length cap, and a .jsonl suffix. `label` names
 *  the runtime in errors (Pi and OMP share the floor). */
function validateSessionFileToken(label: string, token: string): ResumeTokenFormatResult {
  if (token.length > MAX_PI_SESSION_FILE_LEN) {
    return { ok: false, error: `${label} session-file token is too long (max ${MAX_PI_SESSION_FILE_LEN} characters).` };
  }
  if (!token.startsWith("/")) {
    return { ok: false, error: `${label} session-file token must be an absolute path (starting with '/').` };
  }
  if (token.split("/").includes("..")) {
    return { ok: false, error: `${label} session-file token must not contain a '..' path segment.` };
  }
  if (!PI_SESSION_FILE_CHARSET_RE.test(token)) {
    return {
      ok: false,
      error: `${label} session-file token contains disallowed characters (allowed: letters, digits, '.', '_', '/', '@', '-').`,
    };
  }
  if (!token.endsWith(PI_SESSION_FILE_SUFFIX)) {
    return { ok: false, error: `${label} session-file token must end with '${PI_SESSION_FILE_SUFFIX}'.` };
  }
  return { ok: true, token };
}

export function validatePiSessionFileToken(token: string): ResumeTokenFormatResult {
  return validateSessionFileToken("Pi", token);
}

/** OMP session files share Pi's floor (upstream #35). */
export function validateOmpSessionFileToken(token: string): ResumeTokenFormatResult {
  return validateSessionFileToken("OMP", token);
}
