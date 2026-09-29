// Cline TUI pane patterns, taken from live `tmux capture-pane` output of
// cline 3.0.65 (fixtures under packages/daemon/test/fixtures/cli-panes/cline/).
//
// Ready: the input box placeholder (home view "What can I do for you?", chat
// view "Ask anything...", plan mode "Plan something...") or the status footer
// "Auto-approve all enabled|disabled (Shift+Tab)", which the TUI renders under
// the input box in both views. Neither appears on the provider sign-in screen.

export interface ClineGatePattern {
  pattern: RegExp;
  code: string;
  reason: string;
}

export interface ClineErrorPattern {
  pattern: RegExp;
  reason: string;
  /** "retry_fresh": the requested session is gone; the caller stops and asks
   *  instead of silently starting fresh. */
  recovery?: "retry_fresh";
  /** Readiness code reported while the TUI still shows the error. */
  code?: string;
}

export const CLINE_READY_PATTERNS: readonly RegExp[] = [
  /❯ (?:What can I do for you\?|Ask anything\.\.\.|Plan something\.\.\.)/,
  /Auto-approve all (?:enabled|disabled) \(Shift\+Tab\)/,
];

export const CLINE_GATE_PATTERNS: readonly ClineGatePattern[] = [
  {
    // First run with no provider configured: the sign-in picker.
    pattern: /Connect a model provider to get started\./,
    code: "login_required",
    reason: "cline has no model provider configured; run `cline auth` or pick a provider in the pane",
  },
  {
    // A launch notice modal. CLINE_DISABLE_CLINE_PASS_NOTICE suppresses the
    // known ones; any other notice still swallows the next keystroke and opens
    // a browser on Enter, so it needs an operator before anything is typed.
    pattern: /Press Enter to open, any other key to close/,
    code: "update_gate",
    reason: "cline is showing an announcement modal; dismiss it with Esc in the pane",
  },
];

export const CLINE_ERROR_PATTERNS: readonly ClineErrorPattern[] = [
  {
    // zsh, bash, and env (every managed launch is prefixed with `env`).
    pattern: /command not found: cline|cline: command not found|env: [\u2018']?cline[\u2019']?: No such file or directory/,
    reason: "cline is not installed or not on the pane's PATH (npm install -g cline)",
  },
  {
    // `cline --id <gone>` stays in the TUI and prints this instead of exiting.
    pattern: /Error: Unknown session: /,
    reason: "cline does not know the persisted session id",
    recovery: "retry_fresh",
    code: "session_missing",
  },
];
