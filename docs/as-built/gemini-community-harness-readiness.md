---
kind: as-built
title: Gemini community harness readiness
status: active
topics: [runtimes, community-harnesses, verification]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Preparing to test Gemini CLI against the community plug-in draft in upstream
  Discussion 43, or separating the fork's TUI behavior from earlier ACP reports.
prerequisite-reads: [../reference/harnesses/gemini-cli.md, ../reference/runtimes/gemini.md]
last-verified-against-source: f46f664ad0f035edb98338f70cf25d413082577f
last-updated: 2026-10-19
---

# Gemini community harness readiness

The useful preparation now is an evidence map and a verification plan. Keep the
Gemini adapter on the fork until the upstream draft contract is posted. The fork
implements an interactive TUI adapter; an ACP port remains future work.

## Upstream boundary and provenance

Read [Discussion #43](https://github.com/mvschwarz/openrig/discussions/43) through
GitHub's read-only GraphQL API on 2026-10-19. Its reported update time was
`2026-10-19T18:36:23Z`. The fetched comments and replies contained these decisions:

- The [community plan](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19040164)
  schedules the full plug-in work after 0.7.0, promises a draft contract first,
  and asks contributors to hold separate adapters. Community plug-ins stay with
  their maintainers; OpenRig will disclose that it has not tested them, their
  maintainer, and their limits before launch. Unknown state must be shown honestly.
- The [Gemini invitation](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19045798)
  asks us to try Gemini against that draft once posted.
- The [accepted offer](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19046328)
  commits to agent-reported ACP signals, screen fallback, and a version recheck at
  draft time; adapter PRs remain on hold. No draft contract was present in the
  fetched discussion. The original issue's protocol example is still a proposal.

Evidence below has three distinct origins:

1. **Current source inspection:** this fork at the full source stamp above,
   including tests. No Gemini process, model, daemon, or ACP probe was run for
   this page. Test assertions described below were read, not executed.
2. **Prior TUI evidence:** the [runtime note](../reference/runtimes/gemini.md) and
   pane fixtures record isolated Gemini CLI 0.61.0 checks with a fake key. Activity
   markers name `fb972b2f` (v0.62); the [activity fixture README](../../packages/daemon/test/fixtures/cli-panes/activity/README.md)
   explicitly calls those busy/approval screens synthesized, not captured.
3. **Prior ACP report:** the [2026-10-17 comment](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19005365)
   pins fork `bbfd090261aa649a8292f0b73e887aed75120d62` and Gemini CLI 0.64.0.
   It reports stdio ACP against a local mock model, throwaway home and fake key,
   without a real account or external model request. This page inspected that
   report, not a raw transcript or reproducible ACP runner. It establishes what
   was reported previously, not a fresh OpenRig integration result.

The [existing implementation note](../reference/harnesses/gemini-cli.md) is pinned
to `bbfd0902`; its numeric line references have drifted at this source stamp.
Its statement that ACP auth refusal was not covered is too broad: the public
report records unauthenticated `initialize` and a missing-key `session/new`
error, JSON-RPC `-32000`. Real-provider credential refusal, expiry and recovery
remain unverified. Neither that report nor this page refreshes account eligibility
claims or establishes that 0.64.0 is still the latest release.

## Current implementation and prior ACP evidence

Source entry points are the [Gemini descriptor and registration](../../packages/daemon/src/adapters/cli/gemini/index.ts),
[family spec and late capture](../../packages/daemon/src/adapters/cli/gemini-family/runtime.ts),
[launch arguments](../../packages/daemon/src/adapters/cli/gemini-family/launch-args.ts),
[session store](../../packages/daemon/src/adapters/cli/gemini-family/session-store.ts),
[TUI base](../../packages/daemon/src/adapters/cli/tui-cli-runtime-adapter.ts),
and [activity markers](../../packages/daemon/src/adapters/cli/activity-markers.ts).
The registration constructs `TuiCliRuntimeAdapter`; these Gemini modules contain
no ACP client or hook-based activity handling.

| Case | Current fork source and test boundary | Prior ACP 0.64.0 report; remaining gap |
|---|---|---|
| Busy | `classifyActivity` matches `(esc to cancel, <digit>` in the bottom 12 nonblank pane lines. Synthetic activity fixtures exercise the screen path. | Open `session/prompt` plus `session/update` tool/message events reported live against the mock. No OpenRig consumer of these events exists here. |
| Idle | The composer placeholder supplies idle; unknown screens return `null` to the caller's fallback. Readiness is also screen-based, with gates/errors checked before ready. | Prompt completion with `stopReason: end_turn` reported live. `cancelled`, `max_tokens`, `refusal`, and hooks were source-derived. Completion reason needs separate treatment from human attention and readiness. |
| Approval | In-session prompt patterns take precedence over busy. Trust/auth gates and startup dialogs are classified separately; Gemini gates have no automatic answer. Floor passes `--approval-mode auto_edit`; bypass passes `--yolo`. | `session/request_permission` with `proceed_always`, `proceed_once`, `cancel` reported live. No current bridge to the queue/send guard or human response lifecycle. Hook `Notification/ToolPermission` was source-derived. |
| Session identity | Fresh launch mints a UUID, records `launch.json` before typing, passes `--session-id`, and returns it at ready. Late capture requires that exact minted ID to have a resumable local session. | Agent-returned `session/new.sessionId` reported live. Future persistence must bind the agent's ID to this seat and launch; it must not use the TUI minting path as proof of agent-reported identity. |
| Resume | `gemini_session_id`; `--resume` excludes `--session-id`. Local precheck replays 0.61.0 JSONL messages/checkpoints/rewinds and requires a real prompt or nonempty model message. Missing target returns `retry_fresh`. | `loadSession` and `session/load` resume reported live. No raw replay evidence reviewed here and no OpenRig ACP restart/restore test. Capability advertisement alone does not prove restore continuity. |
| Fork | `supportsFork: false`; rejected before typing. Qwen's fork support in shared code does not imply Gemini support. | No Gemini ACP fork evidence in the report. Keep unsupported unless the draft and new evidence justify it. |

The minted-at-ready path can store an ID before the conversation is resumable;
late capture is stricter. A never-prompted ready seat can therefore fail the later
resume precheck. The [startup orchestrator](../../packages/daemon/src/domain/startup-orchestrator.ts)
permits fresh fallback in some contexts, while the [restore orchestrator](../../packages/daemon/src/domain/restore-orchestrator.ts)
disables it for pod-aware resume and maps unavailable continuity to
`awaiting-decision`. Preserve those policy distinctions when testing a new port.
The known daemon/pane `GEMINI_CLI_HOME` mismatch can also cause a false refusal.

## Stuck cases to carry into the draft review

- **Before a session:** missing binary/Node floor, folder trust, auth selection,
  missing API key, pending sign-in, IDE/keybinding consent, project-agent/policy
  discovery, MCP OAuth, extension-update consent, startup exit and timeout.
  `GEMINI_PANE_PATTERNS` supplies explicit attention reasons. Launch environment
  suppresses IDE dialogs; per-seat npm prefix/cache contain npm updates.
  Other package-manager updates are detected after starting, not prevented.
- **During a turn:** shell/edit approval, loop detection and quota/plan banners
  have screen patterns. Busy/approval fixtures are synthetic; loop and quota
  strings do not establish live detection or structured ACP equivalents.
  A model error ending a turn must remain distinguishable from approval waiting.
- **Lost continuity:** absent/malformed/stale token, empty conversation, deleted or
  unreadable store, mismatched cwd/home, and prefix-colliding session filenames.
  The local store checks the full ID. ACP load failures need their own evidence
  and explicit recovery mapping, rather than silently choosing a fresh session.
- **Unresponsive transport/process:** the TUI has a launch deadline and
  `reapProcessTreeOnStop`. There is no Gemini ACP timeout/cancellation supervisor
  here. A live process without a prompt result is not evidence of progress or idle.

## What the draft must define before implementation

These are questions for the draft, not a proposed plug-in API:

1. Which transport/version and capability negotiation are supported? Which
   operations may be unsupported, and which core consumer/tests enforce each
   declaration? How are community ownership, limits and untested status displayed?
2. What distinguishes initialized, session-created, ready-to-receive, working,
   idle, approval-waiting, unknown, failed and exited? What wins when an approval
   request overlaps fresh busy evidence, or structured evidence becomes stale?
3. Who may answer permission requests, how are options mapped to seat posture,
   and what happens on cancel, disconnect, timeout or unknown options? Does the
   delivery guard prevent queued messages from answering an approval?
4. How are agent-emitted opaque session references correlated, persisted,
   migrated and restored? Define cwd/home scope, late identity, nested processes,
   unsupported fork and failed-load behavior, including deliberate fresh fallback.
5. How many prompts may be in flight? Define queue/steering, cancellation,
   deadlines, unknown server requests, malformed events and child death. Avoid
   inventing a quiet-period threshold or restart policy before these are agreed.
6. Where do config, guidance, skills, transcript and usage readers belong? Define
   owner-state isolation, shutdown, telemetry provenance and screen fallback,
   including an explicit unknown result for unavailable quota/approval signals.

## Verification when the draft is posted

Pin the draft URL/revision, fork commit, plug-in revision, Gemini CLI version,
package integrity, Node/OS, ACP initialize response and capabilities. Recheck the
then-current release rather than extrapolating from 0.61/0.62/0.64. Capture sanitized
request IDs, session IDs, timestamps, events, results and exit status in a private
throwaway home/project. Retain a runnable probe and artifact hashes; keep keys out
of evidence. Use a local mock first and label any later real-provider run separately.

The first port should verify these assertions through the draft's actual shared
consumers, not only by inspecting protocol output:

- New session → prompt → work updates → terminal result: persist the returned ID,
  expose busy/idle accurately, and deliver the next queued task only when allowed.
- Permission request during fresh busy evidence: expose approval waiting and type
  no automatic task/ack into it. Exercise explicit allow/reject/cancel, disconnect,
  duplicate responses, unknown options and posture changes.
- Restart the private daemon and ACP child, load the same session, and demonstrate
  prior context with a deterministic mock sentinel. Use two seats sharing a cwd
  and another Node-based runtime; neither identity nor restore path may cross.
- Try missing, malformed, deleted, empty and wrong-scope sessions; failed load must
  preserve the draft's continuity policy. Reject unsupported fork without launch.
- Inject a never-resolving prompt, missing result after an error, child exit,
  malformed/unknown protocol requests and cancelled work. Check bounded completion
  or explicit unknown/failure, no false idle, no duplicate task delivery, and clean
  child/process teardown according to the agreed contract.
- Recheck pre-session auth/trust/config/update behavior and any remaining screen
  fallback at 80x24, including stale history. Compare owner config/install state
  before and after. Verify guidance/skills and label unsupported usage/quota data.

Existing executable reference coverage is in
[gemini-runtime-adapter.test.ts](../../packages/daemon/test/gemini-runtime-adapter.test.ts),
[gemini-family.test.ts](../../packages/daemon/test/gemini-family.test.ts),
[gemini-family-80col.test.ts](../../packages/daemon/test/gemini-family-80col.test.ts),
[gemini-family-auto-update.test.ts](../../packages/daemon/test/gemini-family-auto-update.test.ts),
[needs-input-activity.test.ts](../../packages/daemon/test/needs-input-activity.test.ts),
and the [shared TUI contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts).
The contract includes real refresher/restore consumers with scripted tmux/session
fixtures; it does not run Gemini or ACP. Reuse its behavior assertions where the
draft permits, without treating it as plug-in conformance evidence.

For this documentation-only preparation, verification consists of source review,
relative-link/source-stamp checks, `git diff --check`, and the tracked-docs guard.
No runtime suite was run; this isolated checkout has no installed Vitest.
