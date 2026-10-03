// Per-seat launch readiness window (rig spec member `readiness_timeout_ms`,
// an upstream roadmap item: "Codex seats time out under load"). The value is
// validated and bounded, persisted on the node, and replaces each launch
// wait's built-in window: the startup readiness poll, the successor launcher,
// the TUI CLI base, and the built-in adapters' own launch/resume checks.
// Absent, every default is unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigSpecSchema, READINESS_TIMEOUT_MAX_MS, READINESS_TIMEOUT_MIN_MS } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { nodeReadinessTimeoutSchema } from "../src/db/migrations/500_node_readiness_timeout.js";
import { createFullTestDb, migrationsForFullTestDb, mockTmuxAdapter } from "./helpers/test-app.js";
import { EXAMPLE_CLI_REGISTRATION } from "./helpers/example-cli-runtime.js";
import { atShell, harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

function rawSpec(member: Record<string, unknown>) {
  return {
    version: "0.2",
    name: "timeouts",
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", ...member }], edges: [] }],
    edges: [],
  };
}

describe("rig spec: readiness_timeout_ms", () => {
  it("accepts an integer within bounds and normalizes it onto the member", () => {
    const spec = rawSpec({ readiness_timeout_ms: 120_000 });
    expect(RigSpecSchema.validate(spec)).toMatchObject({ valid: true });
    expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.readinessTimeoutMs).toBe(120_000);
  });

  it.each([
    ["below the minimum", READINESS_TIMEOUT_MIN_MS - 1],
    ["above the maximum", READINESS_TIMEOUT_MAX_MS + 1],
    ["a fraction", 45_000.5],
    ["a string", "90s"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    const result = RigSpecSchema.validate(rawSpec({ readiness_timeout_ms: value }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/readiness_timeout_ms: must be an integer number of milliseconds from 5000 to 600000/);
  });

  it("is optional, and round-trips through spec serialization", () => {
    expect(RigSpecSchema.normalize(rawSpec({})).pods[0]!.members[0]!.readinessTimeoutMs).toBeUndefined();
    const spec = RigSpecSchema.normalize(rawSpec({ readiness_timeout_ms: 90_000 }));
    const yaml = RigSpecCodec.serialize(spec);
    expect(yaml).toContain("readiness_timeout_ms: 90000");
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>).pods[0]!.members[0]!.readinessTimeoutMs).toBe(90_000);
  });
});

