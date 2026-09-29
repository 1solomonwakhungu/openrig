// Reusable contract suite for TUI CLI runtime adapters. Every adapter under
// adapters/cli/<id>/ calls runTuiCliAdapterContract() from its own test file,
// then adds runtime-specific tests (exact argv, token capture, env) beside it.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { CliAdapterFsOps, CliRuntimeRegistration, CliRuntimeAdapter } from "../../src/adapters/cli/types.js";
import type { ProjectionEntry, ProjectionPlan } from "../../src/domain/projection-planner.js";
import { ATTENTION_REQUIRED_READINESS_CODES, type ResolvedStartupFile } from "../../src/domain/runtime-adapter.js";
import { getRuntimeDescriptor, registerRuntimeDescriptor } from "../../src/domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE } from "../../src/domain/runtime-capture.js";
import { createNodeFsOps } from "../../src/adapters/node-fs-ops.js";
import { ResumeMetadataRefresher } from "../../src/domain/resume-metadata-refresher.js";
import { RestoreOrchestrator } from "../../src/domain/restore-orchestrator.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { SnapshotRepository } from "../../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../../src/domain/node-launcher.js";
import type { ClaudeResumeAdapter } from "../../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../../src/adapters/codex-resume.js";
import type { Session } from "../../src/domain/types.js";
import { createFullTestDb } from "./test-app.js";
import {
  HARNESS_CWD, HARNESS_SESSION, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
  type MemFs, type MockTmux, type PaneFrame,
} from "./tui-cli-adapter-harness.js";

export interface TuiCliAdapterContractInput {
  registration: CliRuntimeRegistration;
  /** Pane text a ready CLI shows. */
  readyScreen: string;
  /** Foreground process while the CLI runs. Default: the first paneCommand,
   *  else the binary ("node" for npm-installed CLIs is fine here). */
  runningCommand?: string;
  /** Screens for each interactive gate and the attention code each must yield. */
  gateScreens?: Array<{ screen: string; code: string }>;
  /** Screens with a fatal CLI error while the TUI still runs. */
  errorScreens?: string[];
  /** Text a CLI prints before exiting straight back to the shell, and the
   *  recovery the base must report (fail fast, no timeout). */
  earlyExit?: { screen: string; recovery: "retry_fresh" | "attention_required" };
  /** Required when the descriptor declares a resumeType. */
  validResumeToken?: string;
  invalidResumeToken?: string;
  /** A well-formed token whose session validateResumeTarget reports missing. */
  missingResumeToken?: string;
  /** Default true: the typed launch command carries binding.model. */
  passesModel?: boolean;
  /** A model id this CLI accepts (e.g. "provider/model"). Default "contract-model-7". */
  modelExample?: string;
  /** Make validResumeToken's session exist where validateResumeTarget looks,
   *  on the real filesystem (resume cases run on real temp dirs). */
  seedResumeTarget?: (ctx: { fs: CliAdapterFsOps; homedir: string; cwd: string; token: string; seatStateDir: string; stateRoot: string }) => void;
  /** Default true: floor and full_bypass postures type different commands. */
  postureChangesLaunch?: boolean;
  /** Fork parent id used when the descriptor supports fork. */
  forkSourceValue?: string;
  /** Late capture: make the CLI's session appear on disk the way the real CLI
   *  would (real files under the given dirs) and return its token. Required
   *  when the descriptor has captureResumeToken. */
  seedSession?: (ctx: { seatStateDir: string; cwd: string; homedir: string }) => string;
}

interface Rig {
  adapter: CliRuntimeAdapter;
  pane: MockTmux;
  fs: MemFs;
}

