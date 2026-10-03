// Runtime fallback: undo what a failed attempt wrote into the seat's cwd.
//
// A launch projects skills and merges managed guidance blocks before the
// runtime starts, so a runtime that then stops at a sign-in gate leaves them
// behind, and teardown later follows the runtime the seat fell back to. Before
// an attempt that may fall back, OpenRig snapshots the runtime's guidance files
// (seat-guidance-files.ts, the resolver teardown uses: the guidance file under
// its guidanceRoot and the tracked-file redirect) and its skills directory. After a failed attempt it removes only what is new: blocks and skill
// entries that were not there before. Anything that already existed (another
// seat's blocks, an operator's skill) is left alone. Seat launches within one
// instantiate run one at a time, so what is new belongs to the attempt.
// Only paths inside the seat's workspace (the git top level of the cwd, else
// the cwd) are touched.

import fs from "node:fs";
import nodePath from "node:path";
import { guidanceTargetDeps, type TrackedGuidancePolicy } from "./guidance-target.js";
import { getRuntimeDescriptor } from "./runtime-registry.js";
import { seatGuidanceWriteTargets } from "./seat-guidance-files.js";

const BLOCK_ID_RE = /<!-- BEGIN OpenRig MANAGED BLOCK: ([^>]+?) -->/g;

export interface AttemptResidueTargets {
  guidanceFiles: string[];
  skillsDir: string | null;
  /** The seat's workspace (git top level, else the cwd): nothing outside it is touched. */
  workspace: string;
}

export interface AttemptResidueSnapshot {
  targets: AttemptResidueTargets;
  /** Managed block ids per guidance file before the attempt (null: no file). */
  blockIds: Map<string, Set<string> | null>;
  /** Entries of the skills directory before the attempt (null: no directory). */
  skillEntries: Set<string> | null;
  /** Directories between the workspace and the targets that did not exist before
   *  the attempt, deepest first; removed afterwards only if they are empty. */
  absentDirs: string[];
}

export interface AttemptResidueRemoval {
  blocks: string[];
  skills: string[];
}

function inside(root: string, target: string): boolean {
  const relative = nodePath.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

/** Where `runtime` writes guidance and skills for a seat in `cwd`, limited to
 *  the seat's workspace. Guidance comes from the shared seat guidance resolver. */
export function attemptResidueTargets(input: {
  runtime: string;
  cwd: string;
  sessionName?: string;
  claudeManagedBlockFile?: string | null;
  trackedFile?: TrackedGuidancePolicy | null;
}): AttemptResidueTargets {
  const { runtime, cwd } = input;
  const workspace = guidanceTargetDeps.toplevel(cwd) ?? cwd;
  let skillsDir: string | null = null;
  if (runtime === "claude-code") skillsDir = nodePath.join(cwd, ".claude", "skills");
  else if (runtime === "codex") skillsDir = nodePath.join(cwd, ".agents", "skills");
  else if (runtime !== "pi") {
    // Pi's skills live in its per-seat state directory, outside the workspace.
    try {
      skillsDir = getRuntimeDescriptor(runtime)?.skillsDir?.({ cwd, sessionName: input.sessionName }) ?? null;
    } catch {
      skillsDir = null;
    }
  }
  let guidanceFiles: string[] = [];
  try {
    guidanceFiles = seatGuidanceWriteTargets(runtime, cwd, { claudeManagedBlockFile: input.claudeManagedBlockFile, trackedFile: input.trackedFile });
  } catch {
    guidanceFiles = [];
  }
  return {
    guidanceFiles: guidanceFiles.filter((file) => inside(workspace, file)),
    skillsDir: skillsDir && inside(workspace, skillsDir) ? skillsDir : null,
    workspace,
  };
}

function readBlockIds(file: string): Set<string> | null {
  if (!fs.existsSync(file)) return null;
  return new Set(Array.from(fs.readFileSync(file, "utf-8").matchAll(BLOCK_ID_RE), (match) => match[1]!));
}

function readEntries(dir: string): Set<string> | null {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return null;
  }
}

/** Directories from `dir` up to (not including) `workspace` that do not exist yet. */
function missingDirs(dir: string, workspace: string): string[] {
  const missing: string[] = [];
  for (let current = dir; inside(workspace, current); current = nodePath.dirname(current)) {
    if (fs.existsSync(current)) break;
    missing.push(current);
  }
  return missing;
}

export function snapshotAttemptResidue(targets: AttemptResidueTargets): AttemptResidueSnapshot {
  const dirs = new Set<string>();
  if (targets.skillsDir) for (const dir of missingDirs(targets.skillsDir, targets.workspace)) dirs.add(dir);
  for (const file of targets.guidanceFiles) for (const dir of missingDirs(nodePath.dirname(file), targets.workspace)) dirs.add(dir);
  return {
    targets,
    blockIds: new Map(targets.guidanceFiles.map((file) => [file, readBlockIds(file)])),
    skillEntries: targets.skillsDir ? readEntries(targets.skillsDir) : null,
    // Deepest first, so a parent is considered only after its children.
    absentDirs: [...dirs].sort((a, b) => b.length - a.length),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the managed blocks and skill entries the attempt added. Best-effort per item. */
export function removeAttemptResidue(snapshot: AttemptResidueSnapshot): AttemptResidueRemoval {
  const removal: AttemptResidueRemoval = { blocks: [], skills: [] };
  const { guidanceFiles, skillsDir } = snapshot.targets;
  for (const guidanceFile of guidanceFiles) {
    const before = snapshot.blockIds.get(guidanceFile) ?? null;
    try {
      const now = readBlockIds(guidanceFile);
      const added = now ? [...now].filter((id) => !before?.has(id)) : [];
      if (added.length > 0) {
        let content = fs.readFileSync(guidanceFile, "utf-8");
        for (const id of added) {
          const begin = escapeRegex(`<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->`);
          const end = escapeRegex(`<!-- END OpenRig MANAGED BLOCK: ${id} -->`);
          content = content.replace(new RegExp(`(?:\\n|^)\\s*${begin}[\\s\\S]*?${end}\\s*(?=\\n|$)`, "g"), "\n");
        }
        const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
        if (cleaned === "" && before === null) fs.unlinkSync(guidanceFile);
        else fs.writeFileSync(guidanceFile, cleaned === "" ? "" : `${cleaned}\n`, "utf-8");
        removal.blocks.push(...added);
      }
    } catch { /* best-effort: teardown remains the backstop */ }
  }
  if (skillsDir) {
    const now = readEntries(skillsDir);
    for (const entry of now ?? []) {
      if (snapshot.skillEntries?.has(entry)) continue;
      try {
        fs.rmSync(nodePath.join(skillsDir, entry), { recursive: true, force: true });
        removal.skills.push(entry);
      } catch { /* best-effort */ }
    }
  }
  // Directories the attempt created (for example `.kiro/` around `.kiro/skills`)
  // go once they are empty; a pre-existing or non-empty directory is never removed.
  for (const dir of snapshot.absentDirs) {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* absent or not removable */ }
  }
  return removal;
}
