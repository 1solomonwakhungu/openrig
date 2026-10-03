# Kiro CLI (`runtime: kiro`)

OpenRig runs Kiro CLI's interactive chat (`kiro-cli chat`) in the seat's tmux
pane. Kiro CLI is the successor of Amazon Q Developer CLI. Source:
`packages/daemon/src/adapters/cli/kiro/`.

Parts of this adapter could not be checked against a signed-in Kiro; see
[Verified versus derived](#verified-versus-derived). Readiness is strict
because of that, and Kiro seats are never resumed.

## Install and auth

```sh
brew install --cask kiro-cli
# or the installer at https://kiro.dev/cli (on macOS it installs an app into /Applications)
```

OpenRig checks that `kiro-cli --version` prints `kiro-cli <version>`.

Sign in once outside OpenRig with `kiro-cli login`, or set `KIRO_API_KEY` in
the environment the daemon launches seats from. An unauthenticated seat does
not hang: Kiro shows "Welcome to Kiro CLI, let's get you signed in!" and the
launch reports `attention_required` with the code `login_required` and the
pane text as evidence. OpenRig never presses Enter there, and every launch
sets `BROWSER=true` so no browser tab opens on your desktop.

`rig runtimes` and `rig doctor` report a kiro seat as signed in only when
`KIRO_API_KEY` is set (checked by name, never by value). A browser sign-in is
stored in kiro-cli's own database, which these checks do not open, so without
the key the status is "unknown" with a hint.

## Rig spec

```yaml
members:
  - id: impl
    agent_ref: "local:agents/impl"
    profile: default
    runtime: kiro
    model: claude-sonnet-4.5   # optional; passed as --model
    cwd: "."
```

`model` is a Kiro model id as `kiro-cli chat --list-models` prints it (for
example `claude-sonnet-4.5`, no provider prefix) or `auto`. Preflight warns,
never refuses, when a model does not have that shape.

## Launch

| Posture | Launch argument |
|---|---|
| `floor` (default) | `--trust-tools=` (trust no tools: Kiro asks before every tool call) |
| `full_bypass` | `--trust-all-tools` (every tool runs without asking) |

Both arguments come from `kiro-cli chat --help`. Kiro declares both modes, so
`rig seat set-permissions` can select either for a kiro seat. OpenRig records the emitted
argument as the seat's applied-launch observation (axis `permission`), and
permission drift compares the posture it implies with the seat's policy.

Every launch also sets `KIRO_DISABLE_TELEMETRY=1` (owner privacy) and
`KIRO_NO_AUTO_UPDATE=1` (a managed seat never replaces your install). Both
variable names come from the Kiro binary; their effect was not observed.

## Readiness

The seat is ready when the chat input placeholder
`Ask a question or describe a task` is on screen and none of the sign-in,
browser, tool-approval, or cancel prompts is. Any other screen runs out the
launch wait as `attention_required` with the pane as evidence, never as ready.

## Resume and fork

Not supported. OpenRig records no resume token for Kiro seats, so restore
stops and asks for an explicit `--fresh <seat>`; it never guesses a
conversation. Kiro itself has `--resume-id <session id>`, but its session
store and its behavior for an unknown id could not be observed (both need a
signed-in account), so OpenRig does not use it. There is no fork.

## Usage

Not reported. Kiro seats show no token, context, or cost numbers in `rig ps`
or the usage poller: the descriptor has no usage reader, because Kiro's
session store could not be observed without a signed-in account (see
[Verified versus derived](#verified-versus-derived)).

## Guidance and skills

- Managed guidance blocks merge into `AGENTS.md` in the seat's working
  directory (Kiro also reads `.kiro/steering/`). Rig teardown removes the
  managed blocks.
- Skills are projected into `<cwd>/.kiro/skills/`.

## Known limits

- Stop reaps the pane's process tree, since Kiro starts helper processes.
- `--trust-tools=` asks before every tool, including file reads. That is
  stricter than Kiro's own default; use a `full_bypass` policy for unattended
  seats.

## Verified versus derived

Against kiro-cli 2.27.1 on macOS (2026-10-03). The bundle came from the DMG
named in Kiro's release manifest (sha256 checked against the manifest) and was
copied out without installing; the macOS installer was not run, because it
installs into `/Applications` and starts the desktop app. All runs used an
isolated tmux server, a throwaway `HOME`, and `BROWSER=true`, without signing
in.

Verified live:

- `kiro-cli --version` prints `kiro-cli 2.27.1`.
- `kiro-cli --help-all` and `kiro-cli chat --help`: `chat`, `--model`,
  `--trust-all-tools`, `--trust-tools=<names>` (empty trusts none),
  `--resume`, `--resume-id <SESSION_ID>`, `--resume-picker`, `--list-sessions`,
  `--no-interactive`, `login`, `logout`, `whoami`.
- Unauthenticated `kiro-cli chat` shows "Welcome to Kiro CLI, let's get you
  signed in!" and "Press enter to continue to the browser or esc to cancel"
  inline (not on the alternate screen), with `kiro-cli` as the pane's
  foreground command (fixture `kiro-80-login.txt`).
- Unauthenticated `kiro-cli chat --list-sessions` starts a browser sign-in
  ("Opening browser..."), so even listing sessions needs an account.
- Local state lives under `~/Library/Application Support/kiro-cli/` (a SQLite
  database with `auth_kv` and `state` tables) and `~/.kiro/`.

Derived from strings in the kiro-cli-chat binary (never seen in a live pane):

| String | Adapter use |
|---|---|
| `Ask a question or describe a task` | ready, only with none of the not-ready markers on screen (fixture `kiro-80-idle-synth.txt` is synthesized) |
| `Opening browser`, `Allow this action?`, `Ctrl+C to cancel` | not ready: a sign-in, tool approval, or cancelable step is up |
| `KIRO_DISABLE_TELEMETRY`, `KIRO_NO_AUTO_UPDATE`, `KIRO_API_KEY` | launch env and the documented API key sign-in |
| `AGENTS.md`, `.kiro/steering`, `.kiro/skills` | guidance file and skills directory |

Not verified, carried as residual risk:

- The idle screen and every in-chat prompt. If the placeholder is worded
  differently, launches time out as `attention_required` (safe, but the seat
  never reads ready); the first signed-in launch should confirm
  `KIRO_READY_RE` and the not-ready markers.
- A first-run or `--trust-all-tools` confirmation the strings mention but do
  not word; if it appears, the launch times out as `attention_required`.
- The session store format and `--resume-id` behavior, which is why resume is
  off. With a throwaway `KIRO_API_KEY`, a sandboxed probe could verify both
  and enable resume.
