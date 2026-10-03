# review-pair

A Claude Code builder with an independent GitHub Copilot CLI reviewer.

| Seat | Runtime | Agent |
|---|---|---|
| `dev.builder` | `claude-code` | development/implementer |
| `dev.reviewer` | `copilot` | review/independent-reviewer |

## Before `rig up`

- **claude** on `PATH` and signed in.
- **copilot** on `PATH` (`npm install -g @github/copilot`, or `brew install --cask copilot-cli`). Sign in once with `copilot login`, or export `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`; a fine-grained token needs the "Copilot Requests" permission) in the environment the daemon starts seats from. See `docs/reference/runtimes/copilot.md`.

A seat that is missing its CLI or sign-in stops at `attention_required` with the reason, rather than starting.

Neither seat sets `model:`, so each CLI uses its default model. Set `model:` per member to choose.
