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

Each seat gets its own session database: the launch sets `OPENCODE_DB=<OPENRIG_HOME>/state/opencode/<session>/opencode.db`. That keeps each seat's current session unambiguous even when pod-mates share a `cwd`. Provider credentials (`auth.json` and env vars) stay shared.

OpenCode creates a session only when the first prompt is sent, so a fresh launch has no resume token yet. OpenRig reads the token later, read-only, from the seat's database: the most recently updated top-level, unarchived session. It does this after launch, in the periodic resume-metadata refresh, and once at restore if no token was persisted.

Resume launches `opencode -s <session id>`. Before typing, OpenRig checks that the session is in the seat's database. A missing database or session returns `retry_fresh` (the restore stop-and-ask), never a silent fresh start. If the check cannot read the database, the launch goes ahead, and OpenCode's `Session not found` exit is classified the same way. OpenRig never uses `--continue`.

Session ids look like `ses_` followed by 26 letters or digits.

## Fork

Not supported. `--fork` only works on a session in the same database, and every seat has its own, so a parent session from another seat is never visible. A fork request fails with a clear error.

## Guidance and skills

- Guidance: managed blocks merge into `<cwd>/AGENTS.md`, which OpenCode reads as project rules (it reads `CLAUDE.md` only when there is no `AGENTS.md`). Per-seat `rig-role` content is not merged into the shared file; it is delivered as text. Rig teardown removes the managed blocks.
- Skills: projected to `<cwd>/.opencode/skills/<name>/SKILL.md`, a project skills location OpenCode scans.

## Readiness

The seat is ready when the pane shows the home placeholder `Ask anything` or the prompt footer `ctrl+p commands`. A resumed session opens without the placeholder, so the footer covers it. A pane back at a shell is never ready. OpenCode shows no trust or login modal, so no attention gates are mapped.

## Known limits

- OpenCode console accounts and their organization config are stored in the session database (the `account` tables), so a seat with its own database does not see them. Provider credentials work normally.
- The footer marker assumes the default command palette key (`ctrl+p`). If you rebind it, a resumed seat is only detected as ready from the home placeholder.
- npm installs run behind a `node` launcher, so the pane's foreground command is `node`. The runtime is identified from the launcher's arguments instead; `node` alone is never treated as OpenCode.
- Stopping a seat never relies on keystrokes. The default exit keys (`ctrl+c`, `ctrl+d`, `<leader>q`) can be rebound, and in the Kilo fork a single `ctrl+c` at idle did not exit in live testing.

## What was verified live

Verified on 2026-09-29 against opencode 1.18.33 (Homebrew build), in an isolated tmux server with a throwaway `HOME` and no credentials:

- `--help` flags: `-m`, `-c`, `-s`, `--fork`, `--prompt`, `--auto`.
- The home idle screen (placeholder, agent and model line, `tab agents  ctrl+p commands` footer).
- No session row exists at idle before the first prompt.
- `opencode -s <unknown id>` prints `Error: Session not found: <id>` and exits to the shell.
- The `session` table schema, and `OPENCODE_DB` path resolution.

Read from source (tag `v1.18.33`): the session-route prompt footer, the session id format, project skills scanning, `AGENTS.md` precedence, and where the database stores accounts.
