// Hermetic tests for the Cline CLI runtime pieces: launch argv and posture,
// session-id validation, the on-disk session store (capture + resume check),
// and pane patterns against live cline 3.0.65 captures. No real binary.

import nodePath from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildClineArgv, validateClineSessionId, CLINE_LAUNCH_ENV, CLINE_MODEL_UNSUPPORTED_ERROR,
} from "../src/adapters/cli/cline/launch.js";
import {
  clineSessionsDir, clineSessionMetadataPath, checkClineResumeTarget, findClineSessionForLaunch,
  type ClineSessionFsOps,
} from "../src/adapters/cli/cline/sessions.js";
import { CLINE_READY_PATTERNS, CLINE_GATE_PATTERNS, CLINE_ERROR_PATTERNS } from "../src/adapters/cli/cline/patterns.js";
import { ATTENTION_REQUIRED_READINESS_CODES } from "../src/domain/runtime-adapter.js";

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

  it("an empty or shell-only pane is pending", () => {
    expect(classify("")).toBe("pending");
    expect(classify("user@host ~/work/repo % cline --auto-approve false\n")).toBe("pending");
  });
});
