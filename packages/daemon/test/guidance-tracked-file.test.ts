// guidance.tracked_file: what managed guidance does when a runtime's guidance
// file is tracked by git in the seat cwd (an upstream roadmap item is the Codex
// form of this). managed_block (default) merges as before; skip leaves a
// tracked file alone; redirect writes to an untracked alternate the CLI also
// loads (Claude Code: CLAUDE.local.md), and skips when there is none.
// Teardown cleans exactly what delivery could have written.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_TRACKED_GUIDANCE_REDIRECT, guidanceTargetDeps, guidanceTeardownTargets, isGitTracked, resolveGuidanceTarget,
} from "../src/domain/guidance-target.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { EXAMPLE_CLI_SPEC } from "./helpers/example-cli-runtime.js";
import { harnessDeps, memFs, mockTmux as harnessTmux } from "./helpers/tui-cli-adapter-harness.js";
import { QWEN_DESCRIPTOR } from "../src/adapters/cli/qwen/index.js";
import { CLINE_DESCRIPTOR } from "../src/adapters/cli/cline/index.js";
import { GROK_DESCRIPTOR } from "../src/adapters/cli/grok/index.js";
import { GOOSE_DESCRIPTOR } from "../src/adapters/cli/goose/index.js";
import { KILO_REGISTRATION } from "../src/adapters/cli/kilo/index.js";
import { OPENCODE_REGISTRATION } from "../src/adapters/cli/opencode/index.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";

const tracked = (...paths: string[]) => (p: string) => paths.includes(p);

describe("resolveGuidanceTarget", () => {
  const target = "/w/AGENTS.md";
  const redirect = "/w/AGENTS.local.md";

  it("managed_block (and no policy) always writes the guidance file, without asking git", () => {
    const probe = vi.fn(() => true);
    expect(resolveGuidanceTarget({ targetPath: target, isTracked: probe })).toEqual({ kind: "write", path: target, redirected: false });
    expect(resolveGuidanceTarget({ targetPath: target, policy: "managed_block", isTracked: probe })).toMatchObject({ kind: "write", path: target });
    expect(probe).not.toHaveBeenCalled();
  });

  it("an untracked or absent file is merged under every policy", () => {
    for (const policy of ["skip", "redirect"] as const) {
      expect(resolveGuidanceTarget({ targetPath: target, policy, redirectPath: redirect, isTracked: tracked() }))
        .toEqual({ kind: "write", path: target, redirected: false });
    }
  });

  it("skip leaves a tracked file alone", () => {
    expect(resolveGuidanceTarget({ targetPath: target, policy: "skip", isTracked: tracked(target) }))
      .toEqual({ kind: "skip", reason: "AGENTS.md is tracked by git and guidance.tracked_file is skip" });
  });

  it("redirect writes the untracked alternate, and skips when there is none or it is tracked too", () => {
    expect(resolveGuidanceTarget({ targetPath: target, policy: "redirect", redirectPath: redirect, isTracked: tracked(target) }))
      .toEqual({ kind: "write", path: redirect, redirected: true });
    expect(resolveGuidanceTarget({ targetPath: target, policy: "redirect", redirectPath: null, isTracked: tracked(target) }))
      .toMatchObject({ kind: "skip", reason: expect.stringMatching(/no untracked alternate/) });
    expect(resolveGuidanceTarget({ targetPath: target, policy: "redirect", redirectPath: redirect, isTracked: tracked(target, redirect) }))
      .toMatchObject({ kind: "skip", reason: expect.stringMatching(/both tracked/) });
  });
});

