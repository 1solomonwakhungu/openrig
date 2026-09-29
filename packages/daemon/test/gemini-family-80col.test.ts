// OpenRig daemon panes are 80x24. These fixtures were captured live from
// gemini 0.61.0 and qwen 0.24.7 at exactly 80x24 (isolated tmux server,
// throwaway HOME, fake keys, a 150-character cwd), so they carry the real
// wrapping: abbreviated long paths, box-wrapped dialogs, a resumed session's
// history, and error text wrapped mid-token. Each is asserted through the
// launch path and checkReady, not just a regex.

import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { GEMINI_REGISTRATION } from "../src/adapters/cli/gemini/index.js";
import { QWEN_REGISTRATION } from "../src/adapters/cli/qwen/index.js";
import type { CliRuntimeRegistration } from "../src/adapters/cli/types.js";
import { atShell, harnessBinding, harnessDeps, memFs, mockTmux, type PaneFrame } from "./helpers/tui-cli-adapter-harness.js";

const DIR = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "gemini-family", "80x24");
const fixture = (name: string) => fs.readFileSync(nodePath.join(DIR, `${name}.txt`), "utf8");

function launch(registration: CliRuntimeRegistration, frames: PaneFrame[]) {
  const pane = mockTmux([atShell(), ...frames]);
  return registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }))
    .launchHarness(harnessBinding(), { name: "x" });
}

function ready(registration: CliRuntimeRegistration, screen: string) {
  return registration.createAdapter(harnessDeps({ tmux: mockTmux([{ command: "node", content: screen }]).tmux, fsOps: memFs() }))
    .checkReady(harnessBinding());
}

const CASES: Array<{ registration: CliRuntimeRegistration; name: string; expect: "ready" | { code: string } }> = [
  { registration: GEMINI_REGISTRATION, name: "gemini-ready-floor-long-cwd", expect: "ready" },
  { registration: GEMINI_REGISTRATION, name: "gemini-ready-yolo-long-cwd", expect: "ready" },
  { registration: GEMINI_REGISTRATION, name: "gemini-ready-resumed-session", expect: "ready" },
  { registration: GEMINI_REGISTRATION, name: "gemini-trust", expect: { code: "trust_gate" } },
  { registration: GEMINI_REGISTRATION, name: "gemini-auth", expect: { code: "login_required" } },
  { registration: GEMINI_REGISTRATION, name: "gemini-keybinding-prompt", expect: { code: "startup_dialog" } },
  { registration: GEMINI_REGISTRATION, name: "gemini-ide-nudge", expect: { code: "startup_dialog" } },
  { registration: QWEN_REGISTRATION, name: "qwen-ready-floor-long-cwd", expect: "ready" },
  { registration: QWEN_REGISTRATION, name: "qwen-ready-yolo-long-cwd", expect: "ready" },
  { registration: QWEN_REGISTRATION, name: "qwen-trust", expect: { code: "trust_gate" } },
  { registration: QWEN_REGISTRATION, name: "qwen-auth", expect: { code: "login_required" } },
  { registration: QWEN_REGISTRATION, name: "qwen-welcome-back", expect: { code: "startup_dialog" } },
];

describe("gemini family at 80x24 (live captures)", () => {
  it("every fixture is a real 80x24 screen", () => {
    for (const file of fs.readdirSync(DIR)) {
      const rows = fs.readFileSync(nodePath.join(DIR, file), "utf8").replace(/\n$/, "").split("\n");
      expect(rows.length, file).toBeLessThanOrEqual(24);
      for (const row of rows) expect([...row].length, `${file}: ${row}`).toBeLessThanOrEqual(80);
    }
  });

  it.each(CASES.map((c) => [c.name, c] as const))("%s: launch and checkReady", async (_name, c) => {
    const screen = fixture(c.name);
    const launched = await launch(c.registration, [{ command: "node", content: screen }]);
    const readiness = await ready(c.registration, screen);
    if (c.expect === "ready") {
      expect(launched.ok).toBe(true);
      expect(readiness).toEqual({ ready: true });
    } else {
      expect(launched).toMatchObject({ ok: false, recovery: "attention_required" });
      if (!launched.ok) expect(launched.evidence?.trim()).toBeTruthy();
      expect(readiness).toMatchObject({ ready: false, code: c.expect.code });
    }
  });

  it.each([
    [GEMINI_REGISTRATION, "gemini-resume-missing"],
    [QWEN_REGISTRATION, "qwen-resume-missing"],
  ] as const)("%s wrapped session-missing error fails fast as retry_fresh after the CLI exits", async (registration, name) => {
    const screen = fixture(name);
    const launched = await launch(registration, [{ command: "node", content: "" }, { command: "zsh", content: screen }]);
    expect(launched).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });
});
