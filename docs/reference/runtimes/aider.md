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
aider --no-check-update --no-show-release-notes --no-analytics --no-gitignore \
  --chat-history-file <seat state>/aider.chat.history.<launch id>.md \
  --input-history-file <seat state>/aider.input.history \
  --read AGENTS.md
```

where `<seat state>` is `$OPENRIG_HOME/state/aider/<session name>`.

| OpenRig | Aider |
|---|---|
| `model` | `--model <model>` (aliases such as `sonnet` work) |
| floor posture | no auto-approve flag: every aider confirmation waits for an answer |
| full_bypass posture (`OPENRIG_YOLO=1` or a full-bypass permission policy) | `--yes-always`, plus `BROWSER=true` in the launch env. `--yes-always` also accepts aider's "Open documentation url?" offers, and `BROWSER=true` makes those a no-op so a seat never opens a browser. |
| resume | `--restore-chat-history` with the persisted history file |
| fork | refused: Aider has no fork primitive |

All flags are session-scoped. None writes global aider config. For example,
`--analytics-disable` is avoided because it persists. `--no-gitignore` stops aider
from offering to add `.aider*` to the repo's `.gitignore`; the seat's history
files live in the seat state dir, not the repo.

## Readiness

- Ready: aider's prompt (`> `, or `<edit format>> ` such as `architect> `,
  `ask> `, `multi> `) is the last text in the pane and the pane is not at a
  shell. Quoted chat output (`> ...`) is not mistaken for the prompt.
- `login_required`: `<model> expects these environment variables ... - <KEY>: Not set`.
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

If the file is gone at resume time, the resume reports `retry_fresh` (stop and
ask), because restoring from a missing file would silently start an empty chat.

## Guidance and skills

- Guidance: aider does not read `AGENTS.md` (or any instruction file) on its
  own. Managed blocks merge into `AGENTS.md` in the seat cwd as for other
  runtimes, and every launch passes `--read AGENTS.md` so aider loads it as
  read-only context. If the file does not exist yet, aider prints
  `Read-only file ... does not exist. Skipping.` and continues. `rig-role`
  content is delivered per seat, and teardown strips the managed blocks.
- Skills: aider has no skills location, so skill projection is an honest skip.

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
history."), and `BROWSER=true` neutralizing Python's `webbrowser.open`. Prompt
and confirmation formats were also read from `aider/io.py`. The pane fixtures
used in tests are these live captures, including 80x24 captures (OpenRig's pane
size) with a long cwd: ready, resumed, missing key, and the no-git question,
which hard-wraps at 80 columns (`...(Y)es/(N)o` / ` [Yes]:`). Confirmation
patterns tolerate a wrap at any column.
