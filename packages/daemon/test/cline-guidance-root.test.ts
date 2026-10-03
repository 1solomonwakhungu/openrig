// Cline reads AGENTS.md (and its rules) from the workspace root: the git top
// level of the seat cwd, else the cwd (cline cli-v3.0.65,
// apps/cli/src/utils/helpers.ts resolveWorkspaceRoot). OpenRig used to write
// <cwd>/AGENTS.md, which cline never reads when the seat cwd is a repository
// subdirectory. These tests run against real git repositories in a temp dir.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLINE_DESCRIPTOR, CLINE_REGISTRATION } from "../src/adapters/cli/cline/index.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import { gitToplevel } from "../src/domain/guidance-target.js";
import { registeredGuidanceCleanupFile } from "../src/domain/rig-teardown.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import { harnessDeps, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

let root: string;
let repo: string;
let sub: string;
let loose: string;
let source: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

beforeEach(() => {
  // realpath: macOS tmp is a symlink, and git prints the resolved top level.
  root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-cline-root-")));
  repo = nodePath.join(root, "repo");
  sub = nodePath.join(repo, "services", "api");
  loose = nodePath.join(root, "scratch");
  source = nodePath.join(root, "rig", "guide.md");
  for (const dir of [sub, loose, nodePath.dirname(source)]) fs.mkdirSync(dir, { recursive: true });
  git(repo, "init", "-q");
  fs.writeFileSync(source, "Use the shared test fixtures.\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function binding(cwd: string, extra: Partial<NodeBinding> = {}): NodeBinding {
  return { id: "b", nodeId: "n", tmuxSession: "dev-cline@r", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd, ...extra };
}
const guidance = (): ResolvedStartupFile => ({
  path: "guide.md", absolutePath: source, ownerRoot: nodePath.dirname(source), deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
});
async function deliver(cwd: string, extra: Partial<NodeBinding> = {}) {
  const adapter = CLINE_REGISTRATION.createAdapter(harnessDeps({
    tmux: mockTmux().tmux, fsOps: createNodeFsOps(), stateRoot: nodePath.join(root, "state"), homedir: nodePath.join(root, "home"),
  }));
  return adapter.deliverStartup([guidance()], binding(cwd, extra));
}

describe("cline guidance root (the git top level, else the cwd)", () => {
  it("gitToplevel finds the repository root from a subdirectory and is null outside one", () => {
    expect(gitToplevel(sub)).toBe(repo);
    expect(gitToplevel(repo)).toBe(repo);
    expect(gitToplevel(loose)).toBeNull();
  });

  it("seat cwd = repository root: AGENTS.md at the root", async () => {
    expect((await deliver(repo)).delivered).toBe(1);
    expect(fs.readFileSync(nodePath.join(repo, "AGENTS.md"), "utf-8")).toContain("Use the shared test fixtures.");
  });

  it("seat cwd = a subdirectory: AGENTS.md at the repository root, not in the subdirectory", async () => {
    expect((await deliver(sub)).delivered).toBe(1);
    expect(fs.readFileSync(nodePath.join(repo, "AGENTS.md"), "utf-8")).toContain("Use the shared test fixtures.");
    expect(fs.existsSync(nodePath.join(sub, "AGENTS.md"))).toBe(false);
  });

  it("seat cwd outside a repository: AGENTS.md in the cwd", async () => {
    expect((await deliver(loose)).delivered).toBe(1);
    expect(fs.readFileSync(nodePath.join(loose, "AGENTS.md"), "utf-8")).toContain("Use the shared test fixtures.");
  });

  it("teardown cleans the same resolved file", () => {
    expect(registeredGuidanceCleanupFile("cline", sub)).toBe(nodePath.join(repo, "AGENTS.md"));
    expect(registeredGuidanceCleanupFile("cline", loose)).toBe(nodePath.join(loose, "AGENTS.md"));
    // Other runtimes are unchanged: their guidance stays in the seat cwd.
    expect(registeredGuidanceCleanupFile("codex", sub)).toBe(nodePath.join(sub, "AGENTS.md"));
  });

  it("guidance.tracked_file applies to the resolved root file", async () => {
    fs.writeFileSync(nodePath.join(repo, "AGENTS.md"), "# Repo agents\n");
    git(repo, "add", "AGENTS.md");
    // skip: the tracked root AGENTS.md is untouched even though the seat sits in a subdirectory.
    expect((await deliver(sub, { guidanceTrackedFile: "skip" })).delivered).toBe(0);
    expect(fs.readFileSync(nodePath.join(repo, "AGENTS.md"), "utf-8")).toBe("# Repo agents\n");
    // redirect: the rule file goes under the root's .cline/rules.
    expect((await deliver(sub, { guidanceTrackedFile: "redirect" })).delivered).toBe(1);
    expect(fs.readFileSync(nodePath.join(repo, "AGENTS.md"), "utf-8")).toBe("# Repo agents\n");
    expect(fs.readFileSync(nodePath.join(repo, ".cline", "rules", "openrig.md"), "utf-8")).toContain("Use the shared test fixtures.");
    expect(CLINE_DESCRIPTOR.guidanceRoot!({ cwd: sub })).toBe(repo);
  });
});
