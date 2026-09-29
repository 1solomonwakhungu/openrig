// Owner-state-safe edits to a CLI's own config file (trust lists, onboarding
// flags), for TuiCliRuntimeSpec.prepareLaunch. The config belongs to the
// operator, so every edit is:
//   - merge-only: add a value to a list or set a key that is absent; existing
//     keys and values are never removed or rewritten;
//   - skipped when the file exists but does not parse (never overwritten);
//   - comment-preserving for YAML (the yaml Document API edits in place);
//   - atomic: written to a temp file next to the real target (a symlinked
//     dotfile is followed, not replaced), given the original file mode, then
//     renamed over it;
//   - recorded: the caller gets the list of changes it made.
// Same pattern as the Claude adapter's hasTrustDialogAccepted write.

import nodePath from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import type { CliAdapterFsOps } from "./types.js";

export type OwnerConfigFormat = "json" | "yaml";

export interface OwnerConfigChange {
  op: "add_to_list" | "set_if_absent";
  path: string[];
  value: unknown;
}

export interface OwnerConfigEditor {
  /** Append `value` to the list at `path` unless an equal value is present.
   *  Creates missing parent objects and the list. Refuses when a key on the
   *  path holds a non-object / non-list value. */
  addToList(path: readonly string[], value: string | number | boolean): void;
  /** Set `path` to `value` only when the key is absent. */
  setIfAbsent(path: readonly string[], value: unknown): void;
}

export type OwnerConfigMergeResult =
  | { status: "changed"; changes: OwnerConfigChange[] }
  | { status: "unchanged"; changes: [] }
  | { status: "skipped"; reason: "unparseable" | "not_an_object" | "conflicting_shape" | "dangling_symlink"; detail: string; changes: [] };

type Doc = Record<string, unknown>;

class ConflictingShape extends Error {}

function isObject(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A format-specific in-memory document the editor mutates. */
interface EditableDoc {
  editor(changes: OwnerConfigChange[]): OwnerConfigEditor;
  serialize(): string;
}

function jsonDoc(text: string): EditableDoc | OwnerConfigMergeResult {
  let parsed: unknown = {};
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { status: "skipped", reason: "unparseable", detail: (err as Error).message, changes: [] };
    }
  }
  if (parsed === null) parsed = {};
  if (!isObject(parsed)) return { status: "skipped", reason: "not_an_object", detail: "the file is not a JSON object", changes: [] };
  const doc = parsed;
  const parentOf = (path: readonly string[]): Doc => {
    let node: Doc = doc;
    for (const key of path.slice(0, -1)) {
      const next = node[key];
      if (next === undefined) {
        node[key] = {};
        node = node[key] as Doc;
      } else if (isObject(next)) {
        node = next;
      } else {
        throw new ConflictingShape(`"${path.join(".")}": "${key}" is not an object`);
      }
    }
    return node;
  };
  return {
    editor: (changes) => ({
      addToList(path, value) {
        if (path.length === 0) throw new ConflictingShape("empty path");
        const parent = parentOf(path);
        const key = path[path.length - 1]!;
        const current = parent[key];
        if (current === undefined) parent[key] = [value];
        else if (Array.isArray(current)) {
          if (current.some((item) => item === value)) return;
          current.push(value);
        } else throw new ConflictingShape(`"${path.join(".")}" is not a list`);
        changes.push({ op: "add_to_list", path: [...path], value });
      },
      setIfAbsent(path, value) {
        if (path.length === 0) throw new ConflictingShape("empty path");
        const parent = parentOf(path);
        const key = path[path.length - 1]!;
        if (key in parent) return;
        parent[key] = value;
        changes.push({ op: "set_if_absent", path: [...path], value });
      },
    }),
    serialize: () => `${JSON.stringify(doc, null, 2)}\n`,
  };
}

