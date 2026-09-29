// Hermetic tests for the Cline CLI runtime adapter: the shared TUI CLI
// contract suite, then cline specifics (launch argv and posture, the seat model
// refusal, session-id validation, the on-disk session store for capture and the
// resume check, and pane patterns against live cline 3.0.65 captures). No real
// binary, no network.

import nodePath from "node:path";
import os from "node:os";
import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildClineArgv, validateClineSessionId, CLINE_LAUNCH_ENV, CLINE_MODEL_UNSUPPORTED_ERROR,
} from "../src/adapters/cli/cline/launch.js";
import {
  clineLaunchEnv, clineSessionsDir, clineSessionMetadataPath, checkClineResumeTarget, findClineSessionForLaunch,
  type ClineSessionFsOps,
} from "../src/adapters/cli/cline/sessions.js";
import { CLINE_READY_PATTERNS, CLINE_GATE_PATTERNS, CLINE_ERROR_PATTERNS } from "../src/adapters/cli/cline/patterns.js";
import { ATTENTION_REQUIRED_READINESS_CODES } from "../src/domain/runtime-adapter.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import { CLINE_DESCRIPTOR, CLINE_REGISTRATION } from "../src/adapters/cli/cline/index.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { HARNESS_HOME, atShell, harnessBinding, harnessDeps, memFs as harnessMemFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-panes", "cline");
const pane = (name: string) => readFileSync(nodePath.join(FIXTURES, name), "utf8");

/** Same precedence as the TUI CLI base: gate, then error, then ready. */
function classify(content: string): string {
  for (const gate of CLINE_GATE_PATTERNS) if (gate.pattern.test(content)) return `gate:${gate.code}`;
  for (const error of CLINE_ERROR_PATTERNS) if (error.pattern.test(content)) return `error:${error.recovery ?? "none"}`;
  return CLINE_READY_PATTERNS.some((p) => p.test(content)) ? "ready" : "pending";
}

function memFs(files: Record<string, string>): ClineSessionFsOps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile: (p) => {
      reads.push(p);
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    listFiles: (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
  };
}

const HOME = "/home/user";
const SESSIONS = "/home/user/.cline/data/sessions";
const CWD = "/work/repo";
const LAUNCH = new Date("2026-09-29T17:16:00.000Z");

function session(id: string, over: Record<string, unknown> = {}): Record<string, string> {
  const meta = {
    version: 1, session_id: id, source: "cli", pid: 4242, started_at: new Date(Number(id.split("_")[0])).toISOString(),
    interactive: true, cwd: CWD, workspace_root: CWD, ...over,
  };
  return {
    [clineSessionMetadataPath(SESSIONS, id)]: JSON.stringify(meta),
    [`${SESSIONS}/${id}/${id}.messages.json`]: "[]",
  };
}

const AFTER = `${LAUNCH.getTime() + 30_000}_lovnf`;
const LATER = `${LAUNCH.getTime() + 90_000}_k2p9q`;
const BEFORE = `${LAUNCH.getTime() - 3_600_000}_old00`;

describe("cline launch argv", () => {
  it("floor passes --auto-approve false explicitly (cline defaults it to true)", () => {
    expect(buildClineArgv({ posture: "floor" })).toEqual(["cline", "--auto-approve", "false"]);
  });

  it("full_bypass maps to --auto-approve true and never the headless --yolo", () => {
    const argv = buildClineArgv({ posture: "full_bypass" });
    expect(argv).toEqual(["cline", "--auto-approve", "true"]);
    expect(argv).not.toContain("--yolo");
    expect(argv).not.toContain("-y");
  });

  it("refuses a seat model, because cline -m rewrites the operator's default", () => {
    expect(() => buildClineArgv({ posture: "floor", model: "anthropic/claude-sonnet-4.5" })).toThrow(CLINE_MODEL_UNSUPPORTED_ERROR);
    expect(() => buildClineArgv({ posture: "full_bypass", model: "x", resumeToken: "1790702191676_lovnf" })).toThrow(CLINE_MODEL_UNSUPPORTED_ERROR);
  });

  it("never passes -m when the seat has no model", () => {
    for (const model of [undefined, null, "", "   "]) {
      const argv = buildClineArgv({ posture: "floor", model });
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain("--model");
    }
  });

  it("resumes with --id and never adds a positional prompt (which would run one-shot)", () => {
    expect(buildClineArgv({ posture: "floor", resumeToken: " 1790702191676_lovnf " }))
      .toEqual(["cline", "--auto-approve", "false", "--id", "1790702191676_lovnf"]);
  });

  it("refuses fork clearly", () => {
    expect(() => buildClineArgv({ posture: "floor", forkSource: { kind: "native_id", value: "x" } }))
      .toThrow(/no native fork primitive/);
  });

  it("refuses a malformed resume token without echoing it", () => {
    expect(() => buildClineArgv({ posture: "floor", resumeToken: "abc; rm -rf ~" })).toThrow(/disallowed characters/);
    try {
      buildClineArgv({ posture: "floor", resumeToken: "abc; rm -rf ~" });
    } catch (err) {
      expect((err as Error).message).not.toContain("rm -rf");
    }
  });

  it("launch env suppresses the notice modal and auto-update", () => {
    expect(CLINE_LAUNCH_ENV).toEqual({ CLINE_DISABLE_CLINE_PASS_NOTICE: "1", CLINE_NO_AUTO_UPDATE: "1" });
  });
});

describe("cline session id validation", () => {
  it("accepts the observed id shape and trims", () => {
    expect(validateClineSessionId(" 1790702191676_lovnf\n")).toEqual({ ok: true, token: "1790702191676_lovnf" });
  });

  it.each(["", "   ", "a/b", "../x", "..", "a b", "x".repeat(201), "id$(whoami)"])("rejects %j", (raw) => {
    expect(validateClineSessionId(raw).ok).toBe(false);
  });
});

describe("cline sessions dir", () => {
  it("follows cline's own resolution order", () => {
    expect(clineSessionsDir({}, HOME)).toBe(SESSIONS);
    expect(clineSessionsDir({ CLINE_DIR: "/c" }, HOME)).toBe("/c/data/sessions");
    expect(clineSessionsDir({ CLINE_DIR: "/c", CLINE_DATA_DIR: "/d" }, HOME)).toBe("/d/sessions");
    expect(clineSessionsDir({ CLINE_DATA_DIR: "/d", CLINE_SESSION_DATA_DIR: "/s" }, HOME)).toBe("/s");
    expect(clineSessionsDir({ CLINE_DIR: "  " }, HOME)).toBe(SESSIONS);
  });
});

describe("cline resume-token capture", () => {
  const capture = (files: Record<string, string>, cwd = CWD) =>
    findClineSessionForLaunch({ fs: memFs(files), sessionsDir: SESSIONS, cwd, launchStartedAt: LAUNCH });

  it("finds the single interactive session started in the seat cwd after launch", () => {
    expect(capture({ ...session(BEFORE), ...session(AFTER) })).toEqual({ ok: true, sessionId: AFTER });
  });

  it("returns no_match before the first prompt (sessions are created lazily)", () => {
    expect(capture({ ...session(BEFORE) })).toEqual({ ok: false, reason: "no_match" });
  });

  it("returns no_store when cline has never run", () => {
    expect(capture({})).toEqual({ ok: false, reason: "no_store" });
  });

  it("refuses to guess when several sessions match the same cwd", () => {
    expect(capture({ ...session(AFTER), ...session(LATER) })).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("ignores other cwds, headless runs, non-cli sources, and malformed metadata", () => {
    const other = `${LAUNCH.getTime() + 1_000}_other`;
    const headless = `${LAUNCH.getTime() + 2_000}_headl`;
    const acp = `${LAUNCH.getTime() + 3_000}_acp00`;
    const broken = `${LAUNCH.getTime() + 4_000}_brokn`;
    const files = {
      ...session(AFTER),
      ...session(other, { cwd: "/work/other" }),
      ...session(headless, { interactive: false }),
      ...session(acp, { source: "acp" }),
      [clineSessionMetadataPath(SESSIONS, broken)]: "{not json",
    };
    expect(capture(files)).toEqual({ ok: true, sessionId: AFTER });
  });

  it("matches a cwd given with a trailing slash or dot segments", () => {
    expect(capture(session(AFTER), "/work/./repo/")).toEqual({ ok: true, sessionId: AFTER });
  });

  it("skips sessions older than the launch by id prefix without reading them", () => {
    const fs = memFs({ ...session(BEFORE), ...session(AFTER) });
    findClineSessionForLaunch({ fs, sessionsDir: SESSIONS, cwd: CWD, launchStartedAt: LAUNCH });
    expect(fs.reads.some((p) => p.includes(BEFORE))).toBe(false);
  });

  it("tolerates small clock skew between the daemon and the cline hub", () => {
    const skewed = `${LAUNCH.getTime() - 2_000}_skew0`;
    expect(capture(session(skewed))).toEqual({ ok: true, sessionId: skewed });
  });

  it("rejects metadata whose session_id disagrees with its directory", () => {
    expect(capture(session(AFTER, { session_id: "someone_else" }))).toEqual({ ok: false, reason: "no_match" });
  });

  it("never throws when listing fails", () => {
    const fs: ClineSessionFsOps = { readFile: () => "", exists: () => true, listFiles: () => { throw new Error("EACCES"); } };
    expect(findClineSessionForLaunch({ fs, sessionsDir: SESSIONS, cwd: CWD, launchStartedAt: LAUNCH }))
      .toEqual({ ok: false, reason: "no_store" });
  });
});

describe("cline resume target check", () => {
  it("accepts a session whose metadata still exists", () => {
    expect(checkClineResumeTarget(AFTER, { fs: memFs(session(AFTER)), env: {}, homedir: HOME })).toEqual({ ok: true });
  });

  it("maps a vanished session to retry_fresh, never a silent fresh start", () => {
    expect(checkClineResumeTarget(AFTER, { fs: memFs({}), env: {}, homedir: HOME }))
      .toEqual({ ok: false, error: "the persisted cline session no longer exists", recovery: "retry_fresh" });
  });

  it("maps a malformed token to retry_fresh", () => {
    expect(checkClineResumeTarget("../etc", { fs: memFs({}), env: {}, homedir: HOME })).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });
});

describe("cline pane patterns (live captures)", () => {
  it("gate codes are attention-required readiness codes", () => {
    for (const gate of CLINE_GATE_PATTERNS) expect(ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)).toBe(true);
  });

  it.each([
    ["home-ready.txt", "ready"],
    ["chat-ready.txt", "ready"],
    ["resume-unknown-session-after-toast.txt", "ready"],
    ["login-required.txt", "gate:login_required"],
    ["announcement-modal.txt", "gate:update_gate"],
    ["resume-unknown-session.txt", "error:retry_fresh"],
  ])("%s -> %s", (fixture, expected) => {
    expect(classify(pane(fixture))).toBe(expected);
  });

  it.each([
    ["home-ready-80x24.txt", "ready"],
    ["resumed-chat-80x24.txt", "ready"],
    ["login-required-80x24.txt", "gate:login_required"],
    ["announcement-modal-80x24.txt", "gate:update_gate"],
    ["resume-unknown-session-80x24.txt", "error:retry_fresh"],
  ])("live 80x24 capture with a long cwd %s -> %s", (fixture, expected) => {
    expect(classify(pane(fixture))).toBe(expected);
  });

  it("an empty or shell-only pane is pending", () => {
    expect(classify("")).toBe("pending");
    expect(classify("user@host ~/work/repo % cline --auto-approve false\n")).toBe("pending");
  });
});

// ── adapter (TUI CLI base + contract) ───────────────────────────────────────

const VALID_ID = "1790702191676_lovnf";
const HARNESS_SESSIONS = `${HARNESS_HOME}/.cline/data/sessions`;

runTuiCliAdapterContract({
  registration: CLINE_REGISTRATION,
  readyScreen: pane("home-ready.txt"),
  runningCommand: "node",
  gateScreens: [
    { screen: pane("login-required.txt"), code: "login_required" },
    { screen: pane("announcement-modal.txt"), code: "update_gate" },
  ],
  errorScreens: [pane("resume-unknown-session.txt")],
  earlyExit: { screen: "zsh: command not found: cline", recovery: "attention_required" },
  validResumeToken: VALID_ID,
  invalidResumeToken: "../escape",
  missingResumeToken: "1790000000000_nopex",
  seedResumeTarget: ({ fs: seatFs, homedir, token }) => {
    const dir = nodePath.join(homedir, ".cline", "data", "sessions", token);
    seatFs.mkdirp(dir);
    seatFs.writeFile(nodePath.join(dir, `${token}.json`), "{}");
  },
  // A seat model is refused (see "cline seat model" below).
  passesModel: false,
  seedSession: ({ cwd, homedir }) => {
    const id = `${Date.now()}_seed0`;
    const dir = nodePath.join(homedir, ".cline", "data", "sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, `${id}.json`), JSON.stringify({
      version: 1, session_id: id, source: "cli", pid: 4242, started_at: new Date().toISOString(),
      interactive: true, status: "idle", cwd, workspace_root: cwd,
    }));
    fs.writeFileSync(nodePath.join(dir, `${id}.messages.json`), "[]");
    return id;
  },
});

