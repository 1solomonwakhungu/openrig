---
kind: as-built
title: Adapters and Runtimes — Claude/Codex/Pi/Stub/Terminal, tmux/cmux, Resume Honesty
status: active
topics: [agent-runtime, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need the runtime-adapter contract — how OpenRig launches and resumes a
  Claude Code, Codex, Pi, Oh My Pi, stub or terminal harness inside tmux, what
  the five required adapter methods do, or how the daemon honestly assesses
  whether a harness actually resumed vs fresh-launched (the resume-honesty
  layer). Also covers the runtime registry, the table-driven TUI CLI base
  adapter, and the checklist for adding a new runtime adapter.
siblings: [daemon-core.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Adapters and Runtimes

How OpenRig drives the agent harnesses. Pod-aware launches go through a
`RuntimeAdapter`: five adapter classes implement one contract of five required
methods. Legacy (non-pod-aware) restore resumes through separate resume
adapters (`ClaudeResumeAdapter`, `CodexResumeAdapter`, `PiResumeAdapter` and
`OmpResumeAdapter` in `packages/daemon/src/adapters/*-resume.ts`), which are not
`RuntimeAdapter`s. A separate resume-honesty layer answers the question "did
this harness *actually* resume, or did it silently fresh-launch?" truthfully
rather than optimistically.

> Verified against source at main `e8f0ab340db773392ec8be75b072d1c0f3068a50`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The five-method RuntimeAdapter contract

`RuntimeAdapter` is `packages/daemon/src/domain/runtime-adapter.ts:143`
(`interface RuntimeAdapter`). Every adapter declares a `readonly runtime`
string (`runtime-adapter.ts:146`) and implements five required methods
(`runtime-adapter.ts:152–176`; **5** =
`sed -n '/^export interface RuntimeAdapter/,/^}/p' packages/daemon/src/domain/runtime-adapter.ts | grep -c -E '^  [a-zA-Z]+\('`):

| Method | Signature (`runtime-adapter.ts`) | Responsibility |
|---|---|---|
| `listInstalled` | `(binding)` `:153` | List currently installed/projected resources for a node. |
| `project` | `(plan, binding)` `:156` | Project resources from a `ProjectionPlan` to the runtime's target locations. |
| `deliverStartup` | `(files, binding, sendInteractiveText?)` `:160` | Deliver resolved startup files to the runtime. The startup orchestrator passes the optional third argument for Claude Code only, so Claude's `send_text` files go through the checked send described in `agent-spec-and-startup.md`. |
| `launchHarness` | `(binding, opts)` `:170` | Launch the harness inside the bound tmux session; return a resume token. |
| `checkReady` | `(binding)` `:176` | Probe whether the harness is responsive and ready. |

The interface also has two optional members: `claudeManagedLaunch` (`:145`)
and `skillTargetPath?()` (`:150`), implemented by `PiRuntimeAdapter`
(`pi-runtime-adapter.ts:118`) and overridden by `OmpRuntimeAdapter`
(`omp-runtime-adapter.ts:12`).

Startup *action* execution (`slash_command` / `send_text`) is explicitly **not**
part of this contract — the contract docstring (`runtime-adapter.ts:137–142`)
states actions belong to the `StartupOrchestrator` *after* `checkReady()`. The
orchestrator delivery split is in `agent-spec-and-startup.md`.

### `launchHarness` opts and the fork seam

`launchHarness` opts is `{ name: string; resumeToken?: string; forkSource?:
ForkSource }` (`runtime-adapter.ts:172`).

Per the contract docstring (`runtime-adapter.ts:162–169`) `resumeToken` and
`forkSource` are mutually exclusive — if both are provided the adapter **must
refuse** with a clear error, not guess; `forkSource` triggers a fork and the
captured token is the NEW post-fork token, never the parent. `ForkSource` is
`runtime-adapter.ts:132` (`kind: "native_id" | "artifact_path" | "name" |
"last"`, `:133`; v1 MVP accepts `native_id` only — other shapes rejected at
schema validation, docstring `:122–131`, and by the Claude, Codex and Pi
adapters themselves).

### `HarnessLaunchResult` is a discriminated union with an honest failure arm

`HarnessLaunchResult` is a **discriminated union** (`runtime-adapter.ts:97–102`):
`| { ok: true; resumeToken?; resumeType?; appliedLaunch? }`
`| { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence? }`.
The failure arm carries a typed `recovery` hint
(`HarnessLaunchRecovery = "retry_fresh" | "attention_required"`, `:95`) and
optional `evidence` (last-N pane lines, flowed through to
`RestoreNodeResult.attentionEvidence` for `attention_required` outcomes,
`:99–102`). This is the honest-failure shape, not a smoothed optional `error`.

Readiness has its own attention codes (`runtime-adapter.ts:74–87`):
`trust_gate`, `hook_trust_gate`, `update_gate`, `login_required`, `mcp_gate`,
`bypass_consent_gate`, `codex_auth_refusal` and `codex_client_incompatible`.
When `checkReady` reports one, the readiness wait returns at once and startup
ends `attention_required`.

## 2. The runtime adapters

**5** classes implement `RuntimeAdapter`
(`git grep -l 'implements RuntimeAdapter' packages/daemon/src | wc -l`):
`ClaudeCodeAdapter`, `CodexRuntimeAdapter`, `PiRuntimeAdapter`,
`StubRuntimeAdapter` and `TerminalAdapter`. All live under
`packages/daemon/src/adapters/` (Architecture Rule 1: **0** files there import
Hono, `git grep -l 'from "hono' -- packages/daemon/src/adapters | wc -l`).
`OmpRuntimeAdapter` (Oh My Pi) extends `PiRuntimeAdapter`, so the daemon wires
**6** runtime keys — `claude-code`, `codex`, `pi`, `omp`, `stub`, `terminal`
(`startup.ts:989`, and the same map at `:1259`;
`grep 'adapters: {' packages/daemon/src/startup.ts | grep -o -E '"[a-z-]+": ' | wc -l`).

### Launch posture

A seat's launch posture is `floor`, `auto` or `full_bypass`. It comes from the
member's or rig's `permission_policy`: `builtinLaunchPosture()`
(`packages/daemon/src/domain/permission-policy/policy-ref.ts:165`) maps
`builtin:yolo` to `full_bypass`, `builtin:auto` to `auto`, and every other
built-in (`locked`, `standard`, `open`) to `floor`.
`resolvePermissionPolicyAttachment()` (`:172`) resolves the attachment, and
`rigspec-instantiator.ts` binds the result: the member attachment
(`resolveMemberPolicyAttachment`, `:1922`), then the persisted node or rig
attachment (`:2007`), then the floor, set on the binding as `launchPosture`
(`:2159`). `NativePermissionStore.apply()`
(`native-permission-store.ts:238`) then overlays a seat's explicit
`rig seat set-permissions` choice, or the kernel operational or team default
described below. `bundle-behaviour.ts` is the read-only
preview of the same mapping for an unopened bundle (see
`packaging-bootstrap-bundles.md`).

`packages/daemon/src/adapters/yolo-mode.ts` turns the posture into flags:

- **Claude Code** (`claudePostureFlag`): an explicit `permissionMode` becomes
  `--permission-mode <mode>` (`:43`); `auto` becomes
  `--permission-mode auto` (`:47`); `full_bypass` becomes
  `--dangerously-skip-permissions`; otherwise the floor is
  `--permission-mode acceptEdits` (`:50`). For a seat with no resolved
  posture, the instance-wide YOLO setting `OPENRIG_YOLO=1` (`:27`; off by
  default) selects the bypass; a resolved posture always wins (`:26`).
- **Codex** (`codexPostureArg`, `:62`): `full_bypass` becomes
  `-s danger-full-access -a never` (`:67`); for a seat with no resolved
  posture, `OPENRIG_YOLO=1` becomes `-s danger-full-access`; otherwise the
  seat's `-p <profile>` or `-s workspace-write`. Codex with `auto` gets the
  same: its selected profile, or the `-s workspace-write` floor without one.

**Non-interruptive mode** (`nonInterruptiveArgs()` in
`packages/daemon/src/adapters/non-interruptive.ts:12`) adds per-launch
arguments only for a `full_bypass` seat whose rig has it on
(`rigs.non_interruptive`): Claude Code gets
`--settings '{"skipDangerousModePermissionPrompt":true}'` (unless an explicit
non-bypass `permissionMode` is set), and Codex gets
`-c notice.hide_full_access_warning=true -c notice.hide_gpt5_1_migration_prompt=true`.
It never changes permissions or native settings files. `rig up
--non-interruptive` and `--no-non-interruptive` save the choice; otherwise the
rig spec's `non_interruptive`, then the setting `launch.non_interruptive`,
supplies the default (`packages/daemon/src/domain/bootstrap-orchestrator.ts:739`).

**Kernel operational default.** `NativePermissionStore.launchOverride()`
(`native-permission-store.ts:47`) gives a Claude Code or Codex seat in the
persisted rig named `kernel` operational launch arguments when the seat has no
explicit permission choice, its member and rig declare no permission policy,
and (for Codex) it has no `-p` profile (`launchDefault`, `:28`). Fresh start,
continue, restore and handover all take this decision per launch.
`operationalLaunchArgs()` (`packages/daemon/src/adapters/kernel-authority.ts:56`)
then replaces the non-interruptive arguments for that seat:

- Claude Code keeps the floor, `--permission-mode acceptEdits`, and gets
  `--settings` whose `permissions.allow` is `KERNEL_CLAUDE_ALLOW`
  (`:9`): `Skill`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `Bash(<command>:*)`
  for 39 operational commands (`rig`, `tmux`, `node`, `npm`, `git`, `ssh`, `python3` and
  others), `Bash(command -v:*)` (`:16`), two read-only provider login checks (`Bash(claude auth status:*)`,
  `Bash(codex login status:*)`, `:18`), and `Read(~/**)` (`:19`), plus the `PreToolUse`
  hook described under the team default. It is not
  the bypass flag, and the user's own ask and deny rules still apply.
- Codex gets the `full_bypass` posture, `-s danger-full-access -a never`, plus
  the two notice flags above.

It writes no settings file. If the rig lookup fails, the seat keeps its floor.
`rig seat status` reports the source as "kernel operational default"
(`kernel_default`, `native-permission-store.ts:182`).

**Team default.** Under the same conditions, a Claude Code or Codex seat in any
other rig gets `teamPermissionDefault` instead (`native-permission-store.ts:38`,
`:56`), on the same launch paths. A Claude Code seat at the floor with no native
permission mode keeps `--permission-mode acceptEdits` and gets
`--settings` (`kernel-authority.ts:64–66`):
`TEAM_CLAUDE_ALLOW` (`:25`) is `Skill`, `Read(./**)`, `Glob`, `Grep`,
`Bash(rig:*)`, eight read-only shell commands and 17 test-runner commands, and
`TEAM_CLAUDE_ASK` (`:32`) asks before 41 `rig` lifecycle commands such as `up`,
`down`, `seat stop` and `bundle install`. The settings carry the allow list and a
`PreToolUse` Bash hook, `packages/daemon/assets/claude-team-permissions.cjs`, that applies
both lists (`kernel-authority.ts:43–53`): it asks before a lifecycle command unless the
command only asks for `--help` or `-h`, allows a simple literal command that matches an
allow rule, and otherwise leaves the decision to Claude (`claude-team-permissions.cjs:234`,
`:240`). Without the hook file, the settings carry both lists as plain `allow` and `ask`
rules (`kernel-authority.ts:46`). A Codex seat launching at
`-s workspace-write` gets `--add-dir` for the workspace root (`workspace.root`)
and its pod's state directory, each created first and skipped with a warning if
it is the home directory or an ancestor of it
(`packages/daemon/src/domain/codex-team-workspace.ts:18`), on fresh, fork and
resume launches (`codex-runtime-adapter.ts:378`, `codex-resume.ts:103`).

### ClaudeCodeAdapter (`claude-code-adapter.ts:55`)

- `readonly runtime = "claude-code"` (`:56`).
- **Projects** to `.claude/` targets: guidance managed blocks →
  `<cwd>/CLAUDE.md` by default (`:194`, `:501`; default at
  `domain/managed-blocks.ts:17`, and the rig may select `CLAUDE.local.md`
  instead with `managed_blocks: { claude-code: <file> }`,
  `managed-blocks.ts:15`); `skill_install` → `<cwd>/.claude/skills/<name>/`
  (`:200`, `:582`); subagents → `.claude/agents`, plugins →
  `.claude/plugins/<id>` (only plugins that apply to Claude), runtime
  resources → `.claude/extensions/<id>` (`:584–586`); settings fragments
  merged into `.claude/settings.local.json` (`:594`) and MCP fragments into
  `<cwd>/.mcp.json` (`:597`).
- **Launches**: fresh = `claude <posture> --session-id <generatedId> --name
  <name>` (`:329`); resume = `claude <posture> --resume <token> --name <name>`
  (`:328`); fork = `claude <posture> --resume <parentId> --fork-session
  --session-id <generatedId> --name <seat>`, which needs Claude Code 2.0.73 or
  later. `<posture>` is the flag above plus any non-interruptive,
  kernel operational or team default argument. Each command may carry a `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`
  env prefix (`yolo-mode.ts:101–103`; on by default, off with
  `OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0`), a `--model <model>` argument
  (`:275`) and `--effort <effort>` (`:277`). A fresh launch and a fork both
  return the generated `--session-id` as their `claude_id` token, so a forked
  seat's process names its own conversation and strict proof can verify it.
  Neither reads Claude's session files back.
- **Managed launch.** When the binding selects a native permission mode, the
  command comes from `ClaudeManagedLaunch.prepare()`
  (`domain/claude-managed-launch.ts:97`), which resolves `claude` on the
  managed `PATH`, validates the mode against `claude --help` (5-second limit),
  and launches through `/usr/bin/env -i` with only the seat's environment
  (`PATH`, `HOME`, an optional `CLAUDE_CONFIG_DIR`, the OpenRig seat identity
  and forwarded keys).
- **Managed bootstrap.** Before delivery the adapter marks the seat's working
  directory as trusted and onboarding as completed in Claude's state file,
  writing only when a flag is missing (`provisionManagedBootstrap`, `:697`).
  It writes no permission settings. The Codex adapter does the same for
  project trust in its `config.toml` (`codex-runtime-adapter.ts:736`).
- **Readiness** (`checkReady`, `:356`): verifies tmux session alive (`:361`),
  captures the pane command and 40 pane lines, and assesses them with
  `assessNativeResumeProbe` (§3) through `assessManagedProbe` (called `:368`,
  defined `:386`); ready only when probe `status === "resumed"`. The
  resume-launch verification loop `verifyResumeLaunch` (`:420`) retries up to
  **16 attempts** (`:422`), failing loudly with `recovery: "retry_fresh"` on
  `no_conversation_found` (`:429–434`) and with `recovery:
  "attention_required"` plus pane evidence on an `attention_required` probe
  (`:444–450`) — the adapter never relaunches on its own.

### CodexRuntimeAdapter (`codex-runtime-adapter.ts:65`)

- `readonly runtime = "codex"` (`:66`).
- **Projects** to `.agents/` targets: `guidance_merge` → `<cwd>/AGENTS.md`
  (`:309`, `:576`); `skill_install` → `<cwd>/.agents/skills/<name>/` (`:315`);
  skills resolve under `.agents/skills/<id>` (`:664`); plugins go to
  `.codex/plugins/<id>` (`:667`).
- **Launches/resumes**: fresh = `codex[ --no-daemon]<posture>[<network>] -C
  <cwd> …` (`:442`), then capture a fresh thread id (`:460`); resume is built
  by `buildCodexResumeCore` (`:441`) as `codex<daemon><posture> resume
  [<queueStateDirArg>] <token>` (`native-resume-probe.ts:81`); fork =
  `codex<posture> fork<queueStateDirArg> <parentId>` (`:411`). `--no-daemon`
  (`:389`) comes first, and only when `codex --help` lists it
  (`domain/codex-daemon-support.ts`; an unreadable answer refuses the launch).
  `-m <model>` (`:356`) and `-c 'model_reasoning_effort="<effort>"'`
  (`:358`) are added when selected. With a thread id it returns `{ ok: true,
  resumeToken: threadId, resumeType: "codex_id" }` (`:428`, `:457`, `:463`); a
  fresh launch whose thread id is not captured returns `{ ok: true }` with its
  applied launch but no token (`:466`). Every Codex launch, fresh, fork or resume,
  also carries `-c check_for_update_on_startup=false`, so a managed seat leaves Codex
  upgrades to the operator (`kernel-authority.ts:60`, added to the posture at
  `codex-runtime-adapter.ts:363`).
- **Network default.** On the plain `-s workspace-write` floor,
  `domain/codex-network-default.ts` asks a one-shot `codex app-server` for the
  effective configuration; when it allows it, the launch adds
  `-c sandbox_workspace_write.network_access=true` (`:19`). Otherwise it adds
  nothing.
- Refuses `resumeToken` + `forkSource` together with a clear error
  (`:350–351`) — honors the mutual-exclusivity contract.

### TerminalAdapter (`terminal-adapter.ts:19`)

- `readonly runtime = "terminal"` (`:20`).
- **All operations are no-ops** — "the shell is immediately interactive"
  (`terminal-adapter.ts:15`): no-op `project`/`deliverStartup`, a
  `launchHarness` (`:34`) that returns `{ ok: true }`, and a `checkReady` that
  returns ready unconditionally (`:47–48`). Used for infrastructure nodes. A
  terminal node cannot fork: `launchHarness` refuses a `forkSource` with a
  clear error (`:38–42`), as the runtime-adapter docstring requires of
  adapters without fork (`runtime-adapter.ts:129–130`).

### Pi, Oh My Pi and stub adapters

- `PiRuntimeAdapter` (`pi-runtime-adapter.ts:64`), `runtime` `"pi"` (`:65`).
- `OmpRuntimeAdapter` (`omp-runtime-adapter.ts:7`) extends it with
  `runtime = "omp"` (`:8`).
- `StubRuntimeAdapter` (`stub-runtime-adapter.ts:69`), `runtime` defaulting to
  `"stub"` (`:81`).

Pi and stub launch an OpenRig runner inside the seat's tmux pane (header
comments `pi-runtime-adapter.ts:1–10`, `stub-runtime-adapter.ts:1–14`). Pi
and Oh My Pi support fork and report `pi_session_file` or `omp_session_file`
resume tokens; the stub refuses fork and reports `stub_session`.

`createDaemon` constructs the adapters (`startup.ts:778`, `:779`, `:782`,
`:783`, `:788`) and creates the terminal adapter inline in the runtime adapter
maps (`startup.ts:989`, `:1259`); see `daemon-core.md` §4 "Startup sequence".

### Terminal providers

Opening a seat in a terminal app goes through `TerminalProvider`s under
`packages/daemon/src/domain/terminal/`, served by `/api/terminal`:
`HerdrAdapter` (`herdr-adapter.ts:351`), the default
(`terminal-service.ts:55–58`), and `CmuxProviderAdapter`
(`cmux-provider-adapter.ts:52`), which is best effort and refuses with
`cmux_unavailable` when cmux is not connected. A request that names no
provider takes the first of Herdr, then cmux, that is available and alive,
and stays on Herdr when neither is (`providerNameFor`,
`terminal-service.ts:175`); a named provider is used as named. These place existing tmux
sessions in views; they do not launch harnesses.

## 3. Resume honesty

The daemon does not assume a harness resumed just because the launch command
ran. Three domain files (`packages/daemon/src/domain/`) carry the resume
assessment:

### `native-resume-probe.ts`

`assessNativeResumeProbe(input)` (`native-resume-probe.ts:84`) reads pane
command + pane content and returns one of four honest statuses
(`NativeResumeProbeStatus`, `:7`):

- `resumed` — runtime-specific indicators confirm a resumed session.
- `failed` — terminal failure (e.g. Claude printed "No conversation found" →
  code `no_conversation_found`, `:99–104`).
- `inconclusive` — we don't know yet (e.g. Claude trust gate, code
  `trust_gate`, `:113–118`).
