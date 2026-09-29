// The TUI CLI base adapter, proven through the test-only "example-cli" fixture:
// the shared contract suite plus base-specific behavior (exact typed command,
// both env modes executed by a real POSIX shell, minted session ids,
// provisioning, spec validation). Hermetic: no CLI binary, tmux server, or
// network.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { isAttentionRequiredReadinessCode } from "../src/domain/runtime-adapter.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE } from "../src/domain/runtime-capture.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { EXAMPLE_CLI_REGISTRATION, EXAMPLE_CLI_SPEC, exampleSessionPath, seedExampleSession } from "./helpers/example-cli-runtime.js";
import {
  HARNESS_HOME, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
  type PaneFrame,
} from "./helpers/tui-cli-adapter-harness.js";

const READY = "Example CLI v1.2.3\nexample-cli ready> ";
const RUNNING: PaneFrame = { command: "example-cli", content: READY };

runTuiCliAdapterContract({
  registration: EXAMPLE_CLI_REGISTRATION,
  readyScreen: READY,
  gateScreens: [
    { screen: "Do you trust the files in this folder?\n> Yes  No", code: "trust_gate" },
    { screen: "Please log in to continue", code: "login_required" },
  ],
  errorScreens: ["FATAL: config file is corrupt"],
  earlyExit: { screen: "No saved session found with ID abc", recovery: "retry_fresh" },
  validResumeToken: "sess_0197a2f0",
  invalidResumeToken: "bad token; rm -rf /",
  missingResumeToken: "gone_0197a2f0",
  forkSourceValue: "sess_parent",
  seedSession: ({ seatStateDir }) => {
    seedExampleSession(seatStateDir, "sess_lazy_01");
    return "sess_lazy_01";
  },
  seedResumeTarget: ({ seatStateDir, token }) => seedExampleSession(seatStateDir, token),
});

const SEAT_DIR = nodePath.join(HARNESS_STATE_ROOT, "example-cli", HARNESS_SESSION);

function setup(frames: PaneFrame[] = [atShell(), RUNNING], spec: TuiCliRuntimeSpec = EXAMPLE_CLI_SPEC) {
  const pane = mockTmux(frames);
  const files = memFs();
  const adapter = new TuiCliRuntimeAdapter(spec, harnessDeps({ tmux: pane.tmux, fsOps: files }));
  return { pane, fs: files, adapter };
}

