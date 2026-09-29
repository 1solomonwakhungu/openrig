// Gemini CLI runtime adapter: the shared TUI CLI contract suite plus
// gemini-specific behavior (exact argv, posture, minted session id, resume
// precheck, capture, reap flag). Hermetic: mock tmux, in-memory fs, and pane
// fixtures captured live from gemini 0.61.0 (test/fixtures/gemini-family/).

import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { GEMINI_DESCRIPTOR, GEMINI_REGISTRATION } from "../src/adapters/cli/gemini/index.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { SESSION_ID_RE } from "../src/adapters/cli/gemini-family/launch-args.js";
import { createGeminiFamilyCapture, readLaunchRecord } from "../src/adapters/cli/gemini-family/runtime.js";
import { findGeminiSessionFile } from "../src/adapters/cli/gemini-family/session-store.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import {
  HARNESS_CWD, HARNESS_HOME, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";
import { seedGeminiSession } from "./helpers/gemini-family-seed.js";

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "gemini-family");
const fixture = (name: string) => fs.readFileSync(nodePath.join(FIXTURES, name), "utf8");

const VALID = "0b7c2f1e-5d4a-4c3b-9a8f-1e2d3c4b5a69";
const MISSING = "9d8c7b6a-5f4e-4d3c-8b2a-190817263544";
const READY = fixture("gemini-ready-floor.txt");

runTuiCliAdapterContract({
  registration: GEMINI_REGISTRATION,
  readyScreen: READY,
  runningCommand: "node",
  modelExample: "gemini-2.5-pro",
  gateScreens: [
    { screen: fixture("gemini-trust.txt"), code: "trust_gate" },
    { screen: fixture("gemini-auth.txt"), code: "login_required" },
    { screen: fixture("gemini-api-key.txt"), code: "login_required" },
  ],
  errorScreens: [
    "When using Gemini API, you must specify the GEMINI_API_KEY environment variable.\nUpdate your environment and try again (no reload needed if using .env)!",
  ],
  earlyExit: { screen: fixture("gemini-resume-missing.txt"), recovery: "retry_fresh" },
  validResumeToken: VALID,
  invalidResumeToken: "latest; rm -rf ~",
  missingResumeToken: MISSING,
  seedResumeTarget: ({ fs: seedFs, homedir, cwd, token }) => { seedGeminiSession(seedFs, { homedir, cwd, token }); },
  // Late capture reports the minted id once gemini has stored the session.
  seedSession: ({ seatStateDir, cwd, homedir }) => {
    const token = readLaunchRecord(seatStateDir)?.presetToken;
    if (!token) throw new Error("expected a minted session id in launch.json");
    seedGeminiSession({ writeFile: (p, c) => fs.writeFileSync(p, c), mkdirp: (p) => fs.mkdirSync(p, { recursive: true }) }, { homedir, cwd, token });
    return token;
  },
});

function launchRig(frames = [{ command: "node", content: READY }], env: NodeJS.ProcessEnv = {}) {
  const pane = mockTmux([atShell(), ...frames]);
  const files = memFs();
  const adapter = GEMINI_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files, env }));
  return { adapter, pane, files };
}

