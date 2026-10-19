# Gemini CLI harness: resume and stuck cases

Reference notes for the community-harness plug-in contract discussion (mvschwarz/openrig#43). The maintainer asked for three things per harness: the status signals it exposes, how it resumes a conversation, and the cases where it gets stuck. This note covers Gemini CLI as the fork runs it today and what an ACP-based port would change.

The operator-facing runtime doc is [../runtimes/gemini.md](../runtimes/gemini.md). This note is the implementation view, with file and line references.

## Provenance

Every claim carries one of these tags:

- **[src]**: read from this fork's source or tests at commit `bbfd0902`. Nothing was run for this note; Gemini CLI was not installed or launched.
- **[fork-live 0.61.0]**: verified live by the fork earlier, against Gemini CLI 0.61.0 with a throwaway `HOME` and a fake API key. The evidence is the captured pane fixtures under `packages/daemon/test/fixtures/gemini-family/` and the "What was verified live" list in `docs/reference/runtimes/gemini.md`.
- **[comment 0.64.0]**: verified live in the earlier public comment on #43, against Gemini CLI 0.64.0 over ACP. The fork has no ACP code (no `session/prompt`, `request_permission`, or hook handling anywhere under `packages/daemon/src`).

Version skew: the pane patterns were taken from the 0.61.0 TUI source, the activity markers from Gemini CLI commit `fb972b2f` (v0.62), and the ACP signals from 0.64.0. The fork's patterns have not been checked against 0.64.0.

## What the adapter does today

Paths below are relative to `packages/daemon/src/adapters/cli/` unless they start with `packages/` or `src/domain/` (the latter means `packages/daemon/src/domain/`).

Gemini CLI runs as an interactive TUI in the seat's tmux pane. OpenRig types a launch command into the pane, then reads the screen to decide what state the CLI is in. There is no protocol channel. **[src]**

- Registration: `gemini/index.ts:88-98` builds a `TuiCliRuntimeAdapter` (the shared TUI base in `tui-cli-runtime-adapter.ts`) from the Gemini-family spec in `gemini-family/runtime.ts:71-138`. The descriptor is `gemini/index.ts:43-86`.
- Launch argv: `gemini-family/launch-args.ts:89-113`. Always `--approval-mode auto_edit` (floor) or `--yolo` (full_bypass), always `--skip-trust` (`launch-args.ts:33-38`, `:100-102`), then exactly one of `--resume <id>` or `--session-id <id>`. A positional prompt is never passed.
- Launch env: `gemini/index.ts:33-41` blanks the IDE-terminal variables that open the IDE nudge and the keybinding consent dialog, and pins `TERM_PROGRAM=tmux`. `gemini-family/runtime.ts:99-105` adds the per-seat npm prefix and cache (`gemini-family/auto-update.ts:55-59`) so a self-update cannot write the operator's npm global prefix.
- Shell guard: before typing, the base checks that the pane's foreground process is a shell and refuses otherwise (`tui-cli-runtime-adapter.ts:410-417`). Typing a command into a live TUI would send it to the model as a prompt.
- Launch wait: `waitForReady` (`tui-cli-runtime-adapter.ts:684-749`) polls the pane every 500 ms for up to 45 s (`gemini-family/runtime.ts:127`; a seat's `readiness_timeout_ms` wins). Each poll is classified by `readPane` (`:805-829`) in a fixed order: pane at a shell, then gate patterns, then error patterns, then ready patterns, else pending. Gates are checked before ready, so a dialog that replaces the composer is never read as ready.
- Launch window: only output this launch printed counts (`tui-cli-runtime-adapter.ts:469-476`), so ready or error text left in a reused pane's scrollback does not.
- Ready signal: the composer placeholder `Type your message or @path/to/file` (`gemini-family/pane-patterns.ts:35-38`). **[fork-live 0.61.0]** at 80x24, including a long cwd and a resumed session's history (`test/gemini-family-80col.test.ts:32-34`).
- Activity (busy, idle, approval), read on demand by `classifyActivity` (`tui-cli-runtime-adapter.ts:534-561`) from the visible screen only:
  - working: `(esc to cancel, <n>` in the bottom 12 non-blank lines (`activity-markers.ts:65`);
  - needs_input: an in-session prompt in those lines (`activity-markers.ts:66-74`), or a gate anywhere on screen that no later busy or ready marker follows;
  - idle: the composer placeholder on screen;
  - otherwise `null`, and the caller falls back to its generic source.
  The busy and prompt fixtures are synthesized from source strings, not captured, because OpenRig never signs in (`test/fixtures/cli-panes/activity/README.md`).
- Auth status (`rig runtimes`, `rig doctor`): `auth-status.ts:104-138` reads `security.auth.selectedType` from `<cwd>/.gemini/settings.json` or `<GEMINI_CLI_HOME or ~>/.gemini/settings.json` and checks env variable names only. `oauth-personal` is reported `unknown`, with the note that personal accounts are refused since 2026-06-18.
- Stop: `reapProcessTreeOnStop: true` (`gemini/index.ts:83-85`). The `gemini` launcher parent ignores SIGHUP and SIGTERM, so OpenRig reaps the pane's process tree instead of relying on `tmux kill-session`. **[fork-live 0.61.0]** per the descriptor comment.
- No fork primitive: `supportsFork: false` (`gemini/index.ts:74`); `launch-args.ts:93-95` and `tui-cli-runtime-adapter.ts:393-395` refuse a `session_source`.

## How resume works

### Where the token comes from

OpenRig mints the session id itself rather than reading it back from Gemini CLI. **[src]**

1. Mint: on a fresh launch the base calls `mintSessionToken` (`tui-cli-runtime-adapter.ts:424-437`), which for Gemini is a v4 UUID (`gemini-family/runtime.ts:93`, `launch-args.ts:74-76`). It is validated against `SESSION_ID_RE` (RFC 4122 v1-5, `launch-args.ts:61-71`) and lowercased.
2. Record: the id is written as `presetToken` into `<OPENRIG_HOME>/state/gemini/<session>/launch.json` before anything is typed (`tui-cli-runtime-adapter.ts:457-467`, file name at `src/domain/runtime-capture.ts:24`).
3. Pass: the CLI is launched with `--session-id <id>` (`launch-args.ts:109-110`). Gemini CLI writes `chats/session-<timestamp>-<id first 8>.jsonl` at launch. **[fork-live 0.61.0]**
4. Report at ready: once the composer shows, `launchHarness` returns the minted id as the seat's resume token (`tui-cli-runtime-adapter.ts:487`), and the startup orchestrator stores it with provenance `scrape` (`src/domain/startup-orchestrator.ts:274-279`). Gemini does not set `mintedTokenAwaitsCapture`, so this happens even if the seat is never prompted.
5. Late capture: when a launch did not reach ready, no token is stored. The descriptor's `captureResumeToken` (`gemini/index.ts:59`, `gemini-family/runtime.ts:182-198`) can fill it in later. It reads `launch.json` and, for a fresh launch only, returns `presetToken` if Gemini CLI's store holds a resumable session with that id. Resume and fork launches return `null`, so the stored token stands. It runs:
   - from the resume-metadata refresher (`src/domain/resume-metadata-refresher.ts:101-120`), on every refresh;
   - at restore, just before the no-token decision (`src/domain/restore-orchestrator.ts:1037-1040`, implementation `:1662-1682`);
   - on adoption (`src/domain/claim-service.ts:233`).

   Because the capture is keyed to this seat's own minted id, the shared-cwd sibling guard is skipped when `presetToken` exists (`src/domain/runtime-capture.ts:83`). Two Gemini seats in one cwd share one Gemini project directory and never take each other's session (`test/gemini-runtime-adapter.test.ts:218`).

### What "resumable" means

`session-store.ts` mirrors Gemini CLI 0.61.0's own rule (from `chatRecordingService.ts` and `sessionUtils.ts`). **[src]**

- Locate the file (`session-store.ts:60-101`). Look up the cwd's slug in `<GEMINI_CLI_HOME or home>/.gemini/projects.json`; reject slugs that could escape the tmp dir (`:71`). List `tmp/<slug>/chats/`, match `session-*-<id first 8>.jsonl`, and accept only a file whose first JSONL line carries the full `sessionId`. An 8-character prefix collision is rejected (`test/gemini-family.test.ts:253`).
- Replay the records the way Gemini CLI's loader does (`session-store.ts:140-166`): message records upsert by `id`, `$set.messages` rebuilds the set, and `$rewindTo` drops a message and everything after it.
- The session is resumable if any current message is a real user prompt or a non-empty model message (`session-store.ts:121-134`). A real user prompt counts even if no reply landed (crash, quota, API error). The injected `<session_context>` and `<hook_context>` messages, slash commands, `?` help, and empty replies do not count (`test/gemini-family.test.ts:194-230`).

### How a seat is relaunched

1. Restore reads the seat's stored token. A `resume_if_possible` seat with a prior session but no token, after the late-capture attempt, stops at `awaiting-decision` before any session is started (`src/domain/restore-orchestrator.ts:1041-1051`).
2. The startup orchestrator calls `launchHarness` with the token. For a resume requested on a pod-aware seat, `allowFreshFallback` is false (`restore-orchestrator.ts:1420`), so a `retry_fresh` result is never turned into a silent fresh launch (`startup-orchestrator.ts:284-292`).
3. `launchHarness` validates the token format (`tui-cli-runtime-adapter.ts:397-402`), runs the shell guard, then the resume precheck: `validateResumeTarget` -> `checkGeminiResumeTarget` (`gemini-family/runtime.ts:94-97`, `session-store.ts:186-189`). This is the same resumability test as late capture, so a captured token always passes the precheck.
4. If the precheck passes, the base types `exec env <launch env> 'gemini' ... '--skip-trust' '--resume' '<id>'`, with no `--session-id` because both CLIs reject the pair (`launch-args.ts:104-105`; `test/gemini-runtime-adapter.test.ts:155-162`). The precheck reads `GEMINI_CLI_HOME` from the daemon's env (`test/gemini-runtime-adapter.test.ts:172`).
5. The wait for ready is the same as for a fresh launch. On success the stored token is returned unchanged (`tui-cli-runtime-adapter.ts:486`).

### When the token is missing or stale

| Situation | Where it is caught | Result |
|---|---|---|
| Seat stopped at a gate before ready (no token stored) and the session never got a real prompt | late capture returns `null` (`test/gemini-runtime-adapter.test.ts:212`) | restore `awaiting-decision`: "no resume token was captured for this seat ... Re-run with --fresh <seat>" (`restore-orchestrator.ts:1043-1051`). No session is started. |
| Seat stopped at a gate, then the operator answered it in the pane and used the seat | the refresher's late capture finds the now-resumable session | the token fills in with provenance `scrape`; a later restore resumes normally |
| Seat reached ready but was never prompted (token stored, session not resumable) | precheck, before typing (`tui-cli-runtime-adapter.ts:419-422`) | `retry_fresh`. Restore rolls back to zero sessions and reports `awaiting-decision` ("resume attempted but failed ... Re-run with --fresh", `restore-orchestrator.ts:1474-1482`) |
| Session file deleted, cwd slug gone from `projects.json`, or file unparseable | precheck (`session-store.ts:65-101`, `test/gemini-family.test.ts:260`) | same `retry_fresh` -> `awaiting-decision`. The error text never echoes the token (`test/gemini-runtime-adapter.test.ts:164-170`) |
| Precheck itself throws | `checkResumeTarget` (`tui-cli-runtime-adapter.ts:631-640`) | `attention_required`, "could not check the resume target" |
| Precheck passes but Gemini CLI still refuses: `Error resuming session:` (exit 42 on 0.61.0) | error pattern (`pane-patterns.ts:53`), matched while the TUI runs or on new lines after it exits | `retry_fresh` -> `awaiting-decision`. **[fork-live 0.61.0]**: both the "No previous sessions found" and the wrapped "Invalid session identifier" forms (`test/fixtures/gemini-family/80x24/gemini-resume-missing.txt`, `test/gemini-family-80col.test.ts:69-76`) |
| Malformed token (not a v1-5 UUID) | `validateSessionToken` (`launch-args.ts:65-71`) | the launch is refused before typing with "Resume token must be a session UUID" |
| Pane `GEMINI_CLI_HOME` differs from the daemon's | not detected | the precheck can refuse a session that exists (known limit, `docs/reference/runtimes/gemini.md:146`) |

Restore never switches runtimes: `fallback_runtimes` applies only to fresh launches (`src/domain/runtime-fallback.ts:9`).

## Stuck cases

The table lists every stuck case the fork's code handles or tests. "Detected by" names the mechanism. "Operator sees" is the launch or restore result: `attention_required` carries a readiness code and the last 12 pane lines, with trailing blank rows trimmed, as evidence (`DEFAULT_EVIDENCE_LINES`, `tui-cli-runtime-adapter.ts:65`, `:832-837`). `checkReady` reports the same code later. A pattern with no explicit code reports `runtime_error`. The Gemini adapter auto-answers nothing: no Gemini gate has an `answer` (`pane-patterns.ts:39-50`).

### Pre-session (launch and readiness)

| Case | Detected by | Operator sees | Tested |
|---|---|---|---|
| Folder trust dialog ("Do you trust the files in this folder?"). Normally never shown, because every launch passes `--skip-trust` | gate `pane-patterns.ts:42` | `attention_required`, `trust_gate` | yes, live fixture **[fork-live 0.61.0]** (`test/gemini-family.test.ts:127`, `test/gemini-family-80col.test.ts:35`) |
| No auth method chosen ("How would you like to authenticate for this project?"). Shown even with `GEMINI_API_KEY` set | gate `pane-patterns.ts:45` | `attention_required`, `login_required`; triggers `fallback_runtimes` on a fresh launch (`runtime-fallback.ts:19`) | yes, live fixture **[fork-live 0.61.0]** (`test/gemini-family-80col.test.ts:36`) |
| API key method chosen, no key found ("Enter Gemini API Key") | gate `pane-patterns.ts:47` | `attention_required`, `login_required`; fallback eligible | yes, live fixture **[fork-live 0.61.0]** (`test/gemini-family.test.ts:129`) |
| Google sign-in in progress or timed out ("Logging in with Google", "Waiting for authentication...", "Authentication timed out", "Press R to restart") | gate `pane-patterns.ts:49` | `attention_required`, `login_required`; fallback eligible | no Gemini test; pattern from source only |
| `GEMINI_API_KEY` missing for the Gemini API ("When using Gemini API, you must specify the GEMINI_API_KEY environment variable") | error `pane-patterns.ts:55` | `attention_required`, `runtime_error` (not fallback eligible) | yes, contract `errorScreens` (`test/gemini-runtime-adapter.test.ts:40-42`) |
| Minted id already exists ("Error starting session: Session ID ... already exists") | error `pane-patterns.ts:54` | `attention_required`, `runtime_error` | no test |
| IDE connection nudge ("Do you want to connect ... to Gemini CLI?"). Prevented by the launch env | error `pane-patterns.ts:60` | `attention_required`, `startup_dialog`; reason tells the operator to answer in the pane or set `ide.hasSeenNudge` | yes, live fixture plus the env-clearing test (`test/gemini-runtime-adapter.test.ts:122-139`, `test/gemini-family-80col.test.ts:38`) |
| Terminal keybinding consent ("works best with Shift+Enter"). Prevented by the launch env; its preselected "Yes" would edit the editor's `keybindings.json` | error `pane-patterns.ts:63` | `attention_required`, `startup_dialog`; reason says answer No | yes, live fixture (`test/gemini-family-80col.test.ts:37`, `test/gemini-runtime-adapter.test.ts:142`) |
| New project agents in `.gemini/agents` ("New Agents Discovered") | error `pane-patterns.ts:73` | `attention_required`, `startup_dialog` | yes, synthetic screen (`test/gemini-runtime-adapter.test.ts:143`) |
| New or changed policy files ("New or changed ... policies detected") | error `pane-patterns.ts:74` | `attention_required`, `startup_dialog` | yes, synthetic (`:144`) |
| MCP server needs OAuth ("Authentication required for MCP Server:") | error `pane-patterns.ts:75` | `attention_required`, `startup_dialog` | yes, synthetic (`:145`) |
| Extension update consent ("... and installing updates.") | error `pane-patterns.ts:76` | `attention_required`, `startup_dialog` | yes, synthetic (`:146`) |
| Self-update through Volta, pnpm, yarn, bun, or a standalone install ("Installed with ... Attempting to automatically update") | error `pane-patterns.ts:70` | `attention_required`, `self_update`. This is detection only: the install has already started | yes (`test/gemini-family-auto-update.test.ts:98-112`) |
| Self-update through global npm | not a stuck case: contained in the seat's `npm-global` prefix | launch succeeds (`test/gemini-family-auto-update.test.ts:92-96`); the update re-downloads on every launch | yes; containment **[fork-live 0.61.0]** (0.62.0 landed under the seat prefix) |
| Binary not on PATH | `command not found` in this launch's output (`tui-cli-runtime-adapter.ts:736-738`) | `attention_required`, `runtime_missing`; fallback eligible. Preflight also probes `gemini --version` and the Node >= 20 floor (`gemini/index.ts:53`, `gemini-family/runtime.ts:213-223`) | yes, contract suite (`test/helpers/tui-cli-adapter-contract.ts:252`, `:299`) |
| CLI exits to the shell without a known error | pane back at a shell after the CLI was seen (`tui-cli-runtime-adapter.ts:739`) | `attention_required`, "the CLI exited back to the shell"; `checkReady` reports `runtime_exited` (`:515-516`) | yes, contract suite (`:258`) |
| Nothing recognizable within 45 s | timeout (`tui-cli-runtime-adapter.ts:745-748`) | `attention_required`, "timed out waiting for the CLI to report ready" | yes, contract suite (`:306`) |
| Pane not at a shell when OpenRig is about to type | shell guard (`tui-cli-runtime-adapter.ts:410-417`) | `attention_required`, "the pane is not at a shell ... refusing to type the launch command" | yes, contract suite (`:149`) |
| Personal Google account (refused server-side since 2026-06-18) | not detectable locally | `rig runtimes` shows `unknown` for `oauth-personal` with that note (`auth-status.ts:134-136`); at launch it surfaces only if the sign-in gate pattern matches | no |

### In-session (activity)

These never fail a launch. `classifyActivity` reports `needs_input`, which the seat activity sweep shows as needs-input chrome (`src/domain/seat-activity-service.ts:47`). OpenRig never answers them.

| Case | Pattern (`activity-markers.ts`) | Tested |
|---|---|---|
| Tool approval ("Allow execution of [Shell]?" with Allow once / for this session / always / No) | `:73` | yes, synthetic fixture (`test/needs-input-activity.test.ts:44-46`, `test/fixtures/cli-panes/activity/gemini-prompt-80x24.txt`) |
| Edit approval ("Apply this change?", "No, suggest changes (esc)"). Under the floor posture, edits are auto-approved, so this should not normally appear | `:68-69` | covered by the same pattern list; no separate Gemini fixture |
| Loop detection ("A potential loop was detected") | `:70` | pattern only |
| Quota or plan limit ("Upgrade for higher limits") | `:71` | pattern only |
| A launch gate still on screen mid-session (auth, trust) | gate patterns, anywhere on screen | yes, live fixtures (`test/needs-input-activity.test.ts:30-37`) |

The `needs_input` reading has two guards. An answered prompt left higher in the visible history does not count, because only the bottom 12 non-blank lines are read for prompts (`test/needs-input-activity.test.ts:92-97`). An old busy line above that region does not count as working either (`:99`).

### Stop

| Case | Detected by | Result |
|---|---|---|
| `gemini` parent and child survive `tmux kill-session` | known in advance (`gemini/index.ts:83-85`) | OpenRig records the pane's process tree before killing the session, sends SIGTERM to the process group, then SIGKILL to anything left. **[fork-live 0.61.0]** |

## What an ACP-based port would change

The four ACP signals below are **[comment 0.64.0]**. The mapping to fork code is **[src]**. Anything described as a change is a proposal; none of it is implemented.

| Concern | Today (TUI + screen) | Over ACP |
|---|---|---|
| Busy | `(esc to cancel, <n>` in the bottom 12 lines (`activity-markers.ts:65`), synthesized fixture only | an open `session/prompt` request plus `session/update` events |
| Idle | composer placeholder on screen | the `session/prompt` response's `stopReason` |
| Approval wait | `Allow execution of`, `Apply this change?`, and similar strings (`activity-markers.ts:66-74`) | a `session/request_permission` request. OpenRig would hold it as needs_input instead of scraping text |
| Session id | minted, passed as `--session-id`, recorded in `launch.json`, reported at ready (`tui-cli-runtime-adapter.ts:424-487`) | returned by `session/new`; `session/load` resumes by id. The CLI flags `--session-id` and `--resume` also exist |
| Hooks | not used | `BeforeAgent`, `BeforeTool`, `AfterAgent`, `Notification(ToolPermission)` are available as a second channel |
| Resume precheck | file-level replay of Gemini CLI's resumability rule (`session-store.ts:103-189`), tied to the 0.61.0 on-disk format | could be replaced by the `session/load` result. The never-prompted case still has to map to `retry_fresh`, not to a silent fresh session |
| Late capture | reads `launch.json` plus the session file (`gemini-family/runtime.ts:182-198`) | unnecessary if the id comes back from `session/new` and the session is tracked from the first prompt |
| In-session prompts not covered by ACP (loop detection, quota) | screen patterns | unknown; the earlier comment did not cover them |
| Pre-session screens (first-run, folder trust, update, sign-in) | gate and error patterns in `pane-patterns.ts` | **still need the screen [comment 0.64.0]**. The `trust_gate`, `login_required`, `startup_dialog`, and `self_update` rows above remain screen-detected |
| Auth | auth dialog or key prompt on screen, plus `auth-status.ts` file checks | since 2026-06-18 personal Google accounts are refused, so a working seat needs an API key, Vertex AI, or Code Assist Standard or Enterprise. How ACP reports an auth refusal was not covered |
| Stop | process-tree reap | unchanged unless ACP's own shutdown proves clean; the SIGHUP behavior was verified only on 0.61.0 |

For the plug-in contract, the parts that would carry over unchanged are OpenRig's own rules, not Gemini's. These are the no-token stop (`awaiting-decision`), `retry_fresh` on a missing resume target with no fresh fallback, the refusal to type into a non-shell pane, and the per-seat npm containment.
