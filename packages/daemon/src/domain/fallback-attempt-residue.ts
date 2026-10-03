// Runtime fallback: undo what a failed attempt wrote into the seat's cwd.
//
// A launch projects skills and merges managed guidance blocks before the
// runtime starts, so a runtime that then stops at a sign-in gate leaves them
// behind, and teardown later follows the runtime the seat fell back to. Before
// an attempt that may fall back, OpenRig snapshots the runtime's guidance file
// (which managed blocks it holds) and its skills directory (which entries it
// holds). After a failed attempt it removes only what is new: blocks and skill
// entries that were not there before. Anything that already existed (another
// seat's blocks, an operator's skill) is left alone. Seat launches within one
// instantiate run one at a time, so what is new belongs to the attempt.
// Only paths inside the seat cwd are touched.

import fs from "node:fs";
import nodePath from "node:path";
import { DEFAULT_CLAUDE_MANAGED_BLOCK_FILE } from "./managed-blocks.js";
import { getRuntimeDescriptor } from "./runtime-registry.js";

const BLOCK_ID_RE = /<!-- BEGIN OpenRig MANAGED BLOCK: ([^>]+?) -->/g;

export interface AttemptResidueTargets {
  guidanceFile: string | null;
  skillsDir: string | null;
}

export interface AttemptResidueSnapshot {
  targets: AttemptResidueTargets;
  /** Managed block ids in the guidance file before the attempt (null: no file). */
  blockIds: Set<string> | null;
  /** Entries of the skills directory before the attempt (null: no directory). */
  skillEntries: Set<string> | null;
}

export interface AttemptResidueRemoval {
  blocks: string[];
  skills: string[];
}

function inside(cwd: string, target: string): boolean {
  const relative = nodePath.relative(cwd, target);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

/** Where `runtime` writes guidance and skills for a seat in `cwd` (inside cwd only). */
export function attemptResidueTargets(input: {
  runtime: string;
  cwd: string;
  sessionName?: string;
  claudeManagedBlockFile?: string | null;
}): AttemptResidueTargets {
  const { runtime, cwd } = input;
  let guidanceFile: string | null = null;
  let skillsDir: string | null = null;
  if (runtime === "claude-code") {
    guidanceFile = nodePath.join(cwd, input.claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE);
    skillsDir = nodePath.join(cwd, ".claude", "skills");
  } else if (runtime === "codex") {
    guidanceFile = nodePath.join(cwd, "AGENTS.md");
    skillsDir = nodePath.join(cwd, ".agents", "skills");
  } else if (runtime === "pi") {
    // Pi's skills live in its per-seat state directory, outside the cwd.
    guidanceFile = nodePath.join(cwd, "AGENTS.md");
  } else {
    const descriptor = getRuntimeDescriptor(runtime);
    if (descriptor?.guidanceFile) guidanceFile = nodePath.join(cwd, descriptor.guidanceFile);
    try {
      skillsDir = descriptor?.skillsDir?.({ cwd, sessionName: input.sessionName }) ?? null;
    } catch {
      skillsDir = null;
    }
  }
  return {
    guidanceFile: guidanceFile && inside(cwd, guidanceFile) ? guidanceFile : null,
    skillsDir: skillsDir && inside(cwd, skillsDir) ? skillsDir : null,
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

export function snapshotAttemptResidue(targets: AttemptResidueTargets): AttemptResidueSnapshot {
  return {
    targets,
    blockIds: targets.guidanceFile ? readBlockIds(targets.guidanceFile) : null,
    skillEntries: targets.skillsDir ? readEntries(targets.skillsDir) : null,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the managed blocks and skill entries the attempt added. Best-effort per item. */
export function removeAttemptResidue(snapshot: AttemptResidueSnapshot): AttemptResidueRemoval {
  const removal: AttemptResidueRemoval = { blocks: [], skills: [] };
  const { guidanceFile, skillsDir } = snapshot.targets;
  if (guidanceFile) {
    try {
      const now = readBlockIds(guidanceFile);
      const added = now ? [...now].filter((id) => !snapshot.blockIds?.has(id)) : [];
      if (added.length > 0) {
        let content = fs.readFileSync(guidanceFile, "utf-8");
        for (const id of added) {
          const begin = escapeRegex(`<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->`);
          const end = escapeRegex(`<!-- END OpenRig MANAGED BLOCK: ${id} -->`);
          content = content.replace(new RegExp(`(?:\\n|^)\\s*${begin}[\\s\\S]*?${end}\\s*(?=\\n|$)`, "g"), "\n");
        }
        const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
        if (cleaned === "" && snapshot.blockIds === null) fs.unlinkSync(guidanceFile);
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
    // A skills directory the attempt created and that is now empty goes too.
    if (snapshot.skillEntries === null) {
      try { if (fs.readdirSync(skillsDir).length === 0) fs.rmdirSync(skillsDir); } catch { /* best-effort */ }
    }
  }
  return removal;
}
