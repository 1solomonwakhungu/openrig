// Sibling-seat guard for late resume-token capture: a CLI runtime whose
// capture is not session-scoped is not asked while another live seat of the
// same runtime shares the cwd (post-launch, refresher, restore). A minted
// token and the session-scoped built-ins are unaffected.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { getRuntimeDescriptor, registerRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE, runDescriptorTokenCapture } from "../src/domain/runtime-capture.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { Session } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { EXAMPLE_CLI_DESCRIPTOR, EXAMPLE_CLI_SPEC, seedExampleSession } from "./helpers/example-cli-runtime.js";
import { atShell, harnessBinding, harnessDeps, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

const CWD = "/work/shared";

describe("sibling-seat guard", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let root: string;
  let stateRoot: string;
  let unregister: () => void;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-sibling-"));
    stateRoot = nodePath.join(root, "state");
    unregister = registerRuntimeDescriptor(EXAMPLE_CLI_DESCRIPTOR);
  });
  afterEach(() => {
    unregister();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seat(rig: string, member: string, opts: { runtime?: string; cwd?: string; status?: string } = {}) {
    const rigId = rigRepo.findRigsByName?.(rig)?.[0]?.id ?? rigRepo.createRig(rig).id;
    const node = rigRepo.addNode(rigId, member, { runtime: opts.runtime ?? "example-cli", cwd: opts.cwd ?? CWD });
    const sessionName = `${member}@${rig}`;
    const session = registry.registerSession(node.id, sessionName);
    registry.updateStatus(session.id, opts.status ?? "running");
    const seatStateDir = nodePath.join(stateRoot, opts.runtime ?? "example-cli", sessionName);
    return { node, session, sessionName, seatStateDir };
  }
  const guard = { hasLiveSiblingSeat: (input: { runtime: string; cwd: string; sessionName: string }) => registry.hasLiveSiblingSeat(input) };

  describe("SessionRegistry.hasLiveSiblingSeat", () => {
    it("finds a live seat of the same runtime in the same cwd, in any rig", () => {
      const a = seat("r1", "a");
      expect(registry.hasLiveSiblingSeat({ runtime: "example-cli", cwd: CWD, sessionName: a.sessionName })).toBeNull();
      seat("r2", "b");
      expect(registry.hasLiveSiblingSeat({ runtime: "example-cli", cwd: CWD, sessionName: a.sessionName })).toBe("b@r2");
    });

    it("compares normalized cwds (trailing slash, relative segments, symlinks)", () => {
      const real = nodePath.join(root, "repo");
      const link = nodePath.join(root, "repo-link");
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(real, link);
      const a = seat("r1", "a", { cwd: `${real}/` });
      seat("r1", "b", { cwd: link });
      seat("r1", "c", { cwd: nodePath.join(real, "sub", "..") });
      expect(registry.hasLiveSiblingSeat({ runtime: "example-cli", cwd: real, sessionName: a.sessionName })).toMatch(/^(b|c)@r1$/);
      expect(registry.hasLiveSiblingSeat({ runtime: "example-cli", cwd: `${link}/`, sessionName: "b@r1" })).toMatch(/^(a|c)@r1$/);
    });

    it("ignores other cwds, other runtimes, and stopped seats", () => {
      const a = seat("r1", "a");
      seat("r1", "b", { cwd: "/work/other" });
      seat("r1", "c", { runtime: "codex" });
      seat("r1", "d", { status: "exited" });
      expect(registry.hasLiveSiblingSeat({ runtime: "example-cli", cwd: CWD, sessionName: a.sessionName })).toBeNull();
    });
  });

  describe("capture runner", () => {
    it("two same-runtime seats in one cwd: neither is captured, and the hook is not called", async () => {
      const a = seat("r1", "a");
      const b = seat("r1", "b");
      seedExampleSession(a.seatStateDir, "sess_a");
      seedExampleSession(b.seatStateDir, "sess_b");
      const hook = vi.fn(EXAMPLE_CLI_DESCRIPTOR.captureResumeToken!);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      for (const s of [a, b]) {
        expect(await runDescriptorTokenCapture({ ...EXAMPLE_CLI_DESCRIPTOR, captureResumeToken: hook }, { sessionName: s.sessionName, cwd: CWD, seatStateDir: s.seatStateDir }, guard))
          .toEqual({ outcome: "skipped", reason: "ambiguous_seat" });
      }
      expect(hook).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("live example-cli seat b@r1 shares /work/shared"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("live example-cli seat a@r1 shares /work/shared"));
      log.mockRestore();
    });

    it("different cwd or different runtime: capture proceeds", async () => {
      const a = seat("r1", "a");
      seat("r1", "b", { cwd: "/work/other" });
      seat("r1", "c", { runtime: "codex" });
      seedExampleSession(a.seatStateDir, "sess_a");
      expect(await runDescriptorTokenCapture(EXAMPLE_CLI_DESCRIPTOR, { sessionName: a.sessionName, cwd: CWD, seatStateDir: a.seatStateDir }, guard))
        .toEqual({ outcome: "token", token: "sess_a" });
    });

    it("a minted token is unaffected", async () => {
      const a = seat("r1", "a");
      seat("r1", "b");
      fs.mkdirSync(a.seatStateDir, { recursive: true });
      fs.writeFileSync(nodePath.join(a.seatStateDir, LAUNCH_RECORD_FILE), JSON.stringify({ presetToken: "sess_minted" }));
      const minted = { ...EXAMPLE_CLI_DESCRIPTOR, captureResumeToken: () => "sess_minted" };
      expect(await runDescriptorTokenCapture(minted, { sessionName: a.sessionName, cwd: CWD, seatStateDir: a.seatStateDir }, guard))
        .toEqual({ outcome: "token", token: "sess_minted" });
    });

    it("opencode seats in one cwd each capture from their own seat database", async () => {
      const opencode = getRuntimeDescriptor("opencode")!;
      expect(opencode.captureIsSessionScoped).toBe(true);
      expect(getRuntimeDescriptor("kilo")!.captureIsSessionScoped).toBe(true);
      const schema = fs.readFileSync(nodePath.join(import.meta.dirname, "fixtures", "opencode-family", "opencode-1.18.33-session-schema.sql"), "utf8");
      const a = seat("r1", "a", { runtime: "opencode" });
      const b = seat("r1", "b", { runtime: "opencode" });
      const ids = { a: "ses_0198a2f0aaaaAAAAAAAAAAAAAA", b: "ses_0198a2f0bbbbBBBBBBBBBBBBBB" };
      for (const [s, id] of [[a, ids.a], [b, ids.b]] as const) {
        fs.mkdirSync(s.seatStateDir, { recursive: true });
        const seatDb = new Database(nodePath.join(s.seatStateDir, "opencode.db"));
        seatDb.pragma("foreign_keys = OFF");
        seatDb.exec(schema);
        seatDb.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, 'proj', NULL, 'slug', ?, 't', '1.18.33', ?, ?, NULL)")
          .run(id, CWD, Date.now() - 1_000, Date.now());
        seatDb.close();
      }
      const capture = (s: typeof a) => runDescriptorTokenCapture(opencode, { sessionName: s.sessionName, cwd: CWD, seatStateDir: s.seatStateDir }, guard);
      expect(await capture(a)).toEqual({ outcome: "token", token: ids.a });
      expect(await capture(b)).toEqual({ outcome: "token", token: ids.b });
    });

    it("session-scoped built-in capture (claude/codex/pi) is never guarded", async () => {
      const codex = getRuntimeDescriptor("codex")!;
      expect(codex.captureIsSessionScoped).toBe(true);
      seat("r1", "a", { runtime: "codex" });
      seat("r1", "b", { runtime: "codex" });
      const deps = { ...guard, resumeTokenCapturer: { captureCodexThreadId: async () => "thread-1" } };
      expect(await runDescriptorTokenCapture(codex, { sessionName: "a@r1", cwd: CWD, seatStateDir: nodePath.join(stateRoot, "codex", "a@r1") }, deps))
        .toEqual({ outcome: "token", token: "thread-1" });
    });

    it("a failing sibling check skips capture", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await runDescriptorTokenCapture(EXAMPLE_CLI_DESCRIPTOR, { sessionName: "a@r1", cwd: CWD, seatStateDir: nodePath.join(stateRoot, "x") }, {
        hasLiveSiblingSeat: () => { throw new Error("db locked"); },
      })).toEqual({ outcome: "skipped", reason: "ambiguous_seat" });
      warn.mockRestore();
    });
  });

  describe("invocation points", () => {
    it("post-launch: no token for a seat with a live sibling in its cwd", async () => {
      const a = seat("r1", "a");
      seat("r1", "b");
      const pane = mockTmux([atShell(), { command: "example-cli", content: "example-cli ready> " }]);
      const adapter = new TuiCliRuntimeAdapter(EXAMPLE_CLI_SPEC, harnessDeps({
        tmux: pane.tmux, fsOps: createNodeFsOps(), stateRoot, homedir: nodePath.join(root, "home"),
        now: () => new Date(Date.now() - 2_000), ...guard,
      }));
      seedExampleSession(a.seatStateDir, "sess_a");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await adapter.launchHarness(harnessBinding({ tmuxSession: a.sessionName, cwd: CWD }), { name: "x" })).toEqual({ ok: true });
      log.mockRestore();
    });

    it("refresher: shared cwd gets no token for either seat; a lone seat is captured", async () => {
      const a = seat("r1", "a");
      const b = seat("r1", "b");
      const c = seat("r1", "c", { cwd: "/work/alone" });
      for (const [s, t] of [[a, "sess_a"], [b, "sess_b"], [c, "sess_c"]] as const) seedExampleSession(s.seatStateDir, t);
      const refresher = new ResumeMetadataRefresher({ sessionRegistry: registry, tmuxAdapter: mockTmux().tmux, runtimeStateRoot: stateRoot, homeDir: root });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await refresher.refresh([a, b, c].map((s) => ({
        sessionId: s.session.id, sessionName: s.sessionName, runtime: "example-cli", resumeType: null, resumeToken: null,
        cwd: s === c ? "/work/alone" : CWD,
      })), { fillNullOnly: true });
      log.mockRestore();
      const token = (id: string) => (db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(id) as { resume_token: string | null }).resume_token;
      expect([token(a.session.id), token(b.session.id), token(c.session.id)]).toEqual([null, null, "sess_c"]);
    });

    it("restore: late capture is skipped while a sibling is live in the cwd", async () => {
      const a = seat("r1", "a");
      seat("r1", "b");
      seedExampleSession(a.seatStateDir, "sess_a");
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const tmuxAdapter = mockTmux().tmux;
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry: registry, eventBus, snapshotRepo, checkpointStore, tmuxAdapter,
        snapshotCapture: new SnapshotCapture({ db, rigRepo, sessionRegistry: registry, eventBus, snapshotRepo, checkpointStore }),
        nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter }),
        claudeResume: { canResume: () => false } as unknown as ClaudeResumeAdapter,
        codexResume: { canResume: () => false } as unknown as CodexResumeAdapter,
        runtimeStateRoot: stateRoot,
        homedir: root,
      });
      const snapshotSession = { id: a.session.id, sessionName: a.sessionName, resumeType: null, resumeToken: null } as unknown as Session;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await (orchestrator as unknown as { captureLateResumeToken(r: string, c: string, s: Session): Promise<void> })
        .captureLateResumeToken("example-cli", CWD, snapshotSession);
      log.mockRestore();
      expect(snapshotSession.resumeToken).toBeNull();
    });
  });
});
