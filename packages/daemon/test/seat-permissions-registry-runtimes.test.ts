// Per-seat permission selection (`rig seat set-permissions`) for registry CLI
// runtimes: every registered CLI declares floor and full_bypass and maps them
// to distinct launches; the selection validates, persists, applies on the next
// launch, survives the migration that drops the old runtime CHECK, and drift
// detection compares against it. claude-code and codex paths are covered by
// s03-native-permissions.test.ts and stay unchanged.

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { registryPermissionModes, validateNativePermissionSelection } from "../src/domain/native-permission-selection.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { PermissionDriftObserver } from "../src/domain/permission-drift-observer.js";
import { getRuntimeDescriptor, registerRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { COPILOT_SPEC } from "../src/adapters/cli/copilot/index.js";
import type { TuiCliLaunchInput } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { atShell, harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); });

const CLI_IDS = CLI_RUNTIME_REGISTRATIONS.map((r) => r.descriptor.id);

function fixture(runtime: string) {
  const db = new Database(":memory:"); opened.push(db); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db); const rig = rigRepo.createRig("permissions");
  const node = rigRepo.addNode(rig.id, "dev.owner", { runtime, cwd: "/inert/project" });
  const sibling = rigRepo.addNode(rig.id, "dev.sibling", { runtime, cwd: "/inert/project" });
  const registry = new SessionRegistry(db); const session = registry.registerSession(node.id, "dev-owner@permissions");
  registry.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const tmux = new Proxy({}, { get: (_, key) => key === "deliveryGuard" ? undefined : () => { throw new Error("No lifecycle effect permitted"); } }) as TmuxAdapter;
  const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux, runtimeAdapters: {} as Record<string, RuntimeAdapter> });
  return { db, rigRepo, node, sibling, registry, service, store: new NativePermissionStore(db) };
}
const request = (mode: string) => ({ seatRef: "dev-owner@permissions", mode, reason: "operator choice", actor: "operator@permissions" });
const binding = (nodeId: string): NodeBinding => ({ id: "binding", nodeId, attachmentType: "tmux", tmuxSession: "seat", tmuxWindow: null, tmuxPane: "%1", cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/inert/project" });

describe("registry runtimes declare per-seat permission modes", () => {
  it("every registered CLI runtime declares floor and full_bypass", () => {
    expect(CLI_IDS.length).toBeGreaterThanOrEqual(10);
    for (const id of CLI_IDS) expect(getRuntimeDescriptor(id)?.permissionModes, id).toEqual(["floor", "full_bypass"]);
  });

  it.each(CLI_IDS)("%s types different launch commands for floor and full_bypass", async (id) => {
    const registration = CLI_RUNTIME_REGISTRATIONS.find((r) => r.descriptor.id === id)!;
    const typed = async (launchPosture: "floor" | "full_bypass") => {
      // Never ready: the command is typed, then the bounded wait runs out.
      const pane = mockTmux([atShell(), { command: "cli-under-test", content: "starting" }]);
      const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
      await adapter.launchHarness(harnessBinding({ launchPosture }), { name: "x" });
      expect(pane.typed, `${id} ${launchPosture} typed a launch command`).toHaveLength(1);
      return pane.typed[0]!;
    };
    expect(await typed("floor")).not.toBe(await typed("full_bypass"));
  });

  it("the registry refuses invalid declarations", () => {
    const base = { displayName: "Bad", kind: "agent" as const, binary: "bad", supportsFork: false };
    expect(() => registerRuntimeDescriptor({ ...base, id: "bad-mode", permissionModes: ["auto" as never] })).toThrow(/invalid permissionModes/);
    expect(() => registerRuntimeDescriptor({ ...base, id: "bad-kind", kind: "terminal", permissionModes: ["floor"] })).toThrow(/invalid permissionModes/);
    expect(getRuntimeDescriptor("bad-mode")).toBeUndefined();
  });
});

describe("validateNativePermissionSelection for registry runtimes", () => {
  it.each(CLI_IDS)("%s accepts floor and full_bypass and refuses other modes", (id) => {
    expect(validateNativePermissionSelection(id, "floor")).toEqual({ runtime: id, mode: "floor" });
    expect(validateNativePermissionSelection(id, "full_bypass")).toEqual({ runtime: id, mode: "full_bypass" });
    expect(() => validateNativePermissionSelection(id, "auto")).toThrow(/must be floor or full_bypass/);
  });

  it("keeps pi, terminal, and unknown runtimes unsupported, and built-ins on their own paths", () => {
    for (const id of ["pi", "terminal", "stub", "no-such-runtime"]) {
      expect(() => validateNativePermissionSelection(id, "full_bypass"), id).toThrow(/unsupported for runtime/);
    }
    expect(registryPermissionModes("codex")).toEqual([]);
    expect(registryPermissionModes("claude-code")).toEqual([]);
    expect(() => validateNativePermissionSelection("codex", "auto")).toThrow(/Codex permission mode/);
  });
});

describe("rig seat set-permissions on a registry runtime seat", () => {
  it("persists and audits one seat, and the next launch applies it", async () => {
    const f = fixture("copilot");
    expect(await f.service.setPermissions(request("full_bypass"))).toMatchObject({ ok: true, changed: true, to: { runtime: "copilot", mode: "full_bypass" } });
    expect(f.store.read(f.node.id)).toMatchObject({ runtime: "copilot", mode: "full_bypass" });
    expect(f.store.read(f.sibling.id)).toBeNull();
    expect(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.permissions_changed'").get()).toEqual({ n: 1 });
    expect(f.store.apply({ ...binding(f.node.id), launchPosture: "floor" }, "copilot").launchPosture).toBe("full_bypass");
    expect(() => f.store.apply(binding(f.node.id), "cursor")).toThrow(/runtime changed/);
    expect(await f.service.setPermissions(request("inherit"))).toMatchObject({ ok: true, changed: true, to: null });
    expect(f.store.apply({ ...binding(f.node.id), launchPosture: "floor" }, "copilot").launchPosture).toBe("floor");
  });

  it("refuses a mode the runtime does not declare and a runtime that declares none", async () => {
    expect(await fixture("cursor").service.setPermissions(request("auto"))).toMatchObject({ ok: false, code: "permission_selection_refused" });
    expect(await fixture("pi").service.setPermissions(request("full_bypass"))).toMatchObject({ ok: false, message: expect.stringMatching(/unsupported for runtime 'pi'/) });
  });

  it("a stored row for a runtime that does not declare the mode is refused on read, never treated as inherit", () => {
    const f = fixture("copilot");
    f.db.prepare("INSERT INTO node_permission_selections(node_id, runtime, mode, actor, reason) VALUES (?, 'copilot', 'auto', 'a', 'r')").run(f.node.id);
    expect(() => f.store.read(f.node.id)).toThrow(/Invalid persisted native permission selection/);
  });
});

describe("migration 100 drops the runtime CHECK and keeps existing selections", () => {
  it("preserves codex and claude rows, accepts registry runtimes, and applies once", () => {
    const db = new Database(":memory:"); opened.push(db); db.pragma("foreign_keys = ON");
    migrate(db, ALL_MIGRATIONS.filter((m) => !m.name.startsWith("100_")));
    const repo = new RigRepository(db); const rig = repo.createRig("upgrade");
    const codex = repo.addNode(rig.id, "codex", { runtime: "codex", cwd: "/inert" });
    const copilot = repo.addNode(rig.id, "copilot", { runtime: "copilot", cwd: "/inert" });
    db.prepare("INSERT INTO node_permission_selections(node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'codex', 'full_bypass', 'op', 'why', '2026-09-30 00:00:00')").run(codex.id);
    expect(() => db.prepare("INSERT INTO node_permission_selections(node_id, runtime, mode, actor, reason) VALUES (?, 'copilot', 'floor', 'op', 'why')").run(copilot.id)).toThrow(/CHECK/);
    const before = db.prepare("SELECT * FROM node_permission_selections").all();
    migrate(db, ALL_MIGRATIONS); migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM node_permission_selections").all()).toEqual(before);
    db.prepare("INSERT INTO node_permission_selections(node_id, runtime, mode, actor, reason) VALUES (?, 'copilot', 'floor', 'op', 'why')").run(copilot.id);
    expect(new NativePermissionStore(db).read(copilot.id)).toMatchObject({ runtime: "copilot", mode: "floor" });
    expect(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name LIKE '100_%'").get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("drift detection compares against the seat's selected posture", () => {
  function observed(posture: "floor" | "full_bypass") {
    return COPILOT_SPEC.observeLaunch!({ posture } as TuiCliLaunchInput)!;
  }

  it("a full_bypass selection launched as full_bypass is aligned, launched as floor is drift", async () => {
    const f = fixture("copilot");
    const generation = f.registry.currentOccupantTenure(f.node.id)!.generationUuid;
    const observations = new AppliedLaunchObservationStore(f.db);
    const observer = new PermissionDriftObserver({ db: f.db, fs: { readFile: () => "", cwdReadable: () => true, commandAvailable: () => true, claudePermissionModes: () => null } });
    observations.recordGeneration(generation, observed("full_bypass"));
    // No policy and no selection: nothing to compare against.
    expect(observer.diagnose(f.node.id)?.enforcement).toMatchObject({ state: "unknown", reason: "expected_posture_unknown" });
    await f.service.setPermissions(request("full_bypass"));
    expect(observer.diagnose(f.node.id)?.enforcement).toMatchObject({ state: "aligned", expected: "full_bypass", effective: "full_bypass" });
    await f.service.setPermissions(request("floor"));
    expect(observer.diagnose(f.node.id)?.enforcement).toMatchObject({ state: "drift", expected: "floor", effective: "full_bypass" });
  });
});