describe("cline adapter", () => {
  function launchRig(frames = [{ command: "node", content: pane("home-ready.txt") }], env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}) {
    const tmuxPane = mockTmux([atShell(), ...frames]);
    const adapter = CLINE_REGISTRATION.createAdapter(harnessDeps({ tmux: tmuxPane.tmux, fsOps: harnessMemFs(files), env }));
    return { adapter, pane: tmuxPane };
  }

  it("is registered under runtime: cline", () => {
    expect(getRuntimeDescriptor("cline")).toBe(CLINE_DESCRIPTOR);
  });

  it("types the exact floor launch with the additive launch env", async () => {
    const { adapter, pane: p } = launchRig();
    expect((await adapter.launchHarness(harnessBinding(), { name: "x" })).ok).toBe(true);
    expect(p.typed).toEqual([
      "exec env 'CLINE_DISABLE_CLINE_PASS_NOTICE=1' 'CLINE_NO_AUTO_UPDATE=1' 'cline' '--auto-approve' 'false'",
    ]);
  });

  it("types --auto-approve true under OPENRIG_YOLO and a full_bypass policy", async () => {
    for (const [binding, env] of [[harnessBinding(), { OPENRIG_YOLO: "1" }], [harnessBinding({ launchPosture: "full_bypass" }), {}]] as const) {
      const { adapter, pane: p } = launchRig(undefined, env);
      await adapter.launchHarness(binding, { name: "x" });
      expect(p.typed[0]).toContain("'--auto-approve' 'true'");
    }
  });

  it("refuses a seat model before typing anything", async () => {
    const { adapter, pane: p } = launchRig();
    const result = await adapter.launchHarness(harnessBinding({ model: "claude-sonnet-4-5" }), { name: "x" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(CLINE_MODEL_UNSUPPORTED_ERROR) });
    expect(p.typed).toEqual([]);
  });

  it("resumes with --id when the session is still on disk", async () => {
    const files = { [`${HARNESS_SESSIONS}/${VALID_ID}/${VALID_ID}.json`]: "{}" };
    const { adapter, pane: p } = launchRig(undefined, {}, files);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID_ID });
    expect(result).toMatchObject({ ok: true, resumeToken: VALID_ID, resumeType: "cline_session_id" });
    expect(p.typed[0]).toContain(`'--id' '${VALID_ID}'`);
  });

  it("the resume check looks where the launched cline writes (adapter env plus launch env)", async () => {
    const files = { [`/data/cline/sessions/${VALID_ID}/${VALID_ID}.json`]: "{}" };
    const { adapter, pane: p } = launchRig(undefined, { CLINE_DATA_DIR: "/data/cline" }, files);
    expect(await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID_ID })).toMatchObject({ ok: true });
    expect(p.typed[0]).toContain(`'--id' '${VALID_ID}'`);
    const home = launchRig(undefined, {}, files);
    expect(await home.adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID_ID })).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect(clineLaunchEnv({ CLINE_DATA_DIR: "/d" })).toMatchObject({ CLINE_DATA_DIR: "/d", CLINE_NO_AUTO_UPDATE: "1" });
  });

  it("maps the in-TUI unknown-session error to retry_fresh", async () => {
    const files = { [`${HARNESS_SESSIONS}/${VALID_ID}/${VALID_ID}.json`]: "{}" };
    const { adapter } = launchRig([{ command: "node", content: pane("resume-unknown-session.txt") }], {}, files);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID_ID });
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });

  it("projects skills into <cwd>/.cline/skills", () => {
    expect(CLINE_DESCRIPTOR.skillsDir!({ cwd: "/work/repo" })).toBe("/work/repo/.cline/skills");
  });

  it("capture is not session-scoped, so the sibling-seat guard applies", () => {
    expect(CLINE_DESCRIPTOR.captureIsSessionScoped ?? false).toBe(false);
  });

  it("does not reap the pane process tree (the shared hub daemon lives there)", () => {
    expect(CLINE_DESCRIPTOR.reapProcessTreeOnStop).toBe(false);
    expect(CLINE_DESCRIPTOR.paneCommands).toBeUndefined();
  });

  it.each([
    // Live process tree of a pane running cline 3.0.65 (npm, darwin-arm64).
    ["node /usr/local/lib/node_modules/cline/bin/cline --auto-approve false", true],
    ["/usr/local/lib/node_modules/cline/bin/.cline --auto-approve false", true],
    ["/opt/homebrew/bin/cline --auto-approve false", true],
    ["node /opt/tools/clinepass/bin/server.js", false],
    ["node /usr/lib/node_modules/openrig/dist/index.js --cwd /work/cline", false],
    ["vim cline.md", false],
  ])("processMatch %j -> %s", (command, expected) => {
    expect(processMatches(command, CLINE_DESCRIPTOR.processMatch!)).toBe(expected);
  });

  it("late capture needs the launch time and returns null otherwise", () => {
    const capture = CLINE_DESCRIPTOR.captureResumeToken!;
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-cline-"));
    try {
      const input = { sessionName: "s", cwd: "/work/repo", seatStateDir: nodePath.join(tmp, "seat"), homedir: tmp };
      expect(capture(input, {})).toBeNull();
      expect(capture({ ...input, launchStartedAt: new Date() }, {})).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
