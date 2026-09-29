// Runtime registry: the single catalog of agent runtimes OpenRig can manage.
//
// A runtime used to be a free string enumerated at many sites (preflight,
// verifier, resume-token validation/capture, teardown, discovery, ...). Each
// of those sites now asks this registry instead, so adding a runtime is a new
// module under adapters/cli/<id>/ plus one line in adapters/cli/index.ts.
//
// Built-in descriptors reproduce the pre-registry behavior exactly. Sites that
// are deliberately claude/codex-only (native permission selection, provider
// telemetry, native process lineage, the first-run kernel) keep their own
// logic and degrade to a generic tmux path for any other runtime; see
// docs/as-built/architecture/adapters-and-runtimes.md.
//
// Import discipline: this module imports the CLI registration index at
// runtime, so nothing under adapters/cli/ may import this module at runtime
// (type-only imports are fine). Descriptors import token-format validators
// from resume-token-formats.ts, never from resume-token-validation.ts.

import nodePath from "node:path";
import { CLI_RUNTIME_REGISTRATIONS } from "../adapters/cli/index.js";
import {
  validateIdShapedToken,
  validatePiSessionFileToken,
  type ResumeTokenFormatResult,
} from "./resume-token-formats.js";
import type { ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { seatStateDirFor } from "./runtime-capture.js";

export type RuntimeKind = "agent" | "terminal";

/** Normalized result of a descriptor's read-only resume-token capture. The
 *  generic capture path format-validates a token before anyone persists it. */
export type RuntimeTokenCaptureOutcome =
  /** A required dependency is absent (older wiring / tests): silent no-op. */
  | { outcome: "noop" }
  /** Capture ran but produced no usable token: the caller records a skip. */
  | { outcome: "skipped"; reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "capture_error" }
  | { outcome: "token"; token: string };

/** What a capture hook may return: a normalized outcome (built-ins), or a
 *  token string / null (CLI runtimes). runDescriptorTokenCapture normalizes it
 *  and turns a throw into a logged skip. */
export type RuntimeTokenCaptureResult = RuntimeTokenCaptureOutcome | string | null | undefined;

export interface RuntimeTokenCaptureInput {
  sessionName: string;
  /** The seat cwd when the caller knows it. */
  cwd?: string | null;
  /** <OPENRIG_HOME>/state/<runtime id>/<session name> (seatStateDirFor). */
  seatStateDir: string;
  /** When the current launch started: passed on the post-launch capture and
   *  recovered from the seat's launch.json for late capture. */
  launchStartedAt?: Date;
  /** Home directory for CLIs that keep sessions under ~ (os.homedir() unless a
   *  caller or test redirects it). */
  homedir: string;
}

export interface RuntimeVerifyContext {
  exec: (cmd: string) => Promise<string>;
  /** Version parsed from `<binary> <versionArgs>`, or null when unparseable. */
  version: string | null;
}

export interface RuntimeSkillsDirContext {
  cwd: string;
  sessionName?: string;
  /** Root under which per-seat runtime state lives (<OPENRIG_HOME>/state). */
  stateRoot?: string;
  homedir?: string;
}

export interface RuntimeDescriptor {
  /** The rig-spec `runtime:` value. Lowercase, [a-z0-9-]. */
  readonly id: string;
  readonly displayName: string;
  readonly kind: RuntimeKind;
  /** Command name probed by preflight/verifier and checked by permission drift.
   *  Absent = nothing to probe (terminal, the pane-hosted stub runner). */
  readonly binary?: string;
  /** Args for the availability probe. Default ["--version"]. */
  readonly versionArgs?: readonly string[];
  /** Install instruction preflight shows when the probe fails, e.g.
   *  "npm install -g @google/gemini-cli". */
  readonly installHint?: string;
  /** Extra verification after the binary probe succeeds. Returns an error
   *  message to downgrade the verification, or null to keep it verified. */
  readonly verify?: (ctx: RuntimeVerifyContext) => Promise<string | null>;
  /** Persisted resume-token type. Absent = the runtime has no resume token. */
  readonly resumeType?: string;
  /** Format floor for a trimmed, non-empty token of `resumeType`. */
  readonly validateResumeToken?: (token: string) => ResumeTokenFormatResult;
  /** Read-only live capture of the resume token. Runs after launch readiness,
   *  at adoption and handover, from the periodic refresher, and once at restore
   *  when a seat has no persisted token (CLIs that create sessions lazily). */
  readonly captureResumeToken?: (
    input: RuntimeTokenCaptureInput,
    deps: ResumeTokenCaptureDeps,
  ) => Promise<RuntimeTokenCaptureResult> | RuntimeTokenCaptureResult;
  readonly supportsFork: boolean;
  /** Guidance file (relative to the seat cwd) that receives managed blocks. */
  readonly guidanceFile?: string;
  /** Whether rig teardown strips managed blocks from `guidanceFile`.
   *  Default true when guidanceFile is set. */
  readonly cleanupGuidanceOnTeardown?: boolean;
  /** Where projected skills land. Absent = skills are an honest skip. */
  readonly skillsDir?: (ctx: RuntimeSkillsDirContext) => string | null;
  /** Exact foreground process names that mean the runtime is running in the
   *  pane (discovery fingerprinting, seat identity reconciliation). Never
   *  "node" or another generic host: those are ambiguous, not identity. */
  readonly paneCommands?: readonly string[];
  /** For CLIs whose pane command is a generic host (npm-installed CLIs show
   *  "node"): matched against the program of each process in the pane's tree
   *  (via ps) during discovery: argv[0], or the script path when argv[0] is an
   *  interpreter. A string matches a basename or path segment run such as
   *  "@github/copilot"; a RegExp is tested against the program path. Other
   *  arguments never match (processMatches in session-fingerprinter.ts). */
  readonly processMatch?: string | RegExp;
  /** Internal/test-only runtimes: accepted by pod-aware specs, hidden from
   *  legacy specs and user-facing runtime lists. */
  readonly internal?: boolean;
  /** Reap the pane's process tree on stop (the CLI can outlive kill-session).
   *  PID-scoped, snapshot before the kill (process-tree-reaper.ts). Default false. */
  readonly reapProcessTreeOnStop?: boolean;
}

// ── Built-in descriptors (behavior-preserving) ──────────────────────────────

// OPR.0.4.6.PI1: Pi's documented Node engine floor (package.json engines).
export const PI_NODE_ENGINE_FLOOR = "22.19.0";

export function meetsPiNodeEngineFloor(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map((p) => parseInt(p, 10));
  const floor = PI_NODE_ENGINE_FLOOR.split(".").map((p) => parseInt(p, 10));
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0;
    const need = floor[i]!;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/** Parse a semver-like version from probe output (e.g. "tmux 3.4" -> "3.4"). */
export function parseRuntimeVersion(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z])?)/);
  return match?.[1];
}