describe("nodes.readiness_timeout_ms", () => {
  it("persists the seat's window and reads it back; absent stays null", () => {
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db);
      const rig = repo.createRig("timeouts");
      const slow = repo.addNode(rig.id, "dev.slow", { runtime: "codex", readinessTimeoutMs: 120_000 });
      const plain = repo.addNode(rig.id, "dev.plain", { runtime: "codex" });
      expect(slow.readinessTimeoutMs).toBe(120_000);
      expect(plain.readinessTimeoutMs).toBeNull();
      expect(repo.getRig(rig.id)!.nodes.find((n) => n.id === slow.id)!.readinessTimeoutMs).toBe(120_000);
    } finally {
      db.close();
    }
  });

  it("is ignored on a database without the column (pre-500 fixtures)", () => {
    const db = createDb();
    try {
      migrate(db, migrationsForFullTestDb.filter((m) => m !== nodeReadinessTimeoutSchema));
      const repo = new RigRepository(db);
      const rig = repo.createRig("legacy");
      expect(() => repo.addNode(rig.id, "dev.slow", { runtime: "codex", readinessTimeoutMs: 120_000 })).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("startup readiness poll", () => {
  let db: Database.Database;
  let seed: { rigId: string; nodeId: string; sessionId: string };

  beforeEach(() => {
    db = createFullTestDb();
    const repo = new RigRepository(db);
    const rig = repo.createRig("timeouts");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = new SessionRegistry(db).registerSession(node.id, "dev-impl@timeouts");
    seed = { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  });
  afterEach(() => db.close());

  function orchestrator() {
    return new StartupOrchestrator({
      db, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: mockTmuxAdapter(),
    });
  }
  function binding(extra: Partial<NodeBinding> = {}): NodeBinding {
    return {
      id: "b1", nodeId: seed.nodeId, tmuxSession: "dev-impl@timeouts", tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/w", ...extra,
    };
  }
  function adapter(readySequence: boolean[]): RuntimeAdapter {
    let call = 0;
    return {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: true })),
      checkReady: vi.fn(async () => {
        const ready = readySequence[Math.min(call, readySequence.length - 1)]!;
        call++;
        return ready ? { ready: true } : { ready: false, reason: "harness not interactive" };
      }),
    } as unknown as RuntimeAdapter;
  }
  const input = (extra: Record<string, unknown>) => ({
    rigId: seed.rigId, nodeId: seed.nodeId, sessionId: seed.sessionId,
    plan: { runtime: "codex", cwd: "/w", entries: [], actionable: false } as never,
    resolvedStartupFiles: [], startupActions: [], isRestore: false, ...extra,
  });

  it("the seat's window wins over the caller's default (a slow start becomes ready)", async () => {
    // Not ready, not ready, ready. A 100 ms caller window gives up after the
    // second check; the seat's 2.5 s window reaches the third.
    const slow = adapter([false, false, true]);
    const result = await orchestrator().startNode(input({
      binding: binding({ readinessTimeoutMs: 2_500 }), adapter: slow, readinessTimeoutMs: 100,
    }) as never);
    expect(result.ok).toBe(true);
  }, 10_000);

  it("reports the configured window in the timeout message, not a fixed 30s", async () => {
    const result = await orchestrator().startNode(input({
      binding: binding({ readinessTimeoutMs: 100 }), adapter: adapter([false]), readinessTimeoutMs: 60_000,
    }) as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = result.errors.find((e) => e.startsWith("Readiness timeout after"));
      expect(message).toMatch(/^Readiness timeout after 0\.1s: harness did not become interactive \(raise readiness_timeout_ms/);
    }
  });
});

describe("TUI CLI base launch wait", () => {
  it("polls for the seat's window instead of the runtime's launchTimeoutMs", async () => {
    // example-cli: launchTimeoutMs 2000, poll 250 -> 8 polls by default.
    const polls = async (readinessTimeoutMs?: number) => {
      const pane = mockTmux([atShell(), { command: "example-cli", content: "booting" }]);
      const adapter = EXAMPLE_CLI_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
      const result = await adapter.launchHarness(harnessBinding(readinessTimeoutMs ? { readinessTimeoutMs } : {}), { name: "x" });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      return (pane.tmux.getPaneCommand as ReturnType<typeof vi.fn>).mock.calls.length;
    };
    const defaults = await polls();
    const seat = await polls(5_000);
    expect(seat - defaults).toBe(12); // 20 polls instead of 8
  });
});

describe("pi runner wait", () => {
  it("waits for the seat's window instead of ~15 s", async () => {
    const reads = async (readinessTimeoutMs?: number) => {
      const files: Record<string, string> = {};
      const dirs = new Set<string>();
      let stateReads = 0;
      const statePath = piSeatPaths("/state/pi", "dev-pi@r").runnerStatePath;
      const fs: PiAdapterFsOps = {
        readFile: (p) => { if (p === statePath) stateReads++; if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
        writeFile: (p, c) => { files[p] = c; },
        exists: (p) => p in files || dirs.has(p),
        mkdirp: (p) => { dirs.add(p); },
        listFiles: () => [],
      };
      const tmux = { sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })) } as unknown as TmuxAdapter;
      const pi = new PiRuntimeAdapter({ tmux, fsOps: fs, stateRoot: "/state/pi", runnerEntryPath: "/r.js", sleep: async () => {} });
      const result = await pi.launchHarness(
        { id: "b", nodeId: "n", tmuxSession: "dev-pi@r", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/w", ...(readinessTimeoutMs ? { readinessTimeoutMs } : {}) },
        { name: "x" },
      );
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      return stateReads;
    };
    const defaults = await reads();
    const seat = await reads(5_000);
    expect(defaults - seat).toBe(40); // 60 polls of 250 ms vs 20
  });
});

describe("successor launcher", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => db.close());

  it("launches the successor under the seat's window and waits for it", async () => {
    let call = 0;
    const checkReady = vi.fn(async () => (++call >= 3 ? { ready: true } : { ready: false, reason: "booting" }));
    const launchHarness = vi.fn(async () => ({ ok: true }));
    const tmux = {
      createSession: vi.fn(async () => ({ ok: true })),
      listPanes: vi.fn(async () => [{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]),
      killSession: vi.fn(async () => ({ ok: true })),
      respawnPane: vi.fn(async () => ({ ok: true })),
      setRemainOnExit: vi.fn(async () => ({ ok: true })),
      signalPaneProcess: vi.fn(async () => ({ ok: true })),
      isPaneDead: vi.fn(async () => true),
      getDefaultShell: vi.fn(async () => "/bin/zsh"),
      getPaneCommand: vi.fn(async () => "zsh"),
    } as unknown as TmuxAdapter;
    const launcher = new SuccessorSessionLauncher(tmux, new DiscoveryRepository(db), {
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter },
      readinessTimeoutMs: 50, // the launcher default would give up after the second check
      sleep: async () => {}, exitPollMs: 1, exitTimeoutMs: 5,
    });
    const result = await launcher.createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", readinessTimeoutMs: 120_000 },
      departingSessionName: "dev-impl@rig",
    });
    expect(result.ok).toBe(true);
    expect(launchHarness.mock.calls[0]![0]).toMatchObject({ readinessTimeoutMs: 120_000 });
    expect(checkReady).toHaveBeenCalledTimes(3);
  });
});

