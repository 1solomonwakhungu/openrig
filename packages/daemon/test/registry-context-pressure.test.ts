// Feature 4: context-pressure alerts for registry CLI runtimes. A registry
// seat's readUsage reading flows through the context monitor's registry pass
// (feature 1) into context_usage and usage_samples, and from there into the
// existing context.pressure health detector, at the same operator thresholds
// as claude/codex (health.context_pressure.*, default 95/99). A percentage
// exists only when the CLI reports its context window, so a CLI without one
// never alerts. Real migrated database; a test-only runtime with a scripted
// readUsage.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { RuntimeUsageStore } from "../src/domain/runtime-usage-store.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { HealthProjectionService, LiveContextHealthSource } from "../src/domain/health-detectors.js";
import { registerRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import type { RuntimeUsageSnapshot } from "../src/domain/runtime-capabilities.js";
import { delegatedPostureFixture } from "./helpers/delegated-posture.js";

const RUNTIME = "pressure-test-cli";

describe("context-pressure alerts for registry runtimes (feature 4)", () => {
  let home: string;
  let db: Database.Database;
  let rigs: RigRepository;
  let sessions: SessionRegistry;
  let contextStore: ContextUsageStore;
  let monitor: ContextMonitor;
  let projection: HealthProjectionService;
  let reading: RuntimeUsageSnapshot;
  let clock: number;
  let unregister: () => void;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "registry-pressure-"));
    mkdirSync(join(home, "state", "context-usage"), { recursive: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    sessions = new SessionRegistry(db);
    contextStore = new ContextUsageStore(db, { stateDir: home });
    clock = Date.now();
    monitor = new ContextMonitor(db, contextStore, undefined, undefined, {}, new UsageSamplesStore(db));
    monitor.attachRegistryUsage({
      stateRoot: join(home, "state"),
      usageStore: new RuntimeUsageStore(db),
      homedir: home,
      now: () => new Date(clock),
    });
    unregister = registerRuntimeDescriptor({
      id: RUNTIME, displayName: "Pressure Test CLI", kind: "agent", binary: RUNTIME, supportsFork: false, internal: true,
      readUsage: () => reading,
    });
    const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
    const context = new LiveContextHealthSource({
      db, rigRepo: rigs, sessionRegistry: sessions, contextUsageStore: contextStore, now: () => new Date(clock),
    });
    projection = new HealthProjectionService({ read: () => context.read() }, () => policy.read(), delegatedPostureFixture);
  });

  afterEach(() => {
    unregister();
    monitor.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seat() {
    const rig = rigs.createRig("pressure-rig");
    const node = rigs.addNode(rig.id, "dev.impl", { runtime: RUNTIME, cwd: home });
    const session = sessions.registerSession(node.id, "dev-impl@pressure-rig");
    db.prepare("UPDATE sessions SET status = 'running', resume_token = 's1' WHERE id = ?").run(session.id);
    db.prepare("UPDATE occupant_tenures SET boot_at = ? WHERE node_id = ?").run(new Date(clock - 60_000).toISOString(), node.id);
    return node;
  }

  async function report(used: number, window?: number) {
    clock += 10_000;
    reading = {
      contextUsedTokens: used,
      ...(window !== undefined ? { contextWindowTokens: window } : {}),
      observedAt: new Date(clock).toISOString(),
      source: "pressure_test_jsonl",
    };
    await monitor.pollOnce();
  }

  const pressure = () => projection.list({ limit: 50 }).records.filter((r) => r.detector === "context.pressure");

  it("stays quiet below the warning threshold and alerts at it, through the registry pass", async () => {
    const node = seat();
    await report(180_000, 200_000); // 90%
    expect(pressure()).toHaveLength(0);
    await report(192_000, 200_000); // 96%
    const records = pressure();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain(node.id);
    expect(contextStore.getForNode(node.id, "dev-impl@pressure-rig")).toMatchObject({
      availability: "known", usedPercentage: 96, source: "pressure_test_jsonl",
    });
  });

  it("never alerts when the CLI does not report its context window", async () => {
    const node = seat();
    await report(1_900_000); // huge, but no window: no percentage
    await report(1_950_000);
    expect(pressure()).toHaveLength(0);
    expect(contextStore.getForNode(node.id, "dev-impl@pressure-rig")).toMatchObject({ availability: "known", usedPercentage: null });
  });
});
