// Runtime fallback (member `fallback_runtimes`): a fresh launch whose runtime
// CLI is missing or stops at a sign-in gate relaunches on the next runtime,
// records the runtime the seat actually runs on, and surfaces it.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { verifyFallbackMemberRuntimes } from "../src/domain/rigspec-preflight.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { attemptResidueTargets, removeAttemptResidue, snapshotAttemptResidue } from "../src/domain/fallback-attempt-residue.js";
import { describeFallbackAttempts, isCommandOnPath, isFallbackAttentionCode } from "../src/domain/runtime-fallback.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { HarnessLaunchResult, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

const RIG_ROOT = "/project/rigs/my-rig";
let bin: string;

beforeEach(() => {
  bin = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-fallback-bin-"));
  vi.stubEnv("PATH", bin);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(bin, { recursive: true, force: true });
});

function installBinary(name: string): void {
  const file = nodePath.join(bin, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
}

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

const LOGIN_GATE: HarnessLaunchResult = {
  ok: false, recovery: "attention_required", error: "not signed in", evidence: "Please sign in", attentionCode: "login_required",
};

function mockAdapter(runtime: string, launch: HarnessLaunchResult = { ok: true }): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => launch),
  };
}

const fsOps: AgentResolverFsOps = {
  readFile: (p: string) => {
    if (p === `${RIG_ROOT}/agents/impl/agent.yaml`) {
      return `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    }
    throw new Error(`Not found: ${p}`);
  },
  exists: (p: string) => p === `${RIG_ROOT}/agents/impl/agent.yaml`,
};

function spec(fallbackRuntimes?: string[]): RigSpec {
  return {
    version: "0.2", name: "fallback-rig",
    pods: [{ id: "dev", label: "Dev", members: [{
      id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".",
      ...(fallbackRuntimes ? { fallbackRuntimes } : {}),
    }], edges: [] }],
    edges: [],
  };
}

function setup(claude: RuntimeAdapter, codex: RuntimeAdapter) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const podRepo = new PodRepository(db);
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
    startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }),
    fsOps, adapters: { "claude-code": claude, codex, terminal: mockAdapter("terminal") }, tmuxAdapter: tmux,
  } as never);
  return { db, rigRepo, podRepo, sessionRegistry, eventBus, inst, tmux };
}

type InstantiateResult = Awaited<ReturnType<PodRigInstantiator["instantiate"]>>;

/** The attention entry for the one seat when instantiate stops on attention. */
function attentionNode(result: InstantiateResult) {
  expect(result.ok).toBe(false);
  const failure = result as { code?: string; attentionNodes?: Array<{ logicalId: string; reason: string; rigId?: string }>; rigId?: string };
  expect(failure.code).toBe("attention_required");
  expect(failure.attentionNodes).toHaveLength(1);
  return { ...failure.attentionNodes![0]!, rigId: failure.rigId! };
}

function fallbackEvents(db: ReturnType<typeof createFullTestDb>) {
  return db.prepare("SELECT payload FROM events WHERE type = 'node.runtime_fallback'").all() as Array<{ payload: string }>;
}

describe("runtime fallback at a fresh launch", () => {
  it("primary ok: the seat runs on its declared runtime and no fallback is tried", async () => {
    installBinary("claude");
    const claude = mockAdapter("claude-code");
    const codex = mockAdapter("codex");
    const { db, rigRepo, inst } = setup(claude, codex);
    const result = await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("launched");
    const node = rigRepo.getRig(result.result.rigId)!.nodes[0]!;
    expect(node.runtime).toBe("claude-code");
    expect(node.declaredRuntime).toBeNull();
    expect(node.fallbackRuntimes).toEqual(["codex"]);
    expect(codex.launchHarness).not.toHaveBeenCalled();
    expect(fallbackEvents(db)).toHaveLength(0);
    db.close();
  });

  it("primary missing: a binary absent from PATH is skipped and the fallback launches", async () => {
    const claude = mockAdapter("claude-code");
    const codex = mockAdapter("codex");
    const { db, rigRepo, inst } = setup(claude, codex);
    const result = await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("launched");
    expect(claude.launchHarness).not.toHaveBeenCalled();
    expect(codex.launchHarness).toHaveBeenCalledTimes(1);
    const node = rigRepo.getRig(result.result.rigId)!.nodes[0]!;
    expect(node.runtime).toBe("codex");
    expect(node.declaredRuntime).toBe("claude-code");
    const events = fallbackEvents(db).map((e) => JSON.parse(e.payload));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ declaredRuntime: "claude-code", runtime: "codex" });
    expect(events[0].attempts).toContain("claude-code: skipped (claude is not on the launch PATH)");
    db.close();
  });

  it("primary at a login gate: the attempt is released and the fallback launches fresh", async () => {
    installBinary("claude");
    const claude = mockAdapter("claude-code", LOGIN_GATE);
    const codex = mockAdapter("codex");
    const { db, rigRepo, inst, tmux } = setup(claude, codex);
    const result = await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("launched");
    expect(claude.launchHarness).toHaveBeenCalledTimes(1);
    expect(codex.launchHarness).toHaveBeenCalledTimes(1);
    // The failed attempt's tmux session was stopped before the fallback launched.
    expect(tmux.killSession).toHaveBeenCalled();
    // Fresh session: no resume token crosses runtimes.
    const codexCall = (codex.launchHarness as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { resumeToken?: string } | undefined;
    expect(codexCall?.resumeToken).toBeUndefined();
    const node = rigRepo.getRig(result.result.rigId)!.nodes[0]!;
    expect(node.runtime).toBe("codex");
    expect(node.declaredRuntime).toBe("claude-code");
    const attempts = JSON.parse(fallbackEvents(db)[0]!.payload).attempts as string;
    expect(attempts).toContain("claude-code: attention_required");
    expect(attempts).toContain("codex: launched");
    db.close();
  });

  it("readiness at a login gate (launch succeeded) also falls back", async () => {
    installBinary("claude");
    const claude = mockAdapter("claude-code");
    claude.checkReady = vi.fn(async () => ({ ready: false, code: "login_required", reason: "provider not configured" }));
    const codex = mockAdapter("codex");
    const { db, rigRepo, inst } = setup(claude, codex);
    const result = await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(codex.launchHarness).toHaveBeenCalledTimes(1);
    expect(rigRepo.getRig(result.result.rigId)!.nodes[0]!.runtime).toBe("codex");
    db.close();
  });

  it("claude to codex: the failed claude attempt's managed blocks and skills are removed, existing content kept", async () => {
    installBinary("claude");
    const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-fallback-cwd-"));
    try {
      const claudeMd = nodePath.join(cwd, "CLAUDE.md");
      const otherBlock = "<!-- BEGIN OpenRig MANAGED BLOCK: other-seat -->\nother seat\n<!-- END OpenRig MANAGED BLOCK: other-seat -->";
      fs.writeFileSync(claudeMd, `# Project notes\n\n${otherBlock}\n`);
      fs.mkdirSync(nodePath.join(cwd, ".claude", "skills", "operator-skill"), { recursive: true });
      const claude = mockAdapter("claude-code", LOGIN_GATE);
      // Like the real adapter: project skills and merge guidance before the launch stops at the gate.
      claude.project = vi.fn(async (_plan: unknown, b: { cwd: string }) => {
        fs.mkdirSync(nodePath.join(b.cwd, ".claude", "skills", "openrig-start"), { recursive: true });
        fs.writeFileSync(nodePath.join(b.cwd, ".claude", "skills", "openrig-start", "SKILL.md"), "skill");
        fs.appendFileSync(nodePath.join(b.cwd, "CLAUDE.md"), "\n<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nmanaged role\n<!-- END OpenRig MANAGED BLOCK: role -->\n");
        return { projected: [], skipped: [], failed: [] };
      }) as never;
      const codex = mockAdapter("codex");
      const { db, rigRepo, inst } = setup(claude, codex);
      const result = await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT, { cwdOverride: cwd });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(claude.project).toHaveBeenCalled();
      expect(rigRepo.getRig(result.result.rigId)!.nodes[0]!.runtime).toBe("codex");
      const content = fs.readFileSync(claudeMd, "utf-8");
      expect(content).not.toContain("MANAGED BLOCK: role");
      expect(content).toContain("# Project notes");
      expect(content).toContain("MANAGED BLOCK: other-seat");
      expect(fs.existsSync(nodePath.join(cwd, ".claude", "skills", "openrig-start"))).toBe(false);
      expect(fs.existsSync(nodePath.join(cwd, ".claude", "skills", "operator-skill"))).toBe(true);
      const attempts = JSON.parse(fallbackEvents(db)[0]!.payload).attempts as string;
      expect(attempts).toContain("removed its managed blocks [role] and skills [openrig-start]");
      db.close();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("all fail: attention with the evidence of every attempt, on the runtime of the session left at its gate", async () => {
    installBinary("claude");
    const claude = mockAdapter("claude-code", LOGIN_GATE);
    const codex = mockAdapter("codex", LOGIN_GATE);
    const { db, rigRepo, inst } = setup(claude, codex);
    const entry = attentionNode(await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT));
    expect(entry.reason).toContain("no runtime started for dev.impl");
    expect(entry.reason).toContain("claude-code: attention_required");
    expect(entry.reason).toContain("codex: attention_required");
    // The codex session is still at its sign-in gate; the seat says so.
    const node = rigRepo.getRig(entry.rigId)!.nodes[0]!;
    expect(node.runtime).toBe("codex");
    expect(node.declaredRuntime).toBe("claude-code");
    expect(fallbackEvents(db)).toHaveLength(0);
    db.close();
  });

  it("a non-fallback attention (a trust gate) does not move to the next runtime", async () => {
    installBinary("claude");
    const claude = mockAdapter("claude-code", { ok: false, recovery: "attention_required", error: "trust", attentionCode: "trust_gate" });
    const codex = mockAdapter("codex");
    const { db, inst } = setup(claude, codex);
    attentionNode(await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT));
    expect(codex.launchHarness).not.toHaveBeenCalled();
    db.close();
  });

  it("a fallback that stops at a trust gate keeps that runtime on record (its session is live)", async () => {
    installBinary("claude");
    const claude = mockAdapter("claude-code", LOGIN_GATE);
    const codex = mockAdapter("codex", { ok: false, recovery: "attention_required", error: "trust", attentionCode: "trust_gate" });
    const { db, rigRepo, inst } = setup(claude, codex);
    const entry = attentionNode(await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT));
    expect(entry.reason).toContain("codex: attention_required");
    expect(rigRepo.getRig(entry.rigId)!.nodes[0]).toMatchObject({ runtime: "codex", declaredRuntime: "claude-code" });
    db.close();
  });

  it("without fallback_runtimes a login gate stays attention on the declared runtime", async () => {
    const claude = mockAdapter("claude-code", LOGIN_GATE);
    const codex = mockAdapter("codex");
    const { db, inst } = setup(claude, codex);
    const entry = attentionNode(await inst.instantiate(RigSpecCodec.serialize(spec()), RIG_ROOT));
    expect(entry.reason).not.toContain("no runtime started");
    expect(claude.launchHarness).toHaveBeenCalledTimes(1);
    expect(codex.launchHarness).not.toHaveBeenCalled();
    db.close();
  });

  it("the exporter keeps the declared runtime and the fallback list", async () => {
    const { db, rigRepo, podRepo, sessionRegistry, inst } = setup(mockAdapter("claude-code"), mockAdapter("codex"));
    const result = await inst.instantiate(RigSpecCodec.serialize(spec(["codex"])), RIG_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rigRepo.getRig(result.result.rigId)!.nodes[0]!.runtime).toBe("codex");
    const exported = new RigSpecExporter({ rigRepo, podRepo, sessionRegistry } as never).exportRig(result.result.rigId) as RigSpec;
    const member = exported.pods[0]!.members[0]!;
    expect(member.runtime).toBe("claude-code");
    expect(member.fallbackRuntimes).toEqual(["codex"]);
    expect(RigSpecCodec.serialize(exported)).toContain("fallback_runtimes");
    db.close();
  });
});

