// Feature 1 core consumer: the context monitor's registry pass reads each
// running registry seat's usage through its descriptor readUsage hook and
// persists it (runtime_usage, context_usage, usage_samples); the node inventory
// surfaces it as runtimeUsage for `rig ps`. Real migrated database; a test-only
// runtime registered with a scripted readUsage.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor, registryContextUsage } from "../src/domain/context-monitor.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { RuntimeUsageStore, type RuntimeUsageReading } from "../src/domain/runtime-usage-store.js";
import { registerRuntimeDescriptor, type RuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { getNodeInventoryWithContext } from "../src/domain/node-inventory.js";
import type { RuntimeUsageInput } from "../src/domain/runtime-capabilities.js";

const RUNTIME = "usage-test-cli";
const READ_AT = new Date("2026-10-03T04:00:00.000Z");

describe("registry usage pass (feature 1)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessions: SessionRegistry;
  let contextStore: ContextUsageStore;
  let usageStore: RuntimeUsageStore;
  let monitor: ContextMonitor;
  let tmp: string;
  let reading: RuntimeUsageReading | null;
  let readUsage: ReturnType<typeof vi.fn>;
  let unregister: () => void;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessions = new SessionRegistry(db);
    tmp = join(tmpdir(), `usage-poller-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, "state", "context-usage"), { recursive: true });
    contextStore = new ContextUsageStore(db, { stateDir: tmp });
    usageStore = new RuntimeUsageStore(db);
    monitor = new ContextMonitor(db, contextStore, undefined, undefined, {}, new UsageSamplesStore(db));
    monitor.attachRegistryUsage({ stateRoot: join(tmp, "state"), usageStore, homedir: "/home/operator", now: () => READ_AT });
    reading = {
      inputTokens: 30_000, outputTokens: 2_100, cacheReadTokens: 120_000, reasoningTokens: 400, costUsd: 0.42, costSource: "cli_reported",
      contextUsedTokens: 50_000, contextWindowTokens: 200_000, model: "anthropic/claude-sonnet-4-5",
      observedAt: "2026-10-03T03:59:00.000Z", source: "usage_test_db",
    };
    readUsage = vi.fn(async (_input: RuntimeUsageInput) => reading);
    const descriptor: RuntimeDescriptor = {
      id: RUNTIME, displayName: "Usage Test CLI", kind: "agent", binary: RUNTIME, supportsFork: false, internal: true,
      readUsage: (input) => readUsage(input),
    };
    unregister = registerRuntimeDescriptor(descriptor);
  });

  afterEach(() => {
    unregister();
    monitor.stop();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed(opts: { runtime?: string; status?: string; sessionName?: string; resumeToken?: string | null } = {}) {
    const rig = rigRepo.createRig(`rig-${Math.random().toString(36).slice(2, 7)}`);
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts.runtime ?? RUNTIME, cwd: "/work/project" });
    const sessionName = opts.sessionName ?? "dev-impl@usage";
    const session = sessions.registerSession(node.id, sessionName);
    db.prepare("UPDATE sessions SET status = ?, resume_token = ? WHERE id = ?")
      .run(opts.status ?? "running", opts.resumeToken === undefined ? "ses_1" : opts.resumeToken, session.id);
    return { rig, node, sessionName };
  }

  it("reads a running registry seat with its seat context and persists usage, context, and a sample", async () => {
    const { rig, node, sessionName } = seed();
    await monitor.pollOnce();

    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(readUsage.mock.calls[0]![0]).toMatchObject({
      sessionName, cwd: "/work/project", resumeToken: "ses_1", homedir: "/home/operator",
      seatStateDir: join(tmp, "state", RUNTIME, sessionName),
    });

    const usage = usageStore.getForNodes([{ nodeId: node.id, currentSessionName: sessionName }]).get(node.id);
    expect(usage).toEqual({ ...reading, runtime: RUNTIME, sessionName, readAt: READ_AT.toISOString() });

    const context = contextStore.getForNode(node.id, sessionName);
    expect(context).toMatchObject({
      availability: "known", source: "usage_test_db", usedPercentage: 25, remainingPercentage: 75,
      contextWindowSize: 200_000, totalInputTokens: 50_000, sessionName,
    });

    const samples = db.prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE node_id = ?").get(node.id) as { n: number };
    expect(samples.n).toBe(1);

    const [entry] = getNodeInventoryWithContext(db, rig.id, contextStore);
    expect(entry?.runtimeUsage).toMatchObject({ costUsd: 0.42, model: "anthropic/claude-sonnet-4-5", runtime: RUNTIME });
  });

  it("skips stopped seats and runtimes without readUsage", async () => {
    seed({ status: "exited" });
    seed({ runtime: "claude-code" });
    await monitor.pollOnce();
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("keeps context_usage untouched when the CLI reports no context, and stores the rest", async () => {
    reading = { costUsd: 0.05, costSource: "estimated", outputTokens: 10, observedAt: "2026-10-03T03:00:00.000Z", source: "usage_test_db", approximate: true };
    const { node, sessionName } = seed();
    await monitor.pollOnce();
    expect(contextStore.getForNode(node.id, sessionName)).toMatchObject({ availability: "unknown", reason: "no_data" });
    expect(usageStore.getForNodes([{ nodeId: node.id, currentSessionName: sessionName }]).get(node.id))
      .toMatchObject({ costUsd: 0.05, costSource: "estimated", approximate: true });
  });

  it("a null reading or a throwing hook stores nothing and does not stop the poll", async () => {
    const a = seed({ sessionName: "a@usage" });
    reading = null;
    await monitor.pollOnce();
    readUsage.mockImplementationOnce(async () => { throw new Error("corrupt record"); });
    await expect(monitor.pollOnce()).resolves.toBeUndefined();
    expect(usageStore.getForNodes([{ nodeId: a.node.id, currentSessionName: "a@usage" }]).size).toBe(0);
  });

  it("a cost without its provenance is never stored (the F1 runner drops it)", async () => {
    reading = { costUsd: 9.99, inputTokens: 5, observedAt: "2026-10-03T03:00:00.000Z", source: "usage_test_db" };
    const { node, sessionName } = seed();
    await monitor.pollOnce();
    const stored = usageStore.getForNodes([{ nodeId: node.id, currentSessionName: sessionName }]).get(node.id);
    expect(stored).toMatchObject({ inputTokens: 5 });
    expect(stored?.costUsd).toBeUndefined();
    expect(stored?.costSource).toBeUndefined();
  });

  it("a reading from a previous session is not shown for the current one", async () => {
    const { rig, node } = seed();
    await monitor.pollOnce();
    db.prepare("UPDATE sessions SET session_name = 'dev-impl@usage-2' WHERE node_id = ?").run(node.id);
    expect(usageStore.getForNodes([{ nodeId: node.id, currentSessionName: "dev-impl@usage-2" }]).size).toBe(0);
    const [entry] = getNodeInventoryWithContext(db, rig.id, contextStore);
    expect(entry?.runtimeUsage).toBeUndefined();
  });
});

describe("registryContextUsage", () => {
  const seat = { sessionName: "s", resumeToken: "t" };
  it("computes a percentage only when the CLI reports its window", () => {
    expect(registryContextUsage({ contextUsedTokens: 10, observedAt: "x", source: "s" }, seat, "r")).toMatchObject({
      availability: "known", usedPercentage: null, contextWindowSize: null, totalInputTokens: 10, sampledAt: "r",
    });
    expect(registryContextUsage({ contextUsedTokens: 250, contextWindowTokens: 200, observedAt: "x", source: "s" }, seat, "r"))
      .toMatchObject({ usedPercentage: 100, remainingPercentage: 0 });
    expect(registryContextUsage({ costUsd: 1, observedAt: "x", source: "s" }, seat, "r")).toBeNull();
  });
});
