# Goose (`runtime: goose`)

OpenRig runs the interactive Goose CLI (`goose session`) in the seat's tmux
pane. Source: `packages/daemon/src/adapters/cli/goose/`.

## Install

Any official install works. OpenRig launches `goose` from the managed launch
PATH and checks that `goose --version` prints a version number.

```sh
brew install block-goose-cli
# or download goose-<arch>.tar.bz2 from https://github.com/aaif-goose/goose/releases
```

## Auth

Configure a provider once outside OpenRig with `goose configure`, or set
`GOOSE_PROVIDER`, `GOOSE_MODEL`, and the provider's key (for example
`ANTHROPIC_API_KEY`) in the environment the daemon launches seats from. Goose
keeps keys in the system keychain unless `GOOSE_DISABLE_KEYRING` is set.

A seat without a working provider does not hang. Goose prints
`No provider configured. Run 'goose configure' first.` or
`Configuration value not found: <KEY>` and exits; the launch reports
`attention_required` with the code `login_required` and the pane text as
evidence.

Managed launches set `GOOSE_TELEMETRY_OFF=1` (see Telemetry), which also skips
goose's first-run question about sharing usage data. If that question ever
appears anyway, the launch stops with `startup_dialog` rather than answering it.

## Rig spec

```yaml
members:
  - id: impl
    agent_ref: "local:agents/impl"
    profile: default
    runtime: goose
    model: claude-sonnet-4-5   # optional; passed as --model for the configured provider
    cwd: "."
```

The provider comes from goose's own configuration (`GOOSE_PROVIDER`); `model`
must be a model that provider serves.

## Launch posture

Goose has no permission flag. Tool approval follows `GOOSE_MODE` (`auto`,
`approve`, `smart_approve`, `chat`), and goose's own default is `auto` (every
tool call runs without asking). So OpenRig always sets it:

| Posture | Launch env |
|---|---|
| `floor` (default) | `GOOSE_MODE=smart_approve` (goose asks before risky tool calls) |
| `full_bypass` | `GOOSE_MODE=auto` (every tool call runs without asking) |

The launch value overrides a `GOOSE_MODE` in goose's own configuration for
managed seats; the session records the mode it ran with.

Posture comes from the member or rig `permission_policy`. OpenRig records the
emitted value (`GOOSE_MODE=smart_approve` or `GOOSE_MODE=auto`) as the seat's
applied-launch observation (axis `permission`), and permission drift compares
the posture it implies with the seat's policy. This checks what OpenRig
emitted, not goose's own enforcement.

## Telemetry

Every managed launch sets `GOOSE_TELEMETRY_OFF=1`, so goose sends no usage
data from OpenRig seats and skips its first-run question about it. Goose
started outside OpenRig keeps your own choice.

## Resume and fork

A fresh launch runs `goose session --name <seat session name>`. Goose writes
the session row to its sessions database at startup, before any prompt, so
OpenRig reads the seat's session id (for example `20261003_3`) right after
launch: the newest session with the seat's name, in the seat's directory,
created since the launch started. Goose does not dedupe names (every launch
creates a new session), so the launch time is what ties the row to this
launch. The periodic resume refresher and restore read it the same way if the
first read misses.

Resume launches `goose session --resume --session-id <id>`. Before resuming,
OpenRig checks the id is still in the sessions database; if not, the resume is
refused as `retry_fresh` and restore asks before starting a new session. Goose
itself prints `Cannot resume session <id> - no such session exists` for a
missing id, which OpenRig reads the same way. Bare `--resume` (the most recent
session) is never used.

Fork launches `goose session --resume --session-id <parent> --fork`. Goose
refuses `--name` together with `--session-id`, so the copy keeps the parent's
name. OpenRig records the parent in the seat's state and captures the one copy
of it created in the seat's directory since the launch; if two seats fork the
same parent in the same directory at the same moment, neither captures a token
and restore asks for `--fresh` instead of guessing.

Resuming a session from a different directory than the one it was recorded in
makes goose ask whether to switch back; that stops the launch as
`startup_dialog`.

Where goose keeps sessions: `$GOOSE_PATH_ROOT/data/sessions/sessions.db`, else
`$XDG_DATA_HOME/goose/sessions/sessions.db`, else
`~/.local/share/goose/sessions/sessions.db` (macOS included). OpenRig records
the path each launch resolved in the seat's state (`goose-seat.json`) and reads
the database read-only.

## Usage and cost

`rig ps` and the usage poller read the seat's session row in goose's sessions
database (read-only): the session's running totals (`accumulated_input_tokens`,
`accumulated_output_tokens`, the cache read and write totals) and goose's own
`accumulated_cost`, reported as `cli_reported`. The context fill is the row's
`total_tokens` (the latest request's total) and the model is
`provider/model_name`. The column meanings come from goose 1.53.0's schema; no
conversation was run to watch them change. A session with no turns yet
reports nothing.

## Per-seat permissions

Goose declares both `floor` and `full_bypass`, so `rig seat set-permissions`
can select either for a goose seat; the next launch sets the matching
`GOOSE_MODE`.

## Guidance and skills

- Managed guidance blocks merge into `AGENTS.md` in the seat's working
  directory. Goose loads `.goosehints` and `AGENTS.md` from the git root down
  to the working directory by default. Rig teardown removes the managed blocks.
- Skills are projected into `<cwd>/.agents/skills/`, goose's project skill
  location.

## Known limits

- Readiness is read from the pane: the input footer
  `Enter to send · Ctrl+J newline` means ready. The busy marker is the
  spinner's `(Ctrl+C to interrupt)`.
- In `approve` or `smart_approve` mode goose asks
  "Goose would like to call the above tool, do you allow?" during work; a
  launch never sees it.
- OpenRig never runs `goose update`; no self-update was observed on launch
  in the verified version.

## What was verified live

Against goose 1.53.0 (release asset) in an isolated tmux server with a
throwaway home and no credentials: the usage-data question on first run and
`GOOSE_TELEMETRY_OFF=1` skipping it; the no-provider and missing-key errors
exiting to the shell; the ready screen at 80x24 (a local provider pointed at a
closed port, which starts without a key); a new session row per `--name`
launch with `user_set_name = 1`; resume by id, the missing-id error, and the
switch-back question when resuming from another directory; `GOOSE_MODE=smart_approve`
accepted at launch and recorded on the session; `--fork` creating a
copy with the parent's name and `user_set_name = 0`, and `--name` being
refused with `--session-id`; the database locations under `GOOSE_PATH_ROOT`
and `XDG_DATA_HOME` (`goose info`). No prompt was sent to a model.
