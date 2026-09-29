// Qwen Code runtime adapter: the shared TUI CLI contract suite plus
// qwen-specific behavior (exact argv, posture, minted session id, resume
// precheck, fork and fork-child capture, trust-file provisioning). Hermetic:
// mock tmux, in-memory fs, and pane fixtures captured live from qwen 0.24.7.

import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { QWEN_DESCRIPTOR, QWEN_REGISTRATION } from "../src/adapters/cli/qwen/index.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { SESSION_ID_RE } from "../src/adapters/cli/gemini-family/launch-args.js";
import { createGeminiFamilyCapture, readLaunchRecord } from "../src/adapters/cli/gemini-family/runtime.js";
import { captureQwenForkChild, qwenRuntimeStatusExists } from "../src/adapters/cli/gemini-family/session-store.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import {
  HARNESS_CWD, HARNESS_HOME, HARNESS_NOW, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";
import { seedQwenConversation, seedQwenRuntimeStatus } from "./helpers/gemini-family-seed.js";

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "gemini-family");
const fixture = (name: string) => fs.readFileSync(nodePath.join(FIXTURES, name), "utf8");

const VALID = "0b7c2f1e-5d4a-4c3b-9a8f-1e2d3c4b5a69";
const MISSING = "9d8c7b6a-5f4e-4d3c-8b2a-190817263544";
const PARENT = "7f3e2d1c-0b9a-4876-a543-210fedcba987";
const READY = fixture("qwen-ready-floor.txt");
const realSeedFs = { writeFile: (p: string, c: string) => fs.writeFileSync(p, c), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }) };

runTuiCliAdapterContract({
  registration: QWEN_REGISTRATION,
  readyScreen: READY,
  runningCommand: "node",
  gateScreens: [
    { screen: fixture("qwen-trust.txt"), code: "trust_gate" },
    { screen: fixture("qwen-auth.txt"), code: "login_required" },
    { screen: "Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan or another provider.", code: "login_required" },
  ],
  errorScreens: ["Failed to fork session 7f3e2d1c-0b9a-4876-a543-210fedcba987: ENOENT"],
  earlyExit: { screen: fixture("qwen-resume-missing.txt"), recovery: "retry_fresh" },
  validResumeToken: VALID,
  invalidResumeToken: "my session title",
  missingResumeToken: MISSING,
  forkSourceValue: PARENT,
  seedResumeTarget: ({ fs: seedFs, homedir, cwd, token }) => { seedQwenConversation(seedFs, { homedir, cwd, token }); },
  // Late capture reports the minted id once qwen recorded the launch.
  seedSession: ({ seatStateDir, cwd, homedir }) => {
    const token = readLaunchRecord(seatStateDir)?.presetToken;
    if (!token) throw new Error("expected a minted session id in launch.json");
    seedQwenRuntimeStatus(realSeedFs, { homedir, cwd, token, startedAt: new Date() });
    return token;
  },
});

function launchRig(frames = [{ command: "node", content: READY }], env: NodeJS.ProcessEnv = {}, files = memFs()) {
  const pane = mockTmux([atShell(), ...frames]);
  const adapter = QWEN_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files, env }));
  return { adapter, pane, files };
}

