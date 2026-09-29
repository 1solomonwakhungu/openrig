# Runtimes

The agent runtimes a rig spec member can declare with `runtime:`. Runtimes come
from the daemon's runtime registry
(`packages/daemon/src/domain/runtime-registry.ts`); third-party CLI runtimes
register in `packages/daemon/src/adapters/cli/index.ts`. See
`docs/as-built/architecture/adapters-and-runtimes.md`, "Adding a runtime
adapter", for how to add one.

One line per runtime, alphabetical by id:

- `claude-code`: Claude Code (`claude`). Resume, fork, managed `CLAUDE.md` blocks.
- `codex`: Codex (`codex`). Resume, fork, managed `AGENTS.md` blocks.
- `pi`: Pi coding agent (`pi`, RPC runner in the pane). Resume by session file, fork.
- `terminal`: a plain shell for infrastructure nodes (servers, log tails). Requires `agent_ref: builtin:terminal` and `profile: none`.

The internal `stub` runtime exists for OpenRig's own tests and is not listed.

Why these third-party CLIs were chosen as adapter targets:
[`ai-coding-cli-selection.md`](ai-coding-cli-selection.md).
