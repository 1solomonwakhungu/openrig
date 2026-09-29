import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeOwnerConfig } from "../src/adapters/cli/owner-config.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import { memFs } from "./helpers/tui-cli-adapter-harness.js";

describe("mergeOwnerConfig (owner-state-safe config edits)", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

  it("adds to lists and sets absent keys without touching existing ones", () => {
    const files = memFs({ "/h/.copilot/config.json": JSON.stringify({ theme: "dark", trustedFolders: ["/a"], nested: { keep: 1 } }) });
    const result = mergeOwnerConfig(files, "/h/.copilot/config.json", "json", (c) => {
      c.addToList(["trustedFolders"], "/work");
      c.addToList(["trustedFolders"], "/a");
      c.setIfAbsent(["theme"], "light");
      c.setIfAbsent(["nested", "added"], true);
    });
    expect(result).toEqual({
      status: "changed",
      changes: [
        { op: "add_to_list", path: ["trustedFolders"], value: "/work" },
        { op: "set_if_absent", path: ["nested", "added"], value: true },
      ],
    });
    expect(JSON.parse(files.files["/h/.copilot/config.json"]!)).toEqual({
      theme: "dark", trustedFolders: ["/a", "/work"], nested: { keep: 1, added: true },
    });
  });

  it("reports unchanged and writes nothing when every value is present", () => {
    const original = JSON.stringify({ trustedFolders: ["/work"] });
    const files = memFs({ "/c.json": original });
    expect(mergeOwnerConfig(files, "/c.json", "json", (c) => c.addToList(["trustedFolders"], "/work"))).toEqual({ status: "unchanged", changes: [] });
    expect(files.files["/c.json"]).toBe(original);
  });

  it("never overwrites an unparseable or non-object file", () => {
    const files = memFs({ "/bad.json": "{ not json", "/list.yaml": "- a\n- b\n" });
    expect(mergeOwnerConfig(files, "/bad.json", "json", (c) => c.addToList(["x"], 1))).toMatchObject({ status: "skipped", reason: "unparseable" });
    expect(mergeOwnerConfig(files, "/list.yaml", "yaml", (c) => c.addToList(["x"], 1))).toMatchObject({ status: "skipped", reason: "not_an_object" });
    expect(files.files["/bad.json"]).toBe("{ not json");
    expect(files.files["/list.yaml"]).toBe("- a\n- b\n");
  });

  it("refuses a conflicting shape and leaves the file as it was", () => {
    const original = JSON.stringify({ trustedFolders: "/a" });
    const files = memFs({ "/c.json": original });
    expect(mergeOwnerConfig(files, "/c.json", "json", (c) => c.addToList(["trustedFolders"], "/b"))).toMatchObject({ status: "skipped", reason: "conflicting_shape" });
    expect(files.files["/c.json"]).toBe(original);
  });

  it("creates a missing file and edits YAML", () => {
    const files = memFs({ "/h/settings.yaml": "model: x\n" });
    mergeOwnerConfig(files, "/h/new.json", "json", (c) => c.setIfAbsent(["hasTrustDialogAccepted"], true));
    expect(JSON.parse(files.files["/h/new.json"]!)).toEqual({ hasTrustDialogAccepted: true });
    mergeOwnerConfig(files, "/h/settings.yaml", "yaml", (c) => c.addToList(["trusted"], "/w"));
    expect(files.files["/h/settings.yaml"]).toBe("model: x\ntrusted:\n  - /w\n");
  });

  it("keeps YAML comments and layout when adding", () => {
    const original = "# operator settings\nmodel: x # pinned\ntrusted:\n  # my repos\n  - /a\n";
    const files = memFs({ "/s.yaml": original });
    expect(mergeOwnerConfig(files, "/s.yaml", "yaml", (c) => {
      c.addToList(["trusted"], "/w");
      c.setIfAbsent(["ui", "tips"], false);
    }).status).toBe("changed");
    expect(files.files["/s.yaml"]).toBe("# operator settings\nmodel: x # pinned\ntrusted:\n  # my repos\n  - /a\n  - /w\nui:\n  tips: false\n");
  });

  it("refuses a YAML scalar where a mapping is needed", () => {
    const files = memFs({ "/s.yaml": "ui: compact\n" });
    expect(mergeOwnerConfig(files, "/s.yaml", "yaml", (c) => c.setIfAbsent(["ui", "tips"], false))).toMatchObject({ status: "skipped", reason: "conflicting_shape" });
    expect(files.files["/s.yaml"]).toBe("ui: compact\n");
  });

  it("keeps the file mode across the atomic replace (real fs)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-owner-"));
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o600);
    mergeOwnerConfig(createNodeFsOps(), file, "json", (c) => c.setIfAbsent(["a"], 1));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("follows a symlinked dotfile and keeps the link (real fs)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-owner-"));
    const real = path.join(root, "dotfiles", "config.yaml");
    const link = path.join(root, "home", "config.yaml");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(real, "# mine\ntrusted: []\n");
    fs.symlinkSync(real, link);
    mergeOwnerConfig(createNodeFsOps(), link, "yaml", (c) => c.addToList(["trusted"], "/w"));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf-8")).toContain("# mine");
    expect(fs.readFileSync(real, "utf-8")).toBe("# mine\ntrusted: [ /w ]\n"); // flow style kept
  });

  it("writes atomically through a temp file and rename on the real filesystem", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-owner-"));
    const file = path.join(root, "dir", "config.json");
    const result = mergeOwnerConfig(createNodeFsOps(), file, "json", (c) => c.addToList(["trustedFolders"], "/w"));
    expect(result.status).toBe("changed");
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ trustedFolders: ["/w"] });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]); // no temp left behind
  });

  it("refuses to write without an atomic rename", () => {
    const files = memFs();
    delete (files as { rename?: unknown }).rename;
    expect(() => mergeOwnerConfig(files, "/c.json", "json", (c) => c.setIfAbsent(["a"], 1))).toThrow(/needs fsOps.rename/);
  });
});
