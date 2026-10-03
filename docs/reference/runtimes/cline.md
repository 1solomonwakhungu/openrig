# Cline CLI runtime (`runtime: cline`)

OpenRig runs the [Cline CLI](https://docs.cline.bot/cli/cli-reference) as an
interactive TUI in the seat's tmux pane.

## Install and auth

```bash
npm install -g cline
cline auth            # pick a provider; or: cline auth anthropic -k <key> -m <model>
```

Preflight checks `cline --version`. Cline keeps provider settings in
`~/.cline/data/settings/providers.json`. OpenRig never writes them, so authenticate
once as the operator before launching seats. A seat launched with no provider
configured stops at Cline's sign-in picker and reports `login_required`.

## Rig spec

```yaml
pods:
  - id: dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: cline
        cwd: "."
    edges: []
```

## Launch mapping

| OpenRig | Cline |
|---|---|
| launch | `cline --auto-approve false` (typed into the pane; no prompt argument, which would run one-shot) |
| `model` | not supported: a member with `model:` is refused at launch (see below). The seat uses the provider and model selected in Cline. |
| floor posture | `--auto-approve false`. Cline defaults auto-approve to **true**, so the floor always passes `false` explicitly. |
| full_bypass posture (`OPENRIG_YOLO=1` or a full-bypass permission policy) | `--auto-approve true`. The hidden `--yolo` flag is never used because it forces headless output. |
| resume | `--id <session id>` |
| fork | refused: Cline has no fork primitive |
| launch env | `CLINE_DISABLE_CLINE_PASS_NOTICE=1` (suppresses launch notice modals, which swallow the first keystroke and open a browser on Enter) and `CLINE_NO_AUTO_UPDATE=1`. Cline's only self-updater checks npm at launch and later runs the matching global update (`npm update -g cline`, or the pnpm, yarn, or bun equivalent) in the owner's prefix; this variable turns it off before any check. Releases up to 3.0.54 also killed live sessions when they auto-updated. Both variables are applied on fresh and resume launches. |

OpenRig records the permission value it passed (`auto-approve=false` or `auto-approve=true`) as the seat's applied-launch observation (axis `permission`). When the seat has a permission policy (member or rig), permission drift compares the posture that value implies with the policy's posture and reports `aligned` or `drift`; with no policy attached it reports `unknown`. This checks the launch arguments OpenRig emitted, not the CLI's own enforcement.

## Hub

Cline runs sessions through a background hub daemon (`cline --cline-hub-daemon`)
that it starts on demand and detaches, so it outlives the TUI and the tmux
session. By default every Cline process on the host shares one hub (discovery
file `~/.cline/data/locks/hub/production.json`, a fixed port), including the
operator's own Cline, so a seat must never stop that hub. Cline has no flag to
run without a hub.

Each seat therefore runs its own hub. Every launch (fresh and resume) sets:

| Variable | Value |
|---|---|
| `CLINE_HUB_DISCOVERY_PATH` | `<seat state>/cline-hub/discovery.json` (Cline records the hub's pid, url, and auth token there) |
| `CLINE_HUB_PORT` | a free 127.0.0.1 port chosen before launch: the seat's stable preferred port when free, else any free port, and the running seat hub's port on a relaunch |

The discovery path alone is not enough: without the port Cline attaches to the
shared hub on its default port (verified). If no port could be recorded, the
launch is refused rather than falling back to the shared hub. The port is
checked free just before launch, so another process can still take it in the
moment before Cline binds it; the seat's hub then cannot start and the launch
fails visibly (no ready screen) instead of attaching elsewhere.

The per-seat hub needs Cline 3.0.65 or newer, the version it was verified on
(the variable names already appear in the 3.0.0, 3.0.30, and 3.0.54 binaries,
but only 3.0.65 was tested). An older Cline would ignore the variables, attach
to the shared hub, and make the seat the parent of the operator's hub, which a
stop would then reap. So runtime verification reports an older Cline with the
install hint, and a launch refuses one before typing anything. The launch reads
`cline --version` from the daemon's PATH; when it cannot be read, the launch
proceeds and verification reports it.

While the TUI runs, the seat's hub is its child process, so stop reaps the
pane's process tree (`reapProcessTreeOnStop`). The reaper is PID-scoped and
checks each process's start time, so it ends exactly this seat's TUI and hub,
never the operator's shared hub or another seat's. SIGTERM makes the hub exit
cleanly and remove its discovery file. A real-tmux test proves both: no process
with the seat's hub port or discovery path survives a stop, and a real shared
hub started by a second, non-isolated Cline stays up.

## Model selection

Set the model in Cline itself (`cline auth <provider> -m <model>`, or the model
picker in the TUI) and omit `model:` for cline members. A member that sets
`model:` fails to launch with:

```
cline cannot set a per-seat model without changing the operator default; set the model in Cline or omit model:
```

Why: `cline -m <model>` is not per-launch. Cline saves it as the provider's
default model in `~/.cline/data/settings/providers.json`, so a seat would
silently rewrite the operator's default, and pod-mates with different models
would race each other. `CLINE_MODEL` does not affect the TUI (verified). A
per-seat `CLINE_PROVIDER_SETTINGS_PATH` would need a copy of the operator's
provider keys or OAuth tokens, which OpenRig does not make.

## Readiness

- Ready: the input placeholder (`What can I do for you?`, `Ask anything...`,
  `Plan something...`) or the `Auto-approve all enabled|disabled (Shift+Tab)`
  footer is on screen, and the pane is not back at a shell.
- `login_required`: `Connect a model provider to get started.`
- `update_gate`: a launch notice modal (`Press Enter to open, any other key to close`).
- A resume whose session is gone prints `Error: Unknown session: <id>` inside the
  TUI instead of exiting. The resume path checks for the session on disk before
  launching and reports `retry_fresh` (stop and ask), never a silent fresh start.

## Resume token

Resume type `cline_session_id`. Cline creates a session only when the first
prompt is sent, so there is no token at launch. The token is captured later
from `~/.cline/data/sessions/<id>/<id>.json` (honoring `CLINE_SESSION_DATA_DIR`,
`CLINE_DATA_DIR`, and `CLINE_DIR`). A session matches when it is an interactive
CLI session whose `cwd` is the seat cwd and which started at or after the seat's
launch.

Cline's background hub daemon writes these files, not the TUI process, and the
metadata carries nothing tied to the TUI (its `pid` is the hub's), so a session
cannot be tied to one seat by the TUI's pid. The match is therefore guarded:

- When two matching sessions exist (two Cline seats in the same cwd, or one
  seat that started a second task before capture ran), capture records nothing
  rather than guess.
- Late capture is skipped while another live OpenRig seat of the same runtime
  shares the cwd, so a pod-mate's single session is never claimed.
- Not guarded: a session the operator starts by hand with `cline` in the seat's
  cwd, after the seat launched and before the seat's first prompt, matches the
  same filters and can be captured as the seat's token. A later restore would
  then continue the operator's conversation. Avoid running `cline` by hand in a
  seat's cwd; if you did, set the seat's correct session id with
  `rig seat set-resume-token <session>` before restoring.

## Guidance and skills

- Guidance: managed blocks merge into `AGENTS.md` at Cline's workspace root:
  the git top level of the seat cwd, or the cwd outside a repository. That is
  where Cline looks for `AGENTS.md` and its rules (cli-v3.0.65
  `resolveWorkspaceRoot`), so a seat whose cwd is a repository subdirectory
  gets its blocks at the repository root. `rig-role` content is delivered per
  seat instead, and teardown strips the managed blocks from the same file.
  Cline seats in different subdirectories of one repository share that root
  `AGENTS.md`. Teardown also strips blocks an older OpenRig wrote into the
  seat cwd's `AGENTS.md`. Verified from source; which file a live session loads is not observable
  without signing in.
- Skills: projected into `<cwd>/.cline/skills/<skill>/`, one of Cline's
  workspace skill locations (alongside `.clinerules/skills` and `.agents/skills`).

## Usage

Usage (`rig ps`): tokens, cache tokens, cost, and model from the session record's `metadata.aggregateUsage` (the session plus agents it spawned); cline records no context size or window, so CTX stays `??`.

## Context alerts

Context-pressure alerts use the same `context.pressure` health detector and operator thresholds as claude and codex (`health.context_pressure.warning_percent` and `critical_percent`, default 95 and 99). They need a context percentage, which exists only when the CLI reports its context window. OpenRig never compacts a CLI seat: it does not type into a live CLI. cline records no context size, so seats never alert. cline compacts on its own (`--compaction agentic|basic|off`, default `agentic`).

## Known limits

- Tracked guidance file: with `guidance: { tracked_file: redirect }` on the rig, a git-tracked `AGENTS.md` is left alone and OpenRig's blocks go to `<git root>/.cline/rules/openrig.md` (see rig-spec.md).
- No per-seat model (see "Model selection"). All cline seats on a host share
  the operator's Cline provider and model.
- A cline session the operator starts by hand in a seat's cwd can be captured
  as that seat's resume token (see "Resume token").
- The pane's foreground process is `node` (the npm launcher). Discovery
  identifies Cline by the pane process tree's argv (`.../cline/bin/cline` or
  `.../bin/.cline`) instead of the pane command.
- If a seat's TUI dies on its own (not through a stop), its hub loses its
  parent and keeps running until the seat is relaunched (the new TUI finds it
  through the seat's discovery file and reuses it) or the process is ended.
- A launch where `cline` is not on the pane's PATH fails fast with
  `attention_required`.
- Cline draws its TUI on the terminal alternate screen (verified), which leaves
  no tmux scrollback, so `rig transcript` for a cline seat stays thin. Launch
  readiness reads the whole alternate screen once cline holds the foreground.
  First paint took over 7 seconds in the verification run; the launch waits up
  to 30.
- The busy (model working) footer has not been verified with a live provider.

## Verification record

Verified live against cline 3.0.65 (npm, darwin-arm64) in an isolated prefix and
scratch `HOME`, with a dummy provider key (no real account): `--help`, TUI
screens (sign-in, notice modals, home, chat), `--auto-approve true|false`
footer, `-m` persisting into `providers.json`, `CLINE_MODEL` having no effect on the TUI, `CLINE_DISABLE_CLINE_PASS_NOTICE`,
lazy session creation, the session metadata layout, `--id` resume with history,
the unknown-session error, the alternate screen under `exec` launch, and the per-seat hub (its own hub process, discovery file, and port with `CLINE_HUB_DISCOVERY_PATH` plus `CLINE_HUB_PORT`, `--id` resume through it, SIGTERM and `/shutdown` exits, and the shared hub left untouched). The skills and rules search paths were read from
the bundled source. The pane fixtures used in tests are these live captures, including 80x24
captures (OpenRig's pane size) with a long cwd: home, resumed chat, sign-in,
a notice modal, and the unknown-session error. Cline lays its TUI out to the
pane width, so no pattern text wraps at 80 columns.
