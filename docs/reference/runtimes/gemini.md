# Gemini CLI runtime (`runtime: gemini`)

OpenRig runs [Gemini CLI](https://github.com/google-gemini/gemini-cli) as an interactive TUI in the seat's tmux pane. Verified against Gemini CLI 0.61.0.

## Install

```bash
npm install -g @google/gemini-cli   # Node 20+
gemini --version
```

`rig` preflight probes `gemini --version` and, when the binary is missing, fails with the install hint `npm install -g @google/gemini-cli`. The runtime verifier also checks that `node` on PATH is version 20 or later. The Homebrew formula is frozen at 0.46.0 and deprecated; use npm.

## Auth

As of 2026-06-18, Google no longer serves Gemini CLI to free, Google AI Pro, or Ultra personal accounts. The CLI still offers "Sign in with Google", but the server refuses those logins. What still works:

- a Gemini API key (`GEMINI_API_KEY`), or
- Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true` plus `GOOGLE_API_KEY`, or `GOOGLE_CLOUD_PROJECT` with application default credentials), or
- Gemini Code Assist Standard or Enterprise.

Interactive Gemini CLI does **not** pick an auth method from the environment on its own. Until `security.auth.selectedType` is set in `~/.gemini/settings.json`, every launch opens the "Get started / How would you like to authenticate for this project?" dialog, even with `GEMINI_API_KEY` set. Choose once, before running seats:

```bash
gemini          # pick "Use Gemini API Key" (or Vertex AI), then /quit
```

or set it directly:

```json
{ "security": { "auth": { "selectedType": "gemini-api-key" } } }
```

OpenRig never writes auth settings. The seat inherits the tmux pane environment, so export the key where your rig's tmux server starts. A seat that reaches the auth dialog or the "Enter Gemini API Key" prompt reports `attention_required` with code `login_required` and the last pane lines as evidence.

## Rig spec

```yaml
members:
  - id: researcher
    agent_ref: "local:agents/researcher"
    profile: default
    runtime: gemini
    cwd: "."
    model: gemini-2.5-pro
    restore_policy: resume_if_possible
```

## Model

`model` is passed as `--model <value>`. Omit it to use Gemini CLI's own default (`GEMINI_MODEL`, then `model.name` in settings, then `auto`). Aliases such as `pro` and `flash` work.

## Launch posture

| OpenRig posture | Flags |
|---|---|
| floor (default) | `--approval-mode auto_edit`: file edits are auto-approved, shell commands and other tools still ask |
| `full_bypass` (YOLO, or a `full_bypass` permission policy) | `--yolo`: every tool call is auto-approved |

OpenRig records the approval mode it passed (`auto_edit` or `yolo`) as the seat's applied-launch observation (axis `permission`). When the seat has a permission policy (member or rig), permission drift compares the posture that mode implies with the policy's posture and reports `aligned` or `drift`; with no policy attached it reports `unknown`. This checks the launch arguments OpenRig emitted, not the CLI's own enforcement.

Every managed launch also passes `--skip-trust`. It trusts the seat's cwd for that session only and writes no config. Without it, Gemini CLI shows a folder trust dialog, and in an untrusted folder it ignores the cwd `GEMINI.md`, ignores project skills, and silently downgrades `--yolo` to the default mode. This matches the Claude Code adapter, which pre-accepts its trust dialog for the managed cwd.

The command OpenRig types into the pane (each argument shell-quoted; `exec` makes Gemini CLI replace the launch shell):

```bash
exec 'gemini' '--model' 'gemini-2.5-pro' '--approval-mode' 'auto_edit' '--skip-trust' '--session-id' '<uuid>'
```

## Launch environment and startup dialogs

The seat inherits the tmux pane environment (so `GEMINI_API_KEY` and friends reach the CLI). A tmux server passes the environment of the shell that started it to every pane, and two Gemini CLI first-run dialogs key off IDE-terminal variables:

- the IDE connection nudge ("Do you want to connect ... to Gemini CLI?"): `TERMINAL_EMULATOR` (JetBrains), `ZED_SESSION_ID`, `XCODE_VERSION_ACTUAL`, or `TERM_PROGRAM` of vscode, sublime, or Zed;
- the terminal keybinding prompt ("Gemini CLI works best with Shift+Enter/Ctrl+Enter ..."): `CURSOR_TRACE_ID`, `VSCODE_GIT_ASKPASS_MAIN`, `VSCODE_GIT_IPC_HANDLE`, or `TERM_PROGRAM=vscode`. Its preselected "Yes" rewrites the editor's `keybindings.json`.

OpenRig clears those variables for the launch and pins `TERM_PROGRAM=tmux` (what tmux sets in panes anyway). Nothing is written to config.

Other startup dialogs come from repo or owner content, not the environment. OpenRig does not answer them; the launch fails fast with `attention_required`, code `startup_dialog`, and pane evidence:

| Dialog | Trigger |
|---|---|
| New Agents Discovered | unacknowledged agents in the cwd's `.gemini/agents` (loaded because seats trust the cwd) |
| New or changed ... policies detected | new or changed policy files |
| Authentication required for MCP Server | a configured MCP server needs OAuth |
| Extension update consent | an installed extension update needs consent |

Trust and auth dialogs are covered under Launch posture, Auth, and Readiness. Dialogs that only open from slash commands (theme, settings, privacy, permissions) and in-session prompts (tool approvals, quota) are not launch-time.

## Readiness

- Ready: the composer placeholder `Type your message or @path/to/file`.
- Attention gates: folder trust dialog (`trust_gate`), auth dialog, API key prompt, or Google sign-in wait (`login_required`).
- A pane back at a shell is never ready, even if old ready text is still in scrollback.
- Launch waits a bounded time, then reports `attention_required` with pane evidence.

## Resume

OpenRig mints a UUID for each fresh seat and launches with `--session-id <uuid>`, so the resume token is known up front instead of guessed from files on disk (seats in the same cwd share one Gemini project directory). Restore relaunches with `--resume <uuid>`.

Before typing a resume command, OpenRig checks that the session file exists: it looks up the cwd's slug in `~/.gemini/projects.json` (or `$GEMINI_CLI_HOME/.gemini/`) and matches `tmp/<slug>/chats/session-*-<first 8 of id>.jsonl` whose first line carries the full id. A missing session is refused with `retry_fresh`, never started fresh silently.

Gemini CLI writes the session file at launch, but only treats it as resumable once it has a real message. Resuming a seat that never received a prompt makes Gemini print `Error resuming session: No previous sessions found for this project.` and exit 42; OpenRig detects that and returns `retry_fresh`.

## Fork

Not supported. Gemini CLI has no fork or branch-session primitive (`/rewind` and `/chat save` are in-session features). A `session_source` on a `gemini` member is refused with a clear error.

## Guidance and skills

- Guidance: OpenRig merges managed blocks into `GEMINI.md` in the seat cwd, the file Gemini CLI reads by default (it does not read `AGENTS.md` unless `context.fileName` says so). `rig-role` content is delivered per seat through the pane, not merged. Rig teardown removes OpenRig's managed blocks from `GEMINI.md`.
- Skills: projected into `<cwd>/.gemini/skills/<name>/SKILL.md`, a project skills location Gemini CLI discovers in trusted folders (see Launch posture).

## Self-update

Gemini CLI checks npm on launch and, unless `general.enableAutoUpdate` is `false`, updates itself in the background with the install command for how it was installed. For a global npm install that is `npm install -g @google/gemini-cli@latest`, which from a seat would write the operator's npm global prefix. There is no flag or environment variable that turns this off, Gemini CLI skips any system settings or system-defaults file not owned by root, and it ignores the key in workspace settings, so OpenRig contains the update instead:

- Every managed launch (fresh and resume) sets `NPM_CONFIG_PREFIX` and `npm_config_prefix` to the seat's own `<OPENRIG_HOME>/state/gemini/<seat>/npm-global`. A self-update's `npm install -g` lands there, and `NPM_CONFIG_CACHE` points at the seat's own `npm-cache`, so `~/.npm` is untouched too. The seat keeps running the operator's installed `gemini`, and the operator's prefix is untouched (verified live: 0.61.0 in the operator prefix stayed 0.61.0 while the update wrote 0.62.0 under the seat prefix). The same prefix applies to any `npm install -g` the agent itself runs in the seat.
- Gemini CLI still reports "Update successful! The new version will be used on your next run", but the next run uses the operator's binary again, so an out-of-date install downloads the update on every launch. To stop seat downloads entirely, set `"general": { "enableAutoUpdate": false }` in your own `~/.gemini/settings.json`.
- Homebrew, npx, and project-local installs only print an update message; they never run an install.
- **Volta, pnpm, yarn, or bun global installs: set `"general": { "enableAutoUpdate": false }` in your own `~/.gemini/settings.json`.** Those tools update the install directly and the npm prefix cannot contain them. OpenRig only detects such an update: when a seat's pane shows "Installed with Volta/pnpm/yarn/bun. Attempting to automatically update now...", the launch or readiness check reports `attention_required` with code `self_update` and pane evidence. By then Gemini CLI has already started the install, so the detection does not prevent it.

## Stop

The `gemini` launcher is a small parent process that ignores SIGHUP and SIGTERM and waits for the real CLI child, which does not finish its SIGHUP cleanup once the pane is gone. Both processes outlive `tmux kill-session` (verified live). OpenRig therefore reaps the pane's process tree when it stops a `gemini` seat: it records the pane's processes before killing the session, sends SIGTERM to that process group, and SIGKILL to anything left. Stopping never relies on typing Ctrl-C into the pane.

## Known limits

- The pane process is `node`, so seat identity comes from the process arguments (`.../gemini`), never from the process name alone.
- The resume precheck reads `projects.json` from the daemon's view of `GEMINI_CLI_HOME`. If the pane environment sets a different `GEMINI_CLI_HOME`, the check can refuse a session that exists.
- Gemini CLI may print an update notice; it does not block the prompt.

## What was verified live

With Gemini CLI 0.61.0 in an isolated tmux server, a throwaway `HOME`, and a fake API key (no account login):

- `--help` and `--version` output.
- The folder trust dialog, the auth dialog (with and without `GEMINI_API_KEY`), and the API key prompt.
- The ready screen in `auto_edit` and `--yolo` modes.
- `--session-id` writing `chats/session-<timestamp>-<id8>.jsonl` at launch, and `--resume <id>` on a message-less session exiting 42 with the error above.
- The pane process name (`node`) and process arguments.

Everything else (context file rules, skills paths, `--resume` UUID matching, `--session-id`/`--resume` exclusivity, trust downgrade) comes from the Gemini CLI 0.61.0 source.
