// Per-runtime activity markers for TuiCliRuntimeAdapter.classifyActivity:
// the CLI's own busy marker (working, measured at trial on the pane-markers
// rung) and its in-session prompts that wait for the operator (needs_input:
// tool or command approval, mid-session confirms, blocking update dialogs).
//
// Every string below was read from the CLI's source or shipped bundle at the
// version noted; none was observed on a signed-in live screen (OpenRig never
// authenticates a CLI). Patterns are wrap-tolerant (panePhrase) where a phrase
// can break across an 80-column line or a dialog border, and match only the
// status region classifyActivity reads (the last screen lines). Launch gates
// (trust, sign-in) stay in each adapter's gatePatterns.

import { anyPanePhrase, panePhrase } from "./pane-phrase.js";

export interface RuntimeActivityMarkers {
  busyPatterns: readonly RegExp[];
  inputPromptPatterns: readonly RegExp[];
}

const NONE: RuntimeActivityMarkers = { busyPatterns: [], inputPromptPatterns: [] };

/** GitHub Copilot CLI 1.0.91 (app.js inside the native package's SEA blob). */
const COPILOT: RuntimeActivityMarkers = {
  // ThinkingAnimation: "Working (Esc to cancel)"; the hint hides while cancelling.
  busyPatterns: [/\(Esc to cancel\)/],
  inputPromptPatterns: [
    anyPanePhrase([
      "Do you want to run this command",
      "Do you want to use this tool?",
      "Do you want to allow this tool call?",
      "Do you want to allow this access?",
      "Do you want to allow this?",
      "Do you want to approve this request?",
      "Do you want to modify",
      "Switch to auto mode?",
    ]),
    panePhrase("No, and tell Copilot what to do differently"),
  ],
};

/** Cursor CLI 2026.09.28-64d2043 (dist-package/6949.index.js). */
const CURSOR: RuntimeActivityMarkers = {
  // The composer's right-hand hint while the agent generates.
  busyPatterns: [panePhrase("ctrl+c to stop")],
  inputPromptPatterns: [
    anyPanePhrase([
      "Run this command?",
      "Run this command outside the sandbox?",
      "Run this MCP tool?",
      "Delete this file?",
      "Write to this file?",
      "Read this file?",
      "Allow this web search?",
      "Allow this web fetch?",
      "Proceed with this edit?",
      "Waiting for decision (y/n/p)",
      "Approve mode switch",
    ]),
  ],
};

/** Gemini CLI fb972b2f (packages/cli/src/ui; v0.62). */
const GEMINI: RuntimeActivityMarkers = {
  // LoadingIndicator: "(esc to cancel, 12s)" above the input.
  busyPatterns: [/\(esc to cancel, \d/],
  inputPromptPatterns: [
    anyPanePhrase([
      "Apply this change?",
      "No, suggest changes (esc)",
      "A potential loop was detected",
      "Upgrade for higher limits",
    ]),
    /Allow execution of /,
  ],
};

/** Qwen Code 0.24.7 (0f140e3a; a Gemini CLI fork with its own formats). */
const QWEN: RuntimeActivityMarkers = {
  // LoadingIndicator: "(12s · ↓ 1.2k tokens · esc to cancel)".
  busyPatterns: [/· esc to cancel\)/],
  inputPromptPatterns: [
    anyPanePhrase([
      "Apply this change?",
      "No, suggest changes (esc)",
      "No, keep planning (esc)",
    ]),
    /Allow execution of/,
  ],
};

/** OpenCode 1.18.34 (packages/tui; SolidJS/opentui). */
const OPENCODE: RuntimeActivityMarkers = {
  // Footer under the input: "esc interrupt", then "esc again to interrupt".
  busyPatterns: [/esc (?:again to )?interrupt/],
  inputPromptPatterns: [
    anyPanePhrase([
      "Permission required",
      "Tell OpenCode what to do differently",
      "Update Available",
    ]),
  ],
};

