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
| `floor` (default) | `--disable-auto-update --trust`: Cursor's own approval settings apply |
| `full_bypass` | `--disable-auto-update --trust --force` (`--force` runs commands unless explicitly denied) |

Posture comes from the member or rig `permission_policy` (for example
`builtin:yolo` selects `full_bypass`). To choose a posture for one seat, run
`rig seat set-permissions <seat> --mode floor|full_bypass --reason <text>`; it
changes the arguments on the seat's next launch, resume, or handover, and
`--mode inherit` returns the seat to its policy. Cursor also stores approval
mode in each chat: resuming a chat previously run with `--force` without that
flag does not clear its stored Run Everything setting. Selecting `floor` is
therefore not evidence that a resumed chat has reduced permissions. Start a
fresh chat when a lower posture is required; OpenRig does not rewrite Cursor
chat metadata.

Under `full_bypass` OpenRig records `force` as the seat's applied-launch observation (axis `permission`); when the seat has a `rig seat set-permissions` choice or a permission policy, permission drift compares the posture it implies with that choice (else the policy's posture) and reports `aligned` or `drift`. The floor passes no permission flag, so its observation is `unknown` (Cursor's own settings govern) and never compared. This checks the launch arguments OpenRig emitted, not Cursor's own enforcement.

`--trust` is passed on every launch. It marks the seat's workspace as trusted
so the "Workspace Trust Required" dialog does not block the seat; `--force`
alone does not skip that dialog in the interactive CLI. This mirrors how
OpenRig pre-accepts workspace trust for Claude Code seats.

## Updates

Every managed launch passes `--disable-auto-update`, so a seat never updates
Cursor. Without it the CLI checks for a newer release about two seconds after
it starts and, when one exists, installs it under
`~/.local/share/cursor-agent/versions/`, deletes older versions, and re-links
`~/.local/bin/agent`, `~/.local/bin/cursor-agent`, and a `~/.local/bin/cursor`
shim (the same `agent` link the install script replaces). The flag is not
listed in `cursor-agent --help` but is accepted by the CLI. Update Cursor
yourself with `cursor-agent update` (which also re-links `agent`) or by
reinstalling.

## Resume

Cursor stores chats under
`<config dir>/chats/<md5 of the absolute working directory>/<chat id>/store.db`,
where the config dir is `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`,
else `~/.cursor`.

Fresh launches mint a UUIDv4 and pass `--new-session-id <id>`. Cursor reserves
that exact ID and rejects an existing directory at that location. OpenRig
records the ID in the seat's `launch.json` and the launch's resolved config
dir in `cursor-chats-before-launch.json` (the legacy filename is retained).
The launch record is replaced atomically before the command is sent. A
read-only record can be replaced when its directory is writable. If the write
or rename fails, launch stops before starting Cursor and reports
`attention_required`; the previous record remains available for recovery.
This keeps immediate capture, the periodic refresher and restore on the same
identity, including when the new store appears later.

Capture returns only that reserved ID once its `store.db` exists. It never
chooses a chat by its timestamp or by comparing directory contents. Operator
chats and sibling seats in the same directory cannot substitute their IDs.
A never-prompted seat without a store reports no resumable token.

Existing persisted resume tokens continue to work. An older launch without a
reserved ID cannot safely discover its identity from the shared chat store;
set that seat's exact token by hand if it was not already recorded. Fresh
launches use reserved IDs automatically.

Resume launches `cursor-agent --disable-auto-update --trust --resume <chat id>` after checking the
chat's `store.db` still exists; if it does not, the resume is refused as
`retry_fresh` and restore asks before starting a new chat. Fork is not
supported (Cursor has no fork flag).

To set the token by hand for an older seat, identify its exact chat under
`<config dir>/chats/<md5 of the working directory>/` and pipe it in:

```sh
printf '%s' "$CHAT_ID" | rig seat set-resume-token impl@my-rig --token-stdin --reason "cursor chat id"
```

## Guidance and skills

- Managed guidance blocks merge into `AGENTS.md` in the seat's working
  directory, which Cursor reads alongside `.cursor/rules`. Rig teardown
  removes the managed blocks.
- Skills are projected into `<cwd>/.agents/skills/`, one of the skill
  locations Cursor discovers.

## Usage

Usage: not reported. Cursor CLI is closed source with no verified on-disk usage record, so the runtime declares no `readUsage` (CTX and COST stay unknown).

## Context alerts

Context-pressure alerts use the same `context.pressure` health detector and operator thresholds as claude and codex (`health.context_pressure.warning_percent` and `critical_percent`, default 95 and 99). They need a context percentage, which exists only when the CLI reports its context window. OpenRig never compacts a CLI seat: it does not type into a live CLI. No usage is read, so seats never alert.

## Known limits

- The `cursor-agent` script runs its bundled `node` under its own name, so the
  pane command is `node`; discovery matches the `cursor-agent` program name. A
  CLI started through the `agent` link is not recognized as Cursor. Stop reaps
  the pane's process tree.
- `--new-session-id` is a hidden CLI flag, verified in the shipped bundles for
  `2026.09.28-64d2043` and `2026.10.18-ea085cb`. Older releases were not tested.
- A token manually supplied by the operator is trusted; OpenRig does not prove
  the history or original ownership of an existing Cursor chat.
- Readiness is read from the composer placeholder (`Plan, search, build
  anything` or `Add a follow-up`).
- Activity: `ctrl+c to stop` reads as working (at trial: measured, not yet
  authoritative), and an approval prompt such as `Run this command?` or
  `Waiting for decision (y/n/p)` reads as needs-input in `rig ps` and the TUI.
  These strings come from Cursor's shipped bundle; they were not observed on a
  signed-in screen.

## What was verified live

Against Cursor CLI 2026.09.28-64d2043 in an isolated tmux server with a
throwaway home, without signing in: `cursor-agent --version` output, the
unauthenticated `Press any key to log in` screen, the `node` pane command, and
the install script's `rm -f ~/.local/bin/agent`. From the shipped CLI bundle
(the CLI is closed source): `--trust` skipping the interactive trust dialog,
the chat storage layout, the ready placeholders, the trust dialog text, and the
skill locations. The signed-in ready screen and trust dialog were not captured
live; their test fixtures are built from the bundle strings.

## Ownership and posture investigation (2026-10-19)

No Cursor CLI was on PATH during this investigation. Official release archives
for `2026.09.28-64d2043` and `2026.10.18-ea085cb` were extracted under `/tmp`;
the installer was read, never executed. All probes used disposable HOME,
XDG_CONFIG_HOME, CURSOR_CONFIG_DIR and cwd, with no account credentials.

- Live binaries reported their expected versions. `create-chat` printed a UUID
  but did not exit within seven seconds; neither probe left a chat store.
  Both binaries rejected combining `--new-session-id` with `--resume`, with
  the explicit conflict diagnostic. Interactive fresh-ID probes were stopped
  after six seconds without reaching a readable login or ready screen.
- The shipped `src/state/requested-session-id.ts` validates UUIDv4, forbids
  combining it with resume/continue, and reserves the exact chat directory
  with non-recursive mkdir. The exported reservation function was executed in
  isolation with real filesystem operations: it created the requested
  directory and rejected a second reservation. The module loader supplied
  only filesystem/path, a temporary state root and a schema stub; this was
  source-level execution, not an authenticated end-to-end Cursor run.
- Source provenance: `1249.index.js` (September release), SHA-256
  `cf0cf05d8090b491191df9cfd041c122e9031e2c7480d26f33f7c38b450b55f0`;
  `4189.index.js` (October release), SHA-256
  `fe2e8731edba56da8f349ea12f88a0bbabdadf296b20b67f01935fe2aad7d609`.
- Both bundles' `src/commands/chat.ts` load the existing store on resume and
  set `isRunEverything` to true for the force option. The default branch does
  not reset it. `src/shared/approval-mode-setting.ts` reads the stored
  approval mode and legacy `isRunEverything`; the config-sync hook only reacts to changes
  after its initial value. This supports the contributor's warning about
  lowering posture on resume. No authenticated enforcement probe was run,
  and this change adds no posture refusal or metadata mutation.

The [contributor's report](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19047812)
provided the `create-chat` and per-chat posture observations. The adapter uses
`--new-session-id` instead, avoiding the non-exiting creator process. Regression
tests exercise the actual adapter and descriptor consumer with temporary chat
stores, including the unmanaged-chat collision and lazy refresher/restore
capture. Stub-runtime scenarios cannot exercise Cursor's native store or argv;
no real-model or authenticated continuity claim follows from these tests.
