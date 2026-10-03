// Table-driven base for interactive TUI coding CLIs that run in a tmux pane.
//
// A runtime supplies a TuiCliRuntimeSpec (argv builder, pane patterns, optional
// provisioning, token minting, resume precheck, and env) and gets the full
// five-method RuntimeAdapter contract plus restore-time resume. Semantics
// mirror the Pi adapter wherever the two overlap: managed-block guidance merge
// with the rig-role skip, skills projection into the runtime's skills dir (or
// an honest skip), and the shell-foreground readiness guard.
//
// Runtime imports stay off domain/runtime-registry.ts (see the import
// discipline note there): the descriptor arrives through the spec, and token
// capture goes through the dependency-leaf domain/runtime-capture.ts.

import fs from "node:fs";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "../tmux.js";
import { shellQuote } from "../shell-quote.js";
import { effectiveLaunchPosture, type ResolvedLaunchPosture } from "../yolo-mode.js";
import { PI_ENV_BASELINE_VARS, PI_ENV_OPENRIG_VARS } from "../pi-runner-protocol.js";
import {
  ATTENTION_REQUIRED_READINESS_CODES,
  resolveConcreteHint,
  type ForkSource,
  type HarnessLaunchRecovery,
  type HarnessLaunchResult,
  type InstalledResource,
  type NodeBinding,
  type ProjectionResult,
  type ReadinessResult,
  type ResolvedStartupFile,
  type RuntimeResumeRequest,
  type RuntimeResumeResult,
  type StartupDeliveryResult,
} from "../../domain/runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "../../domain/projection-planner.js";
import type { AppliedLaunchObservation } from "../../domain/permission-drift.js";
import { mergeManagedBlock } from "../../domain/managed-blocks.js";
import type { RuntimeDescriptor } from "../../domain/runtime-registry.js";
import type { RuntimeActivityState } from "../../domain/runtime-capabilities.js";
import {
  LAUNCH_RECORD_FILE,
  runDescriptorTokenCapture,
  seatStateDirFor,
  type LaunchRecord,
} from "../../domain/runtime-capture.js";
import {
  mergeOwnerConfig,
  type OwnerConfigChange,
  type OwnerConfigEditor,
  type OwnerConfigFormat,
  type OwnerConfigMergeResult,
} from "./owner-config.js";
import type { CliAdapterFsOps, CliRuntimeAdapter, CliRuntimeAdapterDeps } from "./types.js";

/** Foreground commands that mean the pane is back at a shell. Same vocabulary
 *  as the Pi adapter plus dash; login shells may carry a leading "-". */
const SHELL_COMMANDS = new Set(["bash", "dash", "fish", "nu", "sh", "tmux", "zsh"]);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_EVIDENCE_LINES = 12;
const PANE_CAPTURE_LINES = 40;
/** Every pane read joins soft-wrapped rows (tmux -J): on an 80-column pane a
 *  long line printed inline wraps at the pane width, possibly mid-word, and
 *  patterns must see the line as printed. */
const JOINED = { joinWrapped: true } as const;
/** classifyActivity's bottom status region: the last N non-blank screen lines. */
export const ACTIVITY_STATUS_LINES = 12;

export interface TuiCliLaunchInput {
  binding: NodeBinding;
  /** Effective posture: the seat's resolved policy, else the OPENRIG_YOLO decision. */
  posture: ResolvedLaunchPosture;
  /** Persisted token being resumed. */
  resumeToken?: string;
  forkSource?: ForkSource;
  /** Token minted before launch (mintSessionToken) for a fresh or fork launch. */
  sessionToken?: string;
  /** Per-seat state dir: <stateRoot>/<runtime id>/<session name>. */
  seatStateDir: string;
}

export interface TuiCliGatePattern {
  pattern: RegExp;
  /** Must be one of ATTENTION_REQUIRED_READINESS_CODES. */
  code: string;
  reason: string;
  /** The pattern itself proves the gate is current (for example it is anchored
   *  to the line directly above the input box), so classifyActivity counts it
   *  in the status region even while a ready marker shows. Default false: a
   *  gate counts only while no ready or busy marker shows, because a
   *  line-printing CLI leaves an answered gate in its visible history. */
  currentWhileReady?: boolean;
  /** Answer this gate once during the seat's own launch instead of stopping,
   *  when every guard holds (see TuiCliGateAnswer). Otherwise the gate stays
   *  attention_required. */
  answer?: TuiCliGateAnswer;
}

/**
 * A guarded automatic answer to a folder-trust style dialog. The base sends
 * `keys` only when all of these hold, and otherwise leaves the gate to the
 * operator:
 *  1. it is the seat's own launch wait, and the dialog is on lines this launch
 *     printed (after the positional baseline), never in older scrollback or in
 *     checkReady;
 *  2. `dialogPath` extracts a path from the dialog and, normalized, it equals
 *     the seat cwd (or its realpath) exactly: no prefix or substring match;
 *  3. the option currently selected on screen (the line carrying
 *     `selectionMarker`) reads exactly `expectOptionText`, so the cursor
 *     position is verified, never assumed;
 *  4. it has not been answered yet in this launch. If the gate is still on
 *     screen after the answer settles, the launch fails as attention_required.
 * Each answer is logged and recorded in the seat's launch.json (gateAnswers).
 */
