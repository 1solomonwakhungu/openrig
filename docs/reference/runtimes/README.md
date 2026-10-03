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
- `grok`: Grok Build (`grok`). Resume and fork by minted session id, managed `AGENTS.md` blocks. [grok.md](grok.md)
- `kilo`: Kilo CLI (`kilo`), an OpenCode fork. Resume by session id from a per-seat session database, managed `AGENTS.md` blocks, `.kilo/skills`. No fork. See [kilo.md](kilo.md).
- `omp`: Oh My Pi (`omp`, the Pi RPC runner in the pane, ported from the upstream Oh My Pi runtime). Isolated per-seat state and HOME under `<OPENRIG_HOME>/state/omp/<seat>`, resume by session file once the file exists, fork, approval mode `always-ask` (floor) or `yolo` (full_bypass). See the `omp` notes in [rig-spec.md](../rig-spec.md).
- `opencode`: OpenCode (`opencode`). Resume by session id from a per-seat session database, managed `AGENTS.md` blocks, `.opencode/skills`. No fork. See [opencode.md](opencode.md).
- `pi`: Pi coding agent (`pi`, RPC runner in the pane). Resume by session file, fork.
- `qwen`: Qwen Code (`qwen`), a Gemini CLI fork. Resume by minted session id, managed `QWEN.md` blocks, `.qwen/skills`. Fork via `--fork-session`. See [qwen.md](qwen.md).
- `terminal`: a plain shell for infrastructure nodes (servers, log tails). Requires `agent_ref: builtin:terminal` and `profile: none`.

The internal `stub` runtime exists for OpenRig's own tests and is not listed.

Why these third-party CLIs were chosen as adapter targets:
[`ai-coding-cli-selection.md`](ai-coding-cli-selection.md).

## Mixed-runtime rig templates

Ready-made specs that combine runtimes, listed by `rig specs` and launchable by name with `rig up <name>`. Each directory's `README.md` says which CLIs must be installed and signed in.

- `polyglot-dev`: builder on `opencode`, independent reviewer on `gemini` (`packages/daemon/specs/rigs/mixed/polyglot-dev`).
- `review-pair`: builder on `claude-code`, independent reviewer on `copilot` (`packages/daemon/specs/rigs/mixed/review-pair`).
- `budget-team`: builder on `opencode`, checker on `kilo`, both able to run on free models without signing in; without sign-in, prompts and code go anonymously to those free models, so do not use it on private code (`packages/daemon/specs/rigs/mixed/budget-team`).
