// Hermetic tests for the Kiro CLI runtime adapter: the shared TUI CLI
// contract, launch argv and posture, version identity, and strict readiness
// against the live sign-in capture and a screen synthesized from binary
// strings. No real `kiro-cli`.

import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIRO_DESCRIPTOR, KIRO_NOT_READY_RE, KIRO_READY_RE, KIRO_REGISTRATION, KIRO_SPEC,
  buildKiroArgv, parseKiroVersion, verifyKiroVersionOutput,
} from "../src/adapters/cli/kiro/index.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { atShell, harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

function fixture(name: string): string {
  return readFileSync(nodePath.join(__dirname, "fixtures", "cli-panes", name), "utf-8");
}

const LOGIN = fixture("kiro-80-login.txt");
const IDLE = fixture("kiro-80-idle-synth.txt");

describe("buildKiroArgv", () => {
  it("both postures pass an explicit tool-trust argument", () => {
    expect(buildKiroArgv({ posture: "floor", model: "claude-sonnet-4.5" })).toEqual(["kiro-cli", "chat", "--trust-tools=", "--model", "claude-sonnet-4.5"]);
    expect(buildKiroArgv({ posture: "full_bypass" })).toEqual(["kiro-cli", "chat", "--trust-all-tools"]);
  });

  it("refuses resume, fork, and dash-led models", () => {
    expect(() => buildKiroArgv({ posture: "floor", resumeToken: "abc" })).toThrow(/resume is not supported/);
    expect(() => buildKiroArgv({ posture: "floor", forkSource: { kind: "native_id", value: "x" } })).toThrow(/no fork/);
    expect(() => buildKiroArgv({ posture: "floor", model: "--trust-all-tools" })).toThrow(/model/);
  });

  it("records both postures for permission drift", () => {
    const observe = (posture: "floor" | "full_bypass") => KIRO_SPEC.observeLaunch!({ binding: harnessBinding(), posture, seatStateDir: "/s" });
    expect(observe("floor")).toMatchObject({ state: "observed", value: "--trust-tools=" });
    expect(observe("full_bypass")).toMatchObject({ state: "observed", value: "--trust-all-tools" });
    const postureFor = KIRO_DESCRIPTOR.permissionPostureFor!;
    expect([postureFor("--trust-tools="), postureFor("--trust-all-tools"), postureFor("--trust-tools=fs_read")]).toEqual(["floor", "full_bypass", null]);
  });
});

describe("identity", () => {
  it("reads `kiro-cli --version` (live: 'kiro-cli 2.27.1')", () => {
    expect(parseKiroVersion("kiro-cli 2.27.1\n")).toBe("2.27.1");
    expect(verifyKiroVersionOutput("kiro-cli 2.27.1")).toBeNull();
    expect(verifyKiroVersionOutput("q 1.0.0")).toMatch(/Kiro CLI/);
  });

  it("declares no resume token, so restore asks for --fresh", () => {
    expect(KIRO_DESCRIPTOR.resumeType).toBeUndefined();
    expect(KIRO_DESCRIPTOR.captureResumeToken).toBeUndefined();
    expect(KIRO_DESCRIPTOR.supportsFork).toBe(false);
  });
});

describe("strict readiness (fails toward attention_required)", () => {
  it("the live sign-in screen is a login gate, never ready", () => {
    expect(KIRO_READY_RE.test(LOGIN)).toBe(false);
    expect(KIRO_SPEC.gatePatterns!.find((gate) => gate.pattern.test(LOGIN))?.code).toBe("login_required");
  });

  it("the input placeholder is ready only with no dialog or prompt on screen", () => {
    expect(KIRO_READY_RE.test(IDLE)).toBe(true);
    for (const marker of ["Allow this action? [y/n/t]", "Opening browser... | Press (^) + C to cancel", "Press enter to continue to the browser or esc to cancel"]) {
      expect(KIRO_NOT_READY_RE.test(marker), marker).toBe(true);
      expect(KIRO_READY_RE.test(`${IDLE}\n${marker}`), marker).toBe(false);
    }
  });

  it("an unrecognized screen runs out the wait as attention_required", async () => {
    const pane = mockTmux([atShell(), { command: "kiro-cli", content: "Loading agent..." }]);
    const adapter = KIRO_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs(), sleep: async () => {} }));
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ recovery: "attention_required" });
  });
});

runTuiCliAdapterContract({
  registration: KIRO_REGISTRATION,
  readyScreen: IDLE,
  runningCommand: "kiro-cli",
  gateScreens: [{ screen: LOGIN, code: "login_required" }],
  modelExample: "claude-sonnet-4.5",
});
