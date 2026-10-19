---
kind: as-built
title: Community harness runtime field inventory
status: active
applies-when: |
  Comparing the fork's runtime descriptor and adapter seams with a future
  upstream community-harness draft, or locating each field's reader and tests.
siblings: [architecture/adapters-and-runtimes.md, test-layers.md, frontmatter-schema.md]
last-verified-against-source: f46f664ad0f035edb98338f70cf25d413082577f
last-updated: 2026-10-19
---

# Community harness runtime field inventory

This page inventories the fork's implemented `RuntimeDescriptor` fields, their
core readers, and existing test evidence at
`f46f664ad0f035edb98338f70cf25d413082577f`. It prepares the field table offered
in [upstream discussion #43](https://github.com/mvschwarz/openrig/discussions/43).
It defines no upstream API or conformance requirement.

The supplied contract audit found no author-facing upstream draft as of
2026-10-19 19:12 UTC, with upstream main at
`befd941e949ea4b87447ca37f5215da60f96f3a4`. The
[maintainer's plan](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19040164)
asks contributors to hold separate adapter PRs until the draft after 0.7.0.
The user's [Gemini testing offer](https://github.com/mvschwarz/openrig/discussions/43#discussioncomment-19046328)
provides context for preparation. These are supplied audit findings, not a
fresh upstream review by this document's author. The draft remains unavailable
within that audit boundary; upstream conformance has no defined target here.

The existing [adapter guide](architecture/adapters-and-runtimes.md) describes
registration, lifecycle and capability hooks. This page adds the complete
field-to-reader/test inventory without replacing that guide. The inventory
covers the top-level fields of
[`RuntimeDescriptor`](../../packages/daemon/src/domain/runtime-registry.ts),
then identifies the separate adapter specification needed to operate a CLI.
Named tests below describe assertions inspected in source; test execution is
reported separately by the change that introduces this page.

## Plain data

These values are strings or booleans in the current TypeScript descriptor.
Their meaning still depends on the named core reader. No external descriptor
file loader is established by this classification.

| Field | Actual core reader and behavior | Existing test evidence and limits |
|---|---|---|
| `id` | `add`, `getRuntimeDescriptor` and `runtimeSeatStateDir` in [runtime-registry.ts](../../packages/daemon/src/domain/runtime-registry.ts) key registration and seat state; `add` rejects malformed or duplicate IDs. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): “rejects duplicate ids, malformed ids, and resumeType without a validator”; registration/unregister and seat-state path assertions. |
| `displayName` | `buildRuntimeInventory` in [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts) copies it; `verifyCliRuntimesAvailable` in [rigspec-preflight.ts](../../packages/daemon/src/domain/rigspec-preflight.ts) uses it in install diagnostics. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): “preflight probes registered CLI binaries and names the install fix” asserts `Example CLI` in the error. |
| `kind` | [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts) copies it; [rigspec-schema.ts](../../packages/daemon/src/domain/rigspec-schema.ts) restricts fallback entries to agent runtimes; registry `add` restricts permission-mode declarations to agents. | [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): no-binary terminal fixture; [seat-permissions-registry-runtimes.test.ts](../../packages/daemon/test/seat-permissions-registry-runtimes.test.ts): “the registry refuses invalid declarations” rejects terminal permission modes. These do not exhaust every `kind` branch. |
| `binary` | `runtimeProbeCommand` in [runtime-registry.ts](../../packages/daemon/src/domain/runtime-registry.ts); `probeInstalled` in [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts); `RuntimeVerifier.verifyRegistered` in [runtime-verifier.ts](../../packages/daemon/src/domain/runtime-verifier.ts). Absent means no binary probe. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): built-in probe table; [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): missing, failing and absent binary cases with injected execution. |
| `installHint` | [runtime-verifier.ts](../../packages/daemon/src/domain/runtime-verifier.ts) and [rigspec-preflight.ts](../../packages/daemon/src/domain/rigspec-preflight.ts) include it in missing-binary diagnostics; inventory copies it. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): verifier install-hint and preflight install-fix assertions. |
| `resumeType` | `resumeTypeForRuntime` and `validateResumeToken` in [resume-token-validation.ts](../../packages/daemon/src/domain/resume-token-validation.ts); `deriveResumeToken` in [resume-token-capture.ts](../../packages/daemon/src/domain/resume-token-capture.ts); TUI adapter resume support. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): registered validation/capture, no-capture no-op and registered restore dispatch. Declaring a type alone does not implement resume. |
| `supportsFork` | [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts) advertises it; `TuiCliRuntimeAdapter.launchHarness` in [tui-cli-runtime-adapter.ts](../../packages/daemon/src/adapters/cli/tui-cli-runtime-adapter.ts) refuses unsupported forks. | [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): capability projection; [shared adapter contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): supported-fork/new-token or unsupported-fork refusal branch, selected by descriptor. |
| `guidanceFile` | TUI adapter `guidancePath` resolves it; `registeredGuidanceCleanupFile` in [rig-teardown.ts](../../packages/daemon/src/domain/rig-teardown.ts) resolves cleanup. | [shared adapter contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): managed-block merge or honest skip; [rig-teardown.test.ts](../../packages/daemon/test/rig-teardown.test.ts): “strips managed blocks from a registered runtime's guidance file”. |
| `cleanupGuidanceOnTeardown` | `registeredGuidanceCleanupFile` and `legacyGuidanceCleanupFile` in [rig-teardown.ts](../../packages/daemon/src/domain/rig-teardown.ts) skip cleanup when false. | [rig-teardown.test.ts](../../packages/daemon/test/rig-teardown.test.ts): “leaves Pi's AGENTS.md alone (pre-registry behavior preserved)”. This verifies the built-in opt-out, not every CLI's cleanup lifecycle. |
| `captureIsSessionScoped` | `runDescriptorTokenCapture` in [runtime-capture.ts](../../packages/daemon/src/domain/runtime-capture.ts) skips ambiguous shared-cwd capture unless session-scoped or a launch record has a preset token. | [sibling-seat-guard.test.ts](../../packages/daemon/test/sibling-seat-guard.test.ts): shared-cwd hook not called, minted-token exception, isolated OpenCode databases and built-in scoped capture. |
| `internal` | [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts) hides internal entries; [rigspec-schema.ts](../../packages/daemon/src/domain/rigspec-schema.ts) excludes them from legacy runtime and fallback selection. | [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): “internal runtimes are hidden; the real registry lists every public runtime”; [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): legacy schema excludes stub. |
| `reapProcessTreeOnStop` | `reapingRuntimeForSession` and `createRuntimeStopHook` in [process-tree-reaper.ts](../../packages/daemon/src/domain/process-tree-reaper.ts) opt a runtime into PID-scoped teardown. | [process-tree-reaper.test.ts](../../packages/daemon/test/process-tree-reaper.test.ts): opted-in stop hook, stale launch record, matching-record fallback and reused-PID cases. Process signals are injected. |
| `docsPath` | `buildRuntimeInventory` in [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts) copies it or returns null. | [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): “reports what each runtime supports, straight from its descriptor” asserts the path. This checks projection, not link existence; the registry test separately checks conventional per-runtime docs pages. |