function sidecarOutcome(reason: string): RuntimeTokenCaptureOutcome {
  return { outcome: "skipped", reason: reason === "parse_error" ? "parse_error" : "missing_sidecar" };
}

const CLAUDE_CODE: RuntimeDescriptor = {
  id: "claude-code",
  displayName: "Claude Code",
  kind: "agent",
  binary: "claude",
  resumeType: "claude_id",
  validateResumeToken: validateIdShapedToken,
  // The status-line sidecar's session_id (a file read).
  captureResumeToken: async ({ sessionName }, deps) => {
    if (!deps.contextUsageStore) return { outcome: "noop" };
    const sidecar = deps.contextUsageStore.readSidecar(sessionName);
    if (!sidecar.ok) return sidecarOutcome(sidecar.reason);
    const sid = sidecar.data.session_id;
    if (typeof sid === "string" && sid.trim().length > 0) return { outcome: "token", token: sid.trim() };
    return { outcome: "skipped", reason: "missing_sidecar" };
  },
  supportsFork: true,
  // Teardown resolves the rig-selected managed-block file (#25) itself.
  guidanceFile: "CLAUDE.md",
  paneCommands: ["claude"],
};

const CODEX: RuntimeDescriptor = {
  id: "codex",
  displayName: "Codex",
  kind: "agent",
  binary: "codex",
  resumeType: "codex_id",
  validateResumeToken: validateIdShapedToken,
  // The thread id derived from live pid-keyed logs.
  captureResumeToken: async ({ sessionName }, deps) => {
    if (!deps.resumeTokenCapturer) return { outcome: "noop" };
    const token = await deps.resumeTokenCapturer.captureCodexThreadId(sessionName);
    return token ? { outcome: "token", token } : { outcome: "skipped", reason: "probe_timeout" };
  },
  supportsFork: true,
  guidanceFile: "AGENTS.md",
  paneCommands: ["codex"],
};

