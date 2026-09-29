// Hermetic tests for the Cursor CLI runtime pieces: launch argv and posture,
// the `agent` name collision guard, token format, pane patterns, version
// identity, and chat-store capture. No real `cursor-agent` binary.

import nodePath from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  buildCursorArgv, validateCursorChatId, CURSOR_READY_PATTERNS, CURSOR_GATE_PATTERNS,
  parseCursorVersion, verifyCursorVersionOutput, cursorConfigDir, cursorChatsDirForCwd,
  listCursorChatIds, cursorResumeTargetExists, pickNewCursorChat,
  serializeCursorChatSnapshot, parseCursorChatSnapshot, type ReadOnlyFs,
} from "../src/adapters/cli/cursor/cursor-cli.js";

const ID = "9e8f977d-c5b6-4f2b-82e5-2c1c1164b977";
const OTHER_ID = "1b2c3d4e-0000-4a4a-8b8b-123456789abc";
const CWD = "/home/user/work";
const CONFIG = "/home/user/.cursor";

function fixture(name: string): string {
  return readFileSync(nodePath.join(__dirname, "fixtures", "cli-panes", name), "utf-8");
}

function classify(pane: string): string {
  for (const gate of CURSOR_GATE_PATTERNS) if (gate.pattern.test(pane)) return gate.code;
  return CURSOR_READY_PATTERNS.some((p) => p.test(pane)) ? "ready" : "pending";
}

function memFs(files: Record<string, string>): ReadOnlyFs {
  return {
    exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    readFile: (p) => files[p] ?? "",
    listFiles: (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
  };
}

describe("buildCursorArgv", () => {
  it("fresh launch always trusts the workspace and passes the model; floor adds no approval flag", () => {
    expect(buildCursorArgv({ posture: "floor", model: "sonnet-4-thinking" }))
      .toEqual(["cursor-agent", "--trust", "--model", "sonnet-4-thinking"]);
  });

  it("full_bypass maps to --force and floor never passes it", () => {
    expect(buildCursorArgv({ posture: "full_bypass" })).toEqual(["cursor-agent", "--trust", "--force"]);
    const floor = buildCursorArgv({ posture: "floor" });
    expect(floor).not.toContain("--force");
    expect(floor).not.toContain("--yolo");
  });

  it("keeps bracketed model overrides as one argv element", () => {
    const model = "claude-opus-4-8[context=1m,effort=high]";
    expect(buildCursorArgv({ posture: "floor", model })).toEqual(["cursor-agent", "--trust", "--model", model]);
  });

  it("resume passes the exact chat id, never --continue", () => {
    const argv = buildCursorArgv({ posture: "floor", resumeToken: ID });
    expect(argv).toEqual(["cursor-agent", "--trust", "--resume", ID]);
    expect(argv).not.toContain("--continue");
  });

  it("refuses fork, malformed tokens, flag-like models, and the ambiguous `agent` binary", () => {
    expect(() => buildCursorArgv({ posture: "floor", forkSource: { kind: "native_id", value: ID } }))
      .toThrow(/no native fork primitive/);
    expect(() => buildCursorArgv({ posture: "floor", resumeToken: "$(whoami)" })).toThrow(/lowercase UUID/);
    expect(() => buildCursorArgv({ posture: "floor", model: "-f" })).toThrow(/must not start with '-'/);
    expect(() => buildCursorArgv({ posture: "floor", binary: "agent" })).toThrow(/not `agent`/);
    expect(() => buildCursorArgv({ posture: "floor", binary: "/home/user/.local/bin/agent" })).toThrow(/not `agent`/);
    expect(buildCursorArgv({ posture: "floor", binary: "/opt/cursor/cursor-agent" })[0]).toBe("/opt/cursor/cursor-agent");
  });
});

describe("validateCursorChatId", () => {
  it("accepts a lowercase UUID and rejects anything else without echoing it", () => {
    expect(validateCursorChatId(`${ID}\n`)).toEqual({ ok: true, token: ID });
    const bad = validateCursorChatId("SECRET-TOKEN-VALUE");
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("SECRET");
  });
});

describe("Cursor pane patterns", () => {
  it("the live unauthenticated first run is login_required", () => {
    expect(classify(fixture("cursor-first-run.txt"))).toBe("login_required");
  });

  it("the trust modal is a trust gate", () => {
    expect(classify(fixture("cursor-trust-synth.txt"))).toBe("trust_gate");
  });

  it("the composer placeholder is ready for a new chat and for follow-ups", () => {
    expect(classify(fixture("cursor-idle-synth.txt"))).toBe("ready");
    expect(classify(fixture("cursor-followup-synth.txt"))).toBe("ready");
  });

  it("gate codes are attention-required readiness codes", async () => {
    const { ATTENTION_REQUIRED_READINESS_CODES } = await import("../src/domain/runtime-adapter.js");
    for (const gate of CURSOR_GATE_PATTERNS) expect(ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)).toBe(true);
  });
});

