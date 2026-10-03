// The runtime inventory behind `rig runtimes`, `rig doctor`, and `rig setup`.

import { describe, expect, it, vi } from "vitest";
import {
  buildRuntimeInventory,
  nodeAuthFs,
  runtimeDoctorStatus,
  type RuntimeInventoryEntry,
  type RuntimeInventoryExec,
} from "../src/domain/runtime-inventory.js";
import type { RuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { listRuntimeDescriptors } from "../src/domain/runtime-registry.js";

const auth = { homedir: "/home/op", env: {}, fs: { exists: () => false, readFile: () => null } };

const d = (over: Partial<RuntimeDescriptor> & { id: string }): RuntimeDescriptor => ({
  displayName: over.id.toUpperCase(),
  kind: "agent",
  supportsFork: false,
  ...over,
});

describe("buildRuntimeInventory", () => {
  it("probes `<binary> <versionArgs>` and parses the version from a clean exit", async () => {
    const exec = vi.fn<RuntimeInventoryExec>(async () => ({ code: 0, stdout: "mycli version 1.18.33\n" }));
    const [row] = await buildRuntimeInventory({ exec, auth, descriptors: [d({ id: "mycli", binary: "mycli", versionArgs: ["-v"] })] });
    expect(exec).toHaveBeenCalledWith(["mycli", "-v"], expect.any(Number));
    expect(row).toMatchObject({ installed: true, version: "1.18.33" });
  });

  it("not on PATH (exec null or throws) is not installed; a non-zero exit is installed without a version", async () => {
    const run = (exec: RuntimeInventoryExec) => buildRuntimeInventory({ exec, auth, descriptors: [d({ id: "x", binary: "x" })] });
    expect((await run(async () => null))[0]).toMatchObject({ installed: false, version: null });
    expect((await run(async () => { throw new Error("spawn failed"); }))[0]).toMatchObject({ installed: false, version: null });
    expect((await run(async () => ({ code: 2, stdout: "usage 9.9.9" })))[0]).toMatchObject({ installed: true, version: null });
  });

  it("a runtime without a binary has installed and auth as not applicable", async () => {
    const exec = vi.fn<RuntimeInventoryExec>();
    const [row] = await buildRuntimeInventory({ exec, auth, descriptors: [d({ id: "terminal", kind: "terminal" })] });
    expect(row).toMatchObject({ installed: null, version: null, auth: null });
    expect(exec).not.toHaveBeenCalled();
  });

  it("internal runtimes are hidden; the real registry lists every public runtime", async () => {
    const rows = await buildRuntimeInventory({ exec: async () => null, auth });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("stub");
    for (const desc of listRuntimeDescriptors().filter((x) => !x.internal)) expect(ids).toContain(desc.id);
  });

  it("reports what each runtime supports, straight from its descriptor", async () => {
    const [row] = await buildRuntimeInventory({
      exec: async () => null,
      auth,
      descriptors: [d({ id: "r", binary: "r", resumeType: "r_id", validateResumeToken: (t) => ({ ok: true, token: t }), supportsFork: true, guidanceFile: "AGENTS.md", docsPath: "docs/x.md", installHint: "npm i -g r" })],
    });
    expect(row).toMatchObject({ resume: true, fork: true, guidanceFile: "AGENTS.md", docsPath: "docs/x.md", installHint: "npm i -g r" });
  });

  it("passes the probe exec to authStatus only under probe", async () => {
    const seen: boolean[] = [];
    const desc = d({ id: "p", binary: "p", authStatus: (ctx) => { seen.push(!!ctx.probe); return { state: "unknown" }; } });
    await buildRuntimeInventory({ exec: async () => null, auth, descriptors: [desc] });
    await buildRuntimeInventory({ exec: async () => null, auth, probe: true, descriptors: [desc] });
    expect(seen).toEqual([false, true]);
  });

  it("a throwing authStatus becomes unknown, never a failed inventory", async () => {
    const [row] = await buildRuntimeInventory({
      exec: async () => ({ code: 0, stdout: "1.0.0" }),
      auth,
      descriptors: [d({ id: "t", binary: "t", authStatus: () => { throw new Error("boom"); } })],
    });
    expect(row!.auth?.state).toBe("unknown");
  });
});

describe("nodeAuthFs", () => {
  it("caps reads, and missing or unreadable files are null", () => {
    const files: Record<string, string> = { "/a": "small", "/big": "x".repeat(100) };
    const fs = nodeAuthFs((p) => { if (!(p in files)) throw new Error("ENOENT"); return Buffer.from(files[p]!); }, (p) => p in files);
    expect(fs.readFile("/a")).toBe("small");
    expect(fs.readFile("/big", 10)).toBeNull();
    expect(fs.readFile("/none")).toBeNull();
    expect(fs.exists("/a")).toBe(true);
  });
});

describe("runtimeDoctorStatus", () => {
  const row = (over: Partial<RuntimeInventoryEntry>): RuntimeInventoryEntry => ({
    id: "r", displayName: "R", kind: "agent", binary: "r", installed: true, version: "1.2.3",
    auth: { state: "signed_in", source: "env K" }, resume: true, fork: false, guidanceFile: null, docsPath: null, installHint: "npm i -g r", ...over,
  });

  it("signed in passes; missing sign-in warns; unknown passes and says so; not installed is skipped", () => {
    expect(runtimeDoctorStatus(row({}))).toMatchObject({ status: "pass", message: expect.stringContaining("signed in (env K)") });
    expect(runtimeDoctorStatus(row({ auth: { state: "missing", hint: "run r login" } }))).toMatchObject({ status: "warn", message: expect.stringContaining("run r login") });
    expect(runtimeDoctorStatus(row({ auth: { state: "unknown", detail: "keyring" } }))).toMatchObject({ status: "pass", message: expect.stringContaining("not checked") });
    expect(runtimeDoctorStatus(row({ installed: false }))).toMatchObject({ status: "skipped", message: expect.stringContaining("npm i -g r") });
    expect(runtimeDoctorStatus(row({ installed: null, auth: null }))).toMatchObject({ status: "skipped" });
  });
});
