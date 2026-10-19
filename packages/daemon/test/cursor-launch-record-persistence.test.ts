import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { CURSOR_REGISTRATION } from "../src/adapters/cli/cursor/index.js";
import { cursorChatsDirForCwd } from "../src/adapters/cli/cursor/cursor-cli.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import { runDescriptorTokenCapture } from "../src/domain/runtime-capture.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { getRuntimeDescriptor, registerRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { Session } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { harnessBinding, harnessDeps, atShell, mockTmux, HARNESS_SESSION } from "./helpers/tui-cli-adapter-harness.js";

const OLD = "9e8f977d-c5b6-4f2b-82e5-2c1c1164b977";
const OTHER = "1b2c3d4e-0000-4a4a-8b8b-123456789abc";
const running = { command: "node", content: "Plan, search, build anything" };

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cursor-record-"));
  const stateRoot = path.join(root, "state");
  const homedir = path.join(root, "home");
  const cwd = path.join(root, "work");
  const seatStateDir = path.join(stateRoot, "cursor", HARNESS_SESSION);
  fs.mkdirSync(seatStateDir, { recursive: true });
  const recordPath = path.join(seatStateDir, "launch.json");
  const oldRecord = { runtimeId: "cursor", sessionName: HARNESS_SESSION, cwd, presetToken: OLD,
    launchId: "previous-launch", launchStartedAt: "2026-01-01T00:00:00Z", mode: "fresh" };
  fs.writeFileSync(recordPath, JSON.stringify(oldRecord));
  const store = (token: string) => {
    const file = path.join(cursorChatsDirForCwd(path.join(homedir, ".cursor"), cwd), token, "store.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  };
  store(OLD);
  const pane = mockTmux([atShell(), running]);
  const fsOps = createNodeFsOps();
  const adapter = () => CURSOR_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps, stateRoot, homedir }));
  const capture = () => runDescriptorTokenCapture(CURSOR_REGISTRATION.descriptor, { cwd, sessionName: HARNESS_SESSION, seatStateDir, homedir });
  return { root, stateRoot, homedir, cwd, seatStateDir, recordPath, oldRecord, store, pane, fsOps, adapter, capture,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("Cursor durable launch identity", () => {
  for (const readOnly of [false, true]) for (const storeReady of [false, true]) {
    it(`replaces an older record (${readOnly ? "read-only" : "writable"}) with ${storeReady ? "immediate" : "delayed"} store capture`, async () => {
      const f = fixture();
      const db = createFullTestDb();
      const unregister = getRuntimeDescriptor("cursor") ? () => {} : registerRuntimeDescriptor(CURSOR_REGISTRATION.descriptor);
      try {
        if (readOnly) fs.chmodSync(f.recordPath, 0o444);
        // Simulate the CLI creating its exact reserved store before readiness.
        const send = f.pane.tmux.sendShellCommand.bind(f.pane.tmux);
        let minted = "";
        f.pane.tmux.sendShellCommand = async (session, command) => {
          minted = command.match(/'--new-session-id' '([^']+)'/)![1]!;
          if (storeReady) f.store(minted);
          f.store(OTHER); // same-cwd competing chat must never win
          return send(session, command);
        };
        const result = await f.adapter().launchHarness(harnessBinding({ cwd: f.cwd }), { name: "revision" });
        expect(minted).not.toBe(OLD);
        if (storeReady) expect(result).toMatchObject({ ok: true, resumeToken: minted, resumeType: "cursor_chat_id" });
        else {
          expect(result.ok && result.resumeToken).toBeUndefined();
          expect(await f.capture()).toMatchObject({ outcome: "skipped" });
        }
        expect(JSON.parse(fs.readFileSync(f.recordPath, "utf8")).presetToken).toBe(minted);
        // Restore's capture runner gets no in-memory launch timestamp or token.
        f.store(minted);
        expect(await f.capture()).toEqual({ outcome: "token", token: minted });
        const rigs = new RigRepository(db);
        const sessions = new SessionRegistry(db);
        const node = rigs.addNode(rigs.createRig("revision").id, "dev", { runtime: "cursor", cwd: f.cwd });
        const row = sessions.registerSession(node.id, HARNESS_SESSION);
        const refresher = new ResumeMetadataRefresher({ sessionRegistry: sessions, tmuxAdapter: f.pane.tmux,
          runtimeStateRoot: f.stateRoot, homeDir: f.homedir });
        await refresher.refresh([{ sessionId: row.id, sessionName: HARNESS_SESSION, runtime: "cursor", cwd: f.cwd,
          resumeType: null, resumeToken: null }], { fillNullOnly: true });
        expect(db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(row.id)).toEqual({ resume_token: minted });

        // Exercise the actual restore consumer with a tokenless snapshot,
        // independently of the refresher's result and any adapter memory.
        const eventBus = new EventBus(db);
        const snapshotRepo = new SnapshotRepository(db);
        const checkpointStore = new CheckpointStore(db);
        const restore = new RestoreOrchestrator({
          db, rigRepo: rigs, sessionRegistry: sessions, eventBus, snapshotRepo, checkpointStore,
          tmuxAdapter: f.pane.tmux, runtimeStateRoot: f.stateRoot, homedir: f.homedir,
          snapshotCapture: new SnapshotCapture({ db, rigRepo: rigs, sessionRegistry: sessions, eventBus, snapshotRepo, checkpointStore }),
          nodeLauncher: new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: sessions, eventBus, tmuxAdapter: f.pane.tmux }),
          claudeResume: { canResume: () => false } as unknown as ClaudeResumeAdapter,
          codexResume: { canResume: () => false } as unknown as CodexResumeAdapter,
        });
        const snapshotSession = { ...row, resumeType: null, resumeToken: null } as Session;
        await (restore as unknown as { captureLateResumeToken(r: string, c: string, s: Session): Promise<void> })
          .captureLateResumeToken("cursor", f.cwd, snapshotSession);
        expect(snapshotSession.resumeToken).toBe(minted);
        expect(snapshotSession.resumeType).toBe("cursor_chat_id");
      } finally {
        unregister();
        db.close();
        f.cleanup();
      }
    });
  }

  for (const failure of ["write", "rename"] as const) {
    it(`does not dispatch a new session when launch-record ${failure} fails`, async () => {
      const f = fixture();
      try {
        if (failure === "write") {
          const write = f.fsOps.writeFile;
          f.fsOps.writeFile = (file, content) => {
            if (path.basename(file).startsWith("launch.json")) throw new Error("fixture write denied");
            write(file, content);
          };
        } else {
          f.fsOps.rename = () => { throw new Error("fixture rename denied"); };
        }
        const result = await f.adapter().launchHarness(harnessBinding({ cwd: f.cwd }), { name: "revision" });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
        expect(f.pane.typed).toEqual([]);
        expect(JSON.parse(fs.readFileSync(f.recordPath, "utf8"))).toEqual(f.oldRecord);
        // There is no new CLI to misattribute; retain the preceding record for recovery.
      } finally { f.cleanup(); }
    });
  }
});