const PI: RuntimeDescriptor = {
  id: "pi",
  displayName: "Pi",
  kind: "agent",
  binary: "pi",
  // FR-1: Pi requires Node >= 22.19.0. `node` unresolvable from the daemon's
  // exec context leaves the binary verification standing; the engine floor
  // re-checks at launch.
  verify: async ({ exec }) => {
    try {
      const nodeVersion = parseRuntimeVersion(await exec("node --version"));
      if (nodeVersion && !meetsPiNodeEngineFloor(nodeVersion)) {
        return `Pi requires Node >= ${PI_NODE_ENGINE_FLOOR}; found ${nodeVersion}. Upgrade Node to run pi seats.`;
      }
    } catch { /* see above */ }
    return null;
  },
  resumeType: "pi_session_file",
  validateResumeToken: validatePiSessionFileToken,
  // The pi-runner state sidecar's sessionFile (a file read).
  captureResumeToken: async ({ sessionName }, deps) => {
    if (!deps.piRunnerStateStore) return { outcome: "noop" };
    const state = deps.piRunnerStateStore.readSessionFile(sessionName);
    if (!state.ok) return sidecarOutcome(state.reason);
    if (state.sessionFile.trim().length > 0) return { outcome: "token", token: state.sessionFile.trim() };
    return { outcome: "skipped", reason: "missing_sidecar" };
  },
  supportsFork: true,
  guidanceFile: "AGENTS.md",
  // Pre-registry teardown never cleaned Pi's AGENTS.md; preserved.
  cleanupGuidanceOnTeardown: false,
  // No paneCommands: the pane hosts the node pi-runner, and `node` is far too
  // broad to identify Pi.
};

const TERMINAL: RuntimeDescriptor = {
  id: "terminal",
  displayName: "Terminal",
  kind: "terminal",
  supportsFork: false,
};

const STUB: RuntimeDescriptor = {
  id: "stub",
  displayName: "Stub",
  kind: "agent",
  supportsFork: false,
  internal: true,
};

export const BUILTIN_RUNTIME_IDS = ["claude-code", "codex", "pi", "terminal", "stub"] as const;

// ── Registry ─────────────────────────────────────────────────────────────────

const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const registry = new Map<string, RuntimeDescriptor>();

/** Generic hosts that never identify a runtime on their own. */
const AMBIGUOUS_PANE_COMMANDS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "sh", "bash", "zsh"]);

function add(descriptor: RuntimeDescriptor): void {
  if (!RUNTIME_ID_RE.test(descriptor.id)) {
    throw new Error(`Invalid runtime id "${descriptor.id}" (expected lowercase letters, digits, and '-')`);
  }
  if (registry.has(descriptor.id)) {
    throw new Error(`Runtime "${descriptor.id}" is already registered`);
  }
  const ambiguous = descriptor.paneCommands?.find((cmd) => AMBIGUOUS_PANE_COMMANDS.has(cmd.toLowerCase()));
  if (ambiguous) {
    throw new Error(`Runtime "${descriptor.id}" declares paneCommands "${ambiguous}", a generic host; use processMatch instead`);
  }
  if (descriptor.resumeType && !descriptor.validateResumeToken) {
    throw new Error(`Runtime "${descriptor.id}" declares resumeType without validateResumeToken`);
  }
  registry.set(descriptor.id, descriptor);
}

for (const d of [CLAUDE_CODE, CODEX, PI, TERMINAL, STUB]) add(d);
for (const registration of CLI_RUNTIME_REGISTRATIONS) add(registration.descriptor);

/**
 * Register a descriptor at runtime and return its unregister function.
 * Production runtimes register through adapters/cli/index.ts; this exists for
 * tests that need a fixture runtime visible to registry-driven sites.
 */
export function registerRuntimeDescriptor(descriptor: RuntimeDescriptor): () => void {
  add(descriptor);
  return () => { registry.delete(descriptor.id); };
}

export function getRuntimeDescriptor(id: string | null | undefined): RuntimeDescriptor | undefined {
  return id ? registry.get(id) : undefined;
}

export function isRegisteredRuntime(id: string | null | undefined): boolean {
  return !!id && registry.has(id);
}

/** Every registered runtime, sorted by id. */
export function listRuntimeDescriptors(): RuntimeDescriptor[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The availability probe command, e.g. "claude --version". Null when the
 *  runtime has no binary to probe. */
export function runtimeProbeCommand(descriptor: RuntimeDescriptor | undefined): string | null {
  if (!descriptor?.binary) return null;
  return [descriptor.binary, ...(descriptor.versionArgs ?? ["--version"])].join(" ");
}

/** Human list: "a", "a and b", "a, b, and c". */
export function formatRuntimeIdList(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join("");
  if (ids.length === 2) return `${ids[0]} and ${ids[1]}`;
  return `${ids.slice(0, -1).join(", ")}, and ${ids[ids.length - 1]}`;
}

/** The default runtime state root: <OPENRIG_HOME>/state. */
export function defaultRuntimeStateRoot(): string {
  return nodePath.join(OPENRIG_HOME, "state");
}

/** <stateRoot>/<runtime id>/<session name>; stateRoot defaults to <OPENRIG_HOME>/state. */
export function runtimeSeatStateDir(runtimeId: string, sessionName: string, stateRoot: string = defaultRuntimeStateRoot()): string {
  return seatStateDirFor(stateRoot, runtimeId, sessionName);
}
