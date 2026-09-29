// The runtime registry: built-in descriptors reproduce the pre-registry tables
// exactly, and a registered runtime (the test-only example-cli fixture) flows
// through every registry-driven site without editing it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import {
  BUILTIN_RUNTIME_IDS, formatRuntimeIdList, getRuntimeDescriptor, isRegisteredRuntime, listRuntimeDescriptors,
  registerRuntimeDescriptor, runtimeProbeCommand, runtimeSeatStateDir, type RuntimeDescriptor,
} from "../src/domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE } from "../src/domain/runtime-capture.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { buildRuntimeAdapters, createCliRuntimeAdapters } from "../src/adapters/runtime-adapter-map.js";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { verifyCliRuntimesAvailable } from "../src/domain/rigspec-preflight.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import { LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { SessionFingerprinter, processMatches } from "../src/domain/session-fingerprinter.js";
import { classifyPaneRuntimeMatch } from "../src/domain/seat-identity-reconciler.js";
import { generateDraftRig } from "../src/domain/draft-rig-generator.js";
import { effectiveLaunchPosture } from "../src/adapters/yolo-mode.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { RuntimeAdapter, RuntimeResumeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { CmuxAdapter } from "../src/adapters/cmux.js";
import type { DiscoveredSession } from "../src/domain/discovery-types.js";
import type { RigSpec } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { EXAMPLE_CLI_DESCRIPTOR, EXAMPLE_CLI_REGISTRATION } from "./helpers/example-cli-runtime.js";
import { harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

let unregister: (() => void) | null = null;
function registerExample(overrides: Partial<RuntimeDescriptor> = {}): void {
  unregister = registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, ...overrides });
}
afterEach(() => { unregister?.(); unregister = null; });