- `attention_required` — alive and recoverable but **needs operator action**
  (e.g. Claude resume-selection prompt, code `claude_resume_selection_prompt`,
  `:106–111`). This is the proxy for "an operator must choose the
  conversation"; it is *distinct* from `inconclusive` and `failed` (comment
  `:4–6`).

Other codes include `bypass_consent_gate`, `mcp_gate`, `login_required` and
`returned_to_shell` for Claude, and `codex_client_incompatible`,
`no_saved_session`, `codex_auth_refusal` and `model_selection_gate` for Codex;
an unknown runtime gets `unsupported_runtime`. For Claude, `assessManagedProbe`
upgrades an auto-mode or composer-only screen to `resumed` only after a stable
native process match on a single pane.

`buildNativeResumeCommand` (`:32`) builds the resume command per runtime:
claude → `claude --resume <token> [--name <name>]` (`:41`); codex →
`buildCodexResumeCore` (`:44`), i.e. `codex<posture> resume <token>`
(`:81`); other runtimes → `null` (`:46`).

At the adapter level (Architecture Rule 15, §4), the adapter's
`verifyResumeLaunch` returns `ok:false` with a `retry_fresh` recovery hint and
never relaunches itself. Acting on that hint is the caller's choice:
`StartupOrchestrator` retries once fresh on `retry_fresh` unless the caller
passes `allowFreshFallback: false` (`startup-orchestrator.ts:319–330`), and the
restore orchestrator passes `false` when a pod-aware node requested resume
(`restore-orchestrator.ts:1224`).

