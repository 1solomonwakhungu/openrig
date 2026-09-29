# Runtimes

The agent runtimes a rig spec member can declare with `runtime:`. Runtimes come
from the daemon's runtime registry
(`packages/daemon/src/domain/runtime-registry.ts`); third-party CLI runtimes
register in `packages/daemon/src/adapters/cli/index.ts`. See
`docs/as-built/architecture/adapters-and-runtimes.md`, "Adding a runtime
adapter", for how to add one.

One line per runtime, alphabetical by id:

- `antigravity`: Antigravity CLI (`agy`). Resume by conversation id (captured late), no fork, managed `AGENTS.md` blocks. [antigravity.md](antigravity.md)
- `claude-code`: Claude Code (`claude`). Resume, fork, managed `CLAUDE.md` blocks.
- `codex`: Codex (`codex`). Resume, fork, managed `AGENTS.md` blocks.
- `gemini`: Gemini CLI (`gemini`). Resume by minted session id, no fork, managed `GEMINI.md` blocks. See [gemini.md](gemini.md).
- `grok`: Grok Build (`grok`). Resume and fork by minted session id, managed `AGENTS.md` blocks. [grok.md](grok.md)
- `kilo`: Kilo CLI (`kilo`), an OpenCode fork. Resume by session id from a per-seat session database, managed `AGENTS.md` blocks, `.kilo/skills`. No fork. See [kilo.md](kilo.md).
- `opencode`: OpenCode (`opencode`). Resume by session id from a per-seat session database, managed `AGENTS.md` blocks, `.opencode/skills`. No fork. See [opencode.md](opencode.md).
- `pi`: Pi coding agent (`pi`, RPC runner in the pane). Resume by session file, fork.
- `qwen`: Qwen Code (`qwen`). Resume by minted session id, fork, managed `QWEN.md` blocks. See [qwen.md](qwen.md).
- `terminal`: a plain shell for infrastructure nodes (servers, log tails). Requires `agent_ref: builtin:terminal` and `profile: none`.

The internal `stub` runtime exists for OpenRig's own tests and is not listed.

Why these third-party CLIs were chosen as adapter targets:
[`ai-coding-cli-selection.md`](ai-coding-cli-selection.md).
