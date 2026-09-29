import { describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission, observeCodexSandbox } from "../src/domain/permission-drift.js";
import { ClaudePermissionModeCache, PermissionDriftObserver } from "../src/domain/permission-drift-observer.js";

describe("PermissionDriftObserver", () => {
  it("reads current-generation arguments without claiming native enforcement", () => {
    const db = createFullTestDb();
    try {
      const rigs = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const rig = rigs.createRig("observer-rig");
      const node = rigs.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/project" });
      sessions.registerClaimedSession(node.id, "dev-impl@observer-rig");
      const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
      new AppliedLaunchObservationStore(db).recordGeneration(generation, observeClaudePermission("--permission-mode acceptEdits"));
      const readFile = vi.fn(() => JSON.stringify({ permissions: { defaultMode: "manual", allow: [], ask: [], deny: [] } }));
      const observer = new PermissionDriftObserver({
        db,
        fs: {
          readFile,
          cwdReadable: () => true,
          commandAvailable: () => true,
          claudePermissionModes: () => ["acceptEdits", "manual"],
        },
        now: () => new Date("2026-08-08T00:00:00.000Z"),
      });

      expect(observer.diagnose(node.id)).toMatchObject({
        transport: { state: "healthy" },
        cwdRead: { state: "visible" },
        commandPath: { state: "available" },
        enforcement: { axis: "permission", state: "unknown", expected: "acceptEdits", effective: null },
        configuration: {
          comparison: "drift",
          expected: "acceptEdits",
          observed: { defaultMode: "manual" },
          sourcePath: "/work/project/.claude/settings.local.json",
        },
      });
      expect(readFile).toHaveBeenCalledWith("/work/project/.claude/settings.local.json");
    } finally {
      db.close();
    }
  });

  it("never blocks a request on a cold or slow Claude help process", async () => {
    let resolve!: (modes: string[] | null) => void;
    const cache = new ClaudePermissionModeCache(() => new Promise((done) => { resolve = done; }));
    cache.warm();
    expect(cache.read()).toBeNull();
    resolve(["acceptEdits", "manual"]);
    await vi.waitFor(() => expect(cache.read()).toEqual(["acceptEdits", "manual"]));
  });

  it("refreshes harness vocabulary asynchronously after its cache expires", async () => {
    let now = 1;
    let modes = ["acceptEdits", "manual"];
    const load = vi.fn(async () => modes);
    const cache = new ClaudePermissionModeCache(load, 10, () => now);
    cache.warm();
    await vi.waitFor(() => expect(cache.read()).toEqual(["acceptEdits", "manual"]));

    modes = ["acceptEdits", "manual", "futureMode"];
    now = 12;
    expect(cache.read()).toEqual(["acceptEdits", "manual"]);
    await vi.waitFor(() => expect(cache.read()).toEqual(["acceptEdits", "manual", "futureMode"]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("classifies a production accessSync EACCES as cwd denied", () => {
    const db = createFullTestDb();
    try {
      const rigs = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const rig = rigs.createRig("observer-eacces");
      const node = rigs.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/work/denied" });
      sessions.registerClaimedSession(node.id, "dev-impl@observer-eacces");
      const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
      new AppliedLaunchObservationStore(db).recordGeneration(generation, observeCodexSandbox("-s workspace-write"));
      const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const observer = new PermissionDriftObserver({
        db,
        accessSync: (path: string) => {
          if (path === "/work/denied") throw denied;
        },
      });

      expect(observer.diagnose(node.id)).toMatchObject({
        transport: { state: "healthy" },
        cwdRead: { state: "denied" },
        enforcement: { axis: "sandbox", state: "unknown", expected: "workspace-write", effective: null },
      });
    } finally {
      db.close();
    }
  });

  it("keeps a non-permission production access error at cwd unknown", () => {
    const db = createFullTestDb();
    try {
      const rigs = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const rig = rigs.createRig("observer-eio");
      const node = rigs.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/work/uncapturable" });
      sessions.registerClaimedSession(node.id, "dev-impl@observer-eio");
      const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
      new AppliedLaunchObservationStore(db).recordGeneration(generation, observeCodexSandbox("-s workspace-write"));
      const observer = new PermissionDriftObserver({
        db,
        accessSync: () => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); },
      });

      expect(observer.diagnose(node.id)).toMatchObject({
        transport: { state: "healthy" },
        cwdRead: { state: "unknown" },
        enforcement: { axis: "sandbox", state: "unknown", expected: "workspace-write", effective: null },
      });
    } finally {
      db.close();
    }
  });
  it("compares a registry runtime's recorded posture with the seat's node or rig policy", () => {
    const db = createFullTestDb();
    try {
      const rigs = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const store = new AppliedLaunchObservationStore(db);
      const rig = rigs.createRig("posture-rig");
      const fsStub = { readFile: () => "", cwdReadable: () => true, commandAvailable: () => true, claudePermissionModes: () => [] };
      const observer = new PermissionDriftObserver({ db, fs: fsStub });
      const seat = (id: string, runtime: string, value: string) => {
        const node = rigs.addNode(rig.id, id, { runtime, cwd: "/work/project" });
        sessions.registerClaimedSession(node.id, `${id.replace(".", "-")}@posture-rig`);
        store.recordGeneration(sessions.currentOccupantTenure(node.id)!.generationUuid, {
          runtime, axis: "permission", state: "observed", value, reason: "emitted_launch_arguments",
        });
        return node;
      };

      const noPolicy = seat("dev.a", "gemini", "yolo");
      expect(observer.diagnose(noPolicy.id)?.enforcement).toMatchObject({ state: "unknown", reason: "expected_posture_unknown" });

      rigs.setRigPolicyProvenance(rig.id, { origin: "builtin", resolvedTarget: null, declaringDir: null, launchPosture: "floor" });
      expect(observer.diagnose(noPolicy.id)?.enforcement).toMatchObject({ state: "drift", expected: "floor", effective: "full_bypass" });

      const nodeOverride = seat("dev.b", "qwen", "yolo");
      rigs.setNodePolicyProvenance(nodeOverride.id, { origin: "builtin", resolvedTarget: null, declaringDir: null, launchPosture: "full_bypass" });
      expect(observer.diagnose(nodeOverride.id)?.enforcement).toMatchObject({ state: "aligned", expected: "full_bypass" });
    } finally {
      db.close();
    }
  });
});