### `resume-metadata-refresher.ts`

`ResumeMetadataRefresher` (`resume-metadata-refresher.ts:59`) records which
sessions can be resumed, without overwriting a token it can't re-derive
exactly. `refresh(sessions, opts?)` (`:124`) works in two modes:

- **At shutdown** (default): a Codex session without a token gets its thread
  id captured. For a Claude session with a token, it first reads Claude's live
  per-process session file, and only if that read fails runs
  `probeClaudeResume` (`:216`) — a real launch of the resume command in a
  throwaway probe tmux session (`rigged-refresh-<name>-<ts>`, `:301`),
  returning `"resumable" | "not_resumable" | "inconclusive"`. The probe result
  is recorded without clearing the token.
- **`fillNullOnly`** (`:127`): a missing Claude token is filled from the
  status-line sidecar, and a present Claude or Codex token is re-stamped
  resumable only when it matches what the runtime reports. No probe runs.

### `codex-thread-id.ts`

Codex thread-id extraction (`codex-thread-id.ts`). Reads the Codex thread id
from the Codex *logs* SQLite databases in the Codex home (`CODEX_HOME` when
set, else `~/.codex`, `:40`): `readCodexThreadIdFromCandidateHomes(...)`
(`:34`) → `readCodexThreadIdFromLogs(...)` (`:244`) →
`resolveCodexDbPaths(homeDir, kind)` (`:302`), which globs
`logs_<N>.sqlite` (`:308`) and falls back to `logs_1.sqlite`. The logged
thread ids are then checked against the `threads` table in `state_<N>.sqlite`
(falling back to `state_5.sqlite`, `:320`; query `:269–280`); an id is
returned only when exactly one CLI conversation matches (`:282`). Uses
`better-sqlite3` (`:6`). Resolves the home dir by the harness PID
(`defaultResolveHomeDirByPid`, `:16`).

