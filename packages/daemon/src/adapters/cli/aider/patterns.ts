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
//
// Width: OpenRig panes are 80x24 and tmux capture hard-wraps long lines (no
// -J), so a line break can fall anywhere in a long question, including inside
// "(Y)es/(N)o" or "[Yes]:" (seen live: "...(Y)es/(N)o\n [Yes]:"). Phrases that
// can wrap are matched with wrapTolerant(); short, line-leading text is not.

export interface AiderGatePattern {
  pattern: RegExp;
  code: string;
  reason: string;
}

export interface AiderErrorPattern {
  pattern: RegExp;
  reason: string;
}

/** A regex source matching `literal` with an optional hard wrap (newline)
 *  between any two characters. */
export function wrapTolerant(literal: string): string {
  return [...literal].map((ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("\\n?");
}

export const AIDER_READY_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)(?:[A-Za-z][\w-]*(?: multi)?|multi)?> ?\s*$/,
];

// "(Y)es/(N)o", then up to a few wrapped lines of options ("/(D)on't ask
// again"), then the default "[Yes]:" / "[No]:" as the last text in the pane.
const PENDING_CONFIRM = `${wrapTolerant("(Y)es/(N)o")}[^]{0,200}?(?:${wrapTolerant("[Yes]:")}|${wrapTolerant("[No]:")})\\s*$`;

export const AIDER_GATE_PATTERNS: readonly AiderGatePattern[] = [
  {
    // Printed before the prompt when the model's provider key is missing. It
    // is not tail-anchored: answering the doc-link offer does not fix the key,
    // and under --yes-always aider reaches its prompt with the warning above.
    // Anchored on the short "- KEY: Not set" line: the "<model> expects these
    // environment variables" line above it wraps for long model names.
    pattern: /^- [A-Z][A-Z0-9_]*: Not set[ \t]*$/m,
    code: "login_required",
    reason: "aider is missing the API key for the selected model; set the provider key (for example ANTHROPIC_API_KEY) in the seat env",
  },
  {
    pattern: new RegExp(`${wrapTolerant("No git repo found, create one")}[^]{0,200}?${PENDING_CONFIRM}`),
    code: "trust_gate",
    reason: "aider is asking to create a git repo in the seat cwd",
  },
  {
    pattern: new RegExp(PENDING_CONFIRM),
    code: "trust_gate",
    reason: "aider is waiting on a yes/no confirmation in the pane",
  },
];

export const AIDER_ERROR_PATTERNS: readonly AiderErrorPattern[] = [
  {
    // zsh, bash, and env (the full_bypass launch is prefixed with `env`).
    pattern: /command not found: aider|aider: command not found|env: [\u2018']?aider[\u2019']?: No such file or directory/,
    reason: "aider is not installed or not on the pane's PATH (python -m pip install aider-install && aider-install)",
  },
  {
    // aider 0.86 imports audioop, which Python 3.13 removed (seen live).
    pattern: /ModuleNotFoundError: No module named '(?:pyaudioop|audioop)'/,
    reason: "aider cannot start on this Python (audioop was removed in 3.13); reinstall on Python 3.12, e.g. uv tool install --python 3.12 aider-chat",
  },
];
