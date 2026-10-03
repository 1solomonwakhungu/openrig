// Runtime fallback x per-seat permission selections: a selection made for one
// of the seat's runtimes carries a floor/full_bypass posture to a fallback
// runtime that accepts it; otherwise the policy posture applies. The decision
// is recorded as node.permission_selection_fallback.

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function fixture(selection: { runtime: string; mode: string } | null, fallbackRuntimes: string[] = ["codex", "pi"]) {
  const db = new Database(":memory:"); opened.push(db); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db); const rig = rigRepo.createRig("fallback");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/inert/project", fallbackRuntimes });
  const registry = new SessionRegistry(db); const session = registry.registerSession(node.id, "dev-impl@fallback");
  const eventBus = new EventBus(db);
  const store = new NativePermissionStore(db);
  if (selection) store.write(node.id, selection, "operator@fallback", "deliberate operator choice");
  return { db, rigRepo, rig, node, registry, session, eventBus, store };
}

const binding = (nodeId: string): NodeBinding => ({ id: "binding", nodeId, attachmentType: "tmux", tmuxSession: "seat", tmuxWindow: null, tmuxPane: "%1", cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/inert/project" });

describe("permission selection on a fallback runtime (overrideFor)", () => {
  it("carries full_bypass from the declared runtime to codex", () => {
    const f = fixture({ runtime: "claude-code", mode: "full_bypass" });
    f.rigRepo.setNodeRunningRuntime(f.node.id, "codex");
    expect(f.store.overrideFor(f.node.id, "codex")).toMatchObject({ override: { launchPosture: "full_bypass" }, fallback: { applied: true } });
  });

  it("a Claude-only mode does not apply to codex: the policy posture stays", () => {
    const f = fixture({ runtime: "claude-code", mode: "auto" });
    expect(f.store.overrideFor(f.node.id, "codex")).toMatchObject({ override: {}, fallback: { applied: false, selection: { mode: "auto" } } });
  });

  it("a runtime without per-seat modes (pi) keeps the policy posture", () => {
    const f = fixture({ runtime: "claude-code", mode: "floor" });
    expect(f.store.overrideFor(f.node.id, "pi")).toMatchObject({ override: {}, fallback: { applied: false } });
  });

  it("a selection made while on the fallback carries back to the declared runtime", () => {
    const f = fixture({ runtime: "codex", mode: "floor" });
    expect(f.store.overrideFor(f.node.id, "claude-code")).toMatchObject({ override: { launchPosture: "floor" }, fallback: { applied: true } });
  });

  it("the matching runtime applies the selection as before, with no fallback note", () => {
    const f = fixture({ runtime: "claude-code", mode: "auto" });
    expect(f.store.overrideFor(f.node.id, "claude-code")).toEqual({ override: { permissionMode: "auto" } });
  });

  it("a runtime outside the seat's candidates still refuses", () => {
    const f = fixture({ runtime: "claude-code", mode: "full_bypass" });
    expect(() => f.store.overrideFor(f.node.id, "gemini")).toThrow(/Seat runtime changed since permission selection/);
  });

  it("a seat without fallback_runtimes still refuses a runtime change", () => {
    const f = fixture({ runtime: "claude-code", mode: "full_bypass" }, []);
    expect(() => f.store.overrideFor(f.node.id, "codex")).toThrow(/Seat runtime changed since permission selection/);
  });
});

describe("startup records the carried selection", () => {
  async function start(f: ReturnType<typeof fixture>, runtime: string) {
    const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop before native launch" }));
    const adapter = { runtime, project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: [], failed: [] }), launchHarness } as unknown as RuntimeAdapter;
    const orchestrator = new StartupOrchestrator({ db: f.db, sessionRegistry: f.registry, eventBus: f.eventBus, tmuxAdapter: {} as TmuxAdapter });
    await orchestrator.startNode({ rigId: f.rig.id, nodeId: f.node.id, sessionId: f.session.id,
      binding: { ...binding(f.node.id), launchPosture: "floor" }, adapter, plan: { entries: [] } as never,
      resolvedStartupFiles: [], startupActions: [], isRestore: false });
    const events = (f.db.prepare("SELECT payload FROM events WHERE type = 'node.permission_selection_fallback'").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload));
    return { launchHarness, events };
  }

  it("applies full_bypass on codex and records applied: true", async () => {
    const f = fixture({ runtime: "claude-code", mode: "full_bypass" });
    f.rigRepo.setNodeRunningRuntime(f.node.id, "codex");
    const { launchHarness, events } = await start(f, "codex");
    expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({ launchPosture: "full_bypass" }), expect.anything());
    expect(events).toEqual([expect.objectContaining({ selectionRuntime: "claude-code", runtime: "codex", mode: "full_bypass", applied: true })]);
  });

  it("keeps the policy posture for a Claude-only mode on codex and records applied: false", async () => {
    const f = fixture({ runtime: "claude-code", mode: "auto" });
    f.rigRepo.setNodeRunningRuntime(f.node.id, "codex");
    const { launchHarness, events } = await start(f, "codex");
    expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({ launchPosture: "floor" }), expect.anything());
    expect(launchHarness).not.toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto" }), expect.anything());
    expect(events).toEqual([expect.objectContaining({ runtime: "codex", mode: "auto", applied: false })]);
  });

  it("records nothing when the seat runs its selection's runtime", async () => {
    const f = fixture({ runtime: "claude-code", mode: "full_bypass" });
    const { events } = await start(f, "claude-code");
    expect(events).toEqual([]);
  });
});
