// Hermetic tests for the Aider runtime pieces: launch argv and posture,
// per-seat chat history token rules (validation, capture, resume check), and
// pane patterns against live aider 0.86.2 captures. No real binary.

import nodePath from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildAiderArgv, aiderLaunchEnv, aiderSeatPaths, validateAiderChatHistoryToken,
  checkAiderResumeTarget, captureAiderChatHistory,
} from "../src/adapters/cli/aider/launch.js";
import { AIDER_READY_PATTERNS, AIDER_GATE_PATTERNS, AIDER_ERROR_PATTERNS } from "../src/adapters/cli/aider/patterns.js";
import { ATTENTION_REQUIRED_READINESS_CODES } from "../src/domain/runtime-adapter.js";

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
