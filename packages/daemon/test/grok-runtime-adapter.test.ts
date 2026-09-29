// Grok Build runtime adapter: the shared TUI CLI contract plus grok-specific
// argv, minted session ids, fork, resume target, late capture, and pane
// fixtures. Hermetic: no grok binary, no network. Pane text comes from grok
// 1.0.25 (binary strings; the sign-in screen from an isolated probe).

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GROK_DESCRIPTOR, GROK_REGISTRATION, GROK_SPEC, grokSessionExists, validateGrokSessionId } from "../src/adapters/cli/grok/index.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import { LAUNCH_RECORD_FILE, runDescriptorTokenCapture } from "../src/domain/runtime-capture.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

const READY = "  Grok Build\n\n  > Build anything\n\n  grok-4 · ~/work · ? for help";
const SIGN_IN = [
  "  Approve in your browser to finish signing in.",
  "                     RYAG-7P8A",
  "  Make sure your browser shows this code.",
  "  Waiting for approval...",
  "                    ctrl+q  quit",
].join("\n");
const TOKEN = "0198a2f0-1c2d-7e3f-8a9b-0c1d2e3f4a5b";

function seedGrokSession(homedir: string, cwd: string, id: string): void {
  const dir = nodePath.join(homedir, ".grok", "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "summary.json"), "{}");
}

runTuiCliAdapterContract({
  registration: GROK_REGISTRATION,
  readyScreen: READY,
  gateScreens: [
    { screen: "  Do you trust the contents of this directory?\n  Grok Build may run or modify contents in this directory,\n  > Yes, proceed", code: "trust_gate" },
    { screen: SIGN_IN, code: "login_required" },
  ],
  errorScreens: [],
  earlyExit: { screen: `Error: No session found with id ${TOKEN}.`, recovery: "retry_fresh" },
  validResumeToken: TOKEN,
  invalidResumeToken: "not-a-uuid; rm -rf /",
  missingResumeToken: "0198a2f0-0000-7000-8000-000000000000",
  modelExample: "grok-4",
  forkSourceValue: "0198a2f0-aaaa-7bbb-8ccc-dddddddddddd",
  seedResumeTarget: ({ homedir, cwd, token }) => seedGrokSession(homedir, cwd, token),
  // grok writes the minted session at startup; late capture reads it back.
  seedSession: ({ seatStateDir, cwd, homedir }) => {
    const preset = (JSON.parse(fs.readFileSync(nodePath.join(seatStateDir, LAUNCH_RECORD_FILE), "utf-8")) as { presetToken: string }).presetToken;
    seedGrokSession(homedir, cwd, preset);
    return preset;
  },
});

describe("grok adapter", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  function tmp(): string {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-grok-"));
    roots.push(root);
    return root;
  }
  function launch(env: NodeJS.ProcessEnv = {}) {
    const pane = mockTmux([atShell(), { command: "grok", content: READY }]);
    const adapter = new TuiCliRuntimeAdapter(GROK_SPEC, harnessDeps({ tmux: pane.tmux, fsOps: memFs(), env }));
    return { pane, adapter };
  }
  const uuidIn = (cmd: string) => /'--session-id' '([0-9a-f-]{36})'/.exec(cmd)?.[1];

  it("is registered in production", () => {
    expect(getRuntimeDescriptor("grok")).toBe(GROK_DESCRIPTOR);
  });

  it("launches fresh with a minted session id, the floor posture, and no updater or browser", async () => {
    const { pane, adapter } = launch();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    const minted = uuidIn(pane.typed[0]!);
    expect(minted).toBeTruthy();
    expect(pane.typed[0]).toBe(`exec env 'GROK_DISABLE_AUTOUPDATER=1' 'BROWSER=true' 'grok' '--no-alt-screen' '--trust' '--permission-mode' 'acceptEdits' '--session-id' '${minted}'`);
    expect(result).toEqual({ ok: true, resumeToken: minted, resumeType: "grok_session_id" });
  });

  it("maps full_bypass to --always-approve and passes the model", async () => {
    const { pane, adapter } = launch();
    await adapter.launchHarness(harnessBinding({ model: "grok-4", launchPosture: "full_bypass" }), { name: "x" });
    expect(pane.typed[0]).toContain("'grok' '--no-alt-screen' '--trust' '--model' 'grok-4' '--always-approve' '--session-id'");
    expect(pane.typed[0]).not.toContain("acceptEdits");
  });

  it("resumes by id without minting", async () => {
    const root = tmp();
    const home = nodePath.join(root, "home");
    seedGrokSession(home, "/work/project", TOKEN);
    const pane = mockTmux([atShell(), { command: "grok", content: READY }]);
    const adapter = new TuiCliRuntimeAdapter(GROK_SPEC, harnessDeps({ tmux: pane.tmux, fsOps: memFs(), homedir: home }));
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: TOKEN.toUpperCase() });
    expect(pane.typed[0]!.endsWith(`'--permission-mode' 'acceptEdits' '--resume' '${TOKEN}'`)).toBe(true);
    expect(pane.typed[0]).not.toContain("--session-id");
    expect(result).toEqual({ ok: true, resumeToken: TOKEN, resumeType: "grok_session_id" });
  });

  it("forks from a parent into a new minted child id", async () => {
    const parent = "0198a2f0-aaaa-7bbb-8ccc-dddddddddddd";
    const { pane, adapter } = launch();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: parent } });
    const child = uuidIn(pane.typed[0]!);
    expect(pane.typed[0]).toContain(`'--resume' '${parent}' '--fork-session' '--session-id' '${child}'`);
    expect(child).not.toBe(parent);
    expect(result).toEqual({ ok: true, resumeToken: child, resumeType: "grok_session_id" });
    const refused = await launch().adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "name", value: "t" } });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('ref.kind="name" is not supported') });
  });

  it("discovery matches the grok program path, never the installer's agent symlink", () => {
    expect(processMatches("/Users/x/.grok/bin/grok --no-alt-screen --trust", GROK_DESCRIPTOR.processMatch!)).toBe(true);
    expect(processMatches("grok", GROK_DESCRIPTOR.processMatch!)).toBe(true);
    expect(processMatches("/Users/x/.grok/bin/agent", GROK_DESCRIPTOR.processMatch!)).toBe(false);
    expect(processMatches("agent --resume abc", GROK_DESCRIPTOR.processMatch!)).toBe(false);
    expect(processMatches("vim grok-notes.md", GROK_DESCRIPTOR.processMatch!)).toBe(false);
  });

  it("validates session ids as UUIDs", () => {
    expect(validateGrokSessionId(TOKEN.toUpperCase())).toEqual({ ok: true, token: TOKEN });
    expect(validateGrokSessionId("my-session-title").ok).toBe(false);
  });

  it("finds a session in any working-directory group", () => {
    const home = nodePath.join(tmp(), ".grok");
    expect(grokSessionExists(home, TOKEN)).toBe(false);
    fs.mkdirSync(nodePath.join(home, "sessions", "slug-3f2a", TOKEN), { recursive: true });
    expect(grokSessionExists(home, TOKEN)).toBe(true);
  });

  it("late capture returns only this seat's minted session, once it exists", async () => {
    const root = tmp();
    const home = nodePath.join(root, "home");
    const seat = nodePath.join(root, "state", "grok", HARNESS_SESSION);
    const capture = () => GROK_DESCRIPTOR.captureResumeToken!({ sessionName: HARNESS_SESSION, seatStateDir: seat, homedir: home }, {});
    expect(await capture()).toBeNull();
    fs.mkdirSync(seat, { recursive: true });
    fs.writeFileSync(nodePath.join(seat, LAUNCH_RECORD_FILE), JSON.stringify({ presetToken: TOKEN }));
    expect(await capture()).toBeNull(); // grok has not written it yet
    seedGrokSession(home, "/work/project", TOKEN);
    expect(await capture()).toBe(TOKEN);
  });

  it("two grok seats in one cwd each capture their own minted id (seat-scoped, not guarded)", async () => {
    expect(GROK_DESCRIPTOR.captureIsSessionScoped).toBe(true);
    const root = tmp();
    const home = nodePath.join(root, "home");
    const ids = { a: TOKEN, b: "0198a2f0-bbbb-7ccc-8ddd-eeeeeeeeeeee" };
    const siblingAlwaysLive = { hasLiveSiblingSeat: () => "other@rig" };
    for (const [name, id] of Object.entries(ids)) {
      const seat = nodePath.join(root, "state", "grok", `${name}@rig`);
      fs.mkdirSync(seat, { recursive: true });
      fs.writeFileSync(nodePath.join(seat, LAUNCH_RECORD_FILE), JSON.stringify({ launchId: name, runtimeId: "grok", sessionName: `${name}@rig`, cwd: "/work/shared" }));
      seedGrokSession(home, "/work/shared", id);
      // No presetToken in this record, so only captureIsSessionScoped keeps the guard away.
      const scoped = { ...GROK_DESCRIPTOR, captureResumeToken: () => id };
      expect(await runDescriptorTokenCapture(scoped, { sessionName: `${name}@rig`, cwd: "/work/shared", seatStateDir: seat, homedir: home }, siblingAlwaysLive))
        .toEqual({ outcome: "token", token: id });
    }
  });

  it("uses the harness state root for the seat dir", () => {
    const adapter = new TuiCliRuntimeAdapter(GROK_SPEC, harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }));
    expect(adapter.seatStateDir(HARNESS_SESSION)).toBe(nodePath.join(HARNESS_STATE_ROOT, "grok", HARNESS_SESSION));
  });
});
