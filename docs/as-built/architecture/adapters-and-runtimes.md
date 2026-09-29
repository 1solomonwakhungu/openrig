---
kind: as-built
title: Adapters and Runtimes — Claude/Codex/Terminal, tmux/cmux, Resume Honesty
status: active
topics: [agent-runtime, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need the runtime-adapter contract — how OpenRig launches and resumes a
  Claude Code, Codex, or terminal harness inside tmux, what the five adapter
  methods do, or how the daemon honestly assesses whether a harness actually
  resumed vs fresh-launched (the resume-honesty layer). Also covers the
  runtime registry, the table-driven TUI CLI base adapter, and the checklist
  for adding a new runtime adapter.
siblings: [daemon-core.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-09-29
---

# Adapters and Runtimes

How OpenRig drives the agent harnesses. The daemon never talks to Claude Code,
Codex, or a shell directly — it talks to a `RuntimeAdapter`. Three adapters
implement one five-method contract; a separate resume-honesty layer answers the
question "did this harness *actually* resume, or did it silently fresh-launch?"
truthfully rather than optimistically.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). All source in this module is **present at `v0.3.0`**
> (`git cat-file -e v0.3.0:<path>` for all 7 files → present) — the adapter
> layer is core reboot-era machinery, **not** a 0.3.x feature; do not
> back-attribute (§10.8 version-attribution proof technique).

> Drift-fix (scope) — `architecture.md` §5 "Runtime adapters" carries **no
> slice-00 numeric drift** (proposed-structure §4.2: "adapter contract is
> current"). The corrections below are *precision* refinements where the source
> is more specific than the prose, not stale-count fixes. Each is annotated
> inline and re-confirmed at HEAD.

## 1. The five-method RuntimeAdapter contract

`RuntimeAdapter` is `packages/daemon/src/domain/runtime-adapter.ts:127`
(`interface RuntimeAdapter`). Every adapter declares a `readonly runtime`
string and implements exactly five methods (`runtime-adapter.ts:128–153`):

| Method | Signature (`runtime-adapter.ts`) | Responsibility |
|---|---|---|
| `listInstalled` | `(binding)` `:131` | List currently installed/projected resources for a node. |
| `project` | `(plan, binding)` `:134` | Project resources from a `ProjectionPlan` to the runtime's target locations. |
| `deliverStartup` | `(files, binding)` `:137` | Deliver resolved startup files to the runtime. |
| `launchHarness` | `(binding, opts)` `:147` | Launch the harness inside the bound tmux session; return a resume token. |
| `checkReady` | `(binding)` `:153` | Probe whether the harness is responsive and ready. |

Startup *action* execution (`slash_command` / `send_text`) is explicitly **not**
part of this contract — the contract docstring (`runtime-adapter.ts:121–125`)
states actions belong to the `StartupOrchestrator` *after* `checkReady()`. The
orchestrator delivery split is in `agent-spec-and-startup.md`.

### `launchHarness` opts and the fork seam

`launchHarness` opts is `{ name: string; resumeToken?: string; forkSource?:
ForkSource }` (`runtime-adapter.ts:147–150`).

> Drift-fix (precision) — `architecture.md` §4 said `launchHarness(binding,
> opts: { name, resumeToken? })`. Source adds a third, mutually-exclusive
> `forkSource` field. Per the contract docstring (`runtime-adapter.ts:142–146`)
> `resumeToken` and `forkSource` are mutually exclusive — if both are provided
> the adapter **must refuse** with a clear error, not guess; `forkSource`
> triggers a fork and the captured token is the NEW post-fork token, never the
> parent. `ForkSource` is `runtime-adapter.ts:116` (`kind: "native_id" |
> "artifact_path" | "name" | "last"`; v1 MVP accepts `native_id` only — other
> shapes rejected at schema validation, docstring `:106–119`).

### `HarnessLaunchResult` is a discriminated union with an honest failure arm

> Drift-fix (precision) — `architecture.md` §4 said `HarnessLaunchResult` is
> `{ ok, resumeToken?, resumeType?, error? }` (a single optional-field shape).
> Source is a **discriminated union** (`runtime-adapter.ts:81–86`):
> `| { ok: true; resumeToken?; resumeType? }`
> `| { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence? }`.
> The failure arm carries a typed `recovery` hint
> (`HarnessLaunchRecovery = "retry_fresh" | "attention_required"`,
> `:79`) and optional `evidence` (last-N pane lines, flowed through to
> `RestoreNodeResult.attentionEvidence` for `attention_required` outcomes,
> `:83–86`). This is the honest-failure shape, not a smoothed optional `error`.

## 2. The three adapters

All three live under `packages/daemon/src/adapters/` and implement
`RuntimeAdapter` (Architecture Rule 1: zero Hono in `adapters/`).

### ClaudeCodeAdapter (`claude-code-adapter.ts:41`)

- `readonly runtime = "claude-code"` (`:42`).
- **Projects** to `.claude/` targets: `guidance_merge` → `<cwd>/CLAUDE.md`
  (`:127`); `skill_install` → `<cwd>/.claude/skills/<name>/` (`:71,133`);
  subagents → `.claude/agents`, plugins → `.claude/plugins/<id>`,
  runtime resources → `.claude/extensions/<id>`, settings fragments merged
  into `.claude/settings.local.json` (`:388–400`).
- **Launches** (`:213–215`): fresh = `claude <permissionMode> --session-id
  <generatedId> --name <name>`; resume = `claude <permissionMode> --resume
  <token> --name <name>`; fork = `claude <permissionMode> --resume <parentId>
  --fork-session --name <seat>` (`:188`).
  > Drift-fix (precision) — `architecture.md` §5 said only "launches via
  > `claude --name <name>`, resumes via `claude --resume <token>`". Source
  > shows fresh launch uses an explicit `--session-id` (so a deterministic
  > resume token exists immediately) and the fork branch exists. Re-confirmed
  > `claude-code-adapter.ts:188,213–215` @HEAD.
- **Readiness** (`checkReady`, `:239`): verifies tmux session alive, captures
  40 pane lines + pane command, delegates to `assessNativeResumeProbe` (§3);
  ready only when probe `status === "resumed"`. The resume-launch verification
  loop `verifyResumeLaunch` retries up to **16 attempts** (`:273`), failing
  loudly with `recovery: "retry_fresh"` on `no_conversation_found`
  (`:284–289`) — no silent fresh fallback.

### CodexRuntimeAdapter (`codex-runtime-adapter.ts:37`)

- `readonly runtime = "codex"` (`:38`).
- **Projects** to `.agents/` targets: `guidance_merge` → `<cwd>/AGENTS.md`
  (`:139,330`); `skill_install` → `<cwd>/.agents/skills/<name>/` (`:89,145`);
  skills resolve under `.agents/skills/<id>` (`:377`).
- **Launches/resumes** (`:205,225–226`): fresh launch then capture a fresh
  thread id; resume = `codex<profileArg> resume<queueStateDirArg> <token>`;
  fork = `codex<profileArg> fork<queueStateDirArg> <parentId>` (`:205`). On
  success returns `{ ok: true, resumeToken: threadId, resumeType: "codex_id" }`
  (`:222,245,250`).
  > Drift-fix (precision) — `architecture.md` §5 said "launches via `codex`,
  > resumes via `codex resume <threadId>`". Source confirms the `codex resume
  > <token>` shape (`:226`) and adds the fork branch + the
  > `resumeType: "codex_id"` tag. Re-confirmed @HEAD.
- Refuses `resumeToken` + `forkSource` together with a clear error
  (`:180–181`) — honors the mutual-exclusivity contract.

### TerminalAdapter (`terminal-adapter.ts:19`)

- `readonly runtime = "terminal"` (`:20`).
- **All operations are no-ops** — "the shell IS the harness"
  (`terminal-adapter.ts:15`): no-op `project`/`deliverStartup`/`launchHarness`
  (`:34`), and `checkReady` returns ready immediately as soon as the tmux
  session exists (`:47`). Used for infrastructure nodes — servers, log tails,
  build watchers. (A terminal node cannot fork; the runtime-adapter docstring
  notes fork-unsupported adapters refuse with a runtime-mismatch error,
  `runtime-adapter.ts:113–115`.)

These three are constructed by `createDaemon` step 4 (`startup.ts`; see
`daemon-core.md` §4 "Startup sequence").

## 3. Resume honesty

The daemon does not assume a harness resumed just because the launch command
ran. Three domain files (`packages/daemon/src/domain/`, all present @v0.3.0)
make resume assessment honest:

### `native-resume-probe.ts`

`assessNativeResumeProbe(input)` (`native-resume-probe.ts:43`) reads pane
command + pane content and returns one of four honest statuses
(`NativeResumeProbeStatus`, `:6`):

- `resumed` — runtime-specific indicators confirm a resumed session.
- `failed` — terminal failure (e.g. Claude printed "No conversation found" →
  code `no_conversation_found`, `:51–57`).
- `inconclusive` — we don't know yet (e.g. Claude trust gate, code
  `trust_gate`, `:65–70`).
- `attention_required` — alive and recoverable but **needs operator action**
  (e.g. Claude resume-selection prompt, code `claude_resume_selection_prompt`,
  `:58–64`). This is the proxy for "an operator must choose the conversation";
  it is *distinct* from `inconclusive` and `failed` (docstring `:3–5`).

`buildNativeResumeCommand` (`:27`) builds the resume command per runtime:
claude → `claude --resume <token> [--name <name>]` (`:35`); codex → `codex
resume <token>` (`:38`); other runtimes → `null` (`:40`).

This is Architecture Rule 15 in code: a failed resume is FAILED loudly; there
is no automatic fresh fallback (the adapter's `verifyResumeLaunch` returns
`ok:false` with a `retry_fresh` recovery hint, never a silent relaunch).

### `resume-metadata-refresher.ts`

`ResumeMetadataRefresher` (`resume-metadata-refresher.ts:37`). Post-launch
resume-token capture: `refresh(sessions)` (`:62`) skips sessions that already
have a `resumeToken` (`:65`), and for `claude-code` sessions with a token runs
a `probeClaudeResume` returning `"resumable" | "not_resumable" |
"inconclusive"` (`:31,74–75`) — a real launch of the resume command in a
throwaway probe tmux session (`:106–111`), not a metadata guess.

### `codex-thread-id.ts`

Codex thread-id extraction (`codex-thread-id.ts`). Reads the Codex thread id
from the Codex *logs* SQLite databases under `~/.codex/`:
`readCodexThreadIdFromCandidateHomes(...)` (`:22`) →
`readCodexThreadIdFromLogs(...)` (`:49`) → `resolveCodexLogDbPaths(homeDir)`
(`:79`) which globs `<homeDir>/.codex/logs_<N>.sqlite` (`:84–89`,
regex `^logs_(\d+)\.sqlite$`) and falls back to `logs_1.sqlite` (`:97`).
Uses `better-sqlite3` (`:5`). Resolves the home dir by the harness PID
(`defaultResolveHomeDirByPid`, `:9`).

> Precision note — `architecture.md` §5 "Resume honesty" says codex thread IDs
> come from "the Codex SQLite database". Source is more specific: the
> per-version Codex *logs* DBs `~/.codex/logs_N.sqlite`. Stated precisely here;
> re-confirmed `codex-thread-id.ts:79–97` @HEAD.

## 4. Relevant Architecture Rules (source-verified at HEAD)

From `architecture.md` §7 (re-confirmed against the source cited inline):

- **Rule 5** — Runtime is member-authoritative in the pod-aware model.
- **Rule 13** — Readiness checking is a retry loop with exponential backoff and
  a configurable timeout, using adapter-specific probes (Claude TUI indicator,
  Codex ready message, terminal immediate). Re-confirmed: `checkReady`
  delegates to `assessNativeResumeProbe`; the retry loop is
  `claude-code-adapter.ts:273` (16 attempts).
- **Rule 14** — Resume states are locked: `resumed` / `rebuilt` / `fresh`;
  `rebuilt` = new process assembled from artifacts. (The probe layer adds
  `inconclusive` / `attention_required` as honest *transient* states, not
  outcomes — see §3.)
- **Rule 15** — Restore honesty: failed resume is FAILED loudly; no automatic
  fresh fallback; fresh launch is an explicit follow-up only. Enforced in code
  by §2/§3 (`verifyResumeLaunch` returns `ok:false`, never relaunches).

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

Deliberately claude/codex-only sites keep their own logic and degrade to the
generic tmux path for any other runtime: native permission selection
(`native-permission-selection.ts`), native process lineage
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
  resume (restore resumes through the same path). Failures are logged and never
  block the launch. Owner files are edited only through `ctx.mergeOwnerConfig`
  (`adapters/cli/owner-config.ts`): merge-only (add to a list, set an absent
  key), skip an unparseable file, YAML edited through the `yaml` Document API
  so comments and layout survive, a symlinked file written at its real target,
  an atomic temp-file-and-rename write that keeps the file mode, and a change
  record kept in `launch.json`.
- `mintSessionToken` (optional) mints the session id for a fresh or fork launch
  (`--session-id <uuid>` style CLIs such as copilot, gemini, qwen). The base
  validates it, passes it as `sessionToken`, and reports it as the resume token
  once ready. Late capture stays the fallback.
- `validateResumeTarget(ctx)` (optional) runs before typing a resume with
  `{ token, cwd, seatStateDir, homedir, fs, binding }`; a refusal returns
  `retry_fresh` by default, so a missing session never silently starts fresh.
- `readyPatterns`, `gatePatterns` (each mapped to an
  `ATTENTION_REQUIRED_READINESS_CODES` code), and `errorPatterns` (each with
  an optional `recovery` and readiness `code`). Readiness honors the
  shell-foreground guard: a pane back at a shell is never ready and reports
  `runtime_exited`, whatever its scrollback says.
- Launch polls readiness with an injectable sleep up to `launchTimeoutMs`.
  Before typing it records the pane's absolute line position (tmux
  `history_size + cursor_y`); every poll captures only the lines after it, so
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

- `daemon-core.md` — where `createDaemon` constructs the three adapters.
- `agent-spec-and-startup.md` — the `StartupOrchestrator` that calls these
  adapters and owns startup-action execution after `checkReady()`.
- `lifecycle-snapshot-restore.md` — how persisted resume tokens flow into
  snapshot/restore (resume vs rebuild vs fresh).
- `../../reference/runtimes/README.md`: the runtime index.
- Source roots: `packages/daemon/src/domain/runtime-adapter.ts`,
  `packages/daemon/src/domain/{runtime-registry,runtime-capture,process-tree-reaper}.ts`,
  `packages/daemon/src/adapters/cli/`,
  `packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,terminal-adapter}.ts`,
  `packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id}.ts`.
