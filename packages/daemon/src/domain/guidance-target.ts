// Where a seat's managed guidance blocks land when the runtime's guidance file
// (CLAUDE.md, AGENTS.md, GEMINI.md, ...) is tracked by git in the seat cwd.
//
// A rig chooses with `guidance: { tracked_file: <policy> }`:
// - managed_block (default): merge into the file as before, tracked or not;
// - skip: leave a tracked file alone (the seat gets no merged guidance there);
// - redirect: write to an untracked alternate file the CLI also loads on its
//   own (for example CLAUDE.local.md), and skip when the runtime has none or
//   the alternate is tracked too.
// An untracked or absent file is always merged, whatever the policy. The
// default policy never runs git, so rigs that do not opt in are unchanged.

import { execFileSync } from "node:child_process";
import nodePath from "node:path";

export const TRACKED_GUIDANCE_POLICIES = ["managed_block", "skip", "redirect"] as const;
export type TrackedGuidancePolicy = (typeof TRACKED_GUIDANCE_POLICIES)[number];

export function isTrackedGuidancePolicy(value: unknown): value is TrackedGuidancePolicy {
  return typeof value === "string" && (TRACKED_GUIDANCE_POLICIES as readonly string[]).includes(value);
}

/** Whether `filePath` is tracked by the git repository that contains it. A
 *  directory outside any repository, a missing git, or a timeout all count
 *  as untracked, which keeps today's merge behavior. */
export function isGitTracked(filePath: string): boolean {
  try {
    execFileSync("git", ["-C", nodePath.dirname(filePath), "ls-files", "--error-unmatch", "--", nodePath.basename(filePath)], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The repository root that contains `cwd`, or null outside a repository. */
export function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Indirection so tests can substitute the git probe. */
export const guidanceTargetDeps: { isTracked: (filePath: string) => boolean; toplevel: (cwd: string) => string | null } = {
  isTracked: isGitTracked,
  toplevel: gitToplevel,
};

/** What an adapter passes to its guidance merge: the rig policy and the runtime's alternate. */
export interface GuidanceDestination {
  policy?: TrackedGuidancePolicy;
  redirectPath?: string | null;
}

export type GuidanceTarget =
  | { kind: "write"; path: string; redirected: boolean }
  | { kind: "skip"; reason: string };

export function resolveGuidanceTarget(input: {
  /** The runtime's guidance file for this seat. */
  targetPath: string;
  policy?: TrackedGuidancePolicy | null;
  /** The runtime's untracked alternate (absolute), or null when it has none. */
  redirectPath?: string | null;
  isTracked?: (filePath: string) => boolean;
}): GuidanceTarget {
  const policy = input.policy ?? "managed_block";
  if (policy === "managed_block") return { kind: "write", path: input.targetPath, redirected: false };
  const isTracked = input.isTracked ?? guidanceTargetDeps.isTracked;
  if (!isTracked(input.targetPath)) return { kind: "write", path: input.targetPath, redirected: false };
  const file = nodePath.basename(input.targetPath);
  if (policy === "skip") {
    return { kind: "skip", reason: `${file} is tracked by git and guidance.tracked_file is skip` };
  }
  if (!input.redirectPath) {
    return { kind: "skip", reason: `${file} is tracked by git and this runtime has no untracked alternate file to redirect to` };
  }
  if (isTracked(input.redirectPath)) {
    return { kind: "skip", reason: `${file} and its alternate ${nodePath.basename(input.redirectPath)} are both tracked by git` };
  }
  return { kind: "write", path: input.redirectPath, redirected: true };
}

/** Log line for a skipped merge, in the adapters' existing skip format. */
export function logGuidanceSkip(target: Extract<GuidanceTarget, { kind: "skip" }>, blockId: string): void {
  console.log(`[openrig] skip: ${target.reason} (block=${blockId})`);
}

/** Claude Code also loads CLAUDE.local.md from the working directory (#25), the
 *  conventional untracked file, so it is the redirect target for a tracked CLAUDE.md. */
export const CLAUDE_TRACKED_GUIDANCE_REDIRECT = "CLAUDE.local.md";

/**
 * Files rig teardown strips OpenRig's managed blocks from, symmetric with
 * resolveGuidanceTarget: a tracked guidance file under skip or redirect was
 * never written, so it is left alone; under redirect the alternate is cleaned.
 */
export function guidanceTeardownTargets(input: {
  targetPath: string;
  policy?: TrackedGuidancePolicy | null;
  redirectPath?: string | null;
  isTracked?: (filePath: string) => boolean;
}): string[] {
  const policy = input.policy ?? "managed_block";
  if (policy === "managed_block") return [input.targetPath];
  const isTracked = input.isTracked ?? guidanceTargetDeps.isTracked;
  const targets = isTracked(input.targetPath) ? [] : [input.targetPath];
  if (policy === "redirect" && input.redirectPath && input.redirectPath !== input.targetPath && !isTracked(input.redirectPath)) {
    targets.push(input.redirectPath);
  }
  return targets;
}
