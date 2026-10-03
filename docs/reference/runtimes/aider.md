# Aider runtime (`runtime: aider`)

OpenRig runs [Aider](https://aider.chat) as an interactive chat in the seat's
tmux pane.

## Install and auth

```bash
python -m pip install aider-install && aider-install
# or
uv tool install --python 3.12 aider-chat
```

Aider 0.86.x fails to start on Python 3.13 or later (`No module named 'pyaudioop'`),
so pin Python 3.12 when installing with `uv` or `pipx`. Preflight checks
`aider --version`.

Aider authenticates with provider environment variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and others), a `.env`
file, or `.aider.conf.yml`. Set the key in the environment the seat's pane
inherits. A seat whose model has no key reports `login_required`.

## Rig spec

```yaml
pods:
  - id: dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: aider
        model: sonnet
        cwd: "."
    edges: []
```

## Launch mapping

Every launch passes:

```
PIP_REQUIRE_VIRTUALENV=true \
aider --no-check-update --no-show-release-notes --no-analytics --no-gitignore \
  --disable-playwright \
  --chat-history-file <seat state>/aider.chat.history.<launch id>.md \
  --input-history-file <seat state>/aider.input.history \
  --read AGENTS.md
```

where `<seat state>` is `$OPENRIG_HOME/state/aider/<session name>`.

| OpenRig | Aider |
|---|---|
| `model` | `--model <model>` (aliases such as `sonnet` work) |
| floor posture | no auto-approve flag: every aider confirmation waits for an answer |
| full_bypass posture (`OPENRIG_YOLO=1` or a full-bypass permission policy) | `--yes-always`, plus `BROWSER=true` in the launch env. `--yes-always` also accepts aider's "Open documentation url?" offers, and `BROWSER=true` makes those a no-op so a seat never opens a browser. Never passed when the seat declares no `model:`; for an `openrouter/` model the pane's own shell adds it only when `OPENROUTER_API_KEY` is set in the pane env. Otherwise aider offers an OpenRouter sign-in that `--yes-always` would accept unattended (see "OpenRouter onboarding"). |
| resume | `--restore-chat-history` with the persisted history file |
| fork | refused: Aider has no fork primitive |

Under full_bypass OpenRig records `yes-always` as the seat's applied-launch observation (axis `permission`); when the seat has a permission policy, permission drift compares the posture it implies with the policy's posture and reports `aligned` or `drift`. The floor passes no permission flag (`--yes-always` has no negation, so `.aider.conf.yml` or `AIDER_YES_ALWAYS` could still turn it on), so its observation is `unknown` and never compared. This checks the launch arguments OpenRig emitted, not aider's own enforcement.

All flags are session-scoped. None writes global aider config. For example,
`--analytics-disable` is avoided because it persists. `--no-gitignore` stops aider
from offering to add `.aider*` to the repo's `.gitignore`; the seat's history
files live in the seat state dir, not the repo.

### Self-update and auto-install

Aider can install software from inside a session, and `--yes-always`
(full_bypass) accepts every offer without asking:

| Offer | When | Managed seat |
|---|---|---|
| `pip install --upgrade aider-chat` (self-update) | launch, when the update check runs | `--no-check-update` skips the check entirely |
| `pip install boto3` / `google-cloud-aiplatform` | launch, for `bedrock/` and `vertex_ai/` models missing the package | `PIP_REQUIRE_VIRTUALENV=true` |
| `pip install aider-chat[playwright]` plus `playwright install --with-deps chromium` | `/web` or a URL in chat | `--disable-playwright` (scraping falls back to plain HTTP) |
| `pip install aider-chat[help]` | `/help` | `PIP_REQUIRE_VIRTUALENV=true` |

`PIP_REQUIRE_VIRTUALENV=true` makes pip refuse to install outside a virtualenv,
so an accepted install can only touch aider's own tool environment (uv and pipx
installs are virtualenvs), never the owner's global or Homebrew Python. A uv tool
install ships no pip at all, so those installs fail harmlessly there. None of
these knobs writes owner config.

The variable is inherited by commands aider runs in the pane (for example
`/run pip install ...`), so a global `pip install` from inside an aider seat is
refused too; install into a virtualenv, or run it outside the seat.

## Readiness

- Ready: aider's prompt (`> `, or `<edit format>> ` such as `architect> `,
  `ask> `, `multi> `) is the last text in the pane and the pane is not at a
  shell. Quoted chat output (`> ...`) is not mistaken for the prompt.
- `login_required`: `<model> expects these environment variables ... - <KEY>: Not set`.
- `login_required`: aider's OpenRouter onboarding (`No LLM model was specified and no API keys were provided.`, `Login to OpenRouter or create a free account?`, or an `openrouter/` model that `requires an OpenRouter API key`).
- `trust_gate`: `No git repo found, create one to track aider's changes?`, or any
  other `(Y)es/(N)o` confirmation left pending at the bottom of the pane.
  Under full_bypass, `--yes-always` answers these itself (including creating the
  git repo).

## Resume token