describe("guidanceTeardownTargets (symmetric with delivery)", () => {
  const target = "/w/CLAUDE.md";
  const redirect = "/w/CLAUDE.local.md";
  it("managed_block cleans the guidance file as before", () => {
    expect(guidanceTeardownTargets({ targetPath: target, isTracked: tracked(target) })).toEqual([target]);
  });
  it("a tracked file under skip or redirect is left alone; redirect cleans the alternate", () => {
    expect(guidanceTeardownTargets({ targetPath: target, policy: "skip", isTracked: tracked(target) })).toEqual([]);
    expect(guidanceTeardownTargets({ targetPath: target, policy: "redirect", redirectPath: redirect, isTracked: tracked(target) })).toEqual([redirect]);
  });
  it("an untracked file is cleaned under every policy; a tracked alternate is never touched", () => {
    expect(guidanceTeardownTargets({ targetPath: target, policy: "skip", isTracked: tracked() })).toEqual([target]);
    expect(guidanceTeardownTargets({ targetPath: target, policy: "redirect", redirectPath: redirect, isTracked: tracked() })).toEqual([target, redirect]);
    expect(guidanceTeardownTargets({ targetPath: target, policy: "redirect", redirectPath: redirect, isTracked: tracked(target, redirect) })).toEqual([]);
  });
});

describe("isGitTracked (real git)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-guidance-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("is true only for files the repository tracks", () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    fs.writeFileSync(nodePath.join(root, "AGENTS.md"), "# repo guidance\n");
    fs.writeFileSync(nodePath.join(root, "notes.md"), "scratch\n");
    git("add", "AGENTS.md");
    expect(isGitTracked(nodePath.join(root, "AGENTS.md"))).toBe(true);
    expect(isGitTracked(nodePath.join(root, "notes.md"))).toBe(false);
    expect(isGitTracked(nodePath.join(root, "missing.md"))).toBe(false);
  });

  it("is false outside a repository", () => {
    fs.writeFileSync(nodePath.join(root, "AGENTS.md"), "x\n");
    expect(isGitTracked(nodePath.join(root, "AGENTS.md"))).toBe(false);
  });
});

describe("rig spec: guidance.tracked_file", () => {
  const spec = (guidance: unknown) => ({
    version: "0.2", name: "g", ...(guidance === undefined ? {} : { guidance }),
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
    edges: [],
  });

  it("accepts each policy, normalizes it, and round-trips", () => {
    for (const policy of ["managed_block", "skip", "redirect"]) {
      expect(RigSpecSchema.validate(spec({ tracked_file: policy }))).toMatchObject({ valid: true });
    }
    const normalized = RigSpecSchema.normalize(spec({ tracked_file: "redirect" }));
    expect(normalized.guidance).toEqual({ trackedFile: "redirect" });
    const yaml = RigSpecCodec.serialize(normalized);
    expect(yaml).toContain("tracked_file: redirect");
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>).guidance).toEqual({ trackedFile: "redirect" });
    expect(RigSpecSchema.normalize(spec(undefined)).guidance).toBeUndefined();
  });

  it("rejects an unknown policy, an unknown key, and a non-mapping", () => {
    expect(RigSpecSchema.validate(spec({ tracked_file: "move" })).errors.join("\n")).toMatch(/guidance.tracked_file: must be one of managed_block, skip, redirect/);
    expect(RigSpecSchema.validate(spec({ file: "skip" })).errors.join("\n")).toMatch(/guidance.file: unknown key/);
    expect(RigSpecSchema.validate(spec("skip")).errors.join("\n")).toMatch(/guidance: must be a mapping/);
  });
});

describe("rigs.guidance_tracked_file", () => {
  it("persists the policy and reads it back; absent is null", () => {
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db);
      const rig = repo.createRig("g");
      expect(repo.getRigGuidanceTrackedFile(rig.id)).toBeNull();
      repo.setRigGuidanceTrackedFile(rig.id, "skip");
      expect(repo.getRigGuidanceTrackedFile(rig.id)).toBe("skip");
    } finally {
      db.close();
    }
  });
});

function claudeFs(files: Record<string, string>) {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
    store,
  } as ClaudeAdapterFsOps & { store: Record<string, string> };
}
const tmux = () => ({ sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })) }) as unknown as TmuxAdapter;
const binding = (extra: Partial<NodeBinding> = {}): NodeBinding => ({
  id: "b", nodeId: "n", tmuxSession: "s", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...extra,
});
const guidanceFile: ResolvedStartupFile = {
  path: "guide.md", absolutePath: "/rig/guide.md", ownerRoot: "/rig", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
};
const REPO_CLAUDE = "# The repo's own CLAUDE.md\n";

