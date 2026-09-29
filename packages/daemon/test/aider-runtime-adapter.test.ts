// Hermetic tests for the Aider runtime adapter: the shared TUI CLI contract
// suite, then aider specifics (launch argv and posture, per-seat chat history
// token rules for validation, capture, and the resume check, and pane patterns
// against live aider 0.86.2 captures). No real binary, no network.

import nodePath from "node:path";
import os from "node:os";
import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildAiderArgv, aiderLaunchEnv, aiderSeatPaths, validateAiderChatHistoryToken,
  checkAiderResumeTarget, captureAiderChatHistory,
} from "../src/adapters/cli/aider/launch.js";
import { AIDER_READY_PATTERNS, AIDER_GATE_PATTERNS, AIDER_ERROR_PATTERNS } from "../src/adapters/cli/aider/patterns.js";
import { ATTENTION_REQUIRED_READINESS_CODES } from "../src/domain/runtime-adapter.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import { AIDER_DESCRIPTOR, AIDER_REGISTRATION } from "../src/adapters/cli/aider/index.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import {
  HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-panes", "aider");
const pane = (name: string) => readFileSync(nodePath.join(FIXTURES, name), "utf8");

function classify(content: string): string {
  for (const gate of AIDER_GATE_PATTERNS) if (gate.pattern.test(content)) return `gate:${gate.code}`;
  for (const error of AIDER_ERROR_PATTERNS) if (error.pattern.test(content)) return "error";
  return AIDER_READY_PATTERNS.some((p) => p.test(content)) ? "ready" : "pending";
}

const SEAT = "/openrig-home/state/aider/dev-aider@my-rig";
const CHAT = `${SEAT}/aider.chat.history.md`;
const INPUT = `${SEAT}/aider.input.history`;
const BASE = [
  "aider", "--no-check-update", "--no-show-release-notes", "--no-analytics", "--no-gitignore",
  "--chat-history-file", CHAT, "--input-history-file", INPUT, "--read", "AGENTS.md",
];

describe("aider launch argv", () => {
  it("floor: seat-scoped history files, managed guidance, and no auto-approve", () => {
    const argv = buildAiderArgv({ posture: "floor", seatStateDir: SEAT });
    expect(argv).toEqual(BASE);
    expect(argv).not.toContain("--yes-always");
    expect(argv).not.toContain("--restore-chat-history");
  });

  it("full_bypass adds --yes-always", () => {
    expect(buildAiderArgv({ posture: "full_bypass", seatStateDir: SEAT })).toEqual([...BASE, "--yes-always"]);
  });

  it("never persists analytics settings globally", () => {
    expect(buildAiderArgv({ posture: "floor", seatStateDir: SEAT })).not.toContain("--analytics-disable");
  });

  it("passes the model through --model", () => {
    expect(buildAiderArgv({ posture: "floor", seatStateDir: SEAT, model: " sonnet " })).toEqual([...BASE, "--model", "sonnet"]);
    expect(buildAiderArgv({ posture: "floor", seatStateDir: SEAT, model: null })).toEqual(BASE);
  });

  it("resume restores the persisted chat history file", () => {
    expect(buildAiderArgv({ posture: "floor", seatStateDir: SEAT, model: "sonnet", resumeToken: CHAT }))
      .toEqual([...BASE, "--model", "sonnet", "--restore-chat-history"]);
  });

  it("resume uses the token's file even when the seat state dir moved", () => {
    const old = "/openrig-home/state/aider/old-seat@my-rig/aider.chat.history.md";
    const argv = buildAiderArgv({ posture: "floor", seatStateDir: SEAT, resumeToken: old });
    expect(argv[argv.indexOf("--chat-history-file") + 1]).toBe(old);
  });

  it("refuses fork clearly", () => {
    expect(() => buildAiderArgv({ posture: "floor", seatStateDir: SEAT, forkSource: { kind: "native_id", value: CHAT } }))
      .toThrow(/no native fork primitive/);
  });

  it("refuses a malformed resume token", () => {
    expect(() => buildAiderArgv({ posture: "floor", seatStateDir: SEAT, resumeToken: "relative.md" })).toThrow(/absolute path/);
  });

  it("full_bypass neutralizes webbrowser.open; floor leaves the env alone", () => {
    expect(aiderLaunchEnv("full_bypass")).toEqual({ BROWSER: "true" });
    expect(aiderLaunchEnv("floor")).toEqual({});
  });
});

describe("aider chat history token", () => {
  it("seat paths live in the seat state dir", () => {
    expect(aiderSeatPaths(SEAT)).toEqual({ chatHistoryFile: CHAT, inputHistoryFile: INPUT });
  });

  it("accepts the seat history file and trims", () => {
    expect(validateAiderChatHistoryToken(` ${CHAT}\n`)).toEqual({ ok: true, token: CHAT });
  });

  it.each([
    ["", /empty/],
    ["aider.chat.history.md", /absolute/],
    ["/a/../b.md", /\.\./],
    ["/a b/c.md", /disallowed/],
    ["/a/$(x).md", /disallowed/],
    ["/a/b.txt", /\.md/],
    [`/${"a".repeat(1100)}.md`, /too long/],
  ])("rejects %j", (raw, why) => {
    const result = validateAiderChatHistoryToken(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(why);
  });

  it("capture returns the seat file once aider has written it", () => {
    expect(captureAiderChatHistory({ fs: { exists: () => false }, seatStateDir: SEAT })).toBeUndefined();
    expect(captureAiderChatHistory({ fs: { exists: (p) => p === CHAT }, seatStateDir: SEAT })).toBe(CHAT);
  });

  it("resume check maps a vanished history file to retry_fresh", () => {
    expect(checkAiderResumeTarget(CHAT, { fs: { exists: () => true } })).toEqual({ ok: true });
    expect(checkAiderResumeTarget(CHAT, { fs: { exists: () => false } }))
      .toEqual({ ok: false, error: "the persisted aider chat history file no longer exists", recovery: "retry_fresh" });
    expect(checkAiderResumeTarget("nope", { fs: { exists: () => true } })).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });
});

describe("aider pane patterns", () => {
  it("gate codes are attention-required readiness codes", () => {
    for (const gate of AIDER_GATE_PATTERNS) expect(ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)).toBe(true);
  });

  it.each([
    ["ready.txt", "ready"],
    ["missing-api-key.txt", "gate:login_required"],
    ["no-git-repo.txt", "gate:trust_gate"],
  ])("live capture %s -> %s", (fixture, expected) => {
    expect(classify(pane(fixture))).toBe(expected);
  });

  it("the no-git gate names its own reason", () => {
    const hit = AIDER_GATE_PATTERNS.find((g) => g.pattern.test(pane("no-git-repo.txt")));
    expect(hit?.reason).toMatch(/git repo/);
  });

  it.each(["architect> ", "ask>", "multi> ", "diff multi> "])("edit-format prompt %j is ready", (prompt) => {
    expect(classify(`Aider v0.86.2\n${"─".repeat(20)}\n${prompt}\n\n\n`)).toBe("ready");
  });

  it("quoted chat output is not a prompt", () => {
    expect(classify("> Tokens: 2.1k sent, 120 received.\n> Applied edit to app.py\n")).toBe("pending");
    expect(classify("Aider v0.86.2\n> \nthinking about it...\n")).toBe("pending");
  });

  it("an answered confirmation in scrollback does not gate", () => {
    const answered = "Add file to the chat? (Y)es/(N)o [Yes]: y\nAdded app.py to the chat\n" + "─".repeat(20) + "\napp.py\n> \n";
    expect(classify(answered)).toBe("ready");
  });

  it("any pending yes/no confirmation at the tail gates", () => {
    expect(classify("Run shell command? (Y)es/(N)o/(D)on't ask again [Yes]: ")).toBe("gate:trust_gate");
  });
});

// ── adapter (TUI CLI base + contract) ───────────────────────────────────────

const HARNESS_SEAT = `${HARNESS_STATE_ROOT}/aider/${HARNESS_SESSION}`;
const HARNESS_CHAT = `${HARNESS_SEAT}/aider.chat.history.md`;
const PYTHON = "Python";
const CONTRACT_CHAT = nodePath.join(os.tmpdir(), "openrig-aider-contract", "aider.chat.history.md");

runTuiCliAdapterContract({
  registration: AIDER_REGISTRATION,
  readyScreen: pane("ready.txt"),
  runningCommand: PYTHON,
  modelExample: "sonnet",
  gateScreens: [
    { screen: pane("missing-api-key.txt"), code: "login_required" },
    { screen: pane("no-git-repo.txt"), code: "trust_gate" },
  ],
  earlyExit: {
    screen: "Traceback (most recent call last):\n    import pyaudioop as audioop\nModuleNotFoundError: No module named 'pyaudioop'",
    recovery: "attention_required",
  },
  // Resume legs run on the real filesystem, so the valid token lives under the
  // OS temp dir (seeded by seedResumeTarget).
  validResumeToken: CONTRACT_CHAT,
  invalidResumeToken: "relative/history.md",
  missingResumeToken: "/openrig-home/state/aider/gone@harness-rig/aider.chat.history.md",
  seedResumeTarget: ({ fs: seatFs, token }) => {
    seatFs.mkdirp(nodePath.dirname(token));
    seatFs.writeFile(token, "# aider chat started at 2026-09-29 12:19:22\n");
  },
  seedSession: ({ seatStateDir }) => {
    const file = nodePath.join(seatStateDir, "aider.chat.history.md");
    fs.mkdirSync(seatStateDir, { recursive: true });
    fs.writeFileSync(file, "\n# aider chat started at 2026-09-29 12:19:22\n");
    return file;
  },
});

describe("aider adapter", () => {
  function launchRig(frames = [{ command: PYTHON, content: pane("ready.txt") }], env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}) {
    const tmuxPane = mockTmux([atShell(), ...frames]);
    const seatFs = memFs(files);
    const adapter = AIDER_REGISTRATION.createAdapter(harnessDeps({ tmux: tmuxPane.tmux, fsOps: seatFs, env }));
    return { adapter, pane: tmuxPane, fs: seatFs };
  }
  const q = (argv: string[]) => argv.map((a) => `'${a}'`).join(" ");

  it("is registered under runtime: aider", () => {
    expect(getRuntimeDescriptor("aider")).toBe(AIDER_DESCRIPTOR);
  });

  it("types the exact floor launch with no env prefix", async () => {
    const { adapter, pane: p } = launchRig();
    expect((await adapter.launchHarness(harnessBinding({ model: "sonnet" }), { name: "x" })).ok).toBe(true);
    expect(p.typed).toEqual([`exec ${q(buildAiderArgv({ posture: "floor", seatStateDir: HARNESS_SEAT, model: "sonnet" }))}`]);
    expect(p.typed[0]).not.toContain("--yes-always");
    expect(p.typed[0]).not.toContain("BROWSER");
  });

  it("full_bypass types --yes-always behind BROWSER=true", async () => {
    for (const [binding, env] of [[harnessBinding(), { OPENRIG_YOLO: "1" }], [harnessBinding({ launchPosture: "full_bypass" }), {}]] as const) {
      const { adapter, pane: p } = launchRig(undefined, env);
      await adapter.launchHarness(binding, { name: "x" });
      expect(p.typed[0]).toBe(`exec env 'BROWSER=true' ${q(buildAiderArgv({ posture: "full_bypass", seatStateDir: HARNESS_SEAT }))}`);
    }
  });

  it("resumes with --restore-chat-history when the history file exists", async () => {
    const { adapter, pane: p } = launchRig(undefined, {}, { [HARNESS_CHAT]: "# aider chat started\n" });
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: HARNESS_CHAT });
    expect(result).toMatchObject({ ok: true, resumeToken: HARNESS_CHAT, resumeType: "aider_chat_history_file" });
    expect(p.typed[0]).toContain("'--restore-chat-history'");
  });

  it("refuses a vanished history file as retry_fresh before typing", async () => {
    const { adapter, pane: p } = launchRig();
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: HARNESS_CHAT });
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect(p.typed).toEqual([]);
  });

  it("fails fast when aider is not installed", async () => {
    const { adapter } = launchRig([atShell("$ env 'BROWSER=true' 'aider'\nenv: aider: No such file or directory\n$ ")], { OPENRIG_YOLO: "1" });
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("not installed") });
  });

  it("merges guidance into AGENTS.md (which the launch --read loads) and skips skills", async () => {
    expect(AIDER_DESCRIPTOR.guidanceFile).toBe("AGENTS.md");
    expect(buildAiderArgv({ posture: "floor", seatStateDir: SEAT }).join(" ")).toContain("--read AGENTS.md");
    expect(AIDER_DESCRIPTOR.skillsDir).toBeUndefined();
  });

  it.each([
    // Live ps line on macOS (uv tool install, Homebrew Python 3.12).
    ["/opt/homebrew/Cellar/python@3.12/3.12.13_4/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python /Users/u/.local/bin/aider --model sonnet", true],
    ["/usr/bin/python3.12 /home/u/.local/bin/aider --no-check-update", true],
    ["python3 -m aider --model sonnet", true],
    ["/home/u/.local/bin/aider", true],
    ["python3 /opt/aider-tools/other.py", false],
    ["vim aider.md", false],
  ])("processMatch %j -> %s", (command, expected) => {
    expect(processMatches(command, AIDER_DESCRIPTOR.processMatch!)).toBe(expected);
  });
});
