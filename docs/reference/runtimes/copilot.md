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
| `floor` (default) | no permission flag: Copilot's own default applies (it prompts before writes and commands) |
| `full_bypass` | `--yolo` (tools, paths, and URLs all allowed) |

Both postures also pass `--no-auto-update` (see Updates).

Posture comes from the member or rig `permission_policy` (for example
`builtin:yolo` selects `full_bypass`). To choose a posture for one seat, run
`rig seat set-permissions <seat> --mode floor|full_bypass --reason <text>`; it
applies on the seat's next launch, resume, or handover, and `--mode inherit`
returns the seat to its policy. With `floor`, a `defaultPermissionMode`
you set in Copilot's own settings still applies; OpenRig does not override it.

Under `full_bypass` OpenRig records `yolo` as the seat's applied-launch observation (axis `permission`); when the seat has a `rig seat set-permissions` choice or a permission policy, permission drift compares the posture it implies with that choice (else the policy's posture) and reports `aligned` or `drift`. The floor passes no permission flag, so its observation is `unknown` (Copilot's own settings govern) and never compared. This checks the launch arguments OpenRig emitted, not Copilot's own enforcement.

## Folder trust

Copilot asks "Do you trust the files in this folder?" the first time it runs
in a folder, and `--yolo` does not skip that dialog. OpenRig writes no Copilot
configuration for it. Instead, during the seat's own launch OpenRig chooses
**1. Yes**, which trusts the folder for that Copilot session only; nothing is
remembered for later sessions. It answers only when all of these hold:

- the dialog appeared after this launch started (never old pane text);
- the folder the dialog names is exactly the seat's working directory (or its
  resolved real path), not a parent, a sibling such as `/repo-old`, or any
  other folder;
- the option selected on screen reads `Yes`, so the persistent "Yes, and
  remember" option is never chosen;
- it has not already answered in this launch.

If any of these fail, or the dialog is still showing after the answer, the
launch reports `attention_required` with the code `trust_gate` and the pane
text as evidence. Each answer is logged by the daemon and recorded as
`gateAnswers` in the seat's `launch.json` under the OpenRig state directory.
This applies with both `floor` and `full_bypass`, because OpenRig only
launches into the working directory the rig spec chose.

Copilot's own `trustedFolders` setting is not used: Copilot moves that list
from `settings.json` into its self-managed `config.json` at startup, and seats
that start at the same time lose entries in that move.

## Updates

Every managed launch passes `--no-auto-update`, so a seat never updates
Copilot and always runs the installed version. Without it, a standalone
install downloads newer packages into its per-user cache and switches to them
on a later launch (npm installs only report that an update exists). Update
Copilot yourself with `copilot update`, `npm install -g @github/copilot`, or
`brew upgrade --cask copilot-cli`.

## Resume

OpenRig creates each session with `--session-id <uuid>`, so the session id is
chosen at launch and is unique per seat even when seats share a directory.
Copilot can only resume a session once it has stored a real exchange: a
session that was never prompted has `workspace.yaml` but no event journal, and
`copilot --resume=<uuid>` then fails with `No session, task, or name matched`.
So OpenRig records the id as the seat's resume token only once
`$COPILOT_HOME/session-state/<uuid>/events.jsonl` holds a user message (the
same test Copilot uses for sessions with user-visible history). It checks
right after launch, from the periodic resume refresher, and at restore. A seat
that was started but never prompted has no token, so restore stops at
awaiting-decision and asks for an explicit `--fresh <seat>` (OpenRig's no-token
policy); no wrong conversation is ever resumed.

Resume launches `copilot --no-auto-update --resume=<uuid>`. Before resuming,
OpenRig checks that `$COPILOT_HOME/session-state/<uuid>/workspace.yaml` still
exists; if it does not, the resume is refused as `retry_fresh` and restore
asks before starting a new session. Fork is not supported (Copilot has no fork
flag).

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
suppressing it for one launch, then being moved into `config.json`, and
three concurrent launches all showing the dialog after that move lost their
entries; the trust dialog, idle screen, and resume error at 80x24 with a long
working directory (the path wraps inside the dialog box and is shortened with
`...` on the idle screen); the unauthenticated idle screen; `--resume=<unknown id>`
printing `No session, task, or name matched` and exiting 1; `AGENTS.md` and
`.agents/skills` discovery (`copilot instruction list`, `copilot skill list`).
The signed-in ready screen was not captured; its test fixture is the live
unauthenticated screen with the sign-in lines removed.