## Schema-shaped data

These values have structure or matching semantics. The source accepts
TypeScript values; “schema-shaped” does not mean a published JSON/YAML schema
exists for them. In particular, `RegExp` needs an explicit representation and
matching policy before a future data format could carry it.

| Field | Actual core reader and behavior | Existing test evidence and limits |
|---|---|---|
| `versionArgs` | `runtimeProbeCommand` in [runtime-registry.ts](../../packages/daemon/src/domain/runtime-registry.ts), verifier and inventory probe readers; defaults to `["--version"]`. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): verifier gets `example-cli version`; [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): injected executor gets `["mycli", "-v"]`. |
| `permissionModes` | Registry `add` validates `floor`/`full_bypass`; `registryPermissionModes` in [native-permission-selection.ts](../../packages/daemon/src/domain/native-permission-selection.ts) exposes allowed choices. | [seat-permissions-registry-runtimes.test.ts](../../packages/daemon/test/seat-permissions-registry-runtimes.test.ts): invalid declarations, per-runtime acceptance/refusal, persisted selection and distinct typed launch commands. Typed flags do not establish native permission enforcement. |
| `paneCommands` | Registry `add` rejects generic hosts; `registeredRuntimeForCommand` in [session-fingerprinter.ts](../../packages/daemon/src/domain/session-fingerprinter.ts) matches exact foreground names; [seat-identity-reconciler.ts](../../packages/daemon/src/domain/seat-identity-reconciler.ts) uses the same declaration. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): rejects `node`; registered runtime discovery and seat identity assertions use injected pane state. |
| `processMatch` | `SessionFingerprinter` and `processMatches` in [session-fingerprinter.ts](../../packages/daemon/src/domain/session-fingerprinter.ts) match the program/script path, with string or `RegExp`; arbitrary arguments do not identify a runtime. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): program-versus-arguments cases, regex script match, interpreter handling and node-hosted fixture discovery. |
| `modelShape` | `modelShapeAdvisories` in [model-shape-advisory.ts](../../packages/daemon/src/domain/model-shape-advisory.ts) calls `checkModelShape` in [runtime-capabilities.ts](../../packages/daemon/src/domain/runtime-capabilities.ts). Shape contains `pattern`, `example`, optional `note` and `aliases`; preflight warns on a mismatch. | [runtime-capabilities.test.ts](../../packages/daemon/test/runtime-capabilities.test.ts): aliases and repeatable `g`/`y` matching; [model-shape-advisory.test.ts](../../packages/daemon/test/model-shape-advisory.test.ts): preflight warning keeps the rig ready. A launch builder can separately refuse a model. |