Resume type `aider_chat_history_file`: the absolute path of a chat history
file in the seat state dir. Aider has no session ids; its only continuation is
replaying that file with `--restore-chat-history`.

Every fresh launch gets a new file, `aider.chat.history.<launch id>.md`, minted
before launch and reported as the launch's resume token. A fresh start therefore
stays fresh: a later restore replays only the conversation since that launch,
never one from before it. A resume keeps writing to the file it restored.
Earlier files stay in the seat state dir until the seat is removed.

The file counts as resumable only once it holds a real exchange (a user
message, written as a `#### ` line), as for Gemini and Qwen. Late capture waits
for one, and the resume precheck refuses a file without one. A seat that never
got a prompt is therefore never resumed: restore stops at awaiting-decision and
asks for an explicit `--fresh`; it does not start fresh on its own.

If the file is gone at resume time, or has no exchange, the resume reports
`retry_fresh` (stop and ask), because restoring it would silently start an empty
chat.

## OpenRouter onboarding

With no `--model` and no provider key, aider offers `Login to OpenRouter or
create a free account?`; accepting runs an OAuth sign-in (a local callback
server, then a key saved to `~/.aider/oauth-keys.env`). It makes the same offer
for an `openrouter/` model when `OPENROUTER_API_KEY` is missing. Aider has no
flag or setting that disables this, so under full_bypass:

- With no `model:`, OpenRig never passes `--yes-always` (the permission
  observation is `unknown`, reason `yes_always_withheld_onboarding`).
- With an `openrouter/` model, the key can come from the pane's shell (for
  example its rc files), which the daemon cannot see. The launch runs through
  `sh -c`, and the pane's shell adds `--yes-always` only when its own
  `OPENROUTER_API_KEY` is non-empty (the observation is `unknown`, reason
  `yes_always_decided_in_pane`).
- With any other model, `--yes-always` is passed as usual.

The same applies when a seat's posture comes from `rig seat set-permissions
<seat> --mode full_bypass`: the selection makes the seat full_bypass, but
`--yes-always` is still withheld while OpenRouter onboarding could fire (no
`model:`), as described above.

When the offer does appear, it waits in the pane as a `login_required` gate for
the operator. Declare `model:` and the provider key in the seat env to get
`--yes-always`.

## Guidance and skills

- Guidance: aider does not read `AGENTS.md` (or any instruction file) on its
  own. Managed blocks merge into `AGENTS.md` in the seat cwd as for other
  runtimes, and every launch passes `--read AGENTS.md` so aider loads it as
  read-only context. If the file does not exist yet, aider prints
  `Read-only file ... does not exist. Skipping.` and continues. `rig-role`
  content is delivered per seat, and teardown strips the managed blocks.
- Skills: aider has no skills location, so skill projection is an honest skip.

## Usage

Usage (`rig ps`): the `Tokens: ... Cost: ...` lines aider writes to the chat history. Token counts are rounded by aider (`2.1k`) and marked approximate; the cost is what aider printed (`cli_reported`), so COST shows it unmarked; the session cost restarts per aider process and is summed per segment.

## Context alerts

Context-pressure alerts use the same `context.pressure` health detector and operator thresholds as claude and codex (`health.context_pressure.warning_percent` and `critical_percent`, default 95 and 99). They need a context percentage, which exists only when the CLI reports its context window. OpenRig never compacts a CLI seat: it does not type into a live CLI. aider prints no context window, so seats never alert. aider summarizes older chat history on its own (`ChatSummary`).

## Known limits

- The pane's foreground process is the Python interpreter (`Python` on macOS).
  Discovery identifies aider by the pane process tree's argv (the `aider` entry
  script, or `python -m aider`) instead of the pane command.
- A launch where `aider` is not on the pane's PATH, or that hits the Python 3.13
  `audioop` import error, fails fast with `attention_required`.
- `--restore-chat-history` replays the transcript into the model context; very
  long histories are summarized by aider, so a resumed seat may not see every
  earlier detail.
- Aider still prints its git identity hint (`Update git name with ...`) when
  the repo has no user.name/email; it is informational and does not block.

## Verification record

Verified live against aider 0.86.2 (installed with `uv tool install --python 3.12`
into an isolated prefix, scratch `HOME`, dummy key, no real account): `--help`,
the ready prompt, the missing-key warning and its doc-link confirmation, the
no-git confirmation, the missing `--read` file message, per-seat history files
written at startup, `--restore-chat-history` ("Restored previous conversation
history."), `BROWSER=true` neutralizing Python's `webbrowser.open`, and
`PIP_REQUIRE_VIRTUALENV=true` refusing a pip install into a global Python while
allowing one in a virtualenv. The install offers were read from `aider/versioncheck.py`,
`models.py`, `scrape.py`, and `help.py`. Prompt
and confirmation formats were also read from `aider/io.py`. The pane fixtures
used in tests are these live captures, including 80x24 captures (OpenRig's pane
size) with a long cwd: ready, resumed, missing key, and the no-git question,
which hard-wraps at 80 columns (`...(Y)es/(N)o` / ` [Yes]:`). Confirmation
patterns tolerate a wrap at any column.