describe("runtime registry: built-in descriptors (behavior-preserving)", () => {
  it("keeps every pre-registry runtime (built-ins are a subset of the registry)", () => {
    expect([...BUILTIN_RUNTIME_IDS].sort()).toEqual(["claude-code", "codex", "pi", "stub", "terminal"]);
    const ids = listRuntimeDescriptors().map((d) => d.id);
    for (const id of BUILTIN_RUNTIME_IDS) expect(ids).toContain(id);
  });

  it("every CLI index entry has a registered descriptor, a factory, and a docs page", () => {
    const docs = path.resolve(import.meta.dirname, "../../../docs/reference/runtimes");
    const index = fs.readFileSync(path.join(docs, "README.md"), "utf-8");
    const ids = CLI_RUNTIME_REGISTRATIONS.map((r) => r.descriptor.id);
    expect(ids).toEqual([...ids].sort()); // alphabetical, so parallel additions touch distinct lines
    for (const registration of CLI_RUNTIME_REGISTRATIONS) {
      const id = registration.descriptor.id;
      expect(getRuntimeDescriptor(id)).toBe(registration.descriptor);
      expect(BUILTIN_RUNTIME_IDS as readonly string[]).not.toContain(id);
      expect(typeof registration.createAdapter).toBe("function");
      expect(fs.existsSync(path.join(docs, `${id}.md`)), `docs/reference/runtimes/${id}.md`).toBe(true);
      expect(index).toContain(`\`${id}\``);
    }
  });

  it("reproduces the old preflight probe table (RUNTIME_COMMANDS) for built-ins", () => {
    const table = Object.fromEntries(BUILTIN_RUNTIME_IDS.map((id) => [id, runtimeProbeCommand(getRuntimeDescriptor(id))]));
    expect(table).toEqual({
      "claude-code": "claude --version", codex: "codex --version", pi: "pi --version", stub: null, terminal: null,
    });
  });

  it("reproduces resume types and the set-resume-token refusal text", () => {
    expect(["claude-code", "codex", "pi", "terminal", "stub", "nope", null].map((r) => resumeTypeForRuntime(r)))
      .toEqual(["claude_id", "codex_id", "pi_session_file", null, null, null, null]);
    const resumable = listRuntimeDescriptors().filter((d) => d.resumeType).map((d) => d.id);
    expect(resumable).toEqual(expect.arrayContaining(["claude-code", "codex", "pi"]));
    const refusal = validateResumeToken("terminal", "x");
    expect(refusal.ok).toBe(false);
    const error = refusal.ok ? "" : refusal.error;
    expect(error.startsWith('set-resume-token is not supported for runtime "terminal" (only ')).toBe(true);
    for (const id of resumable) expect(error).toContain(id);
    expect(formatRuntimeIdList(["claude-code", "codex", "pi"])).toBe("claude-code, codex, and pi"); // the pre-registry wording
  });

  it("verifier and preflight carry a runtime's install hint", async () => {
    const db = createFullTestDb();
    try {
      registerExample({ installHint: "npm install -g example-cli" });
      const verifier = new RuntimeVerifier({ db, exec: async () => { throw new Error("ENOENT"); } });
      const [result] = await verifier.verifyAll(["example-cli"]);
      expect(result).toMatchObject({ status: "not_found", error: "example-cli not found (install: npm install -g example-cli)" });
    } finally {
      db.close();
    }
  });

  it("processMatch is anchored to the program, never to other arguments", () => {
    expect(processMatches("vim gemini-notes.md", "gemini")).toBe(false);
    expect(processMatches("less /tmp/gemini/log.txt", "gemini")).toBe(false);
    expect(processMatches("/opt/homebrew/bin/gemini --yolo", "gemini")).toBe(true);
    expect(processMatches("node /usr/local/lib/node_modules/@github/copilot/index.js --yolo", "@github/copilot")).toBe(true);
    expect(processMatches("node --max-old-space-size=4096 /x/cursor-agent/dist/index.js", /cursor-agent\/dist\/index\.js$/)).toBe(true);
    expect(processMatches("node server.js --name copilot", "copilot")).toBe(false);
    // Versioned and framework interpreters are script hosts too.
    expect(processMatches("/opt/homebrew/Cellar/python@3.12/3.12.7/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python /Users/x/.local/bin/aider --model sonnet", "aider")).toBe(true);
    expect(processMatches("/home/x/.venv/bin/python3.12 /home/x/.venv/bin/aider", "aider")).toBe(true);
    expect(processMatches("python -m aider --yes-always", "aider")).toBe(true);
    expect(processMatches("node22 /usr/lib/node_modules/@github/copilot/index.js", "@github/copilot")).toBe(true);
    expect(processMatches("pythonista notes.py aider", "aider")).toBe(false);
    expect(processMatches("", "x")).toBe(false);
  });

  it("keeps fork support, guidance files, and pane commands as the adapters had them", () => {
    const row = (id: string) => {
      const d = getRuntimeDescriptor(id)!;
      return [d.kind, d.supportsFork, d.guidanceFile ?? null, d.cleanupGuidanceOnTeardown ?? null, d.paneCommands ?? null, !!d.internal];
    };
    expect(row("claude-code")).toEqual(["agent", true, "CLAUDE.md", null, ["claude"], false]);
    expect(row("codex")).toEqual(["agent", true, "AGENTS.md", null, ["codex"], false]);
    expect(row("pi")).toEqual(["agent", true, "AGENTS.md", false, null, false]);
    expect(row("terminal")).toEqual(["terminal", false, null, null, null, false]);
    expect(row("stub")).toEqual(["agent", false, null, null, null, true]);
  });

  it("keeps the legacy schema to claude-code, codex, and pi", () => {
    const legacy = (runtime: string) => LegacyRigSpecSchema.validate({
      schema_version: 1, name: "t", version: "1.0", nodes: [{ id: "a", runtime, role: "r" }], edges: [],
    }).valid;
    expect(["claude-code", "codex", "pi", "terminal", "stub", "nope"].map(legacy)).toEqual([true, true, true, false, false, false]);
  });
});

describe("runtime registry: registration rules", () => {
  it("rejects a generic host as a pane command", () => {
    expect(() => registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, paneCommands: ["node"] })).toThrow(/generic host; use processMatch/);
  });

  it("rejects duplicate ids, malformed ids, and resumeType without a validator", () => {
    expect(() => registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, id: "codex" })).toThrow(/already registered/);
    expect(() => registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, id: "Bad_Id" })).toThrow(/Invalid runtime id/);
    expect(() => registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, validateResumeToken: undefined })).toThrow(/without validateResumeToken/);
    expect(isRegisteredRuntime("example-cli")).toBe(false);
  });

  it("unregisters cleanly", () => {
    registerExample();
    expect(isRegisteredRuntime("example-cli")).toBe(true);
    unregister!(); unregister = null;
    expect(getRuntimeDescriptor("example-cli")).toBeUndefined();
  });

  it("formats runtime lists", () => {
    expect([[], ["a"], ["a", "b"], ["a", "b", "c"]].map(formatRuntimeIdList)).toEqual(["", "a", "a and b", "a, b, and c"]);
  });

  it("maps posture from the resolved policy first, then OPENRIG_YOLO", () => {
    expect(effectiveLaunchPosture({}, undefined)).toBe("floor");
    expect(effectiveLaunchPosture({ OPENRIG_YOLO: "true" }, undefined)).toBe("full_bypass");
    expect(effectiveLaunchPosture({ OPENRIG_YOLO: "1" }, "floor")).toBe("floor");
    expect(effectiveLaunchPosture({}, "full_bypass")).toBe("full_bypass");
  });
});