describe("qwen runtime adapter", () => {
  it("is registered in the CLI index and the registry", () => {
    expect(CLI_RUNTIME_REGISTRATIONS).toContain(QWEN_REGISTRATION);
    expect(getRuntimeDescriptor("qwen")).toBe(QWEN_DESCRIPTOR);
  });

  it("descriptor: guidance, skills, identity, fork, no reap", () => {
    expect(QWEN_DESCRIPTOR).toMatchObject({ binary: "qwen", resumeType: "qwen_session_id", supportsFork: true, guidanceFile: "QWEN.md" });
    expect(QWEN_DESCRIPTOR.reapProcessTreeOnStop).toBeFalsy();
    expect(QWEN_DESCRIPTOR.paneCommands).toBeUndefined();
    expect(QWEN_DESCRIPTOR.skillsDir?.({ cwd: "/w" })).toBe("/w/.qwen/skills");
    const match = QWEN_DESCRIPTOR.processMatch as RegExp;
    expect(match.test("node /opt/homebrew/bin/qwen --approval-mode auto-edit")).toBe(true);
    expect(match.test("node /x/@qwen-code/qwen-code/cli.js")).toBe(false);
  });

  it("fresh floor launch types the exact command and returns the minted id", async () => {
    const { adapter, pane } = launchRig();
    const result = await adapter.launchHarness(harnessBinding({ model: "qwen3-coder-plus" }), { name: "x" });
    const token = result.ok ? result.resumeToken : undefined;
    expect(token).toMatch(SESSION_ID_RE);
    expect(pane.typed[0]).toContain(`'qwen' '--model' 'qwen3-coder-plus' '--approval-mode' 'auto-edit' '--session-id' '${token}'`);
    expect(pane.typed[0]).not.toContain("--yolo");
    expect(pane.typed[0]).not.toContain("--skip-trust");
  });

  it("full_bypass passes --yolo instead of an approval mode", async () => {
    const { adapter, pane } = launchRig();
    await adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
    expect(pane.typed[0]).toContain("'qwen' '--yolo' '--session-id'");
  });

  it("resume requires the conversation file, not just runtime.json", async () => {
    const launchedOnly = launchRig();
    seedQwenRuntimeStatus(launchedOnly.files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID, startedAt: HARNESS_NOW });
    const refused = await launchedOnly.adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID });
    expect(refused).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect(launchedOnly.pane.typed).toEqual([]);

    const withConversation = launchRig();
    seedQwenConversation(withConversation.files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID });
    const resumed = await withConversation.adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID });
    expect(resumed).toMatchObject({ ok: true, resumeToken: VALID });
    expect(withConversation.pane.typed[0]).toContain(`'--resume' '${VALID}'`);
    expect(withConversation.pane.typed[0]).not.toContain("--session-id");
  });

  it("finds the conversation under QWEN_RUNTIME_DIR from the adapter env", async () => {
    const { adapter, pane, files } = launchRig(undefined, { QWEN_RUNTIME_DIR: "/runtime" });
    seedQwenConversation(files, { homedir: "/unused", cwd: HARNESS_CWD, token: VALID });
    // Move the seeded file under the runtime dir layout.
    const [path] = Object.keys(files.files);
    files.files[path!.replace("/unused/.qwen", "/runtime")] = files.files[path!]!;
    delete files.files[path!];
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID });
    expect(result.ok).toBe(true);
    expect(pane.typed).toHaveLength(1);
  });

  it("fork types --resume <parent> --fork-session with no minted child id", async () => {
    const { adapter, pane, files } = launchRig();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: PARENT } });
    expect(result.ok).toBe(true);
    expect(pane.typed[0]).toContain(`'--resume' '${PARENT}' '--fork-session'`);
    expect(pane.typed[0]).not.toContain("--session-id");
    if (result.ok) expect(result.resumeToken).not.toBe(PARENT);
    const record = JSON.parse(files.files[nodePath.join(HARNESS_STATE_ROOT, "qwen", HARNESS_SESSION, "launch.json")]!);
    expect(record.mode).toBe("fork");
    expect(record.presetToken).toBeUndefined();
  });

  it("refuses fork refs other than a native session id", async () => {
    const { adapter, pane } = launchRig();
    const byName = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "name", value: "feature" } });
    expect(byName.ok).toBe(false);
    const byTitle = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: "a title" } });
    expect(byTitle.ok).toBe(false);
    expect(pane.typed).toEqual([]);
  });

  it("merges guidance into QWEN.md", async () => {
    const { adapter, files } = launchRig();
    files.files["/src/guidance.md"] = "Be terse.";
    await adapter.deliverStartup([{
      path: "guidance.md", absolutePath: "/src/guidance.md", ownerRoot: "/src", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    }], harnessBinding());
    expect(files.files[nodePath.join(HARNESS_CWD, "QWEN.md")]).toContain("Be terse.");
    expect(files.files[nodePath.join(HARNESS_CWD, "AGENTS.md")]).toBeUndefined();
  });
});