describe("built-in resume adapters", () => {
  // A pane that never resolves, so the verify poll runs to its window.
  function stuckTmux() {
    const getPaneCommand = vi.fn(async () => "unknown-binary");
    const known: Record<string, unknown> = {
      getPaneCommand,
      capturePaneContent: vi.fn(async () => "still booting..."),
      hasSession: vi.fn(async () => true),
    };
    const tmux = new Proxy(known, {
      get: (target, prop: string) => target[prop] ?? vi.fn(async () => ({ ok: true })),
    }) as unknown as TmuxAdapter;
    return { tmux, polls: () => getPaneCommand.mock.calls.length };
  }
  const fast = { pollMs: 100, maxWaitMs: 500, sleep: async () => {} };

  it("codex: the seat's window replaces maxWaitMs", async () => {
    const plain = stuckTmux();
    expect((await new CodexResumeAdapter(plain.tmux, fast).resume("s", "codex_id", "uuid-1", "/w")).ok).toBe(false);
    const seat = stuckTmux();
    expect((await new CodexResumeAdapter(seat.tmux, fast).resume("s", "codex_id", "uuid-1", "/w", undefined, undefined, undefined, 1_000)).ok).toBe(false);
    expect(seat.polls() - plain.polls()).toBe(5); // 11 polls of 100 ms vs 6
  });

  it("claude: the seat's window replaces maxWaitMs", async () => {
    const plain = stuckTmux();
    expect((await new ClaudeResumeAdapter(plain.tmux, fast).resume("s", "claude_id", "abc-1", "/w")).ok).toBe(false);
    const seat = stuckTmux();
    expect((await new ClaudeResumeAdapter(seat.tmux, fast).resume("s", "claude_id", "abc-1", "/w", undefined, undefined, undefined, undefined, 1_000)).ok).toBe(false);
    expect(seat.polls() - plain.polls()).toBe(5);
  });
});