describe("fallback_runtimes schema", () => {
  const raw = (member: Record<string, unknown>) => ({
    version: "0.2", name: "r", pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...member }], edges: [] }], edges: [],
  });

  it("accepts distinct registered agent runtimes and normalizes them", () => {
    expect(RigSpecSchema.validate(raw({ fallback_runtimes: ["codex", "pi"] })).valid).toBe(true);
    const normalized = RigSpecSchema.normalize(raw({ fallback_runtimes: ["codex"] }) as never);
    expect(normalized.pods[0]!.members[0]!.fallbackRuntimes).toEqual(["codex"]);
  });

  it.each([
    [["claude-code"], "same as the primary"],
    [["codex", "codex"], "duplicate"],
    [["nope"], "unknown runtime"],
    [["terminal"], "not an agent runtime"],
    [["codex", "pi", "gemini", "qwen"], "more than three"],
    ["codex", "not a list"],
  ])("rejects %j (%s)", (value) => {
    expect(RigSpecSchema.validate(raw({ fallback_runtimes: value })).valid).toBe(false);
  });
});

describe("fallback preflight", () => {
  const fallbackSpec = (runtime: string, fallbacks: string[]) => ({
    version: "0.2", name: "r", pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "a", profile: "default", runtime, cwd: ".", fallbackRuntimes: fallbacks }], edges: [] }], edges: [],
  }) as never;
  const execWith = (installed: string[]) => vi.fn(async (cmd: string) => {
    if (!installed.some((b) => cmd.includes(b))) throw new Error("not found");
    return "1.0.0";
  });

  it("warns when the primary is missing but a fallback is available", async () => {
    const result = await verifyFallbackMemberRuntimes(fallbackSpec("gemini", ["qwen"]), execWith(["qwen"]) as never);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toContain('runtime "gemini" is not available; the seat will fall back to "qwen"');
  });

  it("errors when every candidate is missing", async () => {
    const result = await verifyFallbackMemberRuntimes(fallbackSpec("gemini", ["qwen"]), execWith([]) as never);
    expect(result.errors.join("\n")).toContain('No runtime available for dev.impl: none of "gemini", "qwen"');
  });

  it("is silent when the primary is available", async () => {
    const result = await verifyFallbackMemberRuntimes(fallbackSpec("gemini", ["qwen"]), execWith(["gemini", "qwen"]) as never);
    expect(result).toEqual({ errors: [], warnings: [] });
  });
});

