// Hermetic tests for the Cursor CLI runtime adapter: the shared TUI CLI
// contract, launch argv and posture, the `agent` name collision guard, token
// format, pane patterns, version identity, and chat-store capture. No real
// `cursor-agent` binary.

import fs, { readFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { CURSOR_CHAT_SNAPSHOT_FILE, CURSOR_REGISTRATION, CURSOR_SPEC } from "../src/adapters/cli/cursor/index.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import {
  HARNESS_CWD, HARNESS_HOME, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps,
  memFs as harnessMemFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";
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

  it("capture takes exactly one new chat created at or after launch start, else null", () => {
    const launchStartedAt = new Date("2026-09-29T12:00:00Z");
    const after = (iso: string) => () => new Date(iso);
    const pick = (before: string[], afterIds: string[], createdAt: (id: string) => Date | null, start: Date | null = launchStartedAt) =>
      pickNewCursorChat({ before, after: afterIds, launchStartedAt: start ?? undefined, createdAt });
    expect(pick([OTHER_ID], [OTHER_ID, ID], after("2026-09-29T12:00:05Z"))).toBe(ID);
    expect(pick([OTHER_ID], [OTHER_ID, ID], after("2026-09-29T12:00:00Z"))).toBe(ID);
    // Nothing new, or two new chats (a pod-mate prompted too): ambiguous.
    expect(pick([OTHER_ID], [OTHER_ID], after("2026-09-29T12:00:05Z"))).toBeNull();
    expect(pick([], [OTHER_ID, ID], after("2026-09-29T12:00:05Z"))).toBeNull();
    // A chat that predates this launch but was missing from the snapshot
    // (created by the owner or a pod-mate before we started) is refused.
    expect(pick([], [ID], after("2026-09-29T11:59:59Z"))).toBeNull();
    // Unknown creation time or unknown launch start: refuse.
    expect(pick([], [ID], () => null)).toBeNull();
    expect(pick([], [ID], after("2026-09-29T12:00:05Z"), null)).toBeNull();
  });

  it("round-trips the snapshot and rejects a corrupt one", () => {
    expect(parseCursorChatSnapshot(serializeCursorChatSnapshot({ chatIds: [ID], configDir: "/c" }))).toEqual({ chatIds: [ID], configDir: "/c" });
    expect(parseCursorChatSnapshot(JSON.stringify({ chatIds: [ID] }))).toEqual({ chatIds: [ID] });
    expect(parseCursorChatSnapshot("{")).toBeNull();
    expect(parseCursorChatSnapshot(JSON.stringify({ chatIds: [1] }))).toBeNull();
  });
});

// ── adapter on the TUI CLI base ─────────────────────────────────────────────

const READY = fixture("cursor-idle-synth.txt");
const SEEDED_ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

function storeDbUnder(homedir: string, cwd: string, id: string): string {
  return nodePath.join(cursorChatsDirForCwd(cursorConfigDir(process.env, homedir), cwd), id, "store.db");
}

runTuiCliAdapterContract({
  registration: CURSOR_REGISTRATION,
  readyScreen: READY,
  // The wrapper execs node; the harness only needs a non-shell foreground.
  runningCommand: "node",
  gateScreens: [
    { screen: fixture("cursor-trust-synth.txt"), code: "trust_gate" },
    { screen: fixture("cursor-first-run.txt"), code: "login_required" },
  ],
  validResumeToken: SEEDED_ID,
  invalidResumeToken: "$(whoami)",
  missingResumeToken: MISSING_ID,
  modelExample: "gpt-5",
  seedResumeTarget: ({ fs: files, homedir, cwd, token }) => {
    const file = storeDbUnder(homedir, cwd, token);
    files.mkdirp(nodePath.dirname(file));
    files.writeFile(file, "");
  },
  // Cursor creates the chat lazily; seeding writes the chat store it creates.
  seedSession: ({ cwd, homedir }) => {
    const file = storeDbUnder(homedir, cwd, SEEDED_ID);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    return SEEDED_ID;
  },
});