export interface TuiCliGateAnswer {
  /** tmux keys that choose the selected option, e.g. ["Enter"]. */
  keys: readonly string[];
  /** The selected option's text, after the marker and any "1." numbering. */
  expectOptionText: string;
  /** Marks the selected option. Default "❯". */
  selectionMarker?: string;
  /** The folder the dialog names, unwrapped from the CLI's layout, or null. */
  dialogPath(screen: string): string | null;
  /** What the answer means, for the log and the launch record. */
  describe: string;
}

/** Polls the gate may keep showing after an answer before it counts as not taken. */
const ANSWER_SETTLE_POLLS = 3;
/** Polls a dialog may stay unreadable (folder or selection not parsed, e.g. a
 *  capture taken mid-draw) before the launch stops for the operator. */
const ANSWER_READ_POLLS = 3;

export interface TuiCliErrorPattern {
  pattern: RegExp;
  reason: string;
  /** How a launch that hits this error recovers. Default attention_required.
   *  "retry_fresh" is for a missing resume target (restore stops and asks). */
  recovery?: HarnessLaunchRecovery;
  /** Readiness code checkReady reports. Default "runtime_error". */
  code?: string;
}

export interface TuiCliEnvPolicy {
  /** Literal values added to the launch env (applied on fresh, fork, and resume). */
  set?: (input: TuiCliLaunchInput) => Record<string, string>;
  /** Opt-in deny-by-default (like Pi's buildPiChildEnv): `env -i` keeping only
   *  the baseline, OpenRig identity, and `allow` names. Default false: the CLI
   *  inherits the pane env and `set` values are added on top. */
  denyByDefault?: boolean;
  /** Extra pane env names passed through when denyByDefault is on. */
  allow?: readonly string[];
}

export interface TuiCliPrepareContext {
  binding: NodeBinding;
  seatStateDir: string;
  fs: CliAdapterFsOps;
  homedir: string;
  env: NodeJS.ProcessEnv;
  mode: "fresh" | "resume" | "fork";
  resumeToken?: string;
  sessionToken?: string;
  /** The fork parent on a fork launch. */
  forkSource?: ForkSource;
  /** Owner-state-safe config edit (owner-config.ts); changes are logged and
   *  recorded in the seat's launch.json. Use this for every owner file edit. */
  mergeOwnerConfig(filePath: string, format: OwnerConfigFormat, edit: (editor: OwnerConfigEditor) => void): OwnerConfigMergeResult;
}

export interface TuiCliResumeTargetContext {
  token: string;
  cwd: string;
  seatStateDir: string;
  homedir: string;
  fs: CliAdapterFsOps;
  binding: NodeBinding;
}

export type TuiCliResumeTargetResult =
  | { ok: true }
  | { ok: false; reason: string; recovery?: HarnessLaunchRecovery };

export interface TuiCliRuntimeSpec {
  descriptor: RuntimeDescriptor;
  /** argv for the launch. The base shell-quotes and types it. Throwing an Error
   *  refuses the launch with that message (e.g. an unsupported fork ref). */
  buildLaunchCommand(input: TuiCliLaunchInput): string[];
  env?: TuiCliEnvPolicy;
  /** Provisioning before typing, on fresh, fork, and resume (restore resumes
   *  through the same path). Failures are logged and never block the launch. */
  prepareLaunch?(ctx: TuiCliPrepareContext): void | Promise<void>;
  /** Mint the session id before a fresh or fork launch (e.g. `--session-id
   *  <uuid>`). Return undefined when this launch cannot take one. The base
   *  passes it to buildLaunchCommand as sessionToken and reports it as the
   *  resume token once ready; late capture stays the fallback. */
  mintSessionToken?(input: { binding: NodeBinding; forkSource?: ForkSource }): string | undefined;
  /** The minted id is not resumable until the CLI has stored a real exchange
   *  (a never-prompted session cannot be resumed). Launch then does not report
   *  it; the descriptor's captureResumeToken reports it once resumable, at
   *  launch, from the refresher, or at restore, so an unused seat restores
   *  fresh instead of stopping on a refused resume. */
  mintedTokenAwaitsCapture?: boolean;
  /** Checked before typing a resume, so a missing session never silently
   *  starts fresh. Default recovery on refusal: retry_fresh. */
  validateResumeTarget?(ctx: TuiCliResumeTargetContext): TuiCliResumeTargetResult | Promise<TuiCliResumeTargetResult>;
  /** Any match (with the CLI holding the foreground) means ready. */
  readyPatterns: readonly RegExp[];
  /** The CLI's busy marker (e.g. "esc to interrupt"); classifyActivity reads
   *  a match as working. Absent = activity never reads as working. */
  busyPatterns?: readonly RegExp[];
  /** In-session prompts that wait for the operator (tool or command approval,
   *  mid-session yes/no confirms, blocking update dialogs). classifyActivity
   *  reads a match in the status region as needs_input; unlike gatePatterns
   *  they never affect launch or readiness. */
  inputPromptPatterns?: readonly RegExp[];
  /** Interactive gates that need an operator (trust, login, update, ...). */
  gatePatterns?: readonly TuiCliGatePattern[];
  /** CLI errors. They fire while the TUI runs and, on new pane lines, after it
   *  exits back to the shell. */
  errorPatterns?: readonly TuiCliErrorPattern[];
  launchTimeoutMs?: number;
  pollIntervalMs?: number;
  evidenceLines?: number;
  /** The applied-launch observation for permission drift, when known. */
  observeLaunch?(input: TuiCliLaunchInput): AppliedLaunchObservation | undefined;
}

