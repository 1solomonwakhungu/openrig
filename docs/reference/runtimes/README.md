# Runtimes

The agent runtimes a rig spec member can declare with `runtime:`. Runtimes come
from the daemon's runtime registry
(`packages/daemon/src/domain/runtime-registry.ts`); third-party CLI runtimes
register in `packages/daemon/src/adapters/cli/index.ts`. See
`docs/as-built/architecture/adapters-and-runtimes.md`, "Adding a runtime
adapter", for how to add one.

One line per runtime, alphabetical by id:

- `aider`: [Aider](aider.md) (`aider`). Resume by per-seat chat history file, no fork, guidance via `--read AGENTS.md`.
- `antigravity`: Antigravity CLI (`agy`). Resume by conversation id (captured late), no fork, managed `AGENTS.md` blocks. [antigravity.md](antigravity.md)
- `claude-code`: Claude Code (`claude`). Resume, fork, managed `CLAUDE.md` blocks.
- `cline`: [Cline CLI](cline.md) (`cline`). Resume by session id (captured after the first prompt), no fork, no per-seat model, managed `AGENTS.md` blocks.
- `codex`: Codex (`codex`). Resume, fork, managed `AGENTS.md` blocks.
- `copilot`: GitHub Copilot CLI (`copilot`). Resume by minted session id, managed `AGENTS.md` blocks, `.agents/skills`. No fork. See [copilot.md](copilot.md).
- `cursor`: Cursor CLI (`cursor-agent`). Resume by captured chat id, managed `AGENTS.md` blocks, `.agents/skills`. No fork. See [cursor.md](cursor.md).
- `gemini`: Gemini CLI (`gemini`). Resume by minted session id, managed `GEMINI.md` blocks, `.gemini/skills`. No fork. See [gemini.md](gemini.md).
- `goose`: [Goose](goose.md) (`goose`). Resume by session id read from goose's sessions database, fork via `--fork`, managed `AGENTS.md` blocks, `.agents/skills`.
- `grok`: Grok Build (`grok`). Resume and fork by minted session id, managed `AGENTS.md` blocks. [grok.md](grok.md)
- `kilo`: Kilo CLI (`kilo`), an OpenCode fork. Resume by session id from a per-seat session database, managed `AGENTS.md` blocks, `.kilo/skills`. No fork. See [kilo.md](kilo.md).
- `kiro`: [Kiro CLI](kiro.md) (`kiro-cli`). No resume (restore asks for `--fresh`), no fork, managed `AGENTS.md` blocks, `.kiro/skills`. Readiness partly derived from binary strings; see the doc.
- `omp`: Oh My Pi (`omp`, the Pi RPC runner in the pane, ported from the upstream Oh My Pi runtime). Isolated per-seat state and HOME under `<OPENRIG_HOME>/state/omp/<seat>`, resume by session file once the file exists, fork, approval mode `always-ask` (floor) or `yolo` (full_bypass). See the `omp` notes in [rig-spec.md](../rig-spec.md).
- `opencode`: OpenCode (`opencode`). Resume by session id from a per-seat session database, managed `AGENTS.md` blocks, `.opencode/skills`. No fork. See [opencode.md](opencode.md).
- `pi`: Pi coding agent (`pi`, RPC runner in the pane). Resume by session file, fork.
- `qwen`: Qwen Code (`qwen`), a Gemini CLI fork. Resume by minted session id, managed `QWEN.md` blocks, `.qwen/skills`. Fork via `--fork-session`. See [qwen.md](qwen.md).
- `terminal`: a plain shell for infrastructure nodes (servers, log tails). Requires `agent_ref: builtin:terminal` and `profile: none`.

The internal `stub` runtime exists for OpenRig's own tests and is not listed.

## Check what is installed: `rig runtimes`

`rig runtimes` lists every runtime above with whether its CLI is installed (and its version), whether it is signed in, resume and fork support, and its guidance file, then says how to install or sign in where something is missing. `--json` prints the same rows for agents. `rig doctor` adds a warn-only line per installed runtime (a CLI that is installed but not signed in warns; a CLI that is not installed is only noted), and `rig setup` lists them after its steps.