## 4. Relevant Architecture Rules

The rule texts live in `architecture-rules-and-event-system.md` §1; this
section cites them by number with the adapter-level evidence checked for this
module.

- **Rule 1** — §2: **0** files in `adapters/` import Hono.
- **Rule 5** — restore picks a node's adapter by that node's own runtime: the
  saved startup context's runtime, else the node's (`restore-orchestrator.ts:1115–1116`),
  used to choose the replay adapter (`:1138`).
- **Rule 13** — the readiness loop is `StartupOrchestrator.waitForReady`
  (`startup-orchestrator.ts:562`; 1 s doubling to a 16 s cap), which calls each
  adapter's `checkReady` (§2). The timeout comes from the
  `runtime.readiness_timeout_seconds` setting (default 30, range 1–600,
  `domain/readiness-timeout.ts:3`).
- **Rule 14** — the probe's `attention_required` (§3) reaches the restore
  result through `HarnessLaunchResult.recovery` and `evidence` (§1), which
  become `RestoreNodeResult.status` (`types.ts:457`, `:475`) and
  `attentionEvidence` (`types.ts:478`). A startup's `continuityOutcome` is a
  separate field that also allows `forked` (`startup-orchestrator.ts:101`).
- **Rule 15** — adapters return `ok:false` and never relaunch (§2, §3);
  restore passes `allowFreshFallback: false` for pod-aware resume
  (`restore-orchestrator.ts:1224`), and a resume that concludes failed rolls
  back to zero sessions as `awaiting-decision` (`restore-orchestrator.ts:1055`,
  `:1243`).

## 5. Runtime registry