export function runTuiCliAdapterContract(input: TuiCliAdapterContractInput): void {
  const { registration, readyScreen } = input;
  const descriptor = registration.descriptor;
  const running = input.runningCommand ?? descriptor.paneCommands?.[0] ?? descriptor.binary ?? descriptor.id;
  const ready: PaneFrame = { command: running, content: readyScreen };

  /** An adapter whose pane serves `frames` verbatim (checkReady). */
  function rig(frames: PaneFrame[] = [ready], env: NodeJS.ProcessEnv = {}): Rig {
    const pane = mockTmux(frames);
    const fs = memFs();
    const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: fs, env }));
    return { adapter, pane, fs };
  }
  /** An adapter for a launch: the pane starts at an idle shell, then `frames`. */
  function launchRig(frames: PaneFrame[] = [ready], env: NodeJS.ProcessEnv = {}): Rig {
    return rig([atShell(), ...frames], env);
  }

  const tempRoots: string[] = [];
  afterEach(() => { for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  /** A launch adapter on real temp dirs (state root, home, cwd), so resume
   *  target checks against real files or SQLite work. Seeds validResumeToken. */
  function resumeRig(frames: PaneFrame[] = [ready], seedToken?: string) {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `openrig-${descriptor.id}-resume-`));
    tempRoots.push(root);
    const dirs = { stateRoot: nodePath.join(root, "state"), homedir: nodePath.join(root, "home"), cwd: nodePath.join(root, "work") };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    const nodeFs = createNodeFsOps();
    const seatStateDir = nodePath.join(dirs.stateRoot, descriptor.id, HARNESS_SESSION);
    if (seedToken) input.seedResumeTarget?.({ fs: nodeFs, ...dirs, token: seedToken, seatStateDir });
    const pane = mockTmux([atShell(), ...frames]);
    const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: nodeFs, stateRoot: dirs.stateRoot, homedir: dirs.homedir }));
    return { adapter, pane, binding: harnessBinding({ cwd: dirs.cwd }), cwd: dirs.cwd };
  }
  const model = input.modelExample ?? "contract-model-7";

  describe(`TUI CLI adapter contract: ${descriptor.id}`, () => {
    it("has a descriptor the registry accepts and an adapter for the same id", () => {
      const registered = getRuntimeDescriptor(descriptor.id);
      if (registered) {
        expect(registered).toBe(descriptor);
      } else {
        const unregister = registerRuntimeDescriptor(descriptor);
        unregister();
      }
      expect(descriptor.kind).toBe("agent");
      expect(descriptor.binary, "a CLI runtime names its binary for preflight").toBeTruthy();
      expect(rig().adapter.runtime).toBe(descriptor.id);
      if (descriptor.resumeType) {
        expect(input.validResumeToken, "resumable runtimes must supply validResumeToken").toBeTruthy();
      }
      if (descriptor.captureResumeToken) {
        expect(input.seedSession, "runtimes with captureResumeToken must supply seedSession").toBeTruthy();
      }
    });

    describe("launchHarness", () => {
      it("refuses without a tmux session", async () => {
        const { adapter, pane } = launchRig();
        const result = await adapter.launchHarness(harnessBinding({ tmuxSession: null }), { name: "x" });
        expect(result.ok).toBe(false);
        expect(pane.typed).toEqual([]);
      });

      it("refuses resumeToken together with forkSource before typing anything", async () => {
        const { adapter, pane } = launchRig();
        const result = await adapter.launchHarness(harnessBinding(), {
          name: "x", resumeToken: input.validResumeToken ?? "token", forkSource: { kind: "native_id", value: "parent" },
        });
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/mutually exclusive/) });
        expect(pane.typed).toEqual([]);
      });

      it("never types into a pane that is not at a shell", async () => {
        const { adapter, pane } = rig([ready]);
        const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringMatching(/not at a shell/) });
        expect(pane.typed).toEqual([]);
      });

      it("types exactly one launch command and reports ready", async () => {
        const { adapter, pane } = launchRig([atShell(), ready]);
        const result = await adapter.launchHarness(harnessBinding(), { name: HARNESS_SESSION });
        expect(result.ok).toBe(true);
        expect(pane.typed).toHaveLength(1);
        expect(pane.typed[0]).toContain(descriptor.binary!);
        expect(pane.typed[0]!.startsWith("exec "), "the CLI replaces the launch shell (exec)").toBe(true);
        if (result.ok && result.resumeToken) {
          // A minted id must validate and be on the command line.
          expect(descriptor.validateResumeToken!(result.resumeToken).ok).toBe(true);
          expect(pane.typed[0]).toContain(result.resumeToken);
        }
      });

      it("records the launch in the seat state dir", async () => {
        const { adapter, fs } = launchRig();
        await adapter.launchHarness(harnessBinding(), { name: "x" });
        const record = Object.entries(fs.files).find(([path]) => path.endsWith(nodePath.join(descriptor.id, HARNESS_SESSION, LAUNCH_RECORD_FILE)));
        expect(record, "launch.json in <stateRoot>/<id>/<session>").toBeTruthy();
        expect(JSON.parse(record![1])).toMatchObject({ runtimeId: descriptor.id, sessionName: HARNESS_SESSION, cwd: HARNESS_CWD, mode: "fresh", launchId: expect.any(String), launchStartedAt: expect.any(String) });
      });

      if (input.passesModel !== false) {
        it("passes binding.model through to the launch", async () => {
          const { adapter, pane } = launchRig();
          await adapter.launchHarness(harnessBinding({ model }), { name: "x" });
          expect(pane.typed[0]).toContain(model);
        });
      }

      if (input.postureChangesLaunch !== false) {
        it("maps floor and full_bypass (policy or OPENRIG_YOLO) to different launches", async () => {
          const strip = (cmd: string) => cmd.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
          const floor = launchRig();
          await floor.adapter.launchHarness(harnessBinding({ launchPosture: "floor" }), { name: "x" });
          const bypass = launchRig();
          await bypass.adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
          const yolo = launchRig([ready], { OPENRIG_YOLO: "1" });
          await yolo.adapter.launchHarness(harnessBinding(), { name: "x" });
          const lockedUnderYolo = launchRig([ready], { OPENRIG_YOLO: "1" });
          await lockedUnderYolo.adapter.launchHarness(harnessBinding({ launchPosture: "floor" }), { name: "x" });
          expect(strip(floor.pane.typed[0]!)).not.toBe(strip(bypass.pane.typed[0]!));
          expect(strip(yolo.pane.typed[0]!)).toBe(strip(bypass.pane.typed[0]!));
          expect(strip(lockedUnderYolo.pane.typed[0]!)).toBe(strip(floor.pane.typed[0]!));
        });
      }

      if (descriptor.supportsFork) {
        it("launches a fork and never reports the parent as the new token", async () => {
          const parent = input.forkSourceValue ?? "parent-session";
          const { adapter, pane } = launchRig();
          const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: parent } });
          expect(pane.typed).toHaveLength(1);
          if (result.ok) expect(result.resumeToken).not.toBe(parent);
        });
      } else {
        it("refuses fork with a clear error", async () => {
          const { adapter, pane } = launchRig();
          const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: "p" } });
          expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/no native fork primitive/) });
          expect(pane.typed).toEqual([]);
        });
      }

      for (const gate of input.gateScreens ?? []) {
        it(`returns attention_required with evidence on the ${gate.code} gate`, async () => {
          expect(ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)).toBe(true);
          const { adapter } = launchRig([{ command: running, content: gate.screen }]);
          const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
          expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
          expect(result.ok === false && result.evidence).toBeTruthy();
          const readiness = await adapter.checkReady(harnessBinding());
          expect(readiness).toMatchObject({ ready: false, code: gate.code });
        });
      }

      for (const screen of input.errorScreens ?? []) {
        it(`fails with evidence on error screen ${JSON.stringify(screen.slice(0, 32))}`, async () => {
          const { adapter } = launchRig([{ command: running, content: screen }]);
          const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
          expect(result).toMatchObject({ ok: false, recovery: expect.any(String) });
          expect(result.ok === false && result.evidence).toBeTruthy();
        });
      }

      if (input.earlyExit) {
        const early = input.earlyExit;
        it(`fails fast (${early.recovery}) when the CLI prints an error and exits to the shell`, async () => {
          const { adapter, pane } = launchRig([atShell(`${early.screen}\n$ `)]);
          const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
          expect(result).toMatchObject({ ok: false, recovery: early.recovery });
          expect((pane.tmux.getPaneCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(3);
        });
      }

      it("fails fast when the CLI starts and then exits back to the shell", async () => {
        const { adapter, pane } = launchRig([{ command: running, content: "starting" }, atShell("starting\nbye\n$ ")]);
        const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringMatching(/exited back to the shell/) });
        expect((pane.tmux.getPaneCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(4);
      });

      it("ignores error text already in scrollback before the launch", async () => {
        const stale = input.earlyExit?.screen ?? input.errorScreens?.[0];
        if (!stale) return;
        const pane = mockTmux([atShell(`${stale}\n$ `), atShell(""), ready]);
        const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
        expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
      });

      it("a ready marker left in a reused pane's scrollback never counts", async () => {
        const pane = mockTmux([atShell(`${readyScreen}\nbye\n$ `), atShell(""), atShell("")]);
        const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
        expect(await adapter.launchHarness(harnessBinding(), { name: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/still at a shell/) });
      });

      it("a full-screen CLI is read whole on the alternate screen", async () => {
        const { adapter } = launchRig([{ command: running, content: readyScreen, alternate: true }]);
        expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
      });

      it("an alternate screen a previous process left on never counts as the new CLI's", async () => {
        const stale: PaneFrame = { command: "zsh", content: `${readyScreen}\n$ `, alternate: true };
        const pane = mockTmux([stale, stale, stale]);
        const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
        expect(await adapter.launchHarness(harnessBinding(), { name: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/still at a shell/) });
      });

      it("an error this launch prints counts even when the same line is already in scrollback", async () => {
        const repeated = input.earlyExit?.screen;
        if (!repeated) return;
        const pane = mockTmux([atShell(`${repeated}\n$ `), atShell(`${repeated}\n$ `)]);
        const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
        expect(await adapter.launchHarness(harnessBinding(), { name: "x" })).toMatchObject({ ok: false, recovery: input.earlyExit!.recovery });
      });

      it("fails fast when the binary is missing", async () => {
        const { adapter, pane } = launchRig([atShell(`sh: 1: exec: ${descriptor.binary}: not found\n$ `)]);
        const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringMatching(/binary was not found/) });
        expect((pane.tmux.getPaneCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(3);
      });

      it("times out as attention_required with pane evidence", async () => {
        const { adapter } = launchRig([{ command: running, content: "still booting\nplease wait" }]);
        const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required", evidence: expect.stringContaining("please wait") });
      });

      it("reports a pane that never leaves the shell", async () => {
        const { adapter } = launchRig([atShell()]);
        const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/still at a shell/) });
      });

      it("surfaces a failed send", async () => {
        const { adapter, pane } = launchRig();
        pane.failNextSend("pane gone");
        const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining("pane gone") });
      });
    });

    describe("checkReady", () => {
      it("is ready only while the CLI holds the foreground", async () => {
        expect(await rig().adapter.checkReady(harnessBinding())).toEqual({ ready: true });
        const stale = await rig([{ command: "zsh", content: readyScreen }]).adapter.checkReady(harnessBinding());
        expect(stale).toMatchObject({ ready: false, code: "runtime_exited" });
        const login = await rig([{ command: "-zsh", content: readyScreen }]).adapter.checkReady(harnessBinding());
        expect(login).toMatchObject({ ready: false, code: "runtime_exited" });
      });

      it("reports awaiting_runtime before the ready screen", async () => {
        const result = await rig([{ command: running, content: "" }]).adapter.checkReady(harnessBinding());
        expect(result).toMatchObject({ ready: false, code: "awaiting_runtime" });
      });

      it("is not ready without a session", async () => {
        expect((await rig().adapter.checkReady(harnessBinding({ tmuxSession: null }))).ready).toBe(false);
      });
    });

    describe("resume", () => {
      if (descriptor.resumeType) {
        const token = input.validResumeToken!;
        it("resumes a valid token through launchHarness and the restore contract", async () => {
          const launch = resumeRig([ready], token);
          const result = await launch.adapter.launchHarness(launch.binding, { name: "x", resumeToken: token });
          expect(result).toMatchObject({ ok: true, resumeToken: token, resumeType: descriptor.resumeType });
          expect(launch.pane.typed[0]).toContain(token);

          const restore = resumeRig([ready], token);
          expect(restore.adapter.canResume(descriptor.resumeType!, token)).toBe(true);
          expect(restore.adapter.canResume("some_other_type", token)).toBe(false);
          expect(restore.adapter.canResume(descriptor.resumeType!, null)).toBe(false);
          const resumed = await restore.adapter.resume({
            nodeId: "node-1", sessionName: HARNESS_SESSION, resumeType: descriptor.resumeType!, resumeToken: token, cwd: restore.cwd,
          });
          expect(resumed.ok).toBe(true);
          expect(restore.pane.typed[0]).toContain(token);
        });

        it("maps a resume gate to attention_required for restore", async () => {
          const gate = input.gateScreens?.[0];
          if (!gate) return;
          const { adapter, cwd } = resumeRig([{ command: running, content: gate.screen }], token);
          const resumed = await adapter.resume({
            nodeId: "node-1", sessionName: HARNESS_SESSION, resumeType: descriptor.resumeType!, resumeToken: token, cwd,
          });
          expect(resumed).toMatchObject({ ok: false, code: "attention_required" });
        });

        if (input.missingResumeToken !== undefined) {
          it("refuses a missing resume target as retry_fresh before typing", async () => {
            const { adapter, pane, binding } = resumeRig([ready], token);
            const result = await adapter.launchHarness(binding, { name: "x", resumeToken: input.missingResumeToken! });
            expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
            expect(pane.typed).toEqual([]);
            const again = resumeRig([ready], token);
            const resumed = await again.adapter.resume({
              nodeId: "node-1", sessionName: HARNESS_SESSION, resumeType: descriptor.resumeType!, resumeToken: input.missingResumeToken!, cwd: again.cwd,
            });
            expect(resumed).toMatchObject({ ok: false, code: "retry_fresh" });
          });
        }

        if (input.invalidResumeToken !== undefined) {
          it("refuses a malformed token before typing and never echoes it", async () => {
            const { adapter, pane } = launchRig();
            const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: input.invalidResumeToken! });
            expect(result.ok).toBe(false);
            if (!result.ok && input.invalidResumeToken!.trim()) expect(result.error).not.toContain(input.invalidResumeToken!.trim());
            expect(pane.typed).toEqual([]);
          });
        }
      } else {
        it("refuses a resume token for a runtime without one", async () => {
          const { adapter, pane } = launchRig();
          const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: "anything" });
          expect(result.ok).toBe(false);
          expect(pane.typed).toEqual([]);
          expect(adapter.canResume("anything", "anything")).toBe(false);
        });
      }
    });

    if (descriptor.resumeType && descriptor.captureResumeToken && input.seedSession) {
      describe("late resume-token capture (lazy sessions)", () => {
        function realDirs() {
          const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `openrig-${descriptor.id}-`));
          const dirs = { root, stateRoot: nodePath.join(root, "state"), homedir: nodePath.join(root, "home"), cwd: nodePath.join(root, "work") };
          for (const dir of [dirs.stateRoot, dirs.homedir, dirs.cwd]) fs.mkdirSync(dir, { recursive: true });
          return dirs;
        }
        function withRegistered<T>(fn: () => Promise<T>): Promise<T> {
          const unregister = getRuntimeDescriptor(descriptor.id) ? null : registerRuntimeDescriptor(descriptor);
          return fn().finally(() => unregister?.());
        }

        it("finds nothing at launch, then the refresher and restore capture the session", () => withRegistered(async () => {
          const dirs = realDirs();
          const db = createFullTestDb();
          try {
            const pane = mockTmux([atShell(), ready]);
            const adapter = registration.createAdapter(harnessDeps({
              tmux: pane.tmux, fsOps: createNodeFsOps(), stateRoot: dirs.stateRoot, homedir: dirs.homedir,
              now: () => new Date(Date.now() - 2_000),
            }));
            const launched = await adapter.launchHarness(harnessBinding({ cwd: dirs.cwd }), { name: "x" });
            expect(launched.ok).toBe(true);
            const seatStateDir = nodePath.join(dirs.stateRoot, descriptor.id, HARNESS_SESSION);
            expect(fs.existsSync(nodePath.join(seatStateDir, LAUNCH_RECORD_FILE))).toBe(true);
            const minted = launched.ok ? launched.resumeToken : undefined;
            if (!minted) {
              // Lazy: nothing to capture yet (the result may carry appliedLaunch).
              expect(launched).toMatchObject({ ok: true });
              expect(launched.ok && launched.resumeToken).toBeFalsy();
            }

            const token = input.seedSession!({ seatStateDir, cwd: dirs.cwd, homedir: dirs.homedir });

            // Refresher: the periodic fill-null tick persists the late token.
            const rigRepo = new RigRepository(db);
            const sessionRegistry = new SessionRegistry(db);
            const node = rigRepo.addNode(rigRepo.createRig("contract").id, "dev", { runtime: descriptor.id, cwd: dirs.cwd });
            const row = sessionRegistry.registerSession(node.id, HARNESS_SESSION);
            const refresher = new ResumeMetadataRefresher({
              sessionRegistry, tmuxAdapter: pane.tmux, runtimeStateRoot: dirs.stateRoot, homeDir: dirs.homedir,
            });
            await refresher.refresh([{
              sessionId: row.id, sessionName: HARNESS_SESSION, runtime: descriptor.id, resumeType: null, resumeToken: null, cwd: dirs.cwd,
            }], { fillNullOnly: true });
            const persisted = db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(row.id) as { resume_type: string; resume_token: string };
            expect(persisted).toEqual({ resume_type: descriptor.resumeType, resume_token: token });

            // Restore: a snapshot session without a token captures it once before deciding.
            const eventBus = new EventBus(db);
            const snapshotRepo = new SnapshotRepository(db);
            const checkpointStore = new CheckpointStore(db);
            const orchestrator = new RestoreOrchestrator({
              db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore, tmuxAdapter: pane.tmux,
              snapshotCapture: new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore }),
              nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: pane.tmux }),
              claudeResume: { canResume: () => false } as unknown as ClaudeResumeAdapter,
              codexResume: { canResume: () => false } as unknown as CodexResumeAdapter,
              runtimeStateRoot: dirs.stateRoot,
              homedir: dirs.homedir,
            });
            const snapshotSession = { id: row.id, sessionName: HARNESS_SESSION, resumeType: null, resumeToken: null } as unknown as Session;
            await (orchestrator as unknown as { captureLateResumeToken(r: string, c: string, s: Session): Promise<void> })
              .captureLateResumeToken(descriptor.id, dirs.cwd, snapshotSession);
            expect(snapshotSession.resumeToken).toBe(token);
            expect(snapshotSession.resumeType).toBe(descriptor.resumeType);
          } finally {
            db.close();
            fs.rmSync(dirs.root, { recursive: true, force: true });
          }
        }));
      });
    }

    describe("guidance and skills", () => {
      const source = "/specs/guidance/openrig-start.md";
      const startupFile = (path: string, hint: ResolvedStartupFile["deliveryHint"]): ResolvedStartupFile => ({
        path, absolutePath: source, ownerRoot: "/specs", deliveryHint: hint, required: true, appliesOn: ["fresh_start"],
      });
      const entry = (overrides: Partial<ProjectionEntry>): ProjectionEntry => ({
        category: "guidance", effectiveId: "openrig-start.md", sourceSpec: "spec", sourcePath: source, resourcePath: source,
        absolutePath: source, classification: "managed_merge", mergeStrategy: "managed_block", ...overrides,
      });
      const plan = (entries: ProjectionEntry[]): ProjectionPlan => ({
        runtime: descriptor.id, cwd: HARNESS_CWD, entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [],
      });

      if (descriptor.guidanceFile) {
        const target = nodePath.join(HARNESS_CWD, descriptor.guidanceFile);
        it(`merges guidance as a managed block into ${descriptor.guidanceFile}`, async () => {
          const { adapter, fs } = rig();
          fs.files[source] = "CONTRACT GUIDANCE BODY";
          const result = await adapter.deliverStartup([startupFile("openrig-start.md", "guidance_merge")], harnessBinding());
          expect(result).toEqual({ delivered: 1, failed: [] });
          expect(fs.files[target]).toContain("CONTRACT GUIDANCE BODY");
          expect(fs.files[target]).toContain("openrig-start.md");
        });

        it("skips rig-role guidance (per-seat send_text path)", async () => {
          const { adapter, fs } = rig();
          fs.files[source] = "ROLE";
          const result = await adapter.project(plan([entry({ effectiveId: "rig-role" })]), harnessBinding());
          expect(result).toEqual({ projected: [], skipped: ["rig-role"], failed: [] });
          expect(fs.files[target]).toBeUndefined();
        });
      } else {
        it("skips guidance honestly when the runtime has no guidance file", async () => {
          const { adapter, fs } = rig();
          fs.files[source] = "BODY";
          const result = await adapter.project(plan([entry({})]), harnessBinding());
          expect(result.projected).toEqual([]);
          expect(result.skipped).toEqual(["openrig-start.md"]);
        });
      }

      it(descriptor.skillsDir ? "projects skills into the runtime skills dir" : "skips skills honestly", async () => {
        const { adapter, fs } = rig();
        const skillSource = "/specs/skills/review";
        fs.files[`${skillSource}/SKILL.md`] = "# SKILL review";
        fs.files[`${skillSource}/refs/a.md`] = "ref";
        const result = await adapter.project(plan([entry({ category: "skill", effectiveId: "review", absolutePath: skillSource, mergeStrategy: undefined })]), harnessBinding());
        if (!descriptor.skillsDir) {
          expect(result).toEqual({ projected: [], skipped: ["review"], failed: [] });
          return;
        }
        expect(result).toEqual({ projected: ["review"], skipped: [], failed: [] });
        const dir = descriptor.skillsDir({ cwd: HARNESS_CWD, sessionName: HARNESS_SESSION, stateRoot: "/openrig-home/state", homedir: "/home/operator" })!;
        expect(fs.files[nodePath.join(dir, "review", "SKILL.md")]).toBe("# SKILL review");
        expect(fs.files[nodePath.join(dir, "review", "refs", "a.md")]).toBe("ref");
        const installed = await adapter.listInstalled(harnessBinding());
        expect(installed.map((r) => r.effectiveId)).toContain(nodePath.join("review", "SKILL.md"));
      });

      it("delivers send_text startup files into the pane", async () => {
        const { adapter, fs, pane } = rig();
        fs.files["/specs/hello.txt"] = "hello";
        const result = await adapter.deliverStartup([{ ...startupFile("hello.txt", "send_text"), absolutePath: "/specs/hello.txt" }], harnessBinding());
        expect(result).toEqual({ delivered: 1, failed: [] });
        expect(pane.texts).toEqual(["hello"]);
      });
    });
  });
}