The checks are local only: the version probe is `<binary> --version` (as preflight runs it), and sign-in is read from environment variable names and each CLI's own files. OpenRig never logs in, never reads the OS keychain, and never prints a key. `--probe` additionally runs a CLI's documented read-only status command where one exists (today: `cursor-agent --disable-auto-update status`; the flag keeps the probe from triggering Cursor's background self-update, which reinstalls and re-links the CLI about 2 s after start).

| Runtime | Signed in when | Otherwise |
|---|---|---|
| `opencode`, `kilo` | a provider key (Kilo also `KILO_API_KEY`), or a non-empty `<XDG_DATA_HOME or ~/.local/share>/<cli>/auth.json` | missing (the CLI still runs on its free models) |
| `gemini` | `security.auth.selectedType` is set in `.gemini/settings.json` (workspace, then `GEMINI_CLI_HOME` or `~/.gemini`) and its credential is set (`GEMINI_API_KEY`, or `GOOGLE_API_KEY` for Vertex AI) | missing; unknown for Google sign-in or Vertex application default credentials |
| `qwen` | a provider in `~/.qwen/settings.json`, or a complete provider env set | missing (also for the discontinued Qwen OAuth tier) |
| `copilot` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` | unknown (a `copilot login` session is in the keychain) |
| `cursor` | `CURSOR_API_KEY`, or `cursor-agent --disable-auto-update status` under `--probe` | unknown |
| `cline` | `CLINE_API_KEY`, or a non-empty `<CLINE_DATA_DIR or ~/.cline/data>/settings/providers.json` | missing |
| `aider` | a provider key in the env, or a `*_API_KEY=` line in `.env` (cwd or home) or `~/.aider/oauth-keys.env` | missing |
| `grok` | `XAI_API_KEY`, or `<GROK_HOME or ~/.grok>/auth.json` | missing |
| `goose` | a provider (`GOOSE_PROVIDER`, or `GOOSE_PROVIDER:` in `<XDG_CONFIG_HOME or ~/.config>/goose/config.yaml`) and its key in the env (or `secrets.yaml` with `GOOSE_DISABLE_KEYRING`) | missing without a provider; unknown when the key is in the system keychain |
| `antigravity` | `GEMINI_API_KEY` with `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json` | unknown (Google sign-in is in the OS keyring) |
| `claude-code`, `codex`, `pi`, `omp` | not checked | unknown |

## Model names

A member's `model:` is passed to its CLI as is. Preflight checks its form against the runtime's expected shape and, when it does not fit, prints one warning with an example; `rig up` continues. The shapes check the form of a name, not a list of current models. Built-in runtimes (`claude-code`, `codex`, `pi`, `omp`) are not checked.

| Runtime | Expected `model:` | Example |
|---|---|---|
| `opencode`, `kilo` | `provider/model` | `anthropic/claude-sonnet-5` |
| `gemini` | a `gemini-*` id, or an alias: `auto`, `pro`, `flash`, `flash-lite` | `pro` |
| `qwen` | a model id of the configured provider, without spaces | `qwen3-coder-plus` |
| `goose` | a model id of the configured goose provider (`GOOSE_PROVIDER`), without spaces | `claude-sonnet-4-5` |
| `copilot` | a Copilot model id without a provider prefix | `gpt-5.4` |
| `cursor` | a Cursor model id without a provider prefix (bracket overrides allowed) | `gpt-5` |
| `aider` | an aider alias or a provider model name | `sonnet` |
| `grok` | a `grok-*` id | `grok-4` |
| `antigravity` | a slug from `agy models` | `gemini-3.5-flash-medium` |
| `cline` | none: omit `model:` and set it with `cline auth <provider> -m <model>` | |

Why these third-party CLIs were chosen as adapter targets:
[`ai-coding-cli-selection.md`](ai-coding-cli-selection.md).

## Mixed-runtime rig templates

Ready-made specs that combine runtimes, listed by `rig specs` and launchable by name with `rig up <name>`. Each directory's `README.md` says which CLIs must be installed and signed in.

- `polyglot-dev`: builder on `opencode`, independent reviewer on `gemini` (`packages/daemon/specs/rigs/mixed/polyglot-dev`).
- `review-pair`: builder on `claude-code`, independent reviewer on `copilot` (`packages/daemon/specs/rigs/mixed/review-pair`).
- `budget-team`: builder on `opencode`, checker on `kilo`, both able to run on free models without signing in; without sign-in, prompts and code go anonymously to those free models, so do not use it on private code (`packages/daemon/specs/rigs/mixed/budget-team`).