## Behavior requiring an adapter or hook

Each field below is executable code. Moving the surrounding metadata into a
future data format would still leave these operations to an implementation.

| Field | Actual core reader and behavior | Existing test evidence and limits |
|---|---|---|
| `verify` | `RuntimeVerifier.verifyRegistered` in [runtime-verifier.ts](../../packages/daemon/src/domain/runtime-verifier.ts) calls it after a verified probe; a returned error changes verification status. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): “the verifier probes a registered runtime and runs its verify hook”; Pi engine-floor case. This runner is separate from capability-hook deadline handling. |
| `validateResumeToken` | [resume-token-validation.ts](../../packages/daemon/src/domain/resume-token-validation.ts) calls it after generic token checks; TUI adapter `validateToken` also uses it. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): registered validator/capture rejects malformed tokens; [resume-token-validation.test.ts](../../packages/daemon/test/resume-token-validation.test.ts): ID and path token floors, whitespace and redaction cases. Format validity does not prove a native session exists. |
| `captureResumeToken` | `runDescriptorTokenCapture` in [runtime-capture.ts](../../packages/daemon/src/domain/runtime-capture.ts) normalizes string/null/outcome results; `deriveResumeToken` in [resume-token-capture.ts](../../packages/daemon/src/domain/resume-token-capture.ts) validates captured tokens. TUI launch also uses the runner. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): valid/invalid capture, missing hook, thrown hook and recovered launch timestamp; [shared adapter contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): late capture through refresher and restore. Capture has no runner deadline here. |
| `skillsDir` | TUI adapter `skillsDir`, `projectEntry` and `listInstalled` in [tui-cli-runtime-adapter.ts](../../packages/daemon/src/adapters/cli/tui-cli-runtime-adapter.ts) resolve the skill destination; absent means skip. | [shared adapter contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): “projects skills into the runtime skills dir” or “skips skills honestly”, including copied `SKILL.md`, nested reference and installed listing. |
| `trackedGuidanceRedirect` | TUI adapter `guidanceDestination` calls it and passes the path to [guidance-target.ts](../../packages/daemon/src/domain/guidance-target.ts); [seat-guidance-files.ts](../../packages/daemon/src/domain/seat-guidance-files.ts) also resolves cleanup targets. | [guidance-tracked-file.test.ts](../../packages/daemon/test/guidance-tracked-file.test.ts): “TUI CLI base: redirect uses the descriptor's trackedGuidanceRedirect”; tracked original stays unchanged. |
| `guidanceRoot` | TUI adapter `guidancePath` and [seat-guidance-files.ts](../../packages/daemon/src/domain/seat-guidance-files.ts) resolve a root other than cwd; [rig-teardown.ts](../../packages/daemon/src/domain/rig-teardown.ts) also handles the legacy cwd file. | [cline-guidance-root.test.ts](../../packages/daemon/test/cline-guidance-root.test.ts): repository root, subdirectory, outside-repository and cleanup symmetry; [rig-teardown.test.ts](../../packages/daemon/test/rig-teardown.test.ts): root and legacy cwd cleanup. |
| `permissionPostureFor` | `inspectRegistryPermission` in [permission-drift.ts](../../packages/daemon/src/domain/permission-drift.ts) maps an observed permission value back to the expected posture comparison. | [permission-drift-observer.test.ts](../../packages/daemon/test/permission-drift-observer.test.ts): “compares a registry runtime's recorded posture with the seat's node or rig policy”. This compares recorded launch evidence, not enforcement inside the CLI. |
| `readUsage` | `runDescriptorUsageRead` in [runtime-capabilities.ts](../../packages/daemon/src/domain/runtime-capabilities.ts); registry usage pass in [context-monitor.ts](../../packages/daemon/src/domain/context-monitor.ts) persists session usage and context samples. | [runtime-capabilities.test.ts](../../packages/daemon/test/runtime-capabilities.test.ts): missing/throw/timeout and cost provenance; [runtime-usage-poller.test.ts](../../packages/daemon/test/runtime-usage-poller.test.ts): running-seat persistence, stopped-seat skip, previous-session exclusion and null/throw behavior. |
| `authStatus` | `runDescriptorAuthStatus` in [runtime-capabilities.ts](../../packages/daemon/src/domain/runtime-capabilities.ts); `buildRuntimeInventory` in [runtime-inventory.ts](../../packages/daemon/src/domain/runtime-inventory.ts) supplies local auth context, optionally probe execution. | [runtime-capabilities.test.ts](../../packages/daemon/test/runtime-capabilities.test.ts): unknown fallback, timeout and parse-error secret filtering; [runtime-inventory.test.ts](../../packages/daemon/test/runtime-inventory.test.ts): probe execution supplied only when requested. No live login acceptance is established. |
| `readTranscript` | `runDescriptorTranscriptRead` in [runtime-capabilities.ts](../../packages/daemon/src/domain/runtime-capabilities.ts); `readNativeSeatTranscript` in [native-transcript.ts](../../packages/daemon/src/domain/native-transcript.ts) renders and redacts results. | [runtime-capabilities.test.ts](../../packages/daemon/test/runtime-capabilities.test.ts): missing/throw/timeout, newest-entry cap; [native-transcript-readers.test.ts](../../packages/daemon/test/native-transcript-readers.test.ts): fixture parsing and registered reader presence. These fixtures do not establish live CLI transcript fidelity. |

