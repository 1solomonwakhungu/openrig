// Managed gemini / qwen seats must not update the operator's install. Both
// CLIs otherwise run their package manager's install from inside the seat (for
// a global npm install, into the operator's npm prefix). Every launch sets a
// per-seat npm prefix (containment, both CLIs), and qwen also gets a seat copy
// of its system defaults with auto-update off (gemini ignores non-root system
// files). Hermetic: in-memory fs, mock tmux, no real binary. The containment
// itself was verified live on gemini 0.61.0 (see docs/reference/runtimes/gemini.md).

import nodePath from "node:path";
import { describe, it, expect } from "vitest";
import {
  QWEN_AUTO_UPDATE_GUARD, buildSeatSystemDefaults, npmContainmentEnv, operatorSystemDefaultsPath, seatNpmPrefix, seatSystemDefaultsPath,
} from "../src/adapters/cli/gemini-family/auto-update.js";
import { GEMINI_REGISTRATION } from "../src/adapters/cli/gemini/index.js";
import { QWEN_REGISTRATION } from "../src/adapters/cli/qwen/index.js";
import type { CliRuntimeRegistration } from "../src/adapters/cli/types.js";
import {
  HARNESS_CWD, HARNESS_HOME, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";
import { seedGeminiSession, seedQwenConversation } from "./helpers/gemini-family-seed.js";

const RESUME_ID = "0b7c2f1e-5d4a-4c3b-9a8f-1e2d3c4b5a69";
const READY = "  Type your message or @path/to/file";

describe("auto-update guard (pure)", () => {
  it("contains npm global installs in a per-seat prefix, under both env spellings", () => {
    expect(seatNpmPrefix("/state/gemini/s@r")).toBe("/state/gemini/s@r/npm-global");
    expect(npmContainmentEnv("/state/gemini/s@r")).toEqual({
      NPM_CONFIG_PREFIX: "/state/gemini/s@r/npm-global",
      npm_config_prefix: "/state/gemini/s@r/npm-global",
    });
  });

  it("resolves qwen's operator system-defaults path: env override, else the platform default", () => {
    expect(operatorSystemDefaultsPath(QWEN_AUTO_UPDATE_GUARD, {}, "darwin")).toBe("/Library/Application Support/QwenCode/system-defaults.json");
    expect(operatorSystemDefaultsPath(QWEN_AUTO_UPDATE_GUARD, {}, "linux")).toBe("/etc/qwen-code/system-defaults.json");
    expect(operatorSystemDefaultsPath(QWEN_AUTO_UPDATE_GUARD, { QWEN_CODE_SYSTEM_DEFAULTS_PATH: "/opt/q/d.json" }, "darwin")).toBe("/opt/q/d.json");
  });

  it("writes auto-update off on top of the operator's defaults; unparseable defaults are not copied", () => {
    const merged = buildSeatSystemDefaults(QWEN_AUTO_UPDATE_GUARD, JSON.stringify({ general: { vimMode: true, enableAutoUpdate: true }, ui: { theme: "x" } }));
    expect(merged.copied).toBe("operator_defaults");
    expect(JSON.parse(merged.content)).toEqual({ general: { vimMode: true, enableAutoUpdate: false }, ui: { theme: "x" } });
    expect(JSON.parse(buildSeatSystemDefaults(QWEN_AUTO_UPDATE_GUARD, null).content)).toEqual({ general: { enableAutoUpdate: false } });
    const jsonc = buildSeatSystemDefaults(QWEN_AUTO_UPDATE_GUARD, "// c\n{}");
    expect(jsonc.copied).toBe("operator_defaults_unparseable");
    expect(JSON.parse(jsonc.content)).toEqual({ general: { enableAutoUpdate: false } });
  });
});

function launchRig(registration: CliRuntimeRegistration, env: NodeJS.ProcessEnv, files = memFs(), frames = [{ command: "node", content: READY }]) {
  const pane = mockTmux([atShell(), ...frames]);
  const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files, env }));
  return { adapter, pane, files };
}