describe("runtime registry: a registered runtime reaches every generic site", () => {
  it("resume-token validation and capture use the descriptor", async () => {
    registerExample({
      captureResumeToken: async ({ sessionName }) => sessionName === "bad"
        ? { outcome: "token", token: "has space" }
        : { outcome: "token", token: " sess_42 " },
    });
    expect(resumeTypeForRuntime("example-cli")).toBe("example_session_id");
    expect(validateResumeToken("example-cli", " sess_1 ")).toEqual({ ok: true, resumeType: "example_session_id", token: "sess_1" });
    expect(validateResumeToken("example-cli", "a b")).toMatchObject({ ok: false });
    expect(await deriveResumeToken({ runtime: "example-cli", sessionName: "s" }, {}))
      .toEqual({ outcome: "captured", resumeType: "example_session_id", token: "sess_42" });
    expect(await deriveResumeToken({ runtime: "example-cli", sessionName: "bad" }, {}))
      .toEqual({ outcome: "skipped", reason: "invalid_token" });
  });

  it("a resumable runtime without a capture hook is a silent no-op", async () => {
    registerExample({ captureResumeToken: undefined });
    expect(await deriveResumeToken({ runtime: "example-cli", sessionName: "s" }, {})).toEqual({ outcome: "noop" });
    expect(await deriveResumeToken({ runtime: "terminal", sessionName: "s" }, {})).toEqual({ outcome: "exempt" });
  });

  it("capture never throws, and late capture recovers launchStartedAt from launch.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-capture-"));
    try {
      const seen: Array<Date | undefined> = [];
      registerExample({
        captureResumeToken: ({ sessionName, launchStartedAt }) => {
          seen.push(launchStartedAt);
          if (sessionName === "boom") throw new Error("sqlite locked");
          return null;
        },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await deriveResumeToken({ runtime: "example-cli", sessionName: "boom", stateRoot: root }, {}))
        .toEqual({ outcome: "skipped", reason: "capture_error" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("sqlite locked"));
      warn.mockRestore();
      const seat = runtimeSeatStateDir("example-cli", "dev@r", root);
      fs.mkdirSync(seat, { recursive: true });
      fs.writeFileSync(path.join(seat, LAUNCH_RECORD_FILE), JSON.stringify({ launchStartedAt: "2026-09-29T10:00:00.000Z" }));
      expect(await deriveResumeToken({ runtime: "example-cli", sessionName: "dev@r", stateRoot: root }, {}))
        .toEqual({ outcome: "skipped", reason: "missing_sidecar" });
      expect(seen[1]?.toISOString()).toBe("2026-09-29T10:00:00.000Z");
      expect(runtimeSeatStateDir("example-cli", "dev@r", root)).toBe(path.join(root, "example-cli", "dev@r"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovery identifies a node-hosted CLI by processMatch, never by node alone", async () => {
    registerExample({ paneCommands: undefined, processMatch: "copilot-cli/index.js" });
    const processes = [
      { pid: 10, ppid: 1, command: "-zsh" },
      { pid: 11, ppid: 10, command: "node /usr/local/lib/node_modules/copilot-cli/index.js --yolo" },
      { pid: 20, ppid: 1, command: "node server.js" },
    ];
    const fp = new SessionFingerprinter({
      cmuxAdapter: { queryAgentPIDs: async () => ({ ok: false, code: "unavailable", message: "x" }) } as unknown as CmuxAdapter,
      tmuxAdapter: { capturePaneContent: async () => null } as unknown as TmuxAdapter,
      fsExists: () => false,
      listProcesses: async () => processes,
    });
    const pane = { tmuxSession: "s", tmuxWindow: "0", tmuxPane: "%0", pid: 10, cwd: "/tmp", activeCommand: "node" };
    expect(await fp.fingerprint(pane)).toMatchObject({ runtimeHint: "example-cli", confidence: "high" });
    expect((await fp.fingerprint({ ...pane, pid: 20 })).runtimeHint).toBe("unknown");
  });

  it("preflight probes registered CLI binaries and names the install fix", async () => {
    registerExample();
    const spec = { pods: [{ id: "dev", members: [{ id: "a", runtime: "example-cli" }, { id: "b", runtime: "codex" }] }] } as unknown as RigSpec;
    const exec = vi.fn(async (cmd: string) => { if (cmd === "example-cli --version") throw new Error("nope"); return "1.0"; });
    expect(await verifyCliRuntimesAvailable(spec, exec)).toEqual([
      `Runtime "example-cli" not available ('example-cli --version' failed). The spec declares a member with runtime "example-cli", so the launch would fail. Fix: install Example CLI and ensure 'example-cli' is on PATH.`,
    ]);
    expect(exec).toHaveBeenCalledTimes(1); // built-ins keep their own probes
    exec.mockResolvedValue("1.0");
    expect(await verifyCliRuntimesAvailable(spec, async () => "1.0")).toEqual([]);
    unregister!(); unregister = null;
    registerExample({ installHint: "npm install -g example-cli" });
    expect(await verifyCliRuntimesAvailable(spec, async (cmd) => { if (cmd.startsWith("example-cli")) throw new Error("x"); return ""; }))
      .toEqual([expect.stringContaining("Fix: install Example CLI (npm install -g example-cli) and ensure 'example-cli' is on PATH.")]);
  });

  it("the verifier probes a registered runtime and runs its verify hook", async () => {
    const db = createFullTestDb();
    try {
      registerExample({ versionArgs: ["version"], verify: async ({ version }) => version === "0.9.0" ? "example-cli >= 1.0 required" : null });
      const calls: string[] = [];
      const verifier = new RuntimeVerifier({ db, exec: async (cmd) => { calls.push(cmd); return "example-cli 0.9.0"; } });
      const [result] = await verifier.verifyAll(["example-cli"]);
      expect(calls).toEqual(["example-cli version"]);
      expect(result).toMatchObject({ runtime: "example-cli", status: "error", version: "0.9.0", error: "example-cli >= 1.0 required" });
      const [unknown] = await verifier.verifyAll(["not-registered"]);
      expect(unknown).toMatchObject({ status: "not_found", error: "unknown runtime: not-registered" });
    } finally {
      db.close();
    }
  });

  it("the verifier keeps Pi's Node engine floor", async () => {
    const db = createFullTestDb();
    try {
      const verifier = new RuntimeVerifier({ db, exec: async (cmd) => cmd === "node --version" ? "v22.1.0" : "pi 0.9.1" });
      expect(await verifier.verifyPi()).toMatchObject({ status: "error", error: expect.stringContaining("Node >= 22.19.0") });
    } finally {
      db.close();
    }
  });

  it("legacy specs, discovery, seat identity, and draft rigs accept the registered runtime", async () => {
    registerExample();
    expect(LegacyRigSpecSchema.validate({
      schema_version: 1, name: "t", version: "1.0", nodes: [{ id: "a", runtime: "example-cli", role: "r" }], edges: [],
    }).valid).toBe(true);

    const fp = new SessionFingerprinter({
      cmuxAdapter: { queryAgentPIDs: async () => ({ ok: false, code: "unavailable", message: "x" }) } as unknown as CmuxAdapter,
      tmuxAdapter: { capturePaneContent: async () => null } as unknown as TmuxAdapter,
      fsExists: () => false,
    });
    const pane = { tmuxSession: "s", tmuxWindow: "0", tmuxPane: "%0", pid: 1, cwd: "/tmp", activeCommand: "example-cli" };
    expect(await fp.fingerprint(pane)).toMatchObject({ runtimeHint: "example-cli", confidence: "high" });
    expect((await fp.fingerprint({ ...pane, activeCommand: "claude" })).runtimeHint).toBe("claude-code");

    expect(classifyPaneRuntimeMatch("example-cli", "example-cli")).toBe("match");
    expect(classifyPaneRuntimeMatch("zsh", "example-cli")).toBe("mismatch");
    expect(classifyPaneRuntimeMatch("node", "example-cli")).toBe("match");
    expect(classifyPaneRuntimeMatch("zsh", "pi")).toBe("match"); // unchanged built-in leniency

    const draft = generateDraftRig([{ tmuxSession: "s", runtimeHint: "example-cli", cwd: "/w" } as unknown as DiscoveredSession]);
    expect(draft.yaml).toContain("runtime: example-cli");
  });
});

describe("runtime adapter map", () => {
  const builtins = () => {
    const make = (runtime: string) => ({ runtime } as RuntimeAdapter);
    return { claudeCode: make("claude-code"), codex: make("codex"), pi: make("pi"), stub: make("stub"), terminal: make("terminal") };
  };

  it("builds one map with built-ins and registered CLI adapters", () => {
    const cli = createCliRuntimeAdapters(harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }), [EXAMPLE_CLI_REGISTRATION]);
    const map = buildRuntimeAdapters(builtins(), cli);
    expect(Object.keys(map).sort()).toEqual(["claude-code", "codex", "example-cli", "pi", "stub", "terminal"]);
    expect(map["example-cli"]).toBe(cli[0]);
    expect(createCliRuntimeAdapters(harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }), [])).toEqual([]);
    expect(createCliRuntimeAdapters(harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() })).map((a) => a.runtime))
      .toEqual(CLI_RUNTIME_REGISTRATIONS.map((r) => r.descriptor.id));
  });

  it("rejects collisions and mismatched adapter ids", () => {
    expect(() => buildRuntimeAdapters(builtins(), [{ runtime: "codex" } as RuntimeAdapter])).toThrow(/Duplicate/);
    const wrong = { ...EXAMPLE_CLI_REGISTRATION, createAdapter: () => ({ runtime: "other" }) as never };
    expect(() => createCliRuntimeAdapters(harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }), [wrong])).toThrow(/created an adapter for "other"/);
  });
});

