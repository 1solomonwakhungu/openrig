import fs from "node:fs";
import nodePath from "node:path";

/** Recursive relative file listing (directories are walked, not listed). */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(nodePath.join(current, entry.name), nodePath.join(prefix, entry.name));
      else out.push(prefix ? nodePath.join(prefix, entry.name) : entry.name);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * The node-backed fsOps shared by every runtime adapter. Each adapter's fsOps
 * interface is a subset of this shape; adapters that need a home directory
 * receive it alongside (`{ ...createNodeFsOps(), homedir }`).
 */
export function createNodeFsOps() {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, content: string) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    listFiles: listFilesRecursive,
    readdir: (dir: string) => fs.readdirSync(dir),
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, mode: number) => fs.chmodSync(p, mode),
    rename: (from: string, to: string) => fs.renameSync(from, to),
    realpath: (p: string) => fs.realpathSync(p),
    isSymlink: (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } },
    createFile: (p: string, content: string, mode: number) => fs.writeFileSync(p, content, { encoding: "utf-8", mode, flag: "wx" }),
  };
}

export type NodeFsOps = ReturnType<typeof createNodeFsOps>;