describe("runtime-fallback helpers", () => {
  it("only login_required and runtime_missing are fallback triggers", () => {
    expect(isFallbackAttentionCode("login_required")).toBe(true);
    expect(isFallbackAttentionCode("runtime_missing")).toBe(true);
    expect(isFallbackAttentionCode("trust_gate")).toBe(false);
    expect(isFallbackAttentionCode(undefined)).toBe(false);
  });

  it("isCommandOnPath finds executables and resolves relative PATH entries against the cwd", () => {
    installBinary("tool");
    expect(isCommandOnPath("tool", bin, "/")).toBe(true);
    expect(isCommandOnPath("absent", bin, "/")).toBe(false);
    expect(isCommandOnPath("tool", nodePath.basename(bin), nodePath.dirname(bin))).toBe(true);
    fs.writeFileSync(nodePath.join(bin, "plain"), "x");
    expect(isCommandOnPath("plain", bin, "/")).toBe(false);
  });

  it("describeFallbackAttempts lists attempts in order", () => {
    expect(describeFallbackAttempts([{ runtime: "a", outcome: "skipped", reason: "x" }, { runtime: "b", outcome: "launched" }]))
      .toBe("a: skipped (x); b: launched");
  });
});

describe("the running runtime on record", () => {
  it("setNodeRunningRuntime records the fallback and clears it on the declared runtime", () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", fallbackRuntimes: ["codex"] });
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@r" });
    const whoami = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore: new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: false }) });

    rigRepo.setNodeRunningRuntime(node.id, "codex");
    expect(rigRepo.getRig(rig.id)!.nodes[0]).toMatchObject({ runtime: "codex", declaredRuntime: "claude-code", fallbackRuntimes: ["codex"] });
    expect(whoami.resolve({ nodeId: node.id }).identity).toMatchObject({ runtime: "codex", declaredRuntime: "claude-code" });
    expect(getNodeInventory(db, rig.id)[0]).toMatchObject({ runtime: "codex", declaredRuntime: "claude-code" });

    rigRepo.setNodeRunningRuntime(node.id, "claude-code");
    expect(rigRepo.getRig(rig.id)!.nodes[0]).toMatchObject({ runtime: "claude-code", declaredRuntime: null });
    expect(whoami.resolve({ nodeId: node.id }).identity).not.toHaveProperty("declaredRuntime");
    expect(getNodeInventory(db, rig.id)[0]!.declaredRuntime).toBeNull();
    db.close();
  });
});

