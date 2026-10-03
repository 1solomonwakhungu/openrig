# OpenCode runtime (`runtime: opencode`)

OpenRig runs [OpenCode](https://opencode.ai/) as an interactive TUI in the seat's tmux pane. The adapter shares its launch, pattern, and session-store code with the [Kilo CLI runtime](kilo.md), because Kilo is an OpenCode fork with the same flags and TUI.

## Install

Any of these puts `opencode` on `PATH`:

```bash
brew install anomalyco/tap/opencode
npm i -g opencode-ai
curl -fsSL https://opencode.ai/install | bash
```

`rig` preflight probes `opencode --version`. Tested with 1.18.33.

## Auth

The adapter never logs in or writes credentials. Authenticate the way OpenCode normally does, before launching seats:

- `opencode auth login` (alias `opencode providers login`), stored in `~/.local/share/opencode/auth.json`
- provider env vars such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the daemon's environment

With no credentials, OpenCode falls back to its free OpenCode Zen models, so there is no login gate to detect.

## Rig spec

```yaml
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: "local:agents/implementer"
        profile: default
        runtime: opencode
        model: anthropic/claude-sonnet-5
        cwd: "."
```

## Model

`model` is passed as `-m <provider>/<model>` and must be in `provider/model` form (for example `anthropic/claude-sonnet-5` or `openrouter/x-ai/grok-4`). A value without a provider is refused at launch with a clear error. With no `model`, OpenCode uses its configured default. The model is also passed on resume.

## Launch posture

| Posture | Flag | Effect |
|---|---|---|
| `floor` (default) | none | OpenCode's own `permission` config decides what needs approval. |
| `full_bypass` | `--auto` | Auto-approves every permission that is not explicitly denied in config. |

A seat is `full_bypass` when its resolved permission policy says so, or, with no policy attached, when `OPENRIG_YOLO` is on. `floor` never passes `--auto`.

## Session database and resume

Each seat gets its own session database: the launch sets `OPENCODE_DB=<OPENRIG_HOME>/state/opencode/<session>/opencode.db`. That keeps each seat's current session unambiguous even when pod-mates share a `cwd`. Provider credentials stay shared: OpenCode reads `auth.json` from its data directory, not from the session database, so a seat's own database does not affect sign-in.

OpenCode creates a session only when the first prompt is sent, so a fresh launch has no resume token yet. OpenRig reads the token later, read-only, from the seat's database: the most recently updated top-level, unarchived session. It does this after launch, in the periodic resume-metadata refresh, and once at restore if no token was persisted.

Resume launches `opencode -s <session id>`. Before typing, OpenRig checks that the session is in the seat's database. A missing database or session returns `retry_fresh` (the restore stop-and-ask), never a silent fresh start. If the check cannot read the database, the launch goes ahead, and OpenCode's `Session not found` exit is classified the same way. OpenRig never uses `--continue`.

Session ids look like `ses_` followed by 26 letters or digits.

## Self-update

OpenCode checks for a new release when the TUI starts and installs a patch release in place through the method it detects (a global npm install, Homebrew, or the install script). From a managed seat that would rewrite the owner's installation unattended, so every launch, fresh or resumed, sets `OPENCODE_DISABLE_AUTOUPDATE=1` for the seat's process only. Nothing is written to the owner's OpenCode config. Update OpenCode yourself with `opencode upgrade` or your package manager.

## Fork

Not supported. `--fork` only works on a session in the same database, and every seat has its own, so a parent session from another seat is never visible. A fork request fails with a clear error.

## Guidance and skills

- Guidance: managed blocks merge into `<cwd>/AGENTS.md`, which OpenCode reads as project rules (it reads `CLAUDE.md` only when there is no `AGENTS.md`). Per-seat `rig-role` content is not merged into the shared file; it is delivered as text. Rig teardown removes the managed blocks.
- Skills: projected to `<cwd>/.opencode/skills/<name>/SKILL.md`, a project skills location OpenCode scans.

## Readiness

The seat is ready when the pane shows the home placeholder `Ask anything`, the prompt box's bottom border (`╹▀▀▀…`), or the prompt footer `ctrl+p commands`, and no dialog is open. A resumed session opens on the session route, which has no placeholder, so the border covers it. The footer alone is not enough: in the daemon's 80x24 panes it wraps across two lines when the cwd is long.

The prompt box stays drawn underneath dialogs (the command palette, model and session pickers, alerts), so every marker is refused while a dialog header (title on the left, `esc` on the right) is on screen. A pane back at a shell is never ready. OpenCode shows no trust or login modal, so no attention gates are mapped.

## Stop and teardown

The seat is stopped by killing its tmux session, never by keystrokes. OpenRig then reaps the pane's process tree (`reapProcessTreeOnStop`), because OpenCode starts LSP servers and local MCP servers as child processes that can outlive the session. The reap is PID-scoped: it uses a snapshot of the pane's tree taken before the kill.

## Usage

Usage (`rig ps`): token, cache, reasoning, and cost totals from the seat database's `session` row, and the context in use from the latest assistant message; no context window is recorded, so CTX shows no percentage.

## Context alerts

Context-pressure alerts use the same `context.pressure` health detector and operator thresholds as claude and codex (`health.context_pressure.warning_percent` and `critical_percent`, default 95 and 99). They need a context percentage, which exists only when the CLI reports its context window. OpenRig never compacts a CLI seat: it does not type into a live CLI. opencode records no context window, so seats never alert. opencode compacts a session itself when it nears the model's limit, unless `compaction.auto` is false (`session/overflow.ts`).

## Transcript

`rig transcript` reads the session's messages from the seat's own database
(`message` and `part` tables, opencode 1.18.33): user and assistant text and tool
calls with their output or error. Reasoning and synthetic text are left out,
and the text is redacted. The session is the seat's resume token, else its
current session. `--source pane` shows the pane capture instead.

## Known limits

- OpenCode console accounts (the hidden `opencode console login` command, used for organization-managed config) are stored in the session database, so a seat with its own database does not see them. OpenCode has no separate setting for the account store. Provider sign-in (`opencode auth login`, env keys) is unaffected.
- npm installs run behind a `node` launcher, so the pane's foreground command is `node`. The runtime is identified from the launcher's arguments instead; `node` alone is never treated as OpenCode.
- Stopping a seat never relies on keystrokes. The default exit keys (`ctrl+c`, `ctrl+d`, `<leader>q`) can be rebound, and in the Kilo fork a single `ctrl+c` at idle did not exit in live testing.

## What was verified live

Verified on 2026-09-29 against opencode 1.18.33 (Homebrew build), in an isolated tmux server with a throwaway `HOME` and no credentials:

- `--help` flags: `-m`, `-c`, `-s`, `--fork`, `--prompt`, `--auto`.
- The home idle screen (placeholder, agent and model line, `tab agents  ctrl+p commands` footer).
- No session row exists at idle before the first prompt.
- `opencode -s <unknown id>` prints `Error: Session not found: <id>` and exits to the shell.
- The `session` table schema, and `OPENCODE_DB` path resolution.
- 80x24 panes with a long cwd, for the home screen, a resumed session, the command palette open on both, and `Session not found`. These captures are the readiness test fixtures.
- A real `rig up`, `rig down`, and restore on an isolated OpenRig daemon. See the pull request that added the 80x24 fixtures for the smoke evidence.
- With a per-seat `OPENCODE_DB`, `opencode auth list` still reports the credential from the shared `auth.json` (probed with a fake key).

Read from source (tag `v1.18.33`): the session-route prompt footer, the session id format, project skills scanning, `AGENTS.md` precedence, and where the database stores accounts.