The capability runners bound asynchronous waits (auth 2 seconds, usage and
transcript 5 seconds by default). They cannot interrupt synchronous work.
Those deadlines and error-message filtering do not apply to every descriptor
hook; capture and verification have separate readers.

## The separate adapter specification

A descriptor does not supply launch argv, readiness or native resume behavior.
[`CliRuntimeRegistration`](../../packages/daemon/src/adapters/cli/types.ts)
contains both `descriptor` and `createAdapter(deps)`.
[`createCliRuntimeAdapters`](../../packages/daemon/src/adapters/runtime-adapter-map.ts)
invokes that factory and checks its runtime ID; the registry tests reject ID
mismatches and collisions. A registration is compiled into
[`adapters/cli/index.ts`](../../packages/daemon/src/adapters/cli/index.ts).
This source seam does not establish external plugin discovery or loading.

For interactive CLIs, the existing `TuiCliRuntimeSpec` and its readers live in
[tui-cli-runtime-adapter.ts](../../packages/daemon/src/adapters/cli/tui-cli-runtime-adapter.ts).
Its top-level fields are separate from `RuntimeDescriptor`:

| Fields | Actual reader | Existing test evidence |
|---|---|---|
| `descriptor` | Constructor and descriptor readers above. | [runtime-registry.test.ts](../../packages/daemon/test/runtime-registry.test.ts): adapter map checks; [shared contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): accepted descriptor and matching adapter ID. |
| `buildLaunchCommand`, `env` (`set`, `denyByDefault`, `allow`) | `buildShellCommand` invokes the builder and applies shell quoting and environment policy. | [tui-cli-runtime-adapter.test.ts](../../packages/daemon/test/tui-cli-runtime-adapter.test.ts): exact shell-quoted command, real POSIX-shell environment allowlist and inherited-environment case. Both builder and `env.set` are code. |
| `prepareLaunch`, `mintSessionToken`, `mintedTokenAwaitsCapture`, `validateResumeTarget` | `launchHarness`, `prepare` and `checkResumeTarget` provision state, mint or defer a token and refuse missing resume targets before typing. | [tui-cli-runtime-adapter.test.ts](../../packages/daemon/test/tui-cli-runtime-adapter.test.ts): minting, malformed ID, owner-config preparation and preparation throw; [shared contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): missing-target refusal and late capture. Gap: this inventory does not establish a dedicated generic assertion for the `mintedTokenAwaitsCapture` switch itself. |
| `readyPatterns`, `gatePatterns`, `errorPatterns` | Constructor, `readPane`, `matchError` and `waitForReady` interpret regexes and typed gate/error records, with a foreground-shell guard. Gate answers can also contain a `dialogPath` function. | [shared contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): ready launch, attention gates, error screens, shell exit, stale scrollback and timeout; [tui-cli-runtime-adapter.test.ts](../../packages/daemon/test/tui-cli-runtime-adapter.test.ts): constructor validation. Coverage depends on the fixture screens passed by each runtime. |
| `busyPatterns`, `inputPromptPatterns` | `classifyActivity` reads the visible screen's status region. | [runtime-capabilities.test.ts](../../packages/daemon/test/runtime-capabilities.test.ts): gate/busy/ready precedence, visible-screen-only reads, stale busy line and unknown fallback. Gap: those tests do not directly exercise `inputPromptPatterns`. |
| `launchTimeoutMs`, `pollIntervalMs`, `evidenceLines` | `waitForReady` chooses timeout/poll values; `evidence` selects the failure tail. A binding's `readinessTimeoutMs` takes precedence over the spec timeout. | [shared contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts): timeout; [tui-cli-runtime-adapter.test.ts](../../packages/daemon/test/tui-cli-runtime-adapter.test.ts): evidence tail and blank-padding cases. Gap: no exhaustive precedence/override assertion is claimed here. |
| `observeLaunch` | `launchHarness` invokes it after readiness and returns `appliedLaunch`. | [seat-permissions-registry-runtimes.test.ts](../../packages/daemon/test/seat-permissions-registry-runtimes.test.ts): selected posture launches and drift diagnosis. Gap: this inventory does not establish an isolated generic test for every observation result. |

