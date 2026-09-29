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

Cline's shared background hub daemon writes these files, not the TUI process,
and the metadata carries nothing seat-specific (its `pid` is the hub's), so a
session cannot be tied to one seat by pid or by a per-seat data dir. The match
is therefore guarded:

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

- Guidance: managed blocks merge into `AGENTS.md` in the seat cwd, the first
  workspace rules file Cline reads. `rig-role` content is delivered per seat
  instead, and teardown strips the managed blocks.
- Skills: projected into `<cwd>/.cline/skills/<skill>/`, one of Cline's
  workspace skill locations (alongside `.clinerules/skills` and `.agents/skills`).

## Known limits

- No per-seat model (see "Model selection"). All cline seats on a host share
  the operator's Cline provider and model.
- A cline session the operator starts by hand in a seat's cwd can be captured
  as that seat's resume token (see "Resume token").
- The pane's foreground process is `node` (the npm launcher). Discovery
  identifies Cline by the pane process tree's argv (`.../cline/bin/cline` or
  `.../bin/.cline`) instead of the pane command.
- Stop does not reap the pane's process tree. While a TUI runs, Cline's shared
  hub daemon is its child process, so reaping would kill the hub every Cline
  seat on the host uses. Killing the tmux session ends the TUI; the hub keeps
  running, as it does after an operator quits Cline (verified).
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
the unknown-session error, and the alternate screen under `exec` launch. The skills and rules search paths were read from
the bundled source. The pane fixtures used in tests are these live captures, including 80x24
captures (OpenRig's pane size) with a long cwd: home, resumed chat, sign-in,
a notice modal, and the unknown-session error. Cline lays its TUI out to the
pane width, so no pattern text wraps at 80 columns.