describe("restore dispatch to registered resume adapters", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  function orchestrator(resumeAdapters: RuntimeResumeAdapter[]) {
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const tmuxAdapter = mockTmux().tmux;
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore, tmuxAdapter,
      snapshotCapture: new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore }),
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter }),
      claudeResume: { canResume: (t: string | null) => t === "claude_id", resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: (t: string | null) => t === "codex_id", resume: vi.fn() } as unknown as CodexResumeAdapter,
      resumeAdapters,
    });
  }

  function fakeResume(result: Awaited<ReturnType<RuntimeResumeAdapter["resume"]>>) {
    return {
      runtime: "example-cli",
      canResume: (type: string | null, token: string | null) => type === "example_session_id" && !!token,
      resume: vi.fn(async () => result),
    } satisfies RuntimeResumeAdapter;
  }

  it("routes a registered resume type to its adapter with the full request", async () => {
    const node = rigRepo.addNode(rigRepo.createRig("r1").id, "dev", { runtime: "example-cli" });
    const adapter = fakeResume({ ok: true });
    const outcome = await (orchestrator([adapter]) as any).attemptResume(node.id, "dev@r1", "example_session_id", "sess_1", "/w", null, "m1", "floor");
    expect(outcome).toEqual({ kind: "resumed" });
    expect(adapter.resume).toHaveBeenCalledWith({
      nodeId: node.id, sessionName: "dev@r1", resumeType: "example_session_id", resumeToken: "sess_1", cwd: "/w",
      codexConfigProfile: null, model: "m1", resolvedPosture: "floor", permissionMode: undefined,
    });
  });

  it("maps retry_fresh and attention_required like the built-ins", async () => {
    const node = rigRepo.addNode(rigRepo.createRig("r2").id, "dev", { runtime: "example-cli" });
    const fresh = await (orchestrator([fakeResume({ ok: false, code: "retry_fresh", message: "gone" })]) as any)
      .attemptResume(node.id, "s", "example_session_id", "t", "/w");
    expect(fresh).toEqual({ kind: "retry_fresh" });
    const gate = await (orchestrator([fakeResume({ ok: false, code: "attention_required", message: "login", evidence: "Please log in" })]) as any)
      .attemptResume(node.id, "s", "example_session_id", "t", "/w");
    expect(gate).toEqual({ kind: "attention_required", message: "login", evidence: "Please log in" });
    const none = await (orchestrator([]) as any).attemptResume(node.id, "s", "example_session_id", "t", "/w");
    expect(none).toEqual({ kind: "failed", message: "No resume adapter available for this runtime/token combination." });
  });

  it("refuses a registered adapter that shadows a built-in", () => {
    expect(() => orchestrator([{ ...fakeResume({ ok: true }), runtime: "codex" }])).toThrow(/duplicate resume adapter/);
  });
});