describe("adapters honor the policy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("claude-code: redirect writes CLAUDE.local.md and leaves the tracked CLAUDE.md byte-identical", async () => {
    vi.spyOn(guidanceTargetDeps, "isTracked").mockImplementation((p) => p === "/project/CLAUDE.md");
    const files = claudeFs({ "/rig/guide.md": "Be terse.", "/project/CLAUDE.md": REPO_CLAUDE });
    const result = await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: files }).deliverStartup([guidanceFile], binding({ guidanceTrackedFile: "redirect" }));
    expect(result).toEqual({ delivered: 1, failed: [] });
    expect(files.store["/project/CLAUDE.md"]).toBe(REPO_CLAUDE);
    expect(files.store[`/project/${CLAUDE_TRACKED_GUIDANCE_REDIRECT}`]).toContain("Be terse.");
  });

  it("claude-code: skip delivers nothing into a tracked CLAUDE.md and does not count it", async () => {
    vi.spyOn(guidanceTargetDeps, "isTracked").mockImplementation((p) => p === "/project/CLAUDE.md");
    const files = claudeFs({ "/rig/guide.md": "Be terse.", "/project/CLAUDE.md": REPO_CLAUDE });
    const result = await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: files }).deliverStartup([guidanceFile], binding({ guidanceTrackedFile: "skip" }));
    expect(result.delivered).toBe(0);
    expect(files.store["/project/CLAUDE.md"]).toBe(REPO_CLAUDE);
    expect(files.store["/project/CLAUDE.local.md"]).toBeUndefined();
  });

  it("claude-code: no policy merges into the tracked file exactly as before", async () => {
    const probe = vi.spyOn(guidanceTargetDeps, "isTracked");
    const files = claudeFs({ "/rig/guide.md": "Be terse.", "/project/CLAUDE.md": REPO_CLAUDE });
    await new ClaudeCodeAdapter({ tmux: tmux(), fsOps: files }).deliverStartup([guidanceFile], binding());
    expect(files.store["/project/CLAUDE.md"]).toContain("Be terse.");
    expect(probe).not.toHaveBeenCalled();
  });

  it("codex: redirect has no qualifying alternate, so a tracked AGENTS.md is skipped, never overwritten", async () => {
    vi.spyOn(guidanceTargetDeps, "isTracked").mockImplementation((p) => p === "/project/AGENTS.md");
    const files = claudeFs({ "/rig/guide.md": "Be terse.", "/project/AGENTS.md": "# repo agents\n" });
    const adapter = new CodexRuntimeAdapter({ tmux: tmux(), fsOps: files } as never);
    const result = await adapter.deliverStartup([guidanceFile], binding({ guidanceTrackedFile: "redirect" }));
    expect(result.delivered).toBe(0);
    expect(files.store["/project/AGENTS.md"]).toBe("# repo agents\n");
  });

  it("TUI CLI base: redirect uses the descriptor's trackedGuidanceRedirect", async () => {
    vi.spyOn(guidanceTargetDeps, "isTracked").mockImplementation((p) => p === "/work/project/EXAMPLE.md");
    const spec = {
      ...EXAMPLE_CLI_SPEC,
      descriptor: { ...EXAMPLE_CLI_SPEC.descriptor, trackedGuidanceRedirect: ({ cwd }: { cwd: string }) => nodePath.join(cwd, "EXAMPLE.local.md") },
    };
    const files = memFs({ "/rig/guide.md": "Be terse.", "/work/project/EXAMPLE.md": "# repo\n" });
    const adapter = new TuiCliRuntimeAdapter(spec, harnessDeps({ tmux: harnessTmux().tmux, fsOps: files }));
    const result = await adapter.deliverStartup([guidanceFile], binding({ cwd: "/work/project", guidanceTrackedFile: "redirect" }));
    expect(result.delivered).toBe(1);
    expect(files.files["/work/project/EXAMPLE.md"]).toBe("# repo\n");
    expect(files.files["/work/project/EXAMPLE.local.md"]).toContain("Be terse.");
  });
});