type PaneState =
  | { kind: "ready" }
  | { kind: "gate"; gate: TuiCliGatePattern }
  | { kind: "error"; pattern: TuiCliErrorPattern }
  | { kind: "at_shell" }
  | { kind: "pending" };

type LaunchFailure = Extract<HarnessLaunchResult, { ok: false }>;

/** Where a launch's output starts: a tmux absolute line position, plus the
 *  lines on screen before typing for panes where no position is available. */
interface LaunchWindow {
  line: number | null;
  lines: ReadonlySet<string>;
  /** A previous process left the pane on the alternate screen. */
  alternateAtLaunch: boolean;
}

/** A shell reporting the launch binary missing (bash, zsh, dash, env). */
const MISSING_BINARY_RE = /command not found|: not found$|No such file or directory/m;

export class TuiCliRuntimeAdapter implements CliRuntimeAdapter {
  readonly runtime: string;
  protected readonly spec: TuiCliRuntimeSpec;
  protected readonly descriptor: RuntimeDescriptor;
  protected readonly tmux: TmuxAdapter;
  protected readonly fs: CliAdapterFsOps;
  protected readonly stateRoot: string;
  protected readonly homedir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly hasLiveSiblingSeat: CliRuntimeAdapterDeps["hasLiveSiblingSeat"];