> Verified against source on `feat/runtime-registry` (based on `a745475b`).

A runtime id used to be a free string enumerated at many sites. The registry
(`packages/daemon/src/domain/runtime-registry.ts`) is now the single catalog.
Each runtime is a `RuntimeDescriptor`:

| Field | Meaning |
|---|---|
| `id`, `displayName`, `kind` | The rig-spec `runtime:` value, a human label, and `"agent"` or `"terminal"`. |
| `binary`, `versionArgs` | Availability probe (`<binary> <versionArgs>`, default `--version`) used by preflight, the verifier, and permission drift. Absent for terminal and the pane-hosted stub. |
| `installHint` | Install instruction appended to preflight's "not available" fix line and the verifier's `not_found` error. |
| `verify` | Optional extra check after the probe (Pi's Node engine floor lives here). |
| `resumeType`, `validateResumeToken` | Persisted resume-token type and its format floor. A descriptor with a `resumeType` must supply a validator. |
| `captureResumeToken` | Read-only live capture, `({ sessionName, cwd, seatStateDir, launchStartedAt?, homedir })` returning a token or null (built-ins return a structured outcome). Run through `runDescriptorTokenCapture` (`runtime-capture.ts`), which never throws: a throw becomes a logged `capture_error` skip. |
| `supportsFork` | Whether `forkSource` is accepted. |
| `guidanceFile`, `cleanupGuidanceOnTeardown` | The cwd file that receives managed blocks, and whether teardown strips them (default yes). |
| `skillsDir` | Where projected skills land; absent means skills are an honest skip. |
| `paneCommands` | Exact foreground process names for discovery fingerprinting and seat identity reconciliation. Generic hosts (`node`, `python`, shells) are rejected at registration. |
| `processMatch` | For CLIs whose pane command is a generic host (npm CLIs show `node`): matched during discovery against the program of each process in the pane's tree (ps): argv[0], or the script path when argv[0] is an interpreter. A string matches a basename or path-segment run (`@github/copilot`); a RegExp tests the program path. Other arguments never match, and `node` alone is never identity. |
| `reapProcessTreeOnStop` | Reap the pane's process tree on stop, for CLIs that survive `kill-session` (default false). |
| `trackedGuidanceRedirect` | For `guidance.tracked_file: redirect` (`domain/guidance-target.ts`): an untracked file the CLI loads automatically in addition to `guidanceFile`, which receives managed blocks when `guidanceFile` is tracked by git. Absent = redirect skips for this runtime. Claude Code (`CLAUDE.local.md`) and Pi (seat agent dir) are handled in their built-in adapters; teardown cleans the same file. |
| `permissionPostureFor` | For runtimes whose spec records a permission-axis `observeLaunch`: map the observed launch value back to `floor` or `full_bypass`. Permission drift (`diagnoseRuntimePosture`) then compares it with the seat's policy posture (member attachment, else rig) and reports `aligned` or `drift`; `unknown` when no policy is attached or the value is unrecognized. Built-in runtimes keep their own drift paths. |
| `internal` | Test/internal runtimes (the stub) that legacy specs and user-facing lists hide. |

The built-in descriptors (`claude-code`, `codex`, `pi`, `terminal`, `stub`)
reproduce the pre-registry tables exactly; `test/runtime-registry.test.ts` pins
them. Two preserved quirks are explicit fields: Pi sets
`cleanupGuidanceOnTeardown: false` (teardown never cleaned Pi's `AGENTS.md`),
and Pi declares no `paneCommands` (its pane runs the node pi-runner).

Per-seat state lives at `<OPENRIG_HOME>/state/<runtime id>/<session name>`
(`runtimeSeatStateDir`, `seatStateDirFor`). Before each launch the TUI CLI base
writes `launch.json` there (`launchId`, `runtimeId`, `sessionName`, `cwd`,
`launchStartedAt`, `mode`, optional `presetToken` and `ownerConfigChanges`).

Resume-token capture runs at four points, all through the same hook: right
after launch readiness, at adoption and handover (`deriveResumeToken`), on every
resume-metadata refresh for registered CLI runtimes (null fill, or replace a
different token with `scrape` provenance so the rank guard still protects
adoption/hook/operator tokens; an equal token re-stamps freshness), and once at
restore when a registered CLI seat's snapshot has no token, before the
fresh-versus-awaiting-decision classification. Late capture reads
`launchStartedAt` from `launch.json`. This is what makes CLIs that create their
session lazily on the first prompt (opencode, kilo) restorable.

Sibling-seat guard: for a runtime whose capture is not session-scoped
(`captureIsSessionScoped` is false, the default for CLI runtimes), the
post-launch, refresher, and restore captures skip the hook while another live
seat of the same runtime shares the cwd in any rig
(`SessionRegistry.hasLiveSiblingSeat`), log why, and report
`ambiguous_seat`, naming the blocking seat in the log. Cwds compare after
normalization (absolute, no trailing slash, symlinks resolved when the path
exists). A seat with a minted token is unaffected. Runtimes whose capture
reads state keyed to the seat alone set `captureIsSessionScoped: true` and are
never guarded: the built-ins (a per-session sidecar or the pane's own process)
and the OpenCode family (the seat's own `OPENCODE_DB` / `KILO_DB`). Sessions the owner starts
outside OpenRig in the same cwd are invisible to the registry; each adapter
documents that limit. The restore plan
preview does not run capture, so it can still show such a seat as
awaiting-decision until the restore itself runs.

Stop-time reaping (`process-tree-reaper.ts`): `TmuxAdapter.stopHook` wraps every
`killSession` (teardown, seat stop, restore rollback, launch cleanup, node
removal). The seat's current runtime comes from the session registry (the
latest session row's node runtime); only a session the registry does not know
falls back to its seat `launch.json`, and only when the record's `runtimeId`
and `sessionName` both match, so a stale file never reaps a seat re-specced to
another runtime. For a seat whose runtime sets `reapProcessTreeOnStop`, it snapshots the pane pid, its process group, and its
descendant tree before `kill-session`; afterwards it SIGTERMs the pane's process
group (only while the leader is the same process still leading it), SIGTERMs
every surviving snapshot pid, and SIGKILLs what is left after a grace period.
Every signal is pid-scoped and checked against the snapshot's start time and
command, so a reused pid is never hit, and nothing is ever killed by name.
Built-ins never opt in, so they stop exactly as before.

Registry-driven sites:

- `rigspec-preflight.ts`: supported runtimes, the legacy availability probe,
  and `verifyCliRuntimesAvailable` for registered non-built-in runtimes.
- `runtime-verifier.ts`: `verifyAll` and `verifyRegistered`.
- `resume-token-validation.ts` and `resume-token-capture.ts`: resume types,
  format floors, and capture hooks. Format floors live in
  `resume-token-formats.ts` so descriptors never import the registry.
- `restore-orchestrator.ts`: resume dispatch walks the built-in resume adapters
  (claude, codex, pi, in the old order) and then the registered
  `RuntimeResumeAdapter`s passed as `resumeAdapters`.
- `permission-drift.ts` (command path), `rig-teardown.ts` (guidance cleanup),
  `rigspec-schema.ts` (legacy runtimes), `discovery-types.ts`,
  `session-fingerprinter.ts`, `draft-rig-generator.ts`, and
  `seat-identity-reconciler.ts` (pane commands).
- `startup.ts`: `buildRuntimeAdapters` (`adapters/runtime-adapter-map.ts`)
  builds the one runtime-id to adapter map that pod instantiation, restore,
  seat lifecycle, and handover share; `createNodeFsOps`
  (`adapters/node-fs-ops.ts`) replaces the duplicated inline fsOps literals.
- UI: `packages/ui/src/lib/runtime-brand.ts` labels a runtime without a brand
  entry from its id (`gemini-cli` renders as "Gemini Cli" with the neutral
  mark). The TUI already falls back to the id prefix in tables and the neutral
  `?` mark in topology, so it needs no per-runtime entry.

Per-seat permission selection (`native-permission-selection.ts`,
`rig seat set-permissions`) is registry-driven for CLI runtimes: a descriptor
that declares `permissionModes` (every registered CLI runtime declares
`["floor", "full_bypass"]`) accepts those postures per seat, stored in
`node_permission_selections` (migration 510 dropped the old claude/codex
`runtime` CHECK) and applied as `binding.launchPosture` on the next launch,
restore resume, or handover. Permission drift uses the selected posture as the
expected one before the policy posture. Claude native modes and Codex keep their
own paths; Pi and runtimes without `permissionModes` refuse.

Deliberately claude/codex-only sites keep their own logic and degrade to the
generic tmux path for any other runtime: native process lineage
(`native-process-lineage.ts`), the native resume probe
(`native-resume-probe.ts`, which returns `inconclusive` /
`unsupported_runtime`), provider telemetry and the context monitor (claude,
codex, pi), the restore runtime-truth reconciliation, workflow agent
harnesses, package and agent-image manifests, and the first-run kernel.

Import discipline: the registry imports `adapters/cli/index.ts` at runtime, so
nothing under `adapters/cli/` may import the registry at runtime (type imports
are fine).

## 6. TUI CLI base adapter

`packages/daemon/src/adapters/cli/tui-cli-runtime-adapter.ts` implements the
five-method contract plus `RuntimeResumeAdapter` for an interactive CLI in a
tmux pane, driven by a `TuiCliRuntimeSpec`:

- `buildLaunchCommand({ binding, posture, resumeToken?, forkSource?, sessionToken?, seatStateDir })`
  returns argv. The base shell-quotes it and types `exec <argv>` with
  `tmux.sendShellCommand`, so the CLI replaces the launch script's shell and
  `pane_current_command` becomes the CLI. It types only after the pane's
  foreground command is a shell; a pane whose foreground is anything else
  (for example a live TUI) is refused as `attention_required` with nothing
  typed. It refuses `resumeToken` with
  `forkSource`, refuses fork when the descriptor has `supportsFork: false`,
  and format-validates a resume token before typing anything. `posture` is
  `effectiveLaunchPosture` (`yolo-mode.ts`): the seat's resolved policy, else
  the `OPENRIG_YOLO` decision.
- `env` (optional): by default the CLI inherits the pane env and `set` adds
  literal `K=V` values (`env 'K=V' cmd`), applied on fresh, fork, and resume.
  `denyByDefault: true` opts into Pi-style `env -i` with the Pi baseline and
  OpenRig identity variables plus the `allow` list; pane variables pass only
  when set (`${NAME+"NAME=$NAME"}`).
- `prepareLaunch(ctx)` (optional) provisions before typing on fresh, fork, and
  resume (restore resumes through the same path); `ctx.mode` names which, and
  a fork carries `ctx.forkSource` (goose records the parent so capture can find
  the copy). Failures are logged and never block the launch. Owner files are edited only through `ctx.mergeOwnerConfig`
  (`adapters/cli/owner-config.ts`): merge-only (add to a list, set an absent
  key), skip an unparseable file, YAML edited through the `yaml` Document API
  so comments and layout survive, a symlinked file written at its real target,
  an atomic temp-file-and-rename write that keeps the file mode, and a change
  record kept in `launch.json`.
- `mintSessionToken` (optional) mints the session id for a fresh or fork launch
  (`--session-id <uuid>` style CLIs such as copilot, gemini, qwen). The base
  validates it, passes it as `sessionToken`, and reports it as the resume token
  once ready. Late capture stays the fallback.
- `mintedTokenAwaitsCapture` (optional) keeps a minted id out of the launch
  result for CLIs that cannot resume a session until it holds a real exchange
  (GitHub Copilot). The descriptor's `captureResumeToken` then reports it once
  resumable, right after launch, from the refresher, or at restore, so a seat
  that was never prompted restores fresh.
- `validateResumeTarget(ctx)` (optional) runs before typing a resume with
  `{ token, cwd, seatStateDir, homedir, fs, binding }`; a refusal returns
  `retry_fresh` by default, so a missing session never silently starts fresh.
- `readyPatterns`, `gatePatterns` (each mapped to an
  `ATTENTION_REQUIRED_READINESS_CODES` code), and `errorPatterns` (each with
  an optional `recovery` and readiness `code`). Readiness honors the
  shell-foreground guard: a pane back at a shell is never ready and reports
  `runtime_exited`, whatever its scrollback says.
- A gate may carry an `answer` (`TuiCliGateAnswer`: `keys`,
  `expectOptionText`, `selectionMarker`, `dialogPath`, `describe`) for a
  folder-trust dialog the CLI shows on every launch. The base sends the keys
  once, and only during the seat's own launch wait, on lines this launch
  printed, when `dialogPath` returns a folder that normalizes to exactly the
  seat cwd or its realpath, and when the selected option on screen reads
  `expectOptionText`. A dialog whose folder or selection cannot be read yet
  (a capture taken mid-draw, or a folder that is not absolute) is retried for
  a few polls; a different folder or a different selected option stops at
  once. Otherwise, or if the dialog is still showing a few polls after the
  answer, the launch is `attention_required`. Each answer is
  logged and recorded in the seat's `launch.json` as `gateAnswers`. The GitHub
  Copilot adapter uses it to trust the seat cwd for that session only.
  `domain/seat-trust-answers.ts` reads the current launch's answers (the record
  must name the seat's session) for seat status (`trust_answers`), whoami
  (`trustAnswers`, only when present), and node detail (`trustAnswers`; not the
  list route), which the UI seat Overview renders.
- Launch polls readiness with an injectable sleep up to `launchTimeoutMs`, or up to the seat's `readiness_timeout_ms` (`NodeBinding.readinessTimeoutMs`) when the rig spec sets one. The same per-seat value replaces the startup orchestrator's 30 s readiness poll, the successor launcher's poll, Pi's runner-ready wait, the Claude/Codex/Pi resume checks, and Codex's extended boot-in-progress window.
  Before typing it records the pane's absolute line position (tmux
  `history_size + cursor_y`); every poll captures only the lines after it,
  with `capture-pane -J` so rows the terminal soft-wrapped at the pane width
  (possibly mid-word, on an 80-column pane) come back as the line the CLI
  printed. `-S`/`-E` address the same physical rows the position counts, so
  joining does not move the window's start. So
  ready, gate, and error text left in a reused pane's scrollback never counts,
  and an error the new run prints counts even if the same line is in older
  scrollback. A gate, an error pattern, or a timeout ends the wait with the
  last `evidenceLines` lines as evidence. A pane that returns to the shell
  after the CLI was seen, or whose new lines show an error pattern or a
  missing binary (`command not found`, `not found`), fails fast instead of
  timing out.
- After readiness the resume token is the resumed token, the minted token, or
  the descriptor's `captureResumeToken` result; a captured fork parent is
  refused.
- Guidance merges as managed blocks into the descriptor's `guidanceFile` with
  the `rig-role` skip; skills project into `skillsDir` or are skipped honestly.
- `resume(request)` relaunches with the persisted token and maps
  `attention_required` / `retry_fresh` for the restore orchestrator.

Tests use the hermetic harness `packages/daemon/test/helpers/tui-cli-adapter-harness.ts`
(`mockTmux`, `atShell`, `memFs`, `noSleep`) and the contract suite
`runTuiCliAdapterContract` in `test/helpers/tui-cli-adapter-contract.ts`. The
test-only `example-cli` fixture (`test/helpers/example-cli-runtime.ts`) proves
both and is never registered in production.

## Capability hooks

Optional, read-only hooks that a runtime implements and core consumes, added
before the features that use them (`packages/daemon/src/domain/runtime-capabilities.ts`).
Every hook reads local files and environment only: no network, no login, no
keychain, no writes. Core calls a hook only through its runner, which never
throws and never hangs: a throw, or a miss of the runner's deadline
(`CAPABILITY_TIMEOUTS_MS`: 2s for auth, 5s for usage and transcript; callers
may pass `timeoutMs`), becomes the hook's unknown value (`null`, or
`state: "unknown"` with a `detail`). The logged reason and the `detail` name
only the error's `name` and `code`, never its message, because a `JSON.parse`
error quotes the file it read and could leak key text. `checkModelShape`
ignores `g` and `y` flags on a declared pattern so repeated checks agree. Seat
hooks receive `RuntimeSeatReadInput` (`sessionName`, `cwd`, `seatStateDir`,
`homedir`, `resumeToken`, and `launchStartedAt`, which the runner fills from
the seat's `launch.json`). No built-in runtime declares a hook yet, so
`claude-code`, `codex`, `pi`, and `terminal` behave exactly as before.

| Hook | Where | Shape | Runner | Core consumer (feature PR) |
|---|---|---|---|---|
| `readUsage` | descriptor | `(input) => RuntimeUsageSnapshot \| null`; every metric optional (including `reasoningTokens`), plus `observedAt`, `source`, and `approximate` for CLIs that only report rounded counts. Token counts and `costUsd` are cumulative totals for the seat's current CLI session (consumers replace the previous snapshot, never sum); `contextUsedTokens` is the current context fill; `model` and `contextWindowTokens` come from the CLI's own record. `costUsd` needs `costSource` (`"cli_reported"` or `"estimated"`); the runner drops a cost without it | `runDescriptorUsageRead` | usage poller in `context-monitor` / `usage-samples-store`, cost in `rig ps` (features 1, 4) |
| `authStatus` | descriptor | `(ctx) => { state: "signed_in" \| "missing" \| "unknown"; source?; hint?; detail? }`; ctx has read-only, size-capped `fs` and, only under `rig runtimes --probe`, a read-only `probe.exec` | `runDescriptorAuthStatus` | `rig runtimes` and the `rig doctor` runtimes section (feature 6) |
| `modelShape` | descriptor | `{ pattern; example; note?; aliases? }` | `checkModelShape` (pure) | warn-only preflight model advisory (feature 7) |
| `docsPath` | descriptor | repo-relative docs page | n/a | `rig runtimes` docs link (feature 6) |
| `readTranscript` | descriptor | `(input) => { source; entries: { role; text; at? }[]; truncated? } \| null` | `runDescriptorTranscriptRead` (keeps the newest `maxEntries`) | `domain/native-transcript.ts` for the transcript routes (`source=auto` prefers it, `native` requires it, `pane` skips it), always redacted; implemented by `cline`, `opencode`, `kilo`, `gemini`, `qwen`, and `goose` (not `antigravity`: its store is unverified) (feature 5) |
| `busyPatterns` | `TuiCliRuntimeSpec` | the CLI's busy markers | n/a | read by `classifyActivity` |
| `inputPromptPatterns` | `TuiCliRuntimeSpec` | in-session prompts that wait for the operator (tool or command approval, mid-session confirms, blocking update dialogs); never affect launch or readiness | n/a | read by `classifyActivity` as needs_input |
| `classifyActivity` | `RuntimeAdapter` (optional), implemented once in `TuiCliRuntimeAdapter` | `(binding) => "working" \| "idle" \| "needs_input" \| null`, read from the visible screen only (never scrollback). In-session prompts and busy markers match only in the bottom status region (`ACTIVITY_STATUS_LINES` non-blank lines), so an answered prompt or an old busy line higher in the history never counts. Gates (full-screen launch dialogs) match anywhere on the visible screen, unless a busy or ready marker in the status region appears after the gate (a line-printing CLI such as aider keeps an answered gate in view above its fresh prompt); a gate declaring `currentWhileReady` (its pattern proves it is current, like Copilot's sign-in line anchored above the input box) counts in the status region even with a ready marker. Pane at a shell is null, then prompt or live gate is needs_input, busy is working, ready is idle, otherwise null so a wrong guess never suppresses a wake | n/a | activity taxonomy and `rig ps` for registry runtimes; claude-code, codex, and pi keep their own sources (feature 2) |

Feature 2 wiring: `SeatActivityService` (the 1 Hz seat sweep) takes a
`paneClassifier` (startup resolves each registry runtime's adapter). Seats on a
registry CLI runtime declare `TUI_CLI_ACTIVITY_RUNG_INVENTORY`: every sweep
reports the classification as `needs-input-chrome` evidence (authoritative;
count 1 for needs_input, else 0, so an answered prompt clears on the next sweep)
and, for working or idle, as `pane-markers` evidence. `pane-markers` enters at
trial: it is measured against `window-sampling` and decides working/idle only
after promotion, so an unverified busy marker never holds a seat at working.
This feeds the arbitrated seat state that `rig ps` (`activityState`), the TUI
(`seat.activity_changed`), and the parked and queue-waiting sweeps read. The
per-runtime markers live in `adapters/cli/activity-markers.ts` with the CLI
version and source each string was read from (none verified on a signed-in
screen).

Per-seat permission modes (`permissionModes`) are added with their consumer in
the feature-3 PR, not here.

Usage (feature 1). `cline`, `opencode`, `kilo`, `gemini`, `qwen`, and `aider`
declare `readUsage` (readers under `adapters/cli/<id>/usage.ts`, keyed by the
seat's resume token); `copilot`, `cursor`, `grok`, and `antigravity` declare
none until an on-disk usage record is verified. On every `ContextMonitor` tick,
after the claude/codex pass, `attachRegistryUsage` reads each running registry
seat through `runDescriptorUsageRead` and stores the reading in
`runtime_usage` (migration 505, `RuntimeUsageStore`, one row per node). When
the CLI reports the context in use, it also writes `context_usage` (a
percentage only when the CLI reports its context window) and a
`usage_samples` context sample. `sampled_at` there is the read time, so the
occupant-generation guard compares when OpenRig read it; the CLI's own record
time stays in `runtime_usage.observed_at`. The node inventory attaches the
current session's reading as `runtimeUsage`, and `rig ps --nodes --full` shows
it in the `COST` column. Every cost carries its provenance, `costSource`
(`cli_reported` when the CLI computed it, `estimated` otherwise); the F1 runner
drops a cost without one, and `~` in the column marks an estimated cost.

Context alerts (feature 4). No new detector: the registry pass writes
`context_usage` and `usage_samples` exactly as the claude/codex pass does, so
the existing `context.pressure` health detector (`LiveContextHealthSource`,
thresholds from `health.context_pressure.*`, default 95/99) covers registry
seats too. It needs a percentage, so only a CLI that reports its context window
can alert (qwen today). There is no auto-compaction for CLI seats: the claude
compaction enforcer stays claude-only, and OpenRig never types into a live CLI;
each runtime page names the CLI's own compaction where it has one.

## 7. Adding a runtime adapter

1. Create `packages/daemon/src/adapters/cli/<id>/index.ts` exporting a
   `CliRuntimeRegistration`: the `RuntimeDescriptor` and
   `createAdapter(deps)`, usually `new TuiCliRuntimeAdapter(spec, deps)`.
   Import token floors from `domain/resume-token-formats.ts`; never import the
   registry at runtime. Keep per-seat CLI state under `seatStateDir` (for
   example a per-seat session DB via the launch env) so capture is unambiguous
   when pod-mates share a cwd; a capture hook returns null when the match is
   ambiguous. Probe a real CLI only on its own tmux server (`tmux -L <name>`)
   and end probes with `kill-server`, never by typing into the pane.
2. Register it with one import and one entry in
   `packages/daemon/src/adapters/cli/index.ts`, alphabetical by id.
3. Add `packages/daemon/test/<id>-runtime-adapter.test.ts` that calls
   `runTuiCliAdapterContract(...)` (with `seedSession` when the descriptor
   captures tokens, `earlyExit` and `missingResumeToken` when they apply) and
   adds runtime-specific tests (exact argv, token capture, env). Keep it
   hermetic: no real binary, no network.
4. Add `docs/reference/runtimes/<id>.md` and one line in
   `docs/reference/runtimes/README.md`, alphabetical.
5. Optional: a brand entry in `packages/ui/src/lib/runtime-brand.ts` and a
   mark in `packages/tui/src/topology/runtime-marks.ts`. Without them the
   runtime renders with the generic fallback.

Nothing else changes: preflight, verification, resume validation and capture,
restore dispatch, teardown, discovery, and the adapter map pick the runtime up
from the registration.

## See also

- `daemon-core.md` — where `createDaemon` constructs the runtime adapters.
- `agent-spec-and-startup.md` — the `StartupOrchestrator` that calls these
  adapters and owns startup-action execution after `checkReady()`.
- `lifecycle-snapshot-restore.md` — how persisted resume tokens flow into
  snapshot/restore (resume vs rebuild vs fresh).
- `../../reference/runtimes/README.md`: the runtime index.
- `architecture-rules-and-event-system.md` — the full architecture rule list.
- Source roots: `packages/daemon/src/domain/runtime-adapter.ts`,
  `packages/daemon/src/domain/{runtime-registry,runtime-capture,process-tree-reaper,built-in-runtimes}.ts`,
  `packages/daemon/src/adapters/cli/`,
  `packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,pi-runtime-adapter,omp-runtime-adapter,stub-runtime-adapter,terminal-adapter,yolo-mode,non-interruptive,kernel-authority}.ts`,
  `packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id,claude-managed-launch,codex-network-default,native-permission-store}.ts`,
  `packages/daemon/src/domain/permission-policy/policy-ref.ts`.