/** Kilo CLI 7.8.3 (Kilo-Org/kilocode; an OpenCode fork). */
const KILO: RuntimeActivityMarkers = {
  busyPatterns: [/esc (?:again to )?interrupt/],
  inputPromptPatterns: [
    anyPanePhrase([
      "Permission required",
      "Tell Kilo what to do differently",
      "Update Available",
    ]),
  ],
};

/** Cline CLI 3.0.68 (apps/cli tui). */
const CLINE: RuntimeActivityMarkers = {
  // Last chat row above the input: dots spinner + "Thinking... (esc to cancel)".
  busyPatterns: [panePhrase("Thinking... (esc to cancel)")],
  inputPromptPatterns: [
    anyPanePhrase([
      "Cline needs permission",
      "Approve tool call?",
      "Cline is asking a question",
      "Cline Hub update required",
    ]),
  ],
};

/** Grok Build 1.0.45 (xai-org/grok-build; Rust/ratatui). */
const GROK: RuntimeActivityMarkers = {
  // The one-row turn status between scrollback and prompt (zero height idle):
  // "<spinner> Thinking… 3s ... ⇣2k [stop]" plus "· send a message to interrupt".
  busyPatterns: [/\[stop\]\s*$/m, panePhrase("send a message to interrupt")],
  inputPromptPatterns: [
    /Allow (?:`[^`\n]+`|Execute|Edit(?: to [^?\n]+| \(on your machine\))?|Delete)?\?/,
    panePhrase("No, reject (type to add feedback)"),
  ],
};

/** Antigravity CLI 1.2.16 (Go binary strings; line breaks unverified). */
const ANTIGRAVITY: RuntimeActivityMarkers = {
  // Spinner: "<label>… (12s · esc to cancel)".
  busyPatterns: [/esc to cancel\)/i],
  inputPromptPatterns: [
    anyPanePhrase([
      "Run this command?",
      "Allow access to this URL?",
      "Allow access to this file?",
      "Allow calling this tool?",
      "Accept this file edit?",
      "Approval Required",
      "Discard changes? (y/n)",
    ]),
  ],
};

/** Aider 0.86 is a line REPL: its "(Y)es/(N)o" confirms are already gate
 *  patterns (any pending confirm). Busy: "<frame> Waiting for <model>", which
 *  clears on the first streamed chunk (aider/waiting.py). */
const AIDER: RuntimeActivityMarkers = {
  busyPatterns: [/^\S?\s*Waiting for [\w./:@-]+\s*$/m],
  inputPromptPatterns: [],
};

/** goose 1.53.0 (strings in the release binary). */
const GOOSE: RuntimeActivityMarkers = {
  // Spinner line while a turn runs: "<thinking message> (Ctrl+C to interrupt)".
  busyPatterns: [/\(Ctrl\+C to interrupt\)/],
  // Tool approval in approve / smart_approve mode.
  inputPromptPatterns: [anyPanePhrase(["Goose would like to call the above tool, do you allow?", "Do you allow this tool call?"])],
};

/** kiro-cli 2.27.1 (strings in kiro-cli-chat; crates/chat-cli/src/cli/chat). */
const KIRO: RuntimeActivityMarkers = {
  // The chat spinner while a turn runs.
  busyPatterns: [panePhrase("Thinking...")],
  // Tool approval: "Allow this action? Use 't' to trust (always allow) ... [y/n/t]".
  inputPromptPatterns: [panePhrase("Allow this action?")],
};

const MARKERS: Readonly<Record<string, RuntimeActivityMarkers>> = {
  aider: AIDER,
  antigravity: ANTIGRAVITY,
  cline: CLINE,
  copilot: COPILOT,
  cursor: CURSOR,
  gemini: GEMINI,
  goose: GOOSE,
  grok: GROK,
  kilo: KILO,
  kiro: KIRO,
  opencode: OPENCODE,
  qwen: QWEN,
};

/** The markers for a runtime id, or none. */
export function activityMarkers(runtimeId: string): RuntimeActivityMarkers {
  return MARKERS[runtimeId] ?? NONE;
}