describe("per-runtime redirect targets (verified in each CLI's source)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("qwen: <gitRoot>/.qwen/QWEN.local.md, and none outside a repository", () => {
    vi.spyOn(guidanceTargetDeps, "toplevel").mockReturnValue("/repo");
    expect(QWEN_DESCRIPTOR.trackedGuidanceRedirect!({ cwd: "/repo/svc" })).toBe("/repo/.qwen/QWEN.local.md");
    vi.spyOn(guidanceTargetDeps, "toplevel").mockReturnValue(null);
    expect(QWEN_DESCRIPTOR.trackedGuidanceRedirect!({ cwd: "/scratch" })).toBeNull();
  });

  it("cline: a rule file under the git top level's .cline/rules (cwd outside a repository)", () => {
    vi.spyOn(guidanceTargetDeps, "toplevel").mockReturnValue("/repo");
    expect(CLINE_DESCRIPTOR.trackedGuidanceRedirect!({ cwd: "/repo/svc" })).toBe("/repo/.cline/rules/openrig.md");
    vi.spyOn(guidanceTargetDeps, "toplevel").mockReturnValue(null);
    expect(CLINE_DESCRIPTOR.trackedGuidanceRedirect!({ cwd: "/scratch" })).toBe("/scratch/.cline/rules/openrig.md");
  });

  it("grok and kilo: a rule file in the cwd's rules dir; opencode has none", () => {
    expect(GROK_DESCRIPTOR.trackedGuidanceRedirect!({ cwd: "/w" })).toBe("/w/.grok/rules/openrig.md");
    expect(KILO_REGISTRATION.descriptor.trackedGuidanceRedirect!({ cwd: "/w" })).toBe("/w/.kilo/rules/openrig.md");
    expect(OPENCODE_REGISTRATION.descriptor.trackedGuidanceRedirect).toBeUndefined();
  });

  it("runtimes without a qualifying alternate declare none", () => {
    for (const id of ["gemini", "copilot", "cursor", "aider", "antigravity", "codex", "claude-code", "pi", "omp"]) {
      expect(getRuntimeDescriptor(id)?.trackedGuidanceRedirect, id).toBeUndefined();
    }
    // goose writes AGENTS.md and has no untracked alternate: redirect behaves as skip.
    expect(GOOSE_DESCRIPTOR.guidanceFile).toBe("AGENTS.md");
    expect(GOOSE_DESCRIPTOR.trackedGuidanceRedirect).toBeUndefined();
  });

  it("pi: redirect writes the seat's own agent-dir AGENTS.md, never the repo", async () => {
    vi.spyOn(guidanceTargetDeps, "isTracked").mockImplementation((p) => p === "/project/AGENTS.md");
    const store: Record<string, string> = { "/rig/guide.md": "Be terse.", "/project/AGENTS.md": "# repo agents\n" };
    const files = {
      readFile: (p: string) => { if (p in store) return store[p]!; throw new Error("ENOENT"); },
      writeFile: (p: string, c: string) => { store[p] = c; },
      exists: (p: string) => p in store,
      mkdirp: () => {},
      listFiles: () => [],
    };
    const pi = new PiRuntimeAdapter({ tmux: tmux(), fsOps: files, stateRoot: "/state/pi", runnerEntryPath: "/r.js", sleep: async () => {} });
    const result = await pi.deliverStartup([guidanceFile], binding({ tmuxSession: "dev-pi@r", guidanceTrackedFile: "redirect" }));
    expect(result.delivered).toBe(1);
    expect(store["/project/AGENTS.md"]).toBe("# repo agents\n");
    expect(store[nodePath.join(piSeatPaths("/state/pi", "dev-pi@r").agentDir, "AGENTS.md")]).toContain("Be terse.");
  });
});
