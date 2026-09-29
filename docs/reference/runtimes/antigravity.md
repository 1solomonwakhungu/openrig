# Antigravity CLI (`agy`)

Runtime id: `antigravity`. Adapter: `packages/daemon/src/adapters/cli/antigravity/index.ts`.

## Install and auth

- Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (installs `~/.local/bin/agy`), or `brew install --cask antigravity-cli`. Preflight probes `agy --version` and shows this install hint when it fails.
- Auth: Google sign-in stored in the OS keyring; an API key needs `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json` plus `GEMINI_API_KEY`. Sign in once for the account the daemon runs as; a seat that reaches the sign-in screen reports `login_required`.

## Rig spec

```yaml
members:
  - id: impl
    agent_ref: local:agents/impl
    profile: default
    runtime: antigravity
    model: gemini-3.5-flash-medium   # optional; passed as --model (see `agy models`)
    cwd: .
```

## Launch

The seat runs `exec env BROWSER=true agy [--model <m>] <posture>`.

| Setting | Flag |
|---|---|
| Model | `--model <slug>` from the member's `model` |
| Posture `floor` | `--mode accept-edits` |
| Posture `full_bypass` (policy or `OPENRIG_YOLO`) | `--dangerously-skip-permissions` (agy has no `--yolo`) |
| Browser | `BROWSER=true`, so sign-in never opens a tab on the operator's desktop |

agy draws a full-screen TUI on the terminal's alternate screen; the base adapter reads that screen whole while the new process holds the pane.

## Resume and fork

- agy has no flag to choose a conversation id, and it creates the conversation lazily. Launch readiness therefore usually has no token; the resume-metadata refresher and restore capture it later from `~/.gemini/antigravity-cli/cache/last_conversations.json` (the last conversation per workspace), but only when that conversation (`conversations/<uuid>.db`) was written after this seat's launch.
- Capture returns nothing when another `antigravity` seat launched in the same cwd within the last 24 hours: agy keeps one "last conversation" per workspace, so the entry could be either seat's. Give agy seats distinct cwds for automatic resume.
- Resume: `--conversation <uuid>`. Before typing, the adapter checks that `conversations/<uuid>.db` exists; a missing conversation returns `retry_fresh`, so restore stops and asks. `conversation not found` in the pane maps to the same outcome.
- Fork: not supported (agy has no fork flag); a `session_source` member is refused with a clear error.

## Readiness

| Pane text | Result |
|---|---|
| `? for shortcuts` (status line) | ready |
| `Do you trust the contents of this project?` | `trust_gate` |
| `Select login method:`, `Other sign-in options`, `Authentication required. Please visit the URL to log in`, `Waiting for authentication`, `Paste the authorization code`, `Enter the authorization code` | `login_required` |
| `conversation not found` | resume refused, `retry_fresh` |
| `[Auth Error]` | launch error, `attention_required` |

## Guidance and skills

- Guidance merges as managed blocks into `<cwd>/AGENTS.md` (agy reads workspace `AGENTS.md` and `GEMINI.md`), with the `rig-role` skip. Teardown removes the blocks. `AGENTS.md` is the same file Codex seats use.
- Skills project into `<cwd>/.agents/skills/` (agy workspace skills; Codex reads the same directory).

## Known limits

- The trust prompt has no known pre-trust flag; a seat in an untrusted project stops at `trust_gate` until someone answers it once.
- agy shares `~/.gemini/` with Gemini CLI (global `GEMINI.md`, `AGENTS.md`, rules).
- Whether agy's process survives `tmux kill-session` was not verified, so the adapter opts into process-tree reaping on stop (PID-scoped, never by name) until it is.

## Verified versus derived

Against agy 1.1.27 on macOS (2026-09-29).

Verified live (observed from the real binary or files):

- `agy --help`: `--model`, `--dangerously-skip-permissions`, `--mode accept-edits|plan`, `--conversation`, `-c/--continue`, `-i/--prompt-interactive`; no fork flag and no flag to choose a conversation id.
- `agy --version` prints `1.1.27` (the preflight probe).
- The local app data layout, read with ids and paths masked: `~/.gemini/antigravity-cli/conversations/<uuid>.db` (one file per conversation) and `~/.gemini/antigravity-cli/cache/last_conversations.json` as `{ "<workspace path>": "<uuid>" }`.

Derived from strings in the agy binary (never seen in a live pane):

| String | Adapter use |
|---|---|
| `? for shortcuts` | ready, only with none of the not-ready markers below on screen |
| `initializing...`, `Esc to cancel`, `to navigate`, `(y/n)`, `Yes, allow`, `No, deny`, `Welcome to`, `Action required` | not ready: a dialog, prompt, picker, or onboarding panel is up (even with the status line visible) |
| `Do you trust the contents of this project?` | `trust_gate` |
| `Select login method:`, `Other sign-in options` | `login_required` |
| `Authentication required. Please visit the URL to log in:`, `Waiting for authentication (timeout 60s)...` | `login_required` |
| `Paste the authorization code below:`, `Enter the authorization code:` | `login_required` |
| `conversation not found` | resume refused, `retry_fresh` |
| `[Auth Error]` | launch error, `attention_required` |
| `Resume with -c (or command below):` / `agy --conversation=%s` | confirms `--conversation <id>` resume |
| `last_conversations.json`, `<appDataDir>/brain/<conversation-id>/` | conversation storage |

Not verified, carried as residual risk:

- The idle (ready) screen, the placement of the status line, and every gate screen. agy authenticates through the OS keyring, which a throwaway `HOME` does not isolate from the owner's account, so the TUI was not launched.
- Because of that, readiness is strict and fails toward `attention_required` with pane evidence: a screen the adapter does not recognize times out as attention, never as ready. The not-ready markers catch the dialogs agy's strings reveal; a dialog worded differently that still shows `? for shortcuts` would read as ready, which is the remaining risk. The first real launch should confirm the ready string and the markers and adjust `ANTIGRAVITY_READY_RE` / `ANTIGRAVITY_NOT_READY_RE` if needed.
- When the conversation file is created (first prompt versus launch), and whether agy survives `tmux kill-session` (reaping covers it meanwhile).
