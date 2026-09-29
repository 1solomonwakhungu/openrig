# Grok Build (`grok`)

Runtime id: `grok`. Adapter: `packages/daemon/src/adapters/cli/grok/index.ts`.

## Install and auth

- Install: `curl -fsSL https://x.ai/cli/install.sh | bash` (installs `~/.grok/bin/grok`), or `npm i -g @xai-official/grok`. Preflight probes `grok --version` and shows this install hint when it fails.
- Auth: `grok login` (browser or `--device-auth`), stored in `~/.grok/auth.json`; `XAI_API_KEY` is the API-key fallback. Login-based use needs a SuperGrok or X Premium+ subscription. Sign in once for the account the daemon runs as; a seat that reaches the sign-in screen reports `login_required`.

## Rig spec

```yaml
members:
  - id: impl
    agent_ref: local:agents/impl
    profile: default
    runtime: grok
    model: grok-4        # optional; passed as --model
    cwd: .
```

## Launch

The seat runs `exec env GROK_DISABLE_AUTOUPDATER=1 BROWSER=true grok --no-alt-screen --trust [--model <m>] <posture> --session-id <uuid>`.

| Setting | Flag |
|---|---|
| Model | `--model <id>` from the member's `model` |
| Posture `floor` | `--permission-mode acceptEdits` |
| Posture `full_bypass` (policy or `OPENRIG_YOLO`) | `--always-approve` |
| Output | `--no-alt-screen`, so output stays in pane scrollback for transcripts and `rig capture` |
| Folder trust | `--trust` records trust for the seat cwd (same role as the Claude adapter's trust acceptance) |
| Updates | `GROK_DISABLE_AUTOUPDATER=1` |
| Browser | `BROWSER=true`, so sign-in never opens a tab on the operator's desktop; the device code shows in the pane |

## Resume and fork

- The adapter mints the session UUID (`--session-id`) before launch, so the resume token is known at readiness and never confused with another seat in the same cwd.
- Resume: `--resume <uuid>`. Before typing, the adapter checks that `~/.grok/sessions/<cwd group>/<uuid>/` exists (`GROK_HOME` overrides `~/.grok`); a missing session returns `retry_fresh`, so restore stops and asks instead of starting fresh. `No session found with id` in the pane maps to the same outcome.
- Fork: `--resume <parent> --fork-session --session-id <new uuid>` (member `session_source` with `ref.kind: native_id`). The new id is the seat's token; the parent is never reported.
- Late capture (adoption, the resume-metadata refresher, restore) returns this seat's minted id from its `launch.json` once grok has written that session. Because it only ever returns the seat's own id, the descriptor is `captureIsSessionScoped`, and the sibling-seat guard does not block grok seats that share a cwd.

## Readiness

Patterns tolerate an 80x24 pane: words may be split by the TUI's own wrapping or by dialog-box borders (`adapters/cli/pane-phrase.ts`); `test/pane-80col.test.ts` holds 80-column fixtures (resumed session, long cwd, box-wrapped trust prompt, wrapped errors).

| Pane text | Result |
|---|---|
| `Build anything` (empty prompt placeholder) | ready |
| `Do you trust the contents of this directory?` | `trust_gate` |
| `Approve in your browser to finish signing in`, `Waiting for approval...`, `Paste your token here` | `login_required` |
| `No session found with id`, `No session found for current directory` | resume refused, `retry_fresh` |

## Guidance and skills

- Identity: the pane command is `grok`, but on macOS tmux reports the symlink target's name (`grok-<version>-macos-aarch64`), so discovery also matches the program path (`processMatch: "grok"`): `~/.grok/bin/grok` matches, and the installer's `~/.grok/bin/agent` symlink never does.
- Guidance merges as managed blocks into `<cwd>/AGENTS.md` (grok reads `AGENTS.md`, `AGENT.md`, and `CLAUDE.md` from the cwd up to the repo root), with the `rig-role` skip. Teardown removes the blocks.
- Skills project into `<cwd>/.grok/skills/`. grok loads project skills only for a trusted folder, which `--trust` provides.

## Known limits

- `--trust` persists folder trust in grok's own `trusted_folders.toml`.
- Admins can disable bypass mode; `--always-approve` is then refused by grok.
- grok's session store is shared across seats (`~/.grok`); only the minted id makes a seat's session unambiguous.

## Verified

Against grok 1.0.25 on macOS (2026-09-29):

- Live: `grok --help`; `grok --trust --version` parses the hidden `--trust` flag; one launch on an isolated tmux server (`tmux -L`) with a throwaway `HOME` showed the device-code sign-in screen (`Approve in your browser to finish signing in.`, `Waiting for approval...`), created `~/.grok/sessions/`, and left no grok process after `tmux kill-server` (so the adapter does not opt into process-tree reaping).
- From the binary's embedded docs and strings: session layout `~/.grok/sessions/<url-encoded cwd>/<session-id>/`, `-s/--session-id` semantics, the `Build anything` placeholder, the trust prompt, `No session found with id`, `GROK_DISABLE_AUTOUPDATER`, `GROK_FOLDER_TRUST`.
- Not verified live: the signed-in ready screen, resume, and fork (no account was used).