function yamlDoc(text: string): EditableDoc | OwnerConfigMergeResult {
  const doc: Document = parseDocument(text === "" ? "{}" : text);
  if (doc.errors.length > 0) {
    return { status: "skipped", reason: "unparseable", detail: doc.errors[0]!.message, changes: [] };
  }
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    doc.contents = doc.createNode({}) as Document["contents"];
  }
  if (!isMap(doc.contents)) return { status: "skipped", reason: "not_an_object", detail: "the file is not a YAML mapping", changes: [] };
  const checkParents = (path: readonly string[]) => {
    for (let i = 1; i < path.length; i++) {
      const node = doc.getIn(path.slice(0, i), true);
      if (node !== undefined && !isMap(node)) throw new ConflictingShape(`"${path.join(".")}": "${path[i - 1]}" is not a mapping`);
    }
  };
  return {
    editor: (changes) => ({
      addToList(path, value) {
        if (path.length === 0) throw new ConflictingShape("empty path");
        checkParents(path);
        const current = doc.getIn(path, true);
        if (current === undefined) {
          doc.setIn(path, doc.createNode([value]));
        } else if (isSeq(current)) {
          if ((current.toJSON() as unknown[]).some((item) => item === value)) return;
          current.add(doc.createNode(value));
        } else {
          throw new ConflictingShape(`"${path.join(".")}" is not a list`);
        }
        changes.push({ op: "add_to_list", path: [...path], value });
      },
      setIfAbsent(path, value) {
        if (path.length === 0) throw new ConflictingShape("empty path");
        checkParents(path);
        if (doc.hasIn(path)) return;
        doc.setIn(path, doc.createNode(value));
        changes.push({ op: "set_if_absent", path: [...path], value });
      },
    }),
    serialize: () => doc.toString(),
  };
}

/**
 * Apply merge-only edits to an owner config file. A missing file starts from
 * an empty document. Throws only for fs failures (read/write/rename), which
 * prepareLaunch callers treat as non-fatal.
 */
export function mergeOwnerConfig(
  fs: CliAdapterFsOps,
  filePath: string,
  format: OwnerConfigFormat,
  edit: (editor: OwnerConfigEditor) => void,
): OwnerConfigMergeResult {
  // A symlink whose target is missing is left alone: replacing it with a
  // regular file would silently break the owner's dotfile link.
  if (fs.isSymlink?.(filePath) && !fs.exists(filePath)) {
    console.warn(`[openrig] owner-config: ${filePath} is a symlink to a missing file; not editing it`);
    return { status: "skipped", reason: "dangling_symlink", detail: `${filePath} points to a missing file`, changes: [] };
  }
  const target = fs.exists(filePath) && fs.realpath ? fs.realpath(filePath) : filePath;
  const text = fs.exists(target) ? fs.readFile(target) : "";
  const doc = format === "json" ? jsonDoc(text) : yamlDoc(text);
  if (!("editor" in doc)) return doc;

  const changes: OwnerConfigChange[] = [];
  // A refused edit writes nothing: the in-memory document is discarded.
  try {
    edit(doc.editor(changes));
  } catch (err) {
    if (err instanceof ConflictingShape) {
      return { status: "skipped", reason: "conflicting_shape", detail: err.message, changes: [] };
    }
    throw err;
  }
  if (changes.length === 0) return { status: "unchanged", changes: [] };

  writeAtomic(fs, target, doc.serialize());
  return { status: "changed", changes };
}

function writeAtomic(fs: CliAdapterFsOps, target: string, content: string): void {
  const dir = nodePath.dirname(target);
  fs.mkdirp(dir);
  if (!fs.rename) {
    throw new Error("atomic owner-config write needs fsOps.rename");
  }
  const mode = fs.exists(target) && fs.statMode ? fs.statMode(target) & 0o7777 : null;
  const temp = nodePath.join(dir, `.${nodePath.basename(target)}.openrig-${process.pid}-${Date.now()}.tmp`);
  if (mode !== null && fs.createFile) {
    // Created with the target's mode from the start (exclusive), so a 0600
    // secret config is never briefly readable at a wider mode.
    fs.createFile(temp, content, mode);
  } else {
    fs.writeFile(temp, content);
  }
  // The creation mode is filtered by the umask; set it exactly.
  if (mode !== null && fs.chmod) fs.chmod(temp, mode);
  fs.rename(temp, target);
}
