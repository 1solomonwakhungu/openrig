// Pane patterns for the Gemini CLI family, taken from the TUI source of
// gemini 0.61.0 and qwen 0.24.7 and checked against live captures (fixtures
// under test/fixtures/gemini-family/).
//
// Both CLIs render the same composer placeholder once the input box is live.
// Every blocking dialog (trust, auth, API key entry) replaces the composer, and
// gates are always checked before ready patterns, so a dialog is never read as
// ready. Qwen localizes the placeholder with t(); the English text is matched
// (see the known limits in docs/reference/runtimes/qwen.md).

export interface GeminiFamilyGatePattern {
  pattern: RegExp;
  /** One of ATTENTION_REQUIRED_READINESS_CODES. */
  code: string;
  reason: string;
}

export interface GeminiFamilyErrorPattern {
  pattern: RegExp;
  reason: string;
  /** retry_fresh: the requested session does not exist, so a resume cannot
   *  proceed and the caller must decide (never a silent fresh start). */
  recovery?: "retry_fresh" | "attention_required";
}

export interface GeminiFamilyPanePatterns {
  readyPatterns: readonly RegExp[];
  gatePatterns: readonly GeminiFamilyGatePattern[];
  errorPatterns: readonly GeminiFamilyErrorPattern[];
}

/** Composer placeholder (Composer.tsx in both CLIs). */
const COMPOSER_PLACEHOLDER = /Type your message or @path\/to\/file/;

export const GEMINI_PANE_PATTERNS: GeminiFamilyPanePatterns = {
  readyPatterns: [COMPOSER_PLACEHOLDER],
  gatePatterns: [
    // FolderTrustDialog.tsx. Normally never shown: managed launches pass
    // --skip-trust. Kept for an env that forces trust decisions.
    { pattern: /Do you trust the files in this folder\?/, code: "trust_gate", reason: "gemini is asking to trust the workspace folder" },
    // AuthDialog.tsx: no security.auth.selectedType yet. An API key in the env
    // does not skip this dialog in interactive mode.
    { pattern: /How would you like to authenticate for this project\?/, code: "login_required", reason: "gemini has no auth method selected; run gemini once and choose one (see docs/reference/runtimes/gemini.md)" },
    // ApiAuthDialog.tsx: gemini-api-key selected but no key found.
    { pattern: /Enter Gemini API Key/, code: "login_required", reason: "gemini is asking for an API key; set GEMINI_API_KEY in the seat environment" },
    // AuthDialog.tsx / AuthInProgress.tsx / LoginRestartDialog.tsx.
    { pattern: /Logging in with Google|Waiting for authentication\.\.\.|Authentication timed out|Press R to restart, or Esc to choose a different authentication method/, code: "login_required", reason: "gemini is waiting on a Google sign-in" },
  ],
  errorPatterns: [
    // gemini.tsx: unknown id, or a session with no resumable messages (exit 42).
    { pattern: /Error resuming session:/, reason: "gemini could not find the session to resume", recovery: "retry_fresh" },
    { pattern: /Error starting session: Session ID .* already exists/, reason: "gemini refused the minted session id because it already exists" },
    { pattern: /When using Gemini API, you must specify the GEMINI_API_KEY environment variable/, reason: "gemini needs GEMINI_API_KEY in the seat environment" },
  ],
};

export const QWEN_PANE_PATTERNS: GeminiFamilyPanePatterns = {
  readyPatterns: [COMPOSER_PLACEHOLDER],
  gatePatterns: [
    // FolderTrustDialog.tsx; only when security.folderTrust.enabled is true
    // (default false). Qwen has no flag to skip it.
    { pattern: /Do you trust this folder\?/, code: "trust_gate", reason: "qwen is asking to trust the workspace folder" },
    // AuthDialog.tsx: no auth type from --auth-type, settings, or env.
    { pattern: /Connect a Provider|You must connect a provider to proceed/, code: "login_required", reason: "qwen has no model provider configured (see docs/reference/runtimes/qwen.md)" },
    // auth.ts / llm.tsx: the TUI stays up but cannot answer until the operator
    // switches provider.
    { pattern: /Qwen OAuth free tier was discontinued/, code: "login_required", reason: "qwen is configured for the discontinued Qwen OAuth free tier; switch provider" },
  ],
  errorPatterns: [
    // config.ts: unknown id or a session with no messages yet (exit 1).
    { pattern: /No saved session found with (?:ID|title)/, reason: "qwen could not find the session to resume", recovery: "retry_fresh" },
    { pattern: /Failed to fork session/, reason: "qwen could not fork the parent session" },
    { pattern: /Session Id \S+ already exists/, reason: "qwen refused the minted session id because it already exists" },
  ],
};