  constructor(spec: TuiCliRuntimeSpec, deps: CliRuntimeAdapterDeps) {
    for (const gate of spec.gatePatterns ?? []) {
      if (!ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)) {
        throw new Error(`${spec.descriptor.id}: gate code "${gate.code}" is not an attention-required readiness code`);
      }
      if (gate.answer && (gate.answer.keys.length === 0 || !gate.answer.expectOptionText.trim())) {
        throw new Error(`${spec.descriptor.id}: gate "${gate.code}" answer needs keys and expectOptionText`);
      }
    }
    for (const name of spec.env?.allow ?? []) {
      if (!ENV_NAME_RE.test(name)) throw new Error(`${spec.descriptor.id}: invalid env allowlist name "${name}"`);
    }
    if (spec.env?.allow?.length && !spec.env.denyByDefault) {
      throw new Error(`${spec.descriptor.id}: env.allow only applies with env.denyByDefault`);
    }
    if (spec.readyPatterns.length === 0) {
      throw new Error(`${spec.descriptor.id}: at least one ready pattern is required`);
    }
    this.spec = spec;
    this.descriptor = spec.descriptor;
    this.runtime = spec.descriptor.id;
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.homedir = deps.homedir;
    this.env = deps.env ?? process.env;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date());
    this.hasLiveSiblingSeat = deps.hasLiveSiblingSeat;
  }

  /** <stateRoot>/<runtime id>/<session name> */
  seatStateDir(sessionName: string): string {
    return seatStateDirFor(this.stateRoot, this.runtime, sessionName);
  }

  // ── RuntimeAdapter ─────────────────────────────────────────────────────────

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const skillsDir = this.skillsDir(binding);
    if (!skillsDir || !this.fs.listFiles || !this.fs.exists(skillsDir)) return [];
    return this.fs.listFiles(skillsDir).map((file) => ({
      effectiveId: file,
      category: "skill",
      installedPath: nodePath.join(skillsDir, file),
    }));
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }
    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];
    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        switch (hint) {
          case "guidance_merge": {
            const guidance = this.guidancePath(binding);
            if (!guidance) {
              this.logSkip(`no guidance file for ${this.runtime}`, file.path);
              continue;
            }
            if (!this.mergeGuidance(guidance, file.path, content)) continue; // rig-role skip: not delivered
            break;
          }
          case "skill_install": {
            const skillsDir = this.skillsDir(binding);
            if (!skillsDir) {
              this.logSkip(`${this.runtime} has no skills directory`, file.path);
              continue;
            }
            const targetDir = nodePath.join(skillsDir, nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }
    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    const id = this.runtime;
    if (!binding.tmuxSession) {
      return { ok: false, error: `No tmux session bound; cannot launch the ${id} harness` };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive; pick one" };
    }
    if (opts.forkSource && !this.descriptor.supportsFork) {
      return { ok: false, error: `${id} runtime has no native fork primitive; remove session_source for ${id} members` };
    }
    let resumeToken: string | undefined;
    if (opts.resumeToken !== undefined) {
      const validation = this.validateToken(opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `${id} resume: ${validation.error}` };
      resumeToken = validation.token;
    }
    const mode: LaunchRecord["mode"] = resumeToken ? "resume" : opts.forkSource ? "fork" : "fresh";

    const sessionName = binding.tmuxSession;
    const seatStateDir = this.seatStateDir(sessionName);
    this.fs.mkdirp(seatStateDir);

    // Never type a shell command into anything but a shell: a live TUI would
    // take it as a prompt (and send it to its model).
    const foreground = ((await this.tmux.getPaneCommand(sessionName)) ?? "").trim().replace(/^-/, "");
    if (!SHELL_COMMANDS.has(foreground)) {
      return {
        ok: false,
        error: `${id} launch: the pane is not at a shell (foreground: ${foreground || "unknown"}); refusing to type the launch command`,
        recovery: "attention_required",
      };
    }

    if (resumeToken && this.spec.validateResumeTarget) {
      const refused = await this.checkResumeTarget({ token: resumeToken, cwd: binding.cwd, seatStateDir, homedir: this.homedir, fs: this.fs, binding });
      if (refused) return refused;
    }

    let sessionToken: string | undefined;
    if (mode !== "resume" && this.spec.mintSessionToken) {
      try {
        sessionToken = this.spec.mintSessionToken({ binding, forkSource: opts.forkSource });
      } catch (err) {
        return { ok: false, error: `${id} launch: could not mint a session id (${(err as Error).message})` };
      }
      if (sessionToken !== undefined) {
        const minted = this.validateToken(sessionToken);
        if (!minted.ok) return { ok: false, error: `${id} launch: minted session id is malformed (${minted.error})` };
        sessionToken = minted.token;
      }
    }

    const ownerConfigChanges = await this.prepare({ binding, seatStateDir, mode, resumeToken, sessionToken, forkSource: opts.forkSource });

    const input: TuiCliLaunchInput = {
      binding,
      posture: effectiveLaunchPosture(this.env, binding.launchPosture),
      resumeToken,
      forkSource: opts.forkSource,
      sessionToken,
      seatStateDir,
    };

    let command: string;
    try {
      command = this.buildShellCommand(input);
    } catch (err) {
      return { ok: false, error: `${id} launch: ${(err as Error).message}` };
    }

    const launchStartedAt = this.now();
    const record: LaunchRecord = {
      launchId: randomUUID(),
      runtimeId: id,
      sessionName,
      cwd: binding.cwd,
      launchStartedAt: launchStartedAt.toISOString(),
      mode,
      ...(sessionToken ? { presetToken: sessionToken } : {}),
      ...(ownerConfigChanges.length ? { ownerConfigChanges } : {}),
    };
    this.writeLaunchRecord(seatStateDir, record);

    // Mark where this launch's output starts, so ready, gate, and error text
    // left in a reused pane's scrollback never counts.
    const window: LaunchWindow = {
      line: await this.tmux.getPaneLinePosition(sessionName),
      lines: new Set(((await this.tmux.capturePaneContent(sessionName, PANE_CAPTURE_LINES, JOINED)) ?? "").split("\n")),
      alternateAtLaunch: (await this.tmux.isPaneAlternateScreen(sessionName)) === true,
    };
    const sent = await this.tmux.sendShellCommand(sessionName, command);
    if (!sent.ok) return { ok: false, error: `Failed to send launch command: ${sent.message}` };

    const waited = await this.waitForReady(sessionName, window, { binding, seatStateDir, record });
    if (!waited.ok) return waited;

    const appliedLaunch = this.spec.observeLaunch?.(input);
    const applied = appliedLaunch ? { appliedLaunch } : {};
    const resumeType = this.descriptor.resumeType;
    if (!resumeType) return { ok: true, ...applied };
    if (resumeToken) return { ok: true, resumeToken, resumeType, ...applied };
    if (sessionToken && !this.spec.mintedTokenAwaitsCapture) return { ok: true, resumeToken: sessionToken, resumeType, ...applied };

    // Fresh or fork without a minted id: capture the NEW session. CLIs that
    // create sessions lazily return nothing here; the refresher and restore
    // capture it later from the same hook.
    const captured = await runDescriptorTokenCapture(
      this.descriptor,
      { sessionName, cwd: binding.cwd, seatStateDir, launchStartedAt, homedir: this.homedir },
      { hasLiveSiblingSeat: this.hasLiveSiblingSeat },
    );
    const token = captured.outcome === "token" ? this.validateToken(captured.token) : null;
    if (token?.ok && opts.forkSource?.value && token.token === opts.forkSource.value.trim()) {
      return { ok: false, error: `${id} fork: captured the parent session instead of the post-fork child` };
    }
    return { ok: true, ...(token?.ok ? { resumeToken: token.token, resumeType } : {}), ...applied };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    const { state } = await this.readPane(binding.tmuxSession);
    switch (state.kind) {
      case "ready": return { ready: true };
      case "gate": return { ready: false, reason: state.gate.reason, code: state.gate.code };
      case "error": return { ready: false, reason: state.pattern.reason, code: state.pattern.code ?? "runtime_error" };
      case "at_shell":
        return { ready: false, reason: `the pane is back at a shell (${this.runtime} process gone)`, code: "runtime_exited" };
      case "pending": return { ready: false, reason: `${this.runtime} has not reported ready yet`, code: "awaiting_runtime" };
    }
  }

  /**
   * Activity from the pane (F1, feature 2), with the readiness shell guard.
   * Reads the visible screen only (never scrollback). In-session prompts and
   * busy markers match only in the bottom status region (the last
   * ACTIVITY_STATUS_LINES non-blank lines), where the live prompt and status
   * render, so an answered prompt or an old busy line left higher in the
   * visible history never reads as needs_input or working. A gate (a launch
   * dialog) counts anywhere on screen unless a busy or ready marker in the
   * status region appears after it. In order: pane at a shell => null; an
   * in-session prompt in the status region, or a gate on screen not followed
   * by a busy or ready marker => needs_input; a busy marker there => working; a ready marker on screen =>
   * idle; anything else => null, so callers fall back to their generic source
   * and a wrong guess never suppresses a wake.
   */
  async classifyActivity(binding: NodeBinding): Promise<RuntimeActivityState | null> {
    if (!binding.tmuxSession) return null;
    const paneCommand = ((await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "").trim().replace(/^-/, "");
    if (SHELL_COMMANDS.has(paneCommand)) return null;
    const screen = (await this.tmux.capturePaneScreen(binding.tmuxSession, JOINED)) ?? "";
    const status = screen.split("\n").filter((line) => line.trim() !== "").slice(-ACTIVITY_STATUS_LINES).join("\n");
    if ((this.spec.inputPromptPatterns ?? []).some((pattern) => pattern.test(status))) return "needs_input";
    const busy = (this.spec.busyPatterns ?? []).some((pattern) => pattern.test(status));
    // A full-screen gate (sign-in, trust, provider picker) can sit above the
    // bottom lines on an 80x24 pane, so a gate anywhere on screen counts, but
    // not once a busy or ready marker in the status region follows it: a
    // line-printing CLI (aider) leaves an answered gate in its visible history,
    // even right above its fresh prompt, after it moves on.
    const gates = this.spec.gatePatterns ?? [];
    if (gates.some((gate) => gate.currentWhileReady && gate.pattern.test(status))) return "needs_input";
    // The newest gate on screen counts unless a busy or ready marker in the
    // status region was printed after it (the CLI moved on).
    const gateAt = Math.max(-1, ...gates.map((gate) => lastMatchIndex(gate.pattern, screen)));
    if (gateAt >= 0) {
      const markers = [...(busy ? this.spec.busyPatterns ?? [] : []), ...this.spec.readyPatterns]
        .filter((pattern) => pattern.test(status));
      const movedOnAt = Math.max(-1, ...markers.map((pattern) => lastMatchIndex(pattern, screen)));
      if (movedOnAt <= gateAt) return "needs_input";
    }
    if (busy) return "working";
    if (this.spec.readyPatterns.some((pattern) => pattern.test(screen))) return "idle";
    return null;
  }

  // ── RuntimeResumeAdapter ───────────────────────────────────────────────────

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return !!this.descriptor.resumeType && resumeType === this.descriptor.resumeType && !!resumeToken;
  }

  async resume(request: RuntimeResumeRequest): Promise<RuntimeResumeResult> {
    if (!this.canResume(request.resumeType, request.resumeToken)) {
      return { ok: false, code: "no_resume", message: `${this.runtime} resume not available` };
    }
    const binding: NodeBinding = {
      id: `resume:${request.nodeId}`,
      nodeId: request.nodeId,
      tmuxSession: request.sessionName,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: this.now().toISOString(),
      cwd: request.cwd,
      ...(request.model ? { model: request.model } : {}),
      ...(request.resolvedPosture ? { launchPosture: request.resolvedPosture } : {}),
    };
    const result = await this.launchHarness(binding, { name: request.sessionName, resumeToken: request.resumeToken! });
    if (result.ok) return { ok: true, ...(result.appliedLaunch ? { appliedLaunch: result.appliedLaunch } : {}) };
    if (result.recovery === "attention_required") {
      return { ok: false, code: "attention_required", message: result.error, ...(result.evidence ? { evidence: result.evidence } : {}) };
    }
    if (result.recovery === "retry_fresh") return { ok: false, code: "retry_fresh", message: result.error };
    return { ok: false, code: "resume_failed", message: result.error };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The exact text typed into the pane (exposed for tests and docs). It
   *  `exec`s the CLI so the CLI replaces the launch script's shell
   *  (`/bin/sh <script>` from sendShellCommand) and pane_current_command
   *  becomes the CLI. When the CLI exits, the pane returns to its own shell
   *  prompt; the pane does not close. */
  buildShellCommand(input: TuiCliLaunchInput): string {
    const argv = this.spec.buildLaunchCommand(input);
    if (argv.length === 0 || !argv[0]) throw new Error("empty launch command");
    const quoted = argv.map(shellQuote).join(" ");
    const policy = this.spec.env;
    if (!policy) return `exec ${quoted}`;
    const literals = Object.entries(policy.set?.(input) ?? {}).map(([name, value]) => {
      if (!ENV_NAME_RE.test(name)) throw new Error(`invalid env name "${name}"`);
      return shellQuote(`${name}=${value}`);
    });
    if (!policy.denyByDefault) {
      return literals.length ? ["exec", "env", ...literals, quoted].join(" ") : `exec ${quoted}`;
    }
    const names = [...new Set([...PI_ENV_BASELINE_VARS, ...PI_ENV_OPENRIG_VARS, ...(policy.allow ?? [])])];
    // ${NAME+"NAME=$NAME"} passes a pane variable only when it is set (POSIX).
    const passthrough = names.map((name) => `\${${name}+"${name}=\$${name}"}`);
    return ["exec", "env", "-i", ...passthrough, ...literals, quoted].join(" ");
  }

  private validateToken(raw: string): { ok: true; token: string } | { ok: false; error: string } {
    if (!this.descriptor.resumeType || !this.descriptor.validateResumeToken) {
      return { ok: false, error: `the ${this.runtime} runtime has no resume token` };
    }
    const token = raw.trim();
    if (!token) return { ok: false, error: "Resume token is empty." };
    return this.descriptor.validateResumeToken(token);
  }

  private async checkResumeTarget(ctx: TuiCliResumeTargetContext): Promise<LaunchFailure | null> {
    let result: TuiCliResumeTargetResult;
    try {
      result = await this.spec.validateResumeTarget!(ctx);
    } catch (err) {
      return { ok: false, error: `${this.runtime} resume: could not check the resume target (${(err as Error).message})`, recovery: "attention_required" };
    }
    if (result.ok) return null;
    return { ok: false, error: `${this.runtime} resume: ${result.reason}`, recovery: result.recovery ?? "retry_fresh" };
  }

  private async prepare(input: {
    binding: NodeBinding;
    seatStateDir: string;
    mode: LaunchRecord["mode"];
    resumeToken?: string;
    sessionToken?: string;
    forkSource?: ForkSource;
  }): Promise<OwnerConfigChange[]> {
    const changes: OwnerConfigChange[] = [];
    if (!this.spec.prepareLaunch) return changes;
    const ctx: TuiCliPrepareContext = {
      ...input,
      fs: this.fs,
      homedir: this.homedir,
      env: this.env,
      mergeOwnerConfig: (filePath, format, edit) => {
        const result = mergeOwnerConfig(this.fs, filePath, format, edit);
        if (result.status === "changed") {
          changes.push(...result.changes);
          console.log(`[openrig] ${this.runtime} prepareLaunch: updated ${filePath} (${result.changes.map((c) => `${c.op} ${c.path.join(".")}`).join(", ")})`);
        } else if (result.status === "skipped") {
          console.warn(`[openrig] ${this.runtime} prepareLaunch: left ${filePath} untouched (${result.reason}: ${result.detail})`);
        }
        return result;
      },
    };
    try {
      await this.spec.prepareLaunch(ctx);
    } catch (err) {
      console.warn(`[openrig] ${this.runtime} prepareLaunch failed (continuing): ${(err as Error).message}`);
    }
    return changes;
  }

  private writeLaunchRecord(seatStateDir: string, record: LaunchRecord): void {
    try {
      this.fs.writeFile(nodePath.join(seatStateDir, LAUNCH_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      console.warn(`[openrig] ${this.runtime}: could not write ${LAUNCH_RECORD_FILE} (${(err as Error).message})`);
    }
  }

  private async waitForReady(
    sessionName: string,
    window: LaunchWindow,
    launch: { binding: NodeBinding; seatStateDir: string; record: LaunchRecord },
  ): Promise<{ ok: true } | LaunchFailure> {
    const timeoutMs = this.spec.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const pollMs = this.spec.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    let sawRuntime = false;
    let answered = null as { gate: TuiCliGatePattern; pollsSince: number } | null;
    let unreadablePolls = 0;
    let last: { state: PaneState; content: string } = { state: { kind: "pending" }, content: "" };
    for (let attempt = 0; attempt < attempts; attempt++) {
      last = await this.readPane(sessionName, window);
      const { state, content } = last;
      if (state.kind === "ready") return { ok: true };
      if (state.kind === "gate") {
        if (answered?.gate === state.gate) {
          // The answer was sent once; give the dialog a few polls to close.
          answered.pollsSince++;
          if (answered.pollsSince >= ANSWER_SETTLE_POLLS) {
            return this.failure(`${state.gate.reason} (still showing after OpenRig answered it)`, "attention_required", content);
          }
        } else if (state.gate.answer && !answered) {
          const fresh = window.line === null ? freshLines(content, window.lines) : content;
          const refusal = this.answerRefusal(state.gate, state.gate.answer, fresh, launch.binding);
          if (refusal && (refusal.final || ++unreadablePolls >= ANSWER_READ_POLLS)) {
            return this.failure(`${state.gate.reason} (not answered automatically: ${refusal.why})`, "attention_required", content);
          }
          if (refusal) {
            if (attempt < attempts - 1) await this.sleep(pollMs);
            continue;
          }
          const sent = await this.tmux.sendKeys(sessionName, [...state.gate.answer.keys]);
          if (!sent.ok) return this.failure(`${state.gate.reason} (sending the answer failed: ${sent.message})`, "attention_required", content);
          answered = { gate: state.gate, pollsSince: 0 };
          this.recordGateAnswer(launch, state.gate, state.gate.answer);
        } else {
          return this.failure(state.gate.reason, "attention_required", content);
        }
      }
      if (state.kind === "error") return this.failure(state.pattern.reason, state.pattern.recovery ?? "attention_required", content);
      if (state.kind === "at_shell") {
        // Right after typing the pane is still at the shell, so a shell alone
        // is not an exit. It is one once the CLI was seen in the foreground, or
        // when this launch's output shows an error pattern or a missing binary
        // (a CLI that exits before the first poll).
        const fresh = window.line === null ? freshLines(content, window.lines) : content;
        const error = this.matchError(fresh);
        if (error) return this.failure(error.reason, error.recovery ?? "attention_required", content);
        if (MISSING_BINARY_RE.test(fresh)) {
          return this.failure(`the ${this.descriptor.binary ?? this.runtime} binary was not found (command not found)`, "attention_required", content);
        }
        if (sawRuntime) return this.failure(`the CLI exited back to the shell`, "attention_required", content);
      } else {
        sawRuntime = true;
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    const why = last.state.kind === "at_shell"
      ? "the pane is still at a shell (the CLI exited or never started)"
      : "timed out waiting for the CLI to report ready";
    return this.failure(why, "attention_required", last.content);
  }

  /** Why a gate answer must not be sent, or null when every guard holds. A
   *  final refusal stops the launch now; an unreadable dialog is retried for a
   *  few polls in case the capture caught it mid-draw. */
  private answerRefusal(
    gate: TuiCliGatePattern,
    answer: TuiCliGateAnswer,
    fresh: string,
    binding: NodeBinding,
  ): { final: boolean; why: string } | null {
    if (!gate.pattern.test(fresh)) return { final: true, why: "the dialog is not in this launch's output" };
    let named: string | null;
    try {
      named = answer.dialogPath(fresh);
    } catch {
      named = null;
    }
    const folder = named ? normalizeDialogPath(named, this.homedir) : null;
    if (!folder) return { final: false, why: "the dialog does not name an absolute folder OpenRig could read" };
    if (!cwdKeys(binding.cwd).includes(folder)) return { final: true, why: "the dialog names a different folder than the seat's cwd" };
    const selected = selectedOptions(fresh, answer.selectionMarker ?? "❯");
    if (selected.length !== 1) return { final: false, why: "the selected option could not be read" };
    const expected = answer.expectOptionText.trim();
    if (selected[0] !== expected) return { final: true, why: `the selected option is "${selected[0]}", not "${expected}"` };
    return null;
  }

  private recordGateAnswer(
    launch: { seatStateDir: string; record: LaunchRecord },
    gate: TuiCliGatePattern,
    answer: TuiCliGateAnswer,
  ): void {
    const entry = { code: gate.code, option: answer.expectOptionText.trim(), describe: answer.describe, answeredAt: this.now().toISOString() };
    console.log(`[openrig] ${this.runtime}: answered ${gate.code} with "${entry.option}" (${answer.describe}) for ${launch.record.sessionName} in ${launch.record.cwd}`);
    launch.record.gateAnswers = [...(launch.record.gateAnswers ?? []), entry];
    this.writeLaunchRecord(launch.seatStateDir, launch.record);
  }

  private failure(reason: string, recovery: HarnessLaunchRecovery, content: string): LaunchFailure {
    return { ok: false, error: `${this.runtime} launch: ${reason}`, recovery, evidence: this.evidence(content) };
  }

  private matchError(content: string): TuiCliErrorPattern | undefined {
    return (this.spec.errorPatterns ?? []).find((error) => error.pattern.test(content));
  }

  /**
   * Read the pane. During a launch wait, `window` limits pattern matching to
   * this launch's output: with a tmux line position, only lines after it are
   * captured (ready, gate, and error text in older scrollback never counts);
   * without one, error patterns skip lines that were on screen before typing.
   */
  private async readPane(sessionName: string, window?: LaunchWindow): Promise<{ state: PaneState; content: string }> {
    const paneCommand = ((await this.tmux.getPaneCommand(sessionName)) ?? "").trim().replace(/^-/, "");
    const atShell = SHELL_COMMANDS.has(paneCommand);
    let content = window && window.line !== null
      ? (await this.tmux.capturePaneFromLine(sessionName, window.line, JOINED)) ?? ""
      : (await this.tmux.capturePaneContent(sessionName, PANE_CAPTURE_LINES, JOINED)) ?? "";
    // An alternate screen is the new CLI's only while the CLI holds the
    // foreground and the screen was not already on before the launch (a
    // previous TUI that exited without restoring it). Otherwise keep only the
    // lines that were not on screen before typing.
    if (window && window.line !== null && (window.alternateAtLaunch || atShell)
      && (await this.tmux.isPaneAlternateScreen(sessionName)) === true) {
      content = freshLines(content, window.lines);
    }
    // A dead CLI leaves the pane at the shell with its last screen in
    // scrollback: gate, error, and ready text there is stale here.
    if (atShell) return { state: { kind: "at_shell" }, content };
    for (const gate of this.spec.gatePatterns ?? []) {
      if (gate.pattern.test(content)) return { state: { kind: "gate", gate }, content };
    }
    const error = this.matchError(window && window.line === null ? freshLines(content, window.lines) : content);
    if (error) return { state: { kind: "error", pattern: error }, content };
    if (this.spec.readyPatterns.some((pattern) => pattern.test(content))) return { state: { kind: "ready" }, content };
    return { state: { kind: "pending" }, content };
  }

  /** The last N non-padding lines: a full-screen capture is padded to the
   *  pane height with blank rows, which would otherwise be all the evidence. */
  private evidence(content: string): string {
    const lines = content.split("\n");
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines.slice(-(this.spec.evidenceLines ?? DEFAULT_EVIDENCE_LINES)).join("\n");
  }

  private guidancePath(binding: NodeBinding): string | null {
    return this.descriptor.guidanceFile ? nodePath.join(binding.cwd, this.descriptor.guidanceFile) : null;
  }

  private skillsDir(binding: NodeBinding): string | null {
    return this.descriptor.skillsDir?.({
      cwd: binding.cwd,
      sessionName: binding.tmuxSession ?? undefined,
      stateRoot: this.stateRoot,
      homedir: this.homedir,
    }) ?? null;
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const guidance = this.guidancePath(binding);
      if (!guidance) return false;
      return this.mergeGuidance(guidance, entry.effectiveId, this.fs.readFile(entry.absolutePath));
    }
    if (entry.category === "skill") {
      const skillsDir = this.skillsDir(binding);
      if (!skillsDir) return false;
      const targetDir = nodePath.join(skillsDir, entry.effectiveId);
      this.fs.mkdirp(targetDir);
      const files = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath) : [];
      if (files.length > 0) {
        for (const file of files) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fs.readFile(entry.absolutePath));
      }
      return true;
    }
    // Plugins / subagents / runtime resources have no generic CLI target: an
    // honest skip, never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Per-seat `rig-role` content collides across pod-mates in a shared cwd
    // file; it is delivered via send_text instead (ADR-0006).
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`,
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  private logSkip(why: string, path: string): void {
    console.log(`[openrig] skip: ${why} (file=${path})`);
  }
}

/** The seat cwd as given and its realpath, normalized for exact comparison. */
function cwdKeys(cwd: string): string[] {
  const keys = new Set([trimSlash(nodePath.resolve(cwd))]);
  try {
    keys.add(trimSlash(fs.realpathSync.native(cwd)));
  } catch {
    // A cwd that does not exist keeps the resolved key only.
  }
  return [...keys];
}

/** The dialog's folder as an absolute normalized path, or null. A relative
 *  path is refused here so no extractor can make the guard resolve it against
 *  the daemon's own working directory. */
function normalizeDialogPath(raw: string, homedir: string): string | null {
  const path = raw.trim();
  const expanded = path === "~" ? homedir : path.startsWith("~/") ? nodePath.join(homedir, path.slice(2)) : path;
  if (!nodePath.isAbsolute(expanded)) return null;
  return trimSlash(nodePath.resolve(expanded));
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Option texts on lines carrying the selection marker, with box borders and
 *  "1." style numbering removed. Empty texts (an idle input prompt) are skipped. */
function selectedOptions(screen: string, marker: string): string[] {
  const out: string[] = [];
  for (const line of screen.split("\n")) {
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const text = line.slice(at + marker.length)
      .replace(/[│┃║]+[\s│┃║]*$/, "")
      .trim()
      .replace(/^\d+[.)]\s*/, "");
    if (text) out.push(text);
  }
  return out;
}

/** Text inside box borders, with lines the CLI hard-wrapped at the box edge
 *  joined back together. Runtimes use it in TuiCliGateAnswer.dialogPath. */
export function unwrapBoxedLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let joinNext = false;
  for (const line of lines) {
    const inner = line.replace(/^[\s│┃║]*[│┃║]\s?/, "").replace(/\s?[│┃║][\s│┃║]*$/, "");
    const text = inner.trimEnd();
    if (/^[\s─━═╭╮╰╯┌┐└┘├┤┬┴┼]*$/.test(text)) {
      // A rule or box corner row separates, never continues, wrapped text.
      out.push("");
      joinNext = false;
      continue;
    }
    if (joinNext && out.length) out[out.length - 1] += text.trimStart();
    else out.push(text.trimStart());
    // Filled to the border (no padding left): the next line continues it.
    joinNext = text.length > 0 && inner.length === text.length;
  }
  return out;
}

/** Start index of the last match of `pattern` in `text`, or -1. */
function lastMatchIndex(pattern: RegExp, text: string): number {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let at = -1;
  for (const match of text.matchAll(global)) {
    at = match.index ?? at;
    if (match[0] === "") break;
  }
  return at;
}

function freshLines(content: string, baseline: ReadonlySet<string>): string {
  return content.split("\n").filter((line) => !baseline.has(line)).join("\n");
}
