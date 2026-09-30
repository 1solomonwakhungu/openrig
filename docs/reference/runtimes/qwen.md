# Qwen Code runtime (`runtime: qwen`)

OpenRig runs [Qwen Code](https://github.com/QwenLM/qwen-code) as an interactive TUI in the seat's tmux pane. Qwen Code is a fork of Gemini CLI and shares most of the OpenRig adapter with the `gemini` runtime. Verified against Qwen Code 0.24.7.

## Install

```bash
npm install -g @qwen-code/qwen-code@latest   # Node 22+
qwen --version
```

`brew install qwen-code` also works. `rig` preflight probes `qwen --version` and, when the binary is missing, fails with the install hint `npm install -g @qwen-code/qwen-code@latest`. The runtime verifier also checks that `node` on PATH is version 22 or later.

## Auth

The Qwen OAuth free tier was discontinued on 2026-04-15. Configure a model provider instead; Qwen Code picks the first match of:

1. `--auth-type` (OpenRig does not pass it),
2. `security.auth.selectedType` in `~/.qwen/settings.json` (or `modelProviders`),
3. environment variables, where each provider needs all of its variables:
   - OpenAI-compatible: `OPENAI_API_KEY` + `OPENAI_BASE_URL` + (`OPENAI_MODEL` or `QWEN_MODEL`)
   - Anthropic: `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`
   - Gemini: `GEMINI_API_KEY` + `GEMINI_MODEL`
   - Alibaba ModelStudio / DashScope: configure through `qwen` once (`/auth`).

The seat inherits the tmux pane environment. OpenRig never writes auth settings. A seat that reaches the "Connect a Provider" dialog, or still points at the discontinued Qwen OAuth tier, reports `attention_required` with code `login_required` and pane evidence.

## Rig spec

```yaml
members:
  - id: coder
    agent_ref: "local:agents/coder"
    profile: default
    runtime: qwen
    cwd: "."
    model: qwen3-coder-plus
    restore_policy: resume_if_possible
```

## Model

`model` is passed as `--model <value>`. Omit it to use Qwen Code's own default (`model.name` in settings, then the provider's model variable).

## Launch posture

| OpenRig posture | Flags |
|---|---|
| floor (default) | `--approval-mode auto-edit`: file edits are auto-approved, shell commands and other tools still ask |
| `full_bypass` (YOLO, or a `full_bypass` permission policy) | `--yolo`: every tool call is auto-approved |

OpenRig records the approval mode it passed (`auto-edit` or `yolo`) as the seat's applied-launch observation (axis `permission`). When the seat has a permission policy (member or rig), permission drift compares the posture that mode implies with the policy's posture and reports `aligned` or `drift`; with no policy attached it reports `unknown`. This checks the launch arguments OpenRig emitted, not the CLI's own enforcement.

OpenRig always passes an approval mode because Qwen Code's own default is `auto`, where a model classifier decides which tool calls run. Note the hyphenated `auto-edit` (Gemini CLI spells it `auto_edit`).

Qwen Code has no flag to trust a folder for one session. Folder trust is off by default (`security.folderTrust.enabled: false`), so seats start normally and OpenRig writes nothing. If you enable it, OpenRig adds the seat cwd as `TRUST_FOLDER` to `~/.qwen/trustedFolders.json` (or `$QWEN_CODE_TRUSTED_FOLDERS_PATH`) before launch. The edit is merge-only and atomic: an existing entry for the cwd, including `DO_NOT_TRUST`, is never changed, and an unparseable file is left alone; in those cases the seat reports `attention_required` with code `trust_gate`. This matches the Claude Code adapter, which pre-accepts its trust dialog for the managed cwd. In an untrusted folder Qwen Code skips the cwd `QWEN.md` and downgrades `--yolo`.

The command OpenRig types into the pane (each argument shell-quoted; `exec` makes Qwen Code replace the launch shell):

```bash
exec 'qwen' '--model' 'qwen3-coder-plus' '--approval-mode' 'auto-edit' '--session-id' '<uuid>'
```

No positional prompt is ever passed: `qwen "text"` runs one shot and exits.

## Startup dialogs

