import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";

describe("createNodeFsOps", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("reads, writes, lists recursively, and creates directories", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-fsops-"));
    const ops = createNodeFsOps();
    ops.mkdirp(path.join(dir, "a", "b"));
    ops.writeFile(path.join(dir, "a", "b", "c.md"), "deep");
    ops.writeFile(path.join(dir, "top.md"), "top");
    ops.copyFile(path.join(dir, "top.md"), path.join(dir, "a", "copy.md"));
    expect(ops.readFile(path.join(dir, "a", "b", "c.md"))).toBe("deep");
    expect(ops.exists(path.join(dir, "a", "copy.md"))).toBe(true);
    expect(ops.listFiles(dir).sort()).toEqual([path.join("a", "b", "c.md"), path.join("a", "copy.md"), "top.md"]);
    expect(ops.readdir(dir).sort()).toEqual(["a", "top.md"]);
    ops.chmod(path.join(dir, "top.md"), 0o600);
    expect(ops.statMode(path.join(dir, "top.md")) & 0o777).toBe(0o600);
  });
});