describe("fallback attempt residue", () => {
  let cwd: string;
  beforeEach(() => { cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-residue-")); });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const block = (id: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->\n${id} body\n<!-- END OpenRig MANAGED BLOCK: ${id} -->`;

  it("targets the runtime's guidance file and skills dir inside the cwd", () => {
    expect(attemptResidueTargets({ runtime: "claude-code", cwd })).toEqual({ guidanceFiles: [nodePath.join(cwd, "CLAUDE.md")], skillsDir: nodePath.join(cwd, ".claude", "skills") });
    expect(attemptResidueTargets({ runtime: "claude-code", cwd, claudeManagedBlockFile: "CLAUDE.local.md" }).guidanceFiles).toEqual([nodePath.join(cwd, "CLAUDE.local.md")]);
    expect(attemptResidueTargets({ runtime: "codex", cwd })).toEqual({ guidanceFiles: [nodePath.join(cwd, "AGENTS.md")], skillsDir: nodePath.join(cwd, ".agents", "skills") });
    expect(attemptResidueTargets({ runtime: "pi", cwd })).toEqual({ guidanceFiles: [nodePath.join(cwd, "AGENTS.md")], skillsDir: null });
  });

  it("deletes a guidance file and skills dir the attempt created", () => {
    const snapshot = snapshotAttemptResidue(attemptResidueTargets({ runtime: "codex", cwd }));
    fs.writeFileSync(nodePath.join(cwd, "AGENTS.md"), `${block("role")}\n`);
    fs.mkdirSync(nodePath.join(cwd, ".agents", "skills", "s1"), { recursive: true });
    expect(removeAttemptResidue(snapshot)).toEqual({ blocks: ["role"], skills: ["s1"] });
    expect(fs.existsSync(nodePath.join(cwd, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(nodePath.join(cwd, ".agents", "skills"))).toBe(false);
  });

  it("keeps a pre-existing file even when only new blocks are removed, and touches nothing when nothing is new", () => {
    const file = nodePath.join(cwd, "AGENTS.md");
    fs.writeFileSync(file, `${block("kept")}\n`);
    const snapshot = snapshotAttemptResidue(attemptResidueTargets({ runtime: "codex", cwd }));
    expect(removeAttemptResidue(snapshot)).toEqual({ blocks: [], skills: [] });
    expect(fs.readFileSync(file, "utf-8")).toBe(`${block("kept")}\n`);
    fs.appendFileSync(file, `\n${block("new")}\n`);
    expect(removeAttemptResidue(snapshot).blocks).toEqual(["new"]);
    expect(fs.readFileSync(file, "utf-8")).toBe(`${block("kept")}\n`);
  });
});