describe.each([
  ["gemini", GEMINI_REGISTRATION],
  ["qwen", QWEN_REGISTRATION],
] as const)("%s: npm containment on every launch", (id, registration) => {
  const seatDir = nodePath.join(HARNESS_STATE_ROOT, id, HARNESS_SESSION);
  const prefix = seatNpmPrefix(seatDir);

  it("sets the seat npm prefix and creates it, on fresh launches", async () => {
    const { adapter, pane, files } = launchRig(registration, {});
    expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
    expect(pane.typed[0]).toContain(`'NPM_CONFIG_PREFIX=${prefix}'`);
    expect(pane.typed[0]).toContain(`'npm_config_prefix=${prefix}'`);
    expect(files.dirs.has(prefix)).toBe(true);
  });

  it("sets it on resume too", async () => {
    const files = memFs();
    if (id === "gemini") seedGeminiSession(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: RESUME_ID });
    else seedQwenConversation(files, { homedir: HARNESS_HOME, cwd: HARNESS_CWD, token: RESUME_ID });
    const { adapter, pane } = launchRig(registration, {}, files);
    expect((await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: RESUME_ID })).ok).toBe(true);
    expect(pane.typed[0]).toContain(`'NPM_CONFIG_PREFIX=${prefix}'`);
  });

  it("does not fail a launch for a contained npm self-update", async () => {
    const screen = `${READY}\nUpdate available! 0.61.0 -> 0.62.0\nInstalled with npm. Attempting to automatically update now...`;
    const { adapter } = launchRig(registration, {}, memFs(), [{ command: "node", content: screen }]);
    expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
  });

  it.each([
    "Installed with pnpm. Attempting to automatically update now...",
    "Installed with Volta. Attempting to automatically update now...",
    "Standalone install detected. Attempting to automatically update now...",
  ])("fails loudly with evidence on an uncontained self-update: %s", async (line) => {
    const screen = `${READY}\n${line}`;
    const { adapter } = launchRig(registration, {}, memFs(), [{ command: "node", content: screen }]);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    if (!result.ok) expect(result.evidence).toContain("Attempting to automatically update");
    const ready = await registration.createAdapter(harnessDeps({ tmux: mockTmux([{ command: "node", content: screen }]).tmux, fsOps: memFs() }))
      .checkReady(harnessBinding());
    expect(ready).toMatchObject({ ready: false, code: "self_update" });
  });
});

describe("qwen: auto-update off through a seat system-defaults copy", () => {
  const seatFile = seatSystemDefaultsPath(nodePath.join(HARNESS_STATE_ROOT, "qwen", HARNESS_SESSION));
  const operatorFile = "/operator/system-defaults.json";

  it("copies the operator's defaults read-only and turns auto-update off, writing nothing the operator owns", async () => {
    const operatorDefaults = JSON.stringify({ general: { vimMode: true } });
    const { adapter, pane, files } = launchRig(QWEN_REGISTRATION, { QWEN_CODE_SYSTEM_DEFAULTS_PATH: operatorFile }, memFs({ [operatorFile]: operatorDefaults }));
    expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
    expect(pane.typed[0]).toContain(`'QWEN_CODE_SYSTEM_DEFAULTS_PATH=${seatFile}'`);
    expect(JSON.parse(files.files[seatFile]!)).toEqual({ general: { vimMode: true, enableAutoUpdate: false } });
    expect(files.files[operatorFile]).toBe(operatorDefaults);
    expect(Object.keys(files.files).filter((f) => f.startsWith(HARNESS_HOME) || f.startsWith(HARNESS_CWD))).toEqual([]);
  });

  it("gemini gets no system-defaults override (it ignores non-root system files)", async () => {
    const { adapter, pane, files } = launchRig(GEMINI_REGISTRATION, {});
    await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(pane.typed[0]).not.toContain("GEMINI_CLI_SYSTEM_DEFAULTS_PATH");
    expect(Object.keys(files.files).filter((f) => f.endsWith("system-defaults.json"))).toEqual([]);
  });
});