The [shared contract](../../packages/daemon/test/helpers/tui-cli-adapter-contract.ts)
is instantiated by [tui-cli-runtime-adapter.test.ts](../../packages/daemon/test/tui-cli-runtime-adapter.test.ts)
with the test-only [example CLI](../../packages/daemon/test/helpers/example-cli-runtime.ts).
Its assertions are reusable fork engineering evidence against scripted panes,
injected files and execution. Per-runtime contract invocations add their own
fixture cases. Neither kind demonstrates a signed-in Gemini run or acceptance
against an upstream community-harness specification.

## Rechecking this inventory

Compare the fields in `RuntimeDescriptor` with the three descriptor tables,
then follow the linked symbols and assertions at the source stamp. Run the
relevant test files from the repository root with `npx vitest run <paths>`.
For documentation placement, use `node scripts/check-docs-guard.mjs` and its
unit tests. The guard checks tracked path placement only; it does not check
links, field coverage or factual accuracy. See [test-layers.md](test-layers.md)
for the broader repository checks and their limits.

The focused check for this document passed 327 tests across these 15 files
(Vitest 3.2.4 from the lockfile, after `npm ci --no-audit --no-fund`):

```sh
npx --no-install vitest run \
  packages/daemon/test/runtime-registry.test.ts \
  packages/daemon/test/runtime-inventory.test.ts \
  packages/daemon/test/runtime-capabilities.test.ts \
  packages/daemon/test/seat-permissions-registry-runtimes.test.ts \
  packages/daemon/test/sibling-seat-guard.test.ts \
  packages/daemon/test/process-tree-reaper.test.ts \
  packages/daemon/test/model-shape-advisory.test.ts \
  packages/daemon/test/guidance-tracked-file.test.ts \
  packages/daemon/test/cline-guidance-root.test.ts \
  packages/daemon/test/permission-drift-observer.test.ts \
  packages/daemon/test/runtime-usage-poller.test.ts \
  packages/daemon/test/native-transcript-readers.test.ts \
  packages/daemon/test/resume-token-validation.test.ts \
  packages/daemon/test/rig-teardown.test.ts \
  packages/daemon/test/tui-cli-runtime-adapter.test.ts
```

`npm run test:repo` also passed: 305 script tests passed, one opt-in
target-native packaging test was skipped, first-run references had zero
failures (five external references remained unchecked), and generated-file
checks completed. `node --test scripts/check-docs-guard.test.mjs` passed all
six tests; `node scripts/check-docs-guard.mjs` passed with this document staged.

A local Python check compared table rows with `readonly` fields in the
`RuntimeDescriptor` interface: all 28 appear exactly once. It also resolved
all 106 relative Markdown links in this page to existing files. These checks
cover field presence and link targets; the reader/test descriptions were
checked by reading the source.

Once an upstream draft exists, compare its actual fields and required behavior
with this inventory and record differences before preparing separate adapter PRs.