function runEnv(command: string, env: Record<string, string>): Record<string, string> {
  const out = execFileSync("/bin/sh", ["-c", command], { env, encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

const SOURCE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/home/with space",
  OPENRIG_NODE_ID: "node-42",
  EXAMPLE_API_KEY: "k-123",
  OPENAI_API_KEY: "provider-key",
  OPENRIG_TOKEN_SECRET: "secret",
};

describe("TuiCliRuntimeAdapter (example-cli fixture)", () => {
  const tmpRoots: string[] = [];
  afterEach(() => { for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it("is test-only: not registered in production", () => {
    expect(getRuntimeDescriptor("example-cli")).toBeUndefined();
    expect(CLI_RUNTIME_REGISTRATIONS.map((r) => r.descriptor.id)).not.toContain("example-cli");
  });

  it("types the exact shell-quoted command behind the deny-by-default env", async () => {
    const { pane, adapter } = setup();
    await adapter.launchHarness(harnessBinding({ model: "fast-1", launchPosture: "full_bypass" }), { name: "x" });
    const typed = pane.typed[0]!;
    expect(typed.startsWith("exec env -i ${PATH+\"PATH=$PATH\"} ${HOME+\"HOME=$HOME\"}")).toBe(true);
    expect(typed).toContain("${OPENRIG_NODE_ID+\"OPENRIG_NODE_ID=$OPENRIG_NODE_ID\"}");
    expect(typed).toContain("${EXAMPLE_API_KEY+\"EXAMPLE_API_KEY=$EXAMPLE_API_KEY\"}");
    expect(typed).toContain(`'EXAMPLE_HOME=${SEAT_DIR}'`);
    expect(typed.endsWith("'example-cli' '--model' 'fast-1' '--yolo'")).toBe(true);
  });

  it("deny-by-default passes only allowlisted, set variables through a real POSIX shell", () => {
    const command = new TuiCliRuntimeAdapter(
      { ...EXAMPLE_CLI_SPEC, buildLaunchCommand: () => ["/usr/bin/env"] },
      harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }),
    ).buildShellCommand({ binding: harnessBinding(), posture: "floor", seatStateDir: "/seat dir/it's" });
    const vars = runEnv(command, SOURCE_ENV);
    expect(vars.HOME).toBe("/home/with space");
    expect(vars.OPENRIG_NODE_ID).toBe("node-42");
    expect(vars.EXAMPLE_API_KEY).toBe("k-123");
    expect(vars.EXAMPLE_HOME).toBe("/seat dir/it's");
    expect(vars.OPENAI_API_KEY).toBeUndefined();
    expect(vars.OPENRIG_TOKEN_SECRET).toBeUndefined();
    expect("LC_ALL" in vars).toBe(false); // unset in the source env: absent, not empty
  });

  it("the default env mode inherits the pane env and adds the spec's values", () => {
    const inherit: TuiCliRuntimeSpec = {
      ...EXAMPLE_CLI_SPEC,
      buildLaunchCommand: () => ["/usr/bin/env"],
      env: { set: ({ seatStateDir }) => ({ OPENCODE_DB: `${seatStateDir}/opencode.db` }) },
    };
    const command = new TuiCliRuntimeAdapter(inherit, harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }))
      .buildShellCommand({ binding: harnessBinding(), posture: "floor", seatStateDir: "/seat" });
    expect(command).toBe("exec env 'OPENCODE_DB=/seat/opencode.db' '/usr/bin/env'");
    const vars = runEnv(command, SOURCE_ENV);
    expect(vars.OPENAI_API_KEY).toBe("provider-key");
    expect(vars.OPENCODE_DB).toBe("/seat/opencode.db");
    const bare = new TuiCliRuntimeAdapter({ ...inherit, env: undefined }, harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }));
    expect(bare.buildShellCommand({ binding: harnessBinding(), posture: "floor", seatStateDir: "/seat" })).toBe("exec '/usr/bin/env'");
  });

  it("mints a session id for fresh launches, passes it to argv, and reports it once ready", async () => {
    const mint = vi.fn(({ forkSource }) => forkSource ? undefined : "sess_minted_1");
    const { pane, adapter, fs: files } = setup([atShell(), RUNNING], { ...EXAMPLE_CLI_SPEC, mintSessionToken: mint });
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result).toEqual({ ok: true, resumeToken: "sess_minted_1", resumeType: "example_session_id" });
    expect(pane.typed[0]).toContain("'--session-id' 'sess_minted_1'");
    expect(JSON.parse(files.files[nodePath.join(SEAT_DIR, LAUNCH_RECORD_FILE)]!)).toMatchObject({
      runtimeId: "example-cli", sessionName: HARNESS_SESSION, cwd: "/work/project", mode: "fresh", presetToken: "sess_minted_1", launchId: expect.any(String),
    });
    const resumed = setup([atShell(), RUNNING], { ...EXAMPLE_CLI_SPEC, mintSessionToken: mint });
    await resumed.adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: "sess_old" });
    expect(mint).toHaveBeenCalledTimes(1); // never on resume
  });

  it("refuses a malformed minted id", async () => {
    const { adapter, pane } = setup([atShell(), RUNNING], { ...EXAMPLE_CLI_SPEC, mintSessionToken: () => "bad id" });
    expect(await adapter.launchHarness(harnessBinding(), { name: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/minted session id is malformed/) });
    expect(pane.typed).toEqual([]);
  });

  it("captures the new session after readiness when it already exists on disk", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-example-"));
    tmpRoots.push(root);
    const stateRoot = nodePath.join(root, "state");
    const pane = mockTmux([atShell(), RUNNING]);
    const adapter = new TuiCliRuntimeAdapter(EXAMPLE_CLI_SPEC, harnessDeps({
      tmux: pane.tmux, fsOps: createNodeFsOps(), stateRoot, homedir: nodePath.join(root, "home"), now: () => new Date(Date.now() - 2_000),
    }));
    seedExampleSession(nodePath.join(stateRoot, "example-cli", HARNESS_SESSION), "sess_eager_1");
    expect(await adapter.launchHarness(harnessBinding(), { name: "x" }))
      .toEqual({ ok: true, resumeToken: "sess_eager_1", resumeType: "example_session_id" });
  });

  it("provisions owner config before typing and records the change", async () => {
    const { adapter, fs: files } = setup();
    await adapter.launchHarness(harnessBinding(), { name: "x" });
    const config = nodePath.join(HARNESS_HOME, ".example", "config.json");
    expect(JSON.parse(files.files[config]!)).toEqual({ trustedFolders: ["/work/project"] });
    expect(JSON.parse(files.files[nodePath.join(SEAT_DIR, LAUNCH_RECORD_FILE)]!).ownerConfigChanges)
      .toEqual([{ op: "add_to_list", path: ["trustedFolders"], value: "/work/project" }]);
  });

  it("keeps launching when prepareLaunch throws", async () => {
    const { adapter, pane } = setup([atShell(), RUNNING], { ...EXAMPLE_CLI_SPEC, prepareLaunch: () => { throw new Error("disk full"); } });
    expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
    expect(pane.typed).toHaveLength(1);
  });

  it("an error printed while the TUI stays open stops the wait with its recovery", async () => {
    const { adapter, fs: files } = setup([atShell(), { command: "example-cli", content: "example-cli\nNo saved session found with ID x" }]);
    files.files[nodePath.join(exampleSessionPath(SEAT_DIR, "sess_1"), "meta.json")] = "{}";
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: "sess_1" });
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect(await adapter.checkReady(harnessBinding())).toMatchObject({ ready: false, code: "session_missing" });
  });

  it("refuses when a fork captures the parent session", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-example-"));
    tmpRoots.push(root);
    const stateRoot = nodePath.join(root, "state");
    const adapter = new TuiCliRuntimeAdapter(EXAMPLE_CLI_SPEC, harnessDeps({
      tmux: mockTmux([atShell(), RUNNING]).tmux, fsOps: createNodeFsOps(), stateRoot, homedir: nodePath.join(root, "home"), now: () => new Date(Date.now() - 2_000),
    }));
    seedExampleSession(nodePath.join(stateRoot, "example-cli", HARNESS_SESSION), "sess_parent");
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: "sess_parent" } });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/parent session/) });
  });

  it("surfaces a spec refusal (unsupported fork ref) without typing", async () => {
    const { adapter, pane } = setup();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "last" } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ref.kind="last"') });
    expect(pane.typed).toEqual([]);
  });

  it("keeps only the last evidence lines of the pane", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const { adapter } = setup([atShell(), { command: "example-cli", content: `${lines}\nPlease log in` }]);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result.ok === false && result.evidence?.split("\n")).toHaveLength(12);
  });

  it("evidence skips the blank rows padding a full-screen capture", async () => {
    const padded = `Please log in\nvisit https://example.test/device${"\n".repeat(40)}`;
    const { adapter } = setup([atShell(), { command: "example-cli", content: padded, alternate: true }]);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result.ok === false && result.evidence).toBe("Please log in\nvisit https://example.test/device");
  });

  it("startup_dialog is an attention-required readiness code", () => {
    expect(isAttentionRequiredReadinessCode("startup_dialog")).toBe(true);
    expect(isAttentionRequiredReadinessCode("awaiting_runtime")).toBe(false);
  });

  it("maps a resume failure without recovery to resume_failed", async () => {
    const { adapter, pane, fs: files } = setup();
    files.files[nodePath.join(exampleSessionPath(SEAT_DIR, "sess_1"), "meta.json")] = "{}";
    pane.failNextSend("pane gone");
    const result = await adapter.resume({ nodeId: "n", sessionName: HARNESS_SESSION, resumeType: "example_session_id", resumeToken: "sess_1", cwd: "/w" });
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
  });

  it("validates the spec at construction", () => {
    const deps = harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() });
    expect(() => new TuiCliRuntimeAdapter({ ...EXAMPLE_CLI_SPEC, gatePatterns: [{ pattern: /x/, code: "made_up", reason: "r" }] }, deps))
      .toThrow(/not an attention-required readiness code/);
    expect(() => new TuiCliRuntimeAdapter({ ...EXAMPLE_CLI_SPEC, env: { denyByDefault: true, allow: ["BAD-NAME"] } }, deps)).toThrow(/invalid env allowlist name/);
    expect(() => new TuiCliRuntimeAdapter({ ...EXAMPLE_CLI_SPEC, env: { allow: ["X"] } }, deps)).toThrow(/only applies with env.denyByDefault/);
    expect(() => new TuiCliRuntimeAdapter({ ...EXAMPLE_CLI_SPEC, readyPatterns: [] }, deps)).toThrow(/ready pattern/);
  });
});