describe("gemini runtime adapter", () => {
  it("is registered in the CLI index and the registry", () => {
    expect(CLI_RUNTIME_REGISTRATIONS).toContain(GEMINI_REGISTRATION);
    expect(getRuntimeDescriptor("gemini")).toBe(GEMINI_DESCRIPTOR);
  });

  it("descriptor: guidance, skills, identity, reap, no fork", () => {
    expect(GEMINI_DESCRIPTOR).toMatchObject({
      binary: "gemini", installHint: "npm install -g @google/gemini-cli", resumeType: "gemini_session_id", supportsFork: false, guidanceFile: "GEMINI.md", reapProcessTreeOnStop: true,
    });
    expect(GEMINI_DESCRIPTOR.paneCommands).toBeUndefined();
    expect(GEMINI_DESCRIPTOR.skillsDir?.({ cwd: "/w" })).toBe("/w/.gemini/skills");
  });

  it("processMatch identifies both gemini processes and nothing adjacent", () => {
    const match = GEMINI_DESCRIPTOR.processMatch!;
    expect(processMatches("node /usr/local/lib/node_modules/.bin/gemini --skip-trust", match)).toBe(true);
    expect(processMatches("/opt/node/bin/node --max-old-space-size=24576 /home/u/.npm/bin/gemini", match)).toBe(true);
    expect(processMatches("node", match)).toBe(false);
    expect(processMatches("/home/u/.gemini/antigravity-cli/bin/agy", match)).toBe(false);
    expect(processMatches("node /x/@google/gemini-cli/bundle/gemini.js", match)).toBe(false);
    expect(processMatches("vim notes-about-gemini", match)).toBe(false);
  });

  it("fresh floor launch types the exact command and returns the minted id", async () => {
    const { adapter, pane, files } = launchRig();
    const result = await adapter.launchHarness(harnessBinding({ model: "gemini-2.5-pro" }), { name: "x" });
    expect(result.ok).toBe(true);
    const token = result.ok ? result.resumeToken : undefined;
    expect(token).toMatch(SESSION_ID_RE);
    expect(result).toMatchObject({ resumeType: "gemini_session_id" });
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]).toContain(`'gemini' '--model' 'gemini-2.5-pro' '--approval-mode' 'auto_edit' '--skip-trust' '--session-id' '${token}'`);
    expect(pane.typed[0]).not.toContain("--yolo");
    const record = JSON.parse(files.files[nodePath.join(HARNESS_STATE_ROOT, "gemini", HARNESS_SESSION, "launch.json")]!);
    expect(record).toMatchObject({ mode: "fresh", presetToken: token });
  });

  it("full_bypass passes --yolo (policy or OPENRIG_YOLO), still with --skip-trust", async () => {
    const byPolicy = launchRig();
    await byPolicy.adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
    expect(byPolicy.pane.typed[0]).toContain("'--yolo' '--skip-trust'");
    expect(byPolicy.pane.typed[0]).not.toContain("--approval-mode");
    const byEnv = launchRig(undefined, { OPENRIG_YOLO: "1" });
    await byEnv.adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(byEnv.pane.typed[0]).toContain("'--yolo'");
  });

  it("resume types --resume <id> without --session-id once the session exists", async () => {
    const { adapter, pane, files } = launchRig();
    seedGeminiSession(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID });
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID });
    expect(result).toMatchObject({ ok: true, resumeToken: VALID });
    expect(pane.typed[0]).toContain(`'--resume' '${VALID}'`);
    expect(pane.typed[0]).not.toContain("--session-id");
  });

  it("refuses resume when the session file is missing, before typing", async () => {
    const { adapter, pane } = launchRig();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: MISSING });
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
    if (!result.ok) expect(result.error).not.toContain(MISSING);
    expect(pane.typed).toEqual([]);
  });

  it("honors GEMINI_CLI_HOME from the adapter env for the precheck", async () => {
    const { adapter, pane, files } = launchRig(undefined, { GEMINI_CLI_HOME: "/alt-home" });
    seedGeminiSession(files, { homedir: "/alt-home", cwd: HARNESS_CWD, token: VALID });
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID });
    expect(result.ok).toBe(true);
    expect(pane.typed).toHaveLength(1);
  });

  it("refuses fork with a clear error", async () => {
    const { adapter, pane } = launchRig();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: VALID } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no native fork primitive/);
    expect(pane.typed).toEqual([]);
  });

  it("merges guidance into GEMINI.md", async () => {
    const { adapter, files } = launchRig();
    files.files["/src/guidance.md"] = "Be terse.";
    const result = await adapter.deliverStartup([{
      path: "guidance.md", absolutePath: "/src/guidance.md", ownerRoot: "/src", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    }], harnessBinding());
    expect(result).toEqual({ delivered: 1, failed: [] });
    expect(files.files[nodePath.join(HARNESS_CWD, "GEMINI.md")]).toContain("Be terse.");
  });
});

describe("gemini late capture", () => {
  const seatStateDir = nodePath.join(HARNESS_STATE_ROOT, "gemini", HARNESS_SESSION);
  const input = { sessionName: HARNESS_SESSION, cwd: HARNESS_CWD, seatStateDir, homedir: HARNESS_HOME };
  const record = (mode: string, presetToken?: string) => JSON.stringify({ launchId: "l1", runtimeId: "gemini", sessionName: HARNESS_SESSION, cwd: HARNESS_CWD, launchStartedAt: "2026-09-29T12:00:00.000Z", mode, ...(presetToken ? { presetToken } : {}) });
  const hook = (files: ReturnType<typeof memFs>) => createGeminiFamilyCapture({ sessionExists: (ctx, id) => findGeminiSessionFile(ctx, id) !== null, fs: files, env: {} });

  it("reports the minted id once gemini stored the session", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("fresh", VALID) });
    expect(hook(files)(input)).toBeNull(); // not stored yet
    seedGeminiSession(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID });
    expect(hook(files)(input)).toBe(VALID);
  });

  it("never reports another seat's session from a shared cwd", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("fresh", VALID) });
    seedGeminiSession(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: MISSING });
    expect(hook(files)(input)).toBeNull();
  });

  it("returns null for resume launches and without a launch record", () => {
    const files = memFs({ [nodePath.join(seatStateDir, "launch.json")]: record("resume") });
    seedGeminiSession(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: VALID });
    expect(hook(files)(input)).toBeNull();
    expect(hook(memFs())(input)).toBeNull();
  });
});
