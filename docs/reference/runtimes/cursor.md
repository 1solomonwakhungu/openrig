# Cursor CLI (`runtime: cursor`)

OpenRig runs the interactive Cursor CLI (`cursor-agent`) in the seat's tmux
pane. Source: `packages/daemon/src/adapters/cli/cursor/`.

## Install

Cursor's documented install is `curl https://cursor.com/install -fsS | bash`.
It places the CLI under `~/.local/share/cursor-agent/versions/<release>/` and
links `~/.local/bin/cursor-agent` and `~/.local/bin/agent`.

> **Coexistence warning:** the install script runs
> `rm -f ~/.local/bin/agent ~/.local/bin/cursor-agent` and then relinks both.
> If another CLI owns `~/.local/bin/agent` (Grok Build installs an `agent`
> link there), the script replaces it. To keep the other CLI's link, download
> the release archive from the URL printed by the script and extract it
> yourself, or restore the other link after installing.

OpenRig always launches `cursor-agent` and never the bare `agent` name, which
can resolve to a different CLI. Verification checks that
`cursor-agent --version` prints a Cursor release such as `2026.09.28-64d2043`.

## Auth

Sign in once outside OpenRig with `cursor-agent login` (set `NO_OPEN_BROWSER=1`
to print the URL instead of opening a browser), or export `CURSOR_API_KEY` in
the environment the daemon launches seats from. `cursor-agent status` shows the
current account.

An unauthenticated seat does not hang: the launch reports `attention_required`
with the code `login_required` and the pane text as evidence.

## Rig spec

```yaml
members:
  - id: impl
    agent_ref: "local:agents/impl"
    profile: default
    runtime: cursor
    model: gpt-5            # optional; passed as --model (bracket overrides allowed)
    cwd: "."
```

## Launch posture

| Posture | Launch flags |
|---|---|
| `floor` (default) | `--trust` only: Cursor's own approval settings apply |
| `full_bypass` | `--trust --force` (`--force` runs commands unless explicitly denied) |

Posture comes from the member or rig `permission_policy` (for example
`builtin:yolo` selects `full_bypass`). `rig seat set-permissions` is currently
limited to `claude-code` and `codex`.

`--trust` is passed on every launch. It marks the seat's workspace as trusted
so the "Workspace Trust Required" dialog does not block the seat; `--force`
alone does not skip that dialog in the interactive CLI. This mirrors how
OpenRig pre-accepts workspace trust for Claude Code seats.

## Resume

Cursor assigns the chat id itself and stores chats under
`<config dir>/chats/<md5 of the absolute working directory>/<chat id>/store.db`,
where the config dir is `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`,
else `~/.cursor`.

Before each launch OpenRig records the chat ids that already exist for the
seat's directory. The resume token is the single chat that appears after that
launch, captured once it exists (after readiness, by the periodic resume
refresher, or at restore). If no new chat appears, or several do (two seats
started in the same directory at once), no token is recorded rather than a
guess. Resume launches `cursor-agent --trust --resume <chat id>` after checking
the chat's `store.db` still exists; if it does not, the resume is refused as
`retry_fresh` and restore asks before starting a new chat. Fork is not
supported (Cursor has no fork flag).

## Guidance and skills

- Managed guidance blocks merge into `AGENTS.md` in the seat's working
  directory, which Cursor reads alongside `.cursor/rules`. Rig teardown
  removes the managed blocks.
- Skills are projected into `<cwd>/.agents/skills/`, one of the skill
  locations Cursor discovers.

## Known limits

- The `cursor-agent` script runs its bundled `node` under its own name, so the
  pane command is `node`; discovery matches the `cursor-agent` program name. A
  CLI started through the `agent` link is not recognized as Cursor. Stop reaps
  the pane's process tree.
- Seats that share a working directory and start at the same moment may get no
  captured resume token (see Resume).
- Readiness is read from the composer placeholder (`Plan, search, build
  anything` or `Add a follow-up`). A busy-state marker is not used.

## What was verified live

Against Cursor CLI 2026.09.28-64d2043 in an isolated tmux server with a
throwaway home, without signing in: `cursor-agent --version` output, the
unauthenticated `Press any key to log in` screen, the `node` pane command, and
the install script's `rm -f ~/.local/bin/agent`. From the shipped CLI bundle
(the CLI is closed source): `--trust` skipping the interactive trust dialog,
the chat storage layout, the ready placeholders, the trust dialog text, and the
skill locations. The signed-in ready screen and trust dialog were not captured
live; their test fixtures are built from the bundle strings.