- "Welcome back!": Qwen Code shows it on every launch, resume included, in a cwd that has `.qwen/PROJECT_SUMMARY.md` (only the `/summary` command writes that file). When the file exists, OpenRig sets `ui.enableWelcomeBack: false` in the cwd's `.qwen/settings.json` before launch (merge-only and atomic; an existing `ui.enableWelcomeBack` value is kept). If the dialog shows anyway, the launch fails fast with `attention_required`, code `startup_dialog`, and pane evidence.
- IDE connection nudge: Qwen Code only offers it when `TERM_PROGRAM=vscode` or the CLI runs under an IDE process. tmux sets `TERM_PROGRAM=tmux` and detaches from the starting terminal, so it does not appear in seats. Qwen Code has no terminal keybinding prompt (Gemini CLI's is not in the fork).
- Content-triggered dialogs fail fast with `attention_required`, code `startup_dialog`, and pane evidence: "Command Format Migration" (legacy `.toml` commands in `.qwen/commands` or `~/.qwen/commands`), project MCP server approval ("Approve this server"), and "Built-in Provider Update".

## Readiness

- Ready: the composer placeholder `Type your message or @path/to/file`.
- Attention gates: folder trust dialog (`trust_gate`), provider dialog or discontinued-OAuth notice (`login_required`).
- A pane back at a shell is never ready, even if old ready text is still in scrollback.
- Launch waits a bounded time, then reports `attention_required` with pane evidence.

## Resume

OpenRig mints a UUID (version 4) for each fresh seat and launches with `--session-id <uuid>`, so the token is known up front. Restore relaunches with `--resume <uuid>`.

Qwen Code writes `<id>.runtime.json` at launch but writes the conversation file `<id>.jsonl` only on the first message. The resume refresher and restore report the minted id as the seat's token only once `<id>.jsonl` exists (the same test the precheck uses). A seat that stopped at a gate before its launch finished therefore has no token and restores fresh; a seat that reached ready but was never prompted holds the minted id from launch, and restore stops for a decision (`retry_fresh`). A fork child is reported only once its conversation file exists. Before typing a resume command, OpenRig checks for `projects/<cwd with non-alphanumerics as "-">/chats/<id>.jsonl` under each possible runtime base (`QWEN_RUNTIME_DIR`, settings `advanced.runtimeOutputDir`, `QWEN_HOME`, `~/.qwen`). A missing conversation is refused with `retry_fresh`, never started fresh silently. If Qwen Code itself reports `No saved session found with ID ...` (exit 1), OpenRig also returns `retry_fresh`.

## Fork

Supported for `session_source` with `ref.kind: native_id` and the parent session UUID. OpenRig launches `qwen --resume <parent> --fork-session`. Qwen Code picks the child id at random (it rejects `--session-id` together with `--resume`), so OpenRig captures it afterwards from the one `<id>.runtime.json` in the cwd's chats directory that started after the launch. The capture runs after readiness and again from the periodic resume refresher. If another qwen seat also launched in the same cwd after the fork, the capture finds more than one candidate and records no token rather than guess; the seat still runs.

## Guidance and skills

- Guidance: OpenRig merges managed blocks into `QWEN.md` in the seat cwd. Qwen Code reads `QWEN.md` and `AGENTS.md` by default; `QWEN.md` keeps OpenRig's blocks separate from Codex and Pi seats that share the cwd `AGENTS.md`. `rig-role` content is delivered per seat through the pane, not merged. Rig teardown removes OpenRig's managed blocks from `QWEN.md`.
- Skills: projected into `<cwd>/.qwen/skills/<name>/SKILL.md`, a project skills location Qwen Code discovers.

## Stop

Qwen Code exits cleanly when its tmux session is killed (verified live), so OpenRig does not reap its process tree. Stopping never relies on keystrokes.

## Self-update

Qwen Code checks npm on launch and, unless `general.enableAutoUpdate` is `false`, updates itself in the background (`npm install -g @qwen-code/qwen-code@latest` for a global npm install, or the standalone installer for a standalone install). There is no flag or environment variable for this. OpenRig applies two seat-scoped layers, and writes nothing the operator owns:

- Every managed launch points `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at a seat-owned copy of the operator's system-defaults file (read-only copy when one exists) with `general.enableAutoUpdate: false`, so Qwen Code does not download at all. System defaults are the lowest settings layer, so an explicit `general.enableAutoUpdate: true` in your own `~/.qwen/settings.json` re-enables updates for seats.
- Every launch also sets `NPM_CONFIG_PREFIX` and `npm_config_prefix` to the seat's own `<OPENRIG_HOME>/state/qwen/<seat>/npm-global`, so a global npm self-update (if re-enabled) lands there and never in the operator's prefix; `NPM_CONFIG_CACHE` points at the seat's own `npm-cache`, so `~/.npm` is untouched.
- Project-local installs only print an update message. pnpm, yarn, and bun global installs and the standalone installer are outside the npm prefix; the defaults layer above keeps them from updating. If your own settings re-enable updates, set `general.enableAutoUpdate` back to `false` in `~/.qwen/settings.json`: OpenRig only detects such an update ("Attempting to automatically update now..." reports `attention_required`, code `self_update`, with pane evidence) and cannot prevent it once Qwen Code has started the install.

## Known limits

- The pane process is `node`, so seat identity comes from the process arguments (`.../qwen`), never from the process name alone.
- Ready detection matches the English placeholder. With a non-English UI language, readiness times out with pane evidence.
- Session ids must be UUID versions 1 to 5; Qwen Code treats anything else given to `--resume` as a session title.

## What was verified live

With Qwen Code 0.24.7 in an isolated tmux server, a throwaway `HOME`, and a fake OpenAI-compatible key pointed at a closed local port (no account login):

- `--help` and `--version` output.
- The "Connect a Provider" dialog, the folder trust dialog (with folder trust enabled), and the default `auto` approval mode notice.
- The ready screen in `auto-edit` and `--yolo` modes.
- `--session-id` writing `<id>.runtime.json` at launch and no `<id>.jsonl` before a message, and `--resume <id>` on such a session exiting 1 with `No saved session found with ID ...`.
- The pane process name (`node`) and process arguments.

Everything else (fork child id, context files, skills paths, runtime base resolution, trust downgrade) comes from the Qwen Code 0.24.7 source.