describe("Cursor adapter launch", () => {
  const running = { command: "node", content: READY };
  const seatDir = nodePath.join(HARNESS_STATE_ROOT, "cursor", HARNESS_SESSION);

  function launch(files = harnessMemFs()) {
    const pane = mockTmux([atShell(), running]);
    const adapter = CURSOR_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files }));
    return { adapter, pane, files };
  }

  it("types cursor-agent with --trust and the model; floor has no --force", async () => {
    const { adapter, pane } = launch();
    const result = await adapter.launchHarness(harnessBinding({ model: "gpt-5" }), { name: "x" });
    expect(result).toEqual({ ok: true });
    expect(pane.typed[0]).toContain("'cursor-agent' '--trust' '--model' 'gpt-5'");
    expect(pane.typed[0]).not.toContain("--force");
  });

  it("full_bypass types --force", async () => {
    const { adapter, pane } = launch();
    await adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
    expect(pane.typed[0]).toContain("'--force'");
  });

  it("snapshots the chats that already exist for the cwd before launch", async () => {
    const files = harnessMemFs({ [storeDbUnder(HARNESS_HOME, HARNESS_CWD, SEEDED_ID)]: "" });
    await launch(files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(parseCursorChatSnapshot(files.files[nodePath.join(seatDir, CURSOR_CHAT_SNAPSHOT_FILE)]!))
      .toEqual({ chatIds: [SEEDED_ID], configDir: nodePath.join(HARNESS_HOME, ".cursor") });
  });

  it("resumes an existing chat by exact id", async () => {
    const files = harnessMemFs({ [storeDbUnder(HARNESS_HOME, HARNESS_CWD, SEEDED_ID)]: "" });
    const { adapter, pane } = launch(files);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: SEEDED_ID });
    expect(result).toMatchObject({ ok: true, resumeToken: SEEDED_ID, resumeType: "cursor_chat_id" });
    expect(pane.typed[0]).toContain(`'--resume' '${SEEDED_ID}'`);
  });

  function captureRig() {
    const root = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), "openrig-cursor-"));
    const homedir = nodePath.join(root, "home");
    const cwd = nodePath.join(root, "work");
    const seatStateDir = nodePath.join(root, "seat");
    fs.mkdirSync(seatStateDir, { recursive: true });
    const seed = (id: string, configDir = nodePath.join(homedir, ".cursor")) => {
      const file = nodePath.join(cursorChatsDirForCwd(configDir, cwd), id, "store.db");
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
    };
    const snapshot = (chatIds: string[], configDir?: string) =>
      fs.writeFileSync(nodePath.join(seatStateDir, CURSOR_CHAT_SNAPSHOT_FILE), serializeCursorChatSnapshot({ chatIds, configDir }));
    // null = the seat has no recorded launch start.
    const capture = (launchStartedAt: Date | null = new Date(Date.now() - 60_000)) => CURSOR_REGISTRATION.descriptor.captureResumeToken!(
      { sessionName: HARNESS_SESSION, cwd, seatStateDir, homedir, launchStartedAt: launchStartedAt ?? undefined }, {} as never,
    );
    return { root, homedir, cwd, seatStateDir, seed, snapshot, capture, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it("late capture ignores pre-launch chats and refuses to guess", () => {
    const rig = captureRig();
    try {
      expect(rig.capture()).toBeNull(); // no snapshot yet
      rig.seed(OTHER_ID);
      rig.snapshot([OTHER_ID]);
      expect(rig.capture()).toBeNull(); // nothing new since launch
      rig.seed(SEEDED_ID);
      expect(rig.capture()).toBe(SEEDED_ID);
      expect(rig.capture(null)).toBeNull(); // no launch start: refuse
      expect(rig.capture(new Date(Date.now() + 60_000))).toBeNull(); // created before this launch
    } finally {
      rig.cleanup();
    }
  });

  it("pod-mate race: a second new chat in the shared cwd makes capture refuse", () => {
    const rig = captureRig();
    try {
      rig.snapshot([]);
      rig.seed(SEEDED_ID); // this seat's chat
      rig.seed(ID); // a pod-mate in the same cwd prompted too
      expect(rig.capture()).toBeNull();
    } finally {
      rig.cleanup();
    }
  });

  it("owner race: a chat created before this launch is never taken, even if the snapshot missed it", () => {
    const rig = captureRig();
    try {
      rig.seed(OTHER_ID); // the owner's chat, created before the seat launched
      rig.snapshot([]); // a snapshot that did not see it (e.g. written first)
      expect(rig.capture(new Date(Date.now() + 1_000))).toBeNull();
    } finally {
      rig.cleanup();
    }
  });

  it("owner race, documented limit: an owner chat started after launch and before the seat prompts is taken", () => {
    // Cursor gives no per-process marker to tell these apart (see cursor.md,
    // Known limits). This pins the limit so a future change is deliberate.
    const rig = captureRig();
    try {
      rig.snapshot([]);
      rig.seed(OTHER_ID);
      expect(rig.capture()).toBe(OTHER_ID);
    } finally {
      rig.cleanup();
    }
  });

  it("capture and the resume check read the config dir the launch recorded, not the daemon env", async () => {
    const rig = captureRig();
    try {
      const configDir = nodePath.join(rig.root, "custom-cursor");
      rig.snapshot([], configDir);
      rig.seed(SEEDED_ID); // under ~/.cursor: not where this seat's Cursor writes
      expect(rig.capture()).toBeNull();
      rig.seed(ID, configDir);
      expect(rig.capture()).toBe(ID);
      const check = await CURSOR_SPEC.validateResumeTarget!({
        token: ID, cwd: rig.cwd, seatStateDir: rig.seatStateDir, homedir: rig.homedir,
        fs: createNodeFsOps(), binding: harnessBinding({ cwd: rig.cwd }),
      });
      expect(check).toEqual({ ok: true });
    } finally {
      rig.cleanup();
    }
  });

  it("prepareLaunch records the config dir from the launch env", async () => {
    const files = harnessMemFs();
    const pane = mockTmux([atShell(), running]);
    const adapter = CURSOR_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files, env: { CURSOR_CONFIG_DIR: "/data/cursor" } }));
    await adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(parseCursorChatSnapshot(files.files[nodePath.join(seatDir, CURSOR_CHAT_SNAPSHOT_FILE)]!)?.configDir).toBe("/data/cursor");
  });

  it("identifies itself by process argv, never by the node host", () => {
    const d = CURSOR_REGISTRATION.descriptor;
    expect(d.paneCommands ?? []).not.toContain("node");
    const matches = (command: string) => processMatches(command, d.processMatch!);
    expect(matches("/home/u/.local/bin/cursor-agent --use-system-ca /home/u/.local/share/cursor-agent/versions/2026.09.28-64d2043/index.js")).toBe(true);
    expect(matches("/home/u/.grok/bin/agent")).toBe(false);
    expect(matches("node /srv/tools/other.js --cwd /home/u/.local/bin/cursor-agent")).toBe(false);
    expect(d.reapProcessTreeOnStop).toBe(true);
  });
});

