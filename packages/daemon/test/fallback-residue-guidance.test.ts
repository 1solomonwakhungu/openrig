// Runtime fallback residue undo uses the same seat guidance resolver as rig
// teardown (seat-guidance-files.ts): Cline's guidance at the git top level and
// guidance.tracked_file redirect alternates. Real git repositories in a temp dir.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptResidueTargets, removeAttemptResidue, snapshotAttemptResidue } from "../src/domain/fallback-attempt-residue.js";
import { seatGuidanceFiles, seatGuidanceWriteTargets } from "../src/domain/seat-guidance-files.js";
import { registeredGuidanceCleanupFile } from "../src/domain/rig-teardown.js";

let root: string;
let repo: string;
let sub: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
const block = (id: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->\n${id} body\n<!-- END OpenRig MANAGED BLOCK: ${id} -->`;

beforeEach(() => {
  // realpath: macOS tmp is a symlink, and git prints the resolved top level.
  root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-residue-guidance-")));
  repo = nodePath.join(root, "repo");
  sub = nodePath.join(repo, "services", "api");
  fs.mkdirSync(sub, { recursive: true });
  git(repo, "init", "-q");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("one seat guidance resolver for teardown and fallback residue", () => {
  it("resolves Cline's guidance at the git top level for a subdirectory seat, like teardown", () => {
    expect(seatGuidanceFiles("cline", sub)).toMatchObject({ targetPath: nodePath.join(repo, "AGENTS.md") });
    expect(registeredGuidanceCleanupFile("cline", sub)).toBe(seatGuidanceFiles("cline", sub).targetPath);
    expect(attemptResidueTargets({ runtime: "cline", cwd: sub }).guidanceFiles).toEqual([nodePath.join(repo, "AGENTS.md")]);
  });

  it("cline in a subdirectory: a failed attempt's block at the repository root is removed, the root file's content kept", () => {
    const rootAgents = nodePath.join(repo, "AGENTS.md");
    fs.writeFileSync(rootAgents, `# Repo agents\n\n${block("other-seat")}\n`);
    const snapshot = snapshotAttemptResidue(attemptResidueTargets({ runtime: "cline", cwd: sub }));
    fs.appendFileSync(rootAgents, `\n${block("role")}\n`);
    expect(removeAttemptResidue(snapshot).blocks).toEqual(["role"]);
    const content = fs.readFileSync(rootAgents, "utf-8");
    expect(content).toContain("# Repo agents");
    expect(content).toContain("MANAGED BLOCK: other-seat");
    expect(content).not.toContain("MANAGED BLOCK: role");
    expect(fs.existsSync(nodePath.join(sub, "AGENTS.md"))).toBe(false);
  });

  it("redirect: a tracked CLAUDE.md is left out and the redirect file the attempt created is removed", () => {
    const claudeMd = nodePath.join(repo, "CLAUDE.md");
    fs.writeFileSync(claudeMd, "# Team guidance\n");
    git(repo, "add", "CLAUDE.md");
    const targets = attemptResidueTargets({ runtime: "claude-code", cwd: repo, trackedFile: "redirect" });
    expect(targets.guidanceFiles).toEqual([nodePath.join(repo, "CLAUDE.local.md")]);
    expect(targets.guidanceFiles).toEqual(seatGuidanceWriteTargets("claude-code", repo, { trackedFile: "redirect" }));
    const snapshot = snapshotAttemptResidue(targets);
    fs.writeFileSync(nodePath.join(repo, "CLAUDE.local.md"), `${block("role")}\n`);
    expect(removeAttemptResidue(snapshot).blocks).toEqual(["role"]);
    expect(fs.existsSync(nodePath.join(repo, "CLAUDE.local.md"))).toBe(false);
    expect(fs.readFileSync(claudeMd, "utf-8")).toBe("# Team guidance\n");
  });

  it("redirect for cline in a subdirectory resolves the rule file under the repository root", () => {
    fs.writeFileSync(nodePath.join(repo, "AGENTS.md"), "# Repo agents\n");
    git(repo, "add", "AGENTS.md");
    const targets = attemptResidueTargets({ runtime: "cline", cwd: sub, trackedFile: "redirect" });
    expect(targets.guidanceFiles).toEqual([nodePath.join(repo, ".cline", "rules", "openrig.md")]);
    expect(attemptResidueTargets({ runtime: "cline", cwd: sub, trackedFile: "skip" }).guidanceFiles).toEqual([]);
  });
});
