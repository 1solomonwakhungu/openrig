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
        model: claude-sonnet-4-5
        cwd: "."
    edges: []
```

## Launch mapping

| OpenRig | Cline |
|---|---|
| launch | `cline --auto-approve false` (typed into the pane; no prompt argument, which would run one-shot) |
| `model` | `-m <model>` for the provider chosen with `cline auth`. The value is passed as is, so OpenRouter-style ids such as `anthropic/claude-sonnet-4.5` work. |
| floor posture | `--auto-approve false`. Cline defaults auto-approve to **true**, so the floor always passes `false` explicitly. |
| full_bypass posture (`OPENRIG_YOLO=1` or a full-bypass permission policy) | `--auto-approve true`. The hidden `--yolo` flag is never used because it forces headless output. |
| resume | `--id <session id>` |
| fork | refused: Cline has no fork primitive |
| launch env | `CLINE_DISABLE_CLINE_PASS_NOTICE=1` (suppresses launch notice modals, which swallow the first keystroke and open a browser on Enter) and `CLINE_NO_AUTO_UPDATE=1` (releases up to 3.0.54 killed live sessions when they auto-updated) |

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
so they cannot be tied to one seat by pid or by a per-seat data dir. When two
matching sessions exist (two Cline seats in the same cwd, or one seat that
started a second task before capture ran), capture records nothing rather than
guess.

## Guidance and skills

- Guidance: managed blocks merge into `AGENTS.md` in the seat cwd, the first
  workspace rules file Cline reads. `rig-role` content is delivered per seat
  instead, and teardown strips the managed blocks.
- Skills: projected into `<cwd>/.cline/skills/<skill>/`, one of Cline's
  workspace skill locations (alongside `.clinerules/skills` and `.agents/skills`).

## Known limits

- `-m` persists: Cline saves the chosen model as the provider's default in
  `~/.cline/data/settings/providers.json`. A seat with `model:` changes the
  default model for later Cline runs that use the same provider. `CLINE_MODEL`
  has no effect on the TUI (verified), so no non-persisting alternative exists.
- The pane's foreground process is `node` (the npm launcher), which is too broad
  to identify Cline. Pane-command fingerprinting is not used.
- The busy (model working) footer has not been verified with a live provider.

## Verification record

Verified live against cline 3.0.65 (npm, darwin-arm64) in an isolated prefix and
scratch `HOME`, with a dummy provider key (no real account): `--help`, TUI
screens (sign-in, notice modals, home, chat), `--auto-approve true|false`
footer, `-m` display and persistence, `CLINE_DISABLE_CLINE_PASS_NOTICE`,
lazy session creation, the session metadata layout, `--id` resume with history,
and the unknown-session error. The skills and rules search paths were read from
the bundled source. The pane fixtures used in tests are these live captures.
