# GitHub Copilot CLI (`runtime: copilot`)

OpenRig runs the interactive GitHub Copilot CLI (`copilot`) in the seat's tmux
pane. Source: `packages/daemon/src/adapters/cli/copilot/`.

## Install

Any of the official installs works. OpenRig launches `copilot` from the
managed launch PATH and checks that `copilot --version` reports
`GitHub Copilot CLI <version>`.

```sh
npm install -g @github/copilot        # Node 22 or newer
brew install --cask copilot-cli
```

## Auth

Sign in once outside OpenRig with `copilot login` (or `/login` inside the TUI),
or export `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` (in that order of
precedence; a fine-grained token needs the "Copilot Requests" permission) in
the environment the daemon launches seats from. BYOK providers use the
`COPILOT_PROVIDER_*` variables described by `copilot help environment`.

An unauthenticated seat does not hang: the launch reports `attention_required`
with the code `login_required` and the pane text as evidence.

## Rig spec

```yaml
members:
  - id: impl
    agent_ref: "local:agents/impl"
    profile: default
    runtime: copilot
    model: gpt-5.4          # optional; passed as --model
    cwd: "."
```

## Launch posture

| Posture | Launch flag |
|---|---|
| `floor` (default) | none: Copilot's own default applies (it prompts before writes and commands) |
| `full_bypass` | `--yolo` (tools, paths, and URLs all allowed) |

Posture comes from the member or rig `permission_policy` (for example
`builtin:yolo` selects `full_bypass`). `rig seat set-permissions` is currently
limited to `claude-code` and `codex`. With `floor`, a `defaultPermissionMode`
you set in Copilot's own settings still applies; OpenRig does not override it.

## Folder trust

`--yolo` does not skip Copilot's "Confirm folder trust" dialog. Before each
launch OpenRig adds the seat's working directory (and its resolved real path)
to `trustedFolders` in `$COPILOT_HOME/settings.json` (default
`~/.copilot/settings.json`). The edit is merge-only: it adds entries and never
removes or rewrites anything else. If the file does not parse as JSON (for
example it contains comments), OpenRig leaves it untouched and the launch
reports `trust_gate` instead.

## Resume

OpenRig creates each session with `--session-id <uuid>`, so the resume token is
known at launch and is unique per seat even when seats share a directory.
Resume launches `copilot --resume=<uuid>`. Before resuming, OpenRig checks that
`$COPILOT_HOME/session-state/<uuid>/workspace.yaml` still exists; if it does
not, the resume is refused as `retry_fresh` and restore asks before starting a
new session. Fork is not supported (Copilot has no fork flag).

## Guidance and skills

- Managed guidance blocks merge into `AGENTS.md` in the seat's working
  directory, which Copilot loads as repository instructions. Rig teardown
  removes the managed blocks.
- Skills are projected into `<cwd>/.agents/skills/`, one of Copilot's project
  skill locations.

## Known limits

- The npm install runs under `node`, so the pane command alone does not
  identify Copilot; discovery matches a program named `copilot` or one inside
  the `@github/copilot` packages. Stop reaps the pane's process tree because
  the launcher starts the native binary as a child.
- Readiness is read from the pane: the footer `/ commands · ? help` means ready.
  A busy-state marker is not used.
- OpenRig records the `COPILOT_HOME` each launch resolved in the seat's state
  and uses it for the resume check and capture.

## What was verified live

Against Copilot CLI 1.0.89 in an isolated tmux server with a throwaway home,
without signing in: `--session-id` creating `session-state/<uuid>/workspace.yaml`
at startup; `--yolo` still showing the folder-trust dialog; `trustedFolders`
suppressing it; the unauthenticated idle screen; `--resume=<unknown id>`
printing `No session, task, or name matched` and exiting 1; `AGENTS.md` and
`.agents/skills` discovery (`copilot instruction list`, `copilot skill list`).
The signed-in ready screen was not captured; its test fixture is the live
unauthenticated screen with the sign-in lines removed.
