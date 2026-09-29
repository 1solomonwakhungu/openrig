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
}

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
  /** Checked before typing a resume, so a missing session never silently
   *  starts fresh. Default recovery on refusal: retry_fresh. */
  validateResumeTarget?(ctx: TuiCliResumeTargetContext): TuiCliResumeTargetResult | Promise<TuiCliResumeTargetResult>;
  /** Any match (with the CLI holding the foreground) means ready. */
  readyPatterns: readonly RegExp[];
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
  | { kind: "gate"; code: string; reason: string }
  | { kind: "error"; pattern: TuiCliErrorPattern }
  | { kind: "at_shell" }
  | { kind: "pending" };

type LaunchFailure = Extract<HarnessLaunchResult, { ok: false }>;

/** Where a launch's output starts: a tmux absolute line position, plus the
 *  lines on screen before typing for panes where no position is available. */
interface LaunchWindow {
  line: number | null;
  lines: ReadonlySet<string>;
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

  constructor(spec: TuiCliRuntimeSpec, deps: CliRuntimeAdapterDeps) {
    for (const gate of spec.gatePatterns ?? []) {
      if (!ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)) {
        throw new Error(`${spec.descriptor.id}: gate code "${gate.code}" is not an attention-required readiness code`);
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

    const ownerConfigChanges = await this.prepare({ binding, seatStateDir, mode, resumeToken, sessionToken });

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
    this.writeLaunchRecord(seatStateDir, {
      launchId: randomUUID(),
      runtimeId: id,
      sessionName,
      cwd: binding.cwd,
      launchStartedAt: launchStartedAt.toISOString(),
      mode,
      ...(sessionToken ? { presetToken: sessionToken } : {}),
      ...(ownerConfigChanges.length ? { ownerConfigChanges } : {}),
    });

    // Mark where this launch's output starts, so ready, gate, and error text
    // left in a reused pane's scrollback never counts.
    const window: LaunchWindow = {
      line: await this.tmux.getPaneLinePosition(sessionName),
      lines: new Set(((await this.tmux.capturePaneContent(sessionName, PANE_CAPTURE_LINES)) ?? "").split("\n")),
    };
    const sent = await this.tmux.sendShellCommand(sessionName, command);
    if (!sent.ok) return { ok: false, error: `Failed to send launch command: ${sent.message}` };

    const waited = await this.waitForReady(sessionName, window);
    if (!waited.ok) return waited;

    const appliedLaunch = this.spec.observeLaunch?.(input);
    const applied = appliedLaunch ? { appliedLaunch } : {};
    const resumeType = this.descriptor.resumeType;
    if (!resumeType) return { ok: true, ...applied };
    if (resumeToken) return { ok: true, resumeToken, resumeType, ...applied };
    if (sessionToken) return { ok: true, resumeToken: sessionToken, resumeType, ...applied };

    // Fresh or fork without a minted id: capture the NEW session. CLIs that
    // create sessions lazily return nothing here; the refresher and restore
    // capture it later from the same hook.
    const captured = await runDescriptorTokenCapture(this.descriptor, { sessionName, cwd: binding.cwd, seatStateDir, launchStartedAt, homedir: this.homedir });
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
      case "gate": return { ready: false, reason: state.reason, code: state.code };
      case "error": return { ready: false, reason: state.pattern.reason, code: state.pattern.code ?? "runtime_error" };
      case "at_shell":
        return { ready: false, reason: `the pane is back at a shell (${this.runtime} process gone)`, code: "runtime_exited" };
      case "pending": return { ready: false, reason: `${this.runtime} has not reported ready yet`, code: "awaiting_runtime" };
    }
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
   *  `exec`s the CLI so the CLI replaces the launch shell: pane_current_command
   *  becomes the CLI, and the pane closes with it instead of dropping to a shell. */
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

  private async waitForReady(sessionName: string, window: LaunchWindow): Promise<{ ok: true } | LaunchFailure> {
    const timeoutMs = this.spec.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const pollMs = this.spec.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    let sawRuntime = false;
    let last: { state: PaneState; content: string } = { state: { kind: "pending" }, content: "" };
    for (let attempt = 0; attempt < attempts; attempt++) {
      last = await this.readPane(sessionName, window);
      const { state, content } = last;
      if (state.kind === "ready") return { ok: true };
      if (state.kind === "gate") return this.failure(state.reason, "attention_required", content);
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
    const content = window && window.line !== null
      ? (await this.tmux.capturePaneFromLine(sessionName, window.line)) ?? ""
      : (await this.tmux.capturePaneContent(sessionName, PANE_CAPTURE_LINES)) ?? "";
    // A dead CLI leaves the pane at the shell with its last screen in
    // scrollback: gate, error, and ready text there is stale here.
    if (SHELL_COMMANDS.has(paneCommand)) return { state: { kind: "at_shell" }, content };
    for (const gate of this.spec.gatePatterns ?? []) {
      if (gate.pattern.test(content)) return { state: { kind: "gate", code: gate.code, reason: gate.reason }, content };
    }
    const error = this.matchError(window && window.line === null ? freshLines(content, window.lines) : content);
    if (error) return { state: { kind: "error", pattern: error }, content };
    if (this.spec.readyPatterns.some((pattern) => pattern.test(content))) return { state: { kind: "ready" }, content };
    return { state: { kind: "pending" }, content };
  }

  private evidence(content: string): string {
    return content.split("\n").slice(-(this.spec.evidenceLines ?? DEFAULT_EVIDENCE_LINES)).join("\n");
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

function freshLines(content: string, baseline: ReadonlySet<string>): string {
  return content.split("\n").filter((line) => !baseline.has(line)).join("\n");
}
