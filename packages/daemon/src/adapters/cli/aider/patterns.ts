// Aider pane patterns, from live `tmux capture-pane` output of aider 0.86.2
// (fixtures under packages/daemon/test/fixtures/cli-panes/aider/) and
// aider/io.py (get_input, confirm_ask).
//
// Ready: aider's prompt is `<edit format>` + ` multi` (multiline mode) + "> ",
// e.g. "> ", "architect> ", "ask> ", "multi> ", "diff multi> ". tmux trims the
// trailing space. The prompt must be the LAST non-blank text in the capture:
// chat output quotes lines with "> " too, so an unanchored match would call a
// busy seat ready.
//
// Confirmations ("(Y)es/(N)o ... [Yes]:") block input until answered. Only a
// confirmation at the tail of the capture counts; once answered the question
// stays in scrollback followed by more output.

export interface AiderGatePattern {
  pattern: RegExp;
  code: string;
  reason: string;
}

export interface AiderErrorPattern {
  pattern: RegExp;
  reason: string;
}

export const AIDER_READY_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)(?:[A-Za-z][\w-]*(?: multi)?|multi)?> ?\s*$/,
];

const PENDING_CONFIRM = String.raw`\(Y\)es\/\(N\)o[^\n]*\[(?:Yes|No)\]:[ \t]*\s*$`;

export const AIDER_GATE_PATTERNS: readonly AiderGatePattern[] = [
  {
    // Printed before the prompt when the model's provider key is missing. It
    // is not tail-anchored: answering the doc-link offer does not fix the key,
    // and under --yes-always aider reaches its prompt with the warning above.
    pattern: /expects these environment variables\s*\n\s*- [A-Z][A-Z0-9_]*: Not set/,
    code: "login_required",
    reason: "aider is missing the API key for the selected model; set the provider key (for example ANTHROPIC_API_KEY) in the seat env",
  },
  {
    pattern: new RegExp(String.raw`No git repo found, create one to track aider's changes[^\n]*` + PENDING_CONFIRM),
    code: "trust_gate",
    reason: "aider is asking to create a git repo in the seat cwd",
  },
  {
    pattern: new RegExp(PENDING_CONFIRM),
    code: "trust_gate",
    reason: "aider is waiting on a yes/no confirmation in the pane",
  },
];

/** No fatal startup text is known that leaves aider running; aider exits on
 *  fatal errors and the shell-foreground guard reports that. */
export const AIDER_ERROR_PATTERNS: readonly AiderErrorPattern[] = [];