describe("Cursor version identity", () => {
  it("accepts the Cursor release format and rejects Grok's `agent`", () => {
    expect(parseCursorVersion("2026.09.28-64d2043\n")).toBe("2026.09.28-64d2043");
    expect(parseCursorVersion("v2026.09.28-64d2043")).toBe("2026.09.28-64d2043");
    expect(verifyCursorVersionOutput("2026.09.28-64d2043")).toBeNull();
    expect(verifyCursorVersionOutput("grok 1.0.25 (f7e67d6988e2)")).toMatch(/did not report a Cursor CLI release/);
  });
});

describe("Cursor chat store", () => {
  it("resolves the config dir from CURSOR_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.cursor", () => {
    expect(cursorConfigDir({}, "/home/user")).toBe(CONFIG);
    expect(cursorConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/user")).toBe("/xdg/cursor");
    expect(cursorConfigDir({ CURSOR_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/xdg" }, "/home/user")).toBe("/c");
  });

  it("keys the chats dir by the md5 of the absolute cwd", () => {
    const digest = createHash("md5").update(CWD).digest("hex");
    expect(cursorChatsDirForCwd(CONFIG, `${CWD}/`)).toBe(`${CONFIG}/chats/${digest}`);
  });

  it("lists only chat ids that have a store.db", () => {
    const dir = cursorChatsDirForCwd(CONFIG, CWD);
    const fs = memFs({
      [`${dir}/${ID}/store.db`]: "",
      [`${dir}/${OTHER_ID}/meta.json`]: "",
      [`${dir}/not-a-uuid/store.db`]: "",
    });
    expect(listCursorChatIds(fs, dir)).toEqual([ID]);
    expect(listCursorChatIds(memFs({}), dir)).toEqual([]);
    expect(cursorResumeTargetExists(fs, dir, ID)).toBe(true);
    expect(cursorResumeTargetExists(fs, dir, OTHER_ID)).toBe(false);
    expect(cursorResumeTargetExists(fs, dir, "../../etc")).toBe(false);
  });

  it("capture takes exactly one new chat since the pre-launch snapshot, else null", () => {
    expect(pickNewCursorChat([OTHER_ID], [OTHER_ID, ID])).toBe(ID);
    expect(pickNewCursorChat([OTHER_ID], [OTHER_ID])).toBeNull();
    expect(pickNewCursorChat([], [OTHER_ID, ID])).toBeNull();
  });

  it("round-trips the snapshot and rejects a corrupt one", () => {
    expect(parseCursorChatSnapshot(serializeCursorChatSnapshot([ID]))).toEqual([ID]);
    expect(parseCursorChatSnapshot("{")).toBeNull();
    expect(parseCursorChatSnapshot(JSON.stringify({ chatIds: [1] }))).toBeNull();
  });
});
