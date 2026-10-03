// Rig expansion carries a member's fallback_runtimes (the expand route and the
// expansion service's synthetic spec), like readiness_timeout_ms: a valid list
// reaches the node, and an invalid one is rejected by the canonical validator
// instead of being dropped.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const root = "/fixture/expand";
const closers: Array<() => void> = [];
let bin: string;

beforeEach(() => {
  // A PATH holding a pi executable, so the declared runtime launches first.
  bin = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-expand-bin-"));
  fs.writeFileSync(nodePath.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  vi.stubEnv("PATH", bin);
});
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.unstubAllEnvs();
  fs.rmSync(bin, { recursive: true, force: true });
});

function adapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function setup() {
  const db = createFullTestDb();
  closers.push(() => db.close());
  const files: Record<string, string> = {
    [root]: "",
    [`${root}/agent/agent.yaml`]: `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`,
  };
  const app = createTestApp(db, {
    tmux: mockTmuxAdapter(), adapters: { pi: adapter("pi"), codex: adapter("codex") },
    podInstantiatorFsOps: { exists: (path) => path in files, readFile: (path) => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]!; } },
  });
  const rig = app.rigRepo.createRig("expand");
  const expand = (member: Record<string, unknown>) => app.app.request(`/api/rigs/${rig.id}/expand`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rigRoot: root, pod: { id: "dev", label: "Dev", members: [member], edges: [] } }),
  });
  return { ...app, rig, expand };
}

const member = { id: "impl", agent_ref: "local:agent", profile: "default", runtime: "pi", cwd: root };

describe("rig expansion carries fallback_runtimes", () => {
  it("an expanded member keeps its fallback_runtimes on the node", async () => {
    const f = setup();
    const res = await f.expand({ ...member, fallback_runtimes: ["codex"] });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBeLessThan(300);
    const node = f.rigRepo.getRig(f.rig.id)!.nodes.find((n) => n.logicalId === "dev.impl");
    expect(node).toMatchObject({ runtime: "pi", fallbackRuntimes: ["codex"] });
  });

  it("the camelCase fallbackRuntimes key is accepted too", async () => {
    const f = setup();
    await f.expand({ ...member, fallbackRuntimes: ["codex"] });
    expect(f.rigRepo.getRig(f.rig.id)!.nodes.find((n) => n.logicalId === "dev.impl")?.fallbackRuntimes).toEqual(["codex"]);
  });

  it("an invalid fallback_runtimes is rejected by the validator, not dropped", async () => {
    const f = setup();
    const res = await f.expand({ ...member, fallback_runtimes: ["not-a-runtime"] });
    const body = await res.json();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).toContain("fallback_runtimes");
    expect(f.rigRepo.getRig(f.rig.id)!.nodes.find((n) => n.logicalId === "dev.impl")).toBeUndefined();
  });
});