describe("qwen trust provisioning (prepareLaunch)", () => {
  const settings = nodePath.join(HARNESS_HOME, ".qwen", "settings.json");
  const trust = nodePath.join(HARNESS_HOME, ".qwen", "trustedFolders.json");

  it("writes nothing when folder trust is off (the qwen default)", async () => {
    const files = memFs({ [settings]: JSON.stringify({ ui: { theme: "x" } }) });
    await launchRig(undefined, {}, files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(files.files[trust]).toBeUndefined();
    expect(JSON.parse(files.files[settings]!)).toEqual({ ui: { theme: "x" } });
  });

  it("adds the seat cwd as TRUST_FOLDER when folder trust is on, keeping other entries", async () => {
    const files = memFs({
      [settings]: JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      [trust]: JSON.stringify({ "/other": "DO_NOT_TRUST" }),
    });
    await launchRig(undefined, {}, files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(JSON.parse(files.files[trust]!)).toEqual({ "/other": "DO_NOT_TRUST", [HARNESS_CWD]: "TRUST_FOLDER" });
  });

  it("never overrides an owner's explicit decision for the cwd", async () => {
    const files = memFs({
      [settings]: JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      [trust]: JSON.stringify({ [HARNESS_CWD]: "DO_NOT_TRUST" }),
    });
    await launchRig(undefined, {}, files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(JSON.parse(files.files[trust]!)).toEqual({ [HARNESS_CWD]: "DO_NOT_TRUST" });
  });

  it("honors QWEN_CODE_TRUSTED_FOLDERS_PATH and leaves unparseable settings alone", async () => {
    const files = memFs({ [settings]: JSON.stringify({ security: { folderTrust: { enabled: true } } }) });
    await launchRig(undefined, { QWEN_CODE_TRUSTED_FOLDERS_PATH: "/etc-qwen/trust.json" }, files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(JSON.parse(files.files["/etc-qwen/trust.json"]!)).toEqual({ [HARNESS_CWD]: "TRUST_FOLDER" });

    const jsonc = memFs({ [settings]: "// comment\n{ \"security\": { \"folderTrust\": { \"enabled\": true } } }" });
    await launchRig(undefined, {}, jsonc).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(jsonc.files[trust]).toBeUndefined();
  });
});

describe("qwen late capture", () => {
  const seatStateDir = nodePath.join(HARNESS_STATE_ROOT, "qwen", HARNESS_SESSION);
  const launchStartedAt = new Date("2026-09-29T12:00:00.000Z");
  const input = { sessionName: HARNESS_SESSION, cwd: HARNESS_CWD, seatStateDir, homedir: HARNESS_HOME, launchStartedAt };
  const record = (mode: string, presetToken?: string) => JSON.stringify({
    launchId: "l1", runtimeId: "qwen", sessionName: HARNESS_SESSION, cwd: HARNESS_CWD, launchStartedAt: launchStartedAt.toISOString(), mode,
    ...(presetToken ? { presetToken } : {}),
  });
  const hook = (files: ReturnType<typeof memFs>) => createGeminiFamilyCapture({
    sessionExists: qwenRuntimeStatusExists,
    captureForkChild: (ctx, at) => captureQwenForkChild(ctx, { launchStartedAt: at }),
    fs: files,
    env: {},
  });
  const later = (ms: number) => new Date(launchStartedAt.getTime() + ms);

  it("fresh: reports the minted id once runtime.json exists, never a pod-mate's", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("fresh", VALID) });
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: MISSING, startedAt: later(500) });
    expect(hook(files)(input)).toBeNull();
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID, startedAt: later(800) });
    expect(hook(files)(input)).toBe(VALID);
  });

  it("fork: reports the single child started after the launch", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("fork") });
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: PARENT, startedAt: new Date("2026-09-29T09:00:00.000Z") });
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID, startedAt: later(1_200) });
    expect(hook(files)(input)).toBe(VALID);
  });

  it("fork: returns null once a pod-mate also launched in the cwd (ambiguous)", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("fork") });
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID, startedAt: later(1_200) });
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: MISSING, startedAt: later(60_000) });
    expect(hook(files)(input)).toBeNull();
  });

  it("resume: returns null (the persisted token stands)", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("resume") });
    seedQwenRuntimeStatus(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID, startedAt: later(100) });
    expect(hook(files)(input)).toBeNull();
  });
});
