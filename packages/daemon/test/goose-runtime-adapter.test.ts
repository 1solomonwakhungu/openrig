// Hermetic tests for the Goose runtime adapter: the shared TUI CLI contract,
// launch argv and posture env, token format, pane patterns against live 80x24
// captures, and the read-only sessions database capture. No real `goose`.

import fs, { readFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GOOSE_REGISTRATION, GOOSE_SEAT_FILE, GOOSE_SPEC } from "../src/adapters/cli/goose/index.js";
import {
  GOOSE_ERROR_PATTERNS, GOOSE_GATE_PATTERNS, GOOSE_PROCESS_MATCH, GOOSE_READY_PATTERNS,
  GOOSE_TRANSCRIPT_SOURCE, GOOSE_USAGE_SOURCE, buildGooseArgv, captureGooseSessionId, readGooseTranscript, readGooseUsage, gooseLaunchEnv, gooseSessionPresence, gooseSessionsDbPath, gooseTimestamp,
  parseGooseVersion, validateGooseSessionId, verifyGooseVersionOutput,
} from "../src/adapters/cli/goose/goose-cli.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { activityMarkers } from "../src/adapters/cli/activity-markers.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import {
  HARNESS_HOME, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";

const ID = "20261003_3";
const MISSING_ID = "20261003_99";

function fixture(name: string): string {
  return readFileSync(nodePath.join(__dirname, "fixtures", "cli-panes", name), "utf-8");
}

const READY = fixture("goose-80-ready.txt");

/** goose's sessions table, reduced to the columns the adapter reads. */
function createSessionsDb(dbPath: string): Database.Database {
  fs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
    session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER,
    accumulated_cache_read_tokens INTEGER, accumulated_cache_write_tokens INTEGER, accumulated_cost REAL,
    provider_name TEXT, model_config_json TEXT)`);
  return db;
}

function addSession(dbPath: string, row: { id: string; name: string; userSet: boolean; cwd: string; createdAt: string; type?: string }): void {
  const db = createSessionsDb(dbPath);
  try {
    db.prepare("INSERT INTO sessions (id, name, user_set_name, session_type, working_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.userSet ? 1 : 0, row.type ?? "user", row.cwd, row.createdAt);
  } finally {
    db.close();
  }
}

/** The database a seat records, else where goose keeps it for this process. */
function seatDb(seatStateDir: string, homedir: string): string {
  const file = nodePath.join(seatStateDir, GOOSE_SEAT_FILE);
  if (fs.existsSync(file)) return (JSON.parse(fs.readFileSync(file, "utf-8")) as { sessionsDb: string }).sessionsDb;
  return gooseSessionsDbPath(process.env, homedir);
}

describe("buildGooseArgv", () => {
  it("fresh launch names the session after the seat and passes the model", () => {
    expect(buildGooseArgv({ seatName: "dev@rig", model: "claude-sonnet-4-5" }))
      .toEqual(["goose", "session", "--name", "dev@rig", "--model", "claude-sonnet-4-5"]);
  });

  it("resume uses the exact id, never bare --resume", () => {
    expect(buildGooseArgv({ seatName: "dev@rig", resumeToken: ID })).toEqual(["goose", "session", "--resume", "--session-id", ID]);
  });

  it("fork copies the parent by id, without --name (goose refuses --name with --session-id)", () => {
    const argv = buildGooseArgv({ seatName: "dev@rig", forkSource: { kind: "native_id", value: ID } });
    expect(argv).toEqual(["goose", "session", "--resume", "--session-id", ID, "--fork"]);
    expect(argv).not.toContain("--name");
  });

  it("refuses malformed tokens, unsupported fork sources, mixes, and dash-led values", () => {
    expect(() => buildGooseArgv({ seatName: "s", resumeToken: "1; rm -rf /" })).toThrow(/YYYYMMDD_N/);
    expect(() => buildGooseArgv({ seatName: "s", resumeToken: ID, forkSource: { kind: "native_id", value: ID } })).toThrow(/mutually exclusive/);
    expect(() => buildGooseArgv({ seatName: "s", forkSource: { kind: "last" } })).toThrow(/native session id/);
    expect(() => buildGooseArgv({ seatName: "s", forkSource: { kind: "native_id", value: "nope" } })).toThrow(/goose fork/);
    expect(() => buildGooseArgv({ seatName: "-x" })).toThrow(/seat name/);
    expect(() => buildGooseArgv({ seatName: "" })).toThrow(/seat name/);
    expect(() => buildGooseArgv({ seatName: "s", model: "--provider" })).toThrow(/model/);
  });

  it("posture travels in the env: the floor asks before risky tools, full_bypass never asks, telemetry always off", () => {
    expect(gooseLaunchEnv("floor")).toEqual({ GOOSE_TELEMETRY_OFF: "1", GOOSE_MODE: "smart_approve" });
    expect(gooseLaunchEnv("full_bypass")).toEqual({ GOOSE_TELEMETRY_OFF: "1", GOOSE_MODE: "auto" });
  });
});

describe("identity", () => {
  it("validates YYYYMMDD_N ids without quoting the token", () => {
    expect(validateGooseSessionId(` ${ID} `)).toEqual({ ok: true, token: ID });
    const bad = validateGooseSessionId("secret-ish");
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("secret-ish");
  });

  it("reads `goose --version` output (live: ' 1.53.0')", () => {
    expect(parseGooseVersion(" 1.53.0\n")).toBe("1.53.0");
    expect(verifyGooseVersionOutput(" 1.53.0\n")).toBeNull();
    expect(verifyGooseVersionOutput("Goose Browser 2.0")).toMatch(/goose/);
  });

  it("matches the goose binary, not other programs", () => {
    expect(GOOSE_PROCESS_MATCH.test("/opt/homebrew/bin/goose")).toBe(true);
    expect(GOOSE_PROCESS_MATCH.test("goose")).toBe(true);
    expect(GOOSE_PROCESS_MATCH.test("/usr/bin/mongoose")).toBe(false);
    expect(processMatches("/usr/local/bin/goose session --name dev@rig", GOOSE_PROCESS_MATCH)).toBe(true);
  });

  it("locates the sessions database like `goose info` does", () => {
    expect(gooseSessionsDbPath({}, "/h")).toBe("/h/.local/share/goose/sessions/sessions.db");
    expect(gooseSessionsDbPath({ XDG_DATA_HOME: "/x" }, "/h")).toBe("/x/goose/sessions/sessions.db");
    expect(gooseSessionsDbPath({ XDG_DATA_HOME: "relative" }, "/h")).toBe("/h/.local/share/goose/sessions/sessions.db");
    expect(gooseSessionsDbPath({ GOOSE_PATH_ROOT: "/g", XDG_DATA_HOME: "/x" }, "/h")).toBe("/g/data/sessions/sessions.db");
  });
});

describe("pane patterns (live 80x24 captures, goose 1.53.0)", () => {
  function classify(pane: string): string {
    for (const gate of GOOSE_GATE_PATTERNS) if (gate.pattern.test(pane)) return gate.code;
    for (const error of GOOSE_ERROR_PATTERNS) if (error.pattern.test(pane)) return error.code ?? "runtime_error";
    return GOOSE_READY_PATTERNS.some((p) => p.test(pane)) ? "ready" : "pending";
  }

  it("classifies every captured screen", () => {
    expect(classify(READY)).toBe("ready");
    expect(classify(fixture("goose-80-telemetry.txt"))).toBe("startup_dialog");
    expect(classify(fixture("goose-80-resumed.txt"))).toBe("startup_dialog");
    expect(classify(fixture("goose-80-no-provider.txt"))).toBe("login_required");
    expect(classify(fixture("goose-80-no-key.txt"))).toBe("login_required");
    expect(classify(fixture("goose-80-resume-missing.txt"))).toBe("session_missing");
  });

  it("a missing resume target recovers by retry_fresh; sign-in errors need the operator", () => {
    const recoveryOf = (name: string) => GOOSE_ERROR_PATTERNS.find((e) => e.pattern.test(fixture(name)))?.recovery;
    expect(recoveryOf("goose-80-resume-missing.txt")).toBe("retry_fresh");
    expect(recoveryOf("goose-80-no-provider.txt")).toBeUndefined();
  });

  it("reads the working spinner as busy and the idle screen as not", async () => {
    expect(activityMarkers("goose").busyPatterns.some((p) => p.test(READY))).toBe(false);
    const working = `${READY}\n  ◒ Pondering the request... (Ctrl+C to interrupt)`;
    const adapter = new TuiCliRuntimeAdapter(GOOSE_SPEC, harnessDeps({ tmux: mockTmux([{ command: "goose", content: working }]).tmux, fsOps: memFs() }));
    expect(await adapter.classifyActivity(harnessBinding())).toBe("working");
  });
});

describe("captureGooseSessionId", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });
  const LAUNCH = new Date("2026-10-03T03:40:00.500Z");
  const CWD = "/home/user/work";

  function dbFile(): string {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-goose-"));
    return nodePath.join(root, "sessions.db");
  }
  const deps = { exists: (p: string) => fs.existsSync(p) };

  it("fresh: the newest session named after the seat, in its cwd, since the launch (second precision)", () => {
    const db = dbFile();
    addSession(db, { id: "20261003_1", name: "dev@rig", userSet: true, cwd: CWD, createdAt: "2026-10-03 03:30:00" }); // before launch
    addSession(db, { id: "20261003_2", name: "qa@rig", userSet: true, cwd: CWD, createdAt: "2026-10-03 03:40:01" }); // pod-mate
    addSession(db, { id: "20261003_3", name: "dev@rig", userSet: true, cwd: "/elsewhere", createdAt: "2026-10-03 03:40:01" });
    addSession(db, { id: "20261003_4", name: "dev@rig", userSet: true, cwd: CWD, createdAt: "2026-10-03 03:40:00" }); // same second
    expect(gooseTimestamp(LAUNCH)).toBe("2026-10-03 03:40:00");
    expect(captureGooseSessionId({ dbPath: db, deps, seatName: "dev@rig", cwd: CWD, launchStartedAt: LAUNCH })).toBe("20261003_4");
    expect(captureGooseSessionId({ dbPath: db, deps, seatName: "qa@rig", cwd: CWD, launchStartedAt: LAUNCH })).toBe("20261003_2");
  });

  it("fresh: nothing without a launch time, a database, or a matching session", () => {
    const db = dbFile();
    expect(captureGooseSessionId({ dbPath: db, deps, seatName: "dev@rig", cwd: CWD, launchStartedAt: LAUNCH })).toBeNull();
    addSession(db, { id: "20261003_1", name: "dev@rig", userSet: false, cwd: CWD, createdAt: "2026-10-03 03:41:00" }); // not user-set
    addSession(db, { id: "20261003_2", name: "dev@rig", userSet: true, cwd: CWD, createdAt: "2026-10-03 03:41:00", type: "sub_agent" });
    expect(captureGooseSessionId({ dbPath: db, deps, seatName: "dev@rig", cwd: CWD, launchStartedAt: LAUNCH })).toBeNull();
    expect(captureGooseSessionId({ dbPath: db, deps, seatName: "dev@rig", cwd: CWD })).toBeNull();
  });

  it("fork: the one unnamed copy of the parent since the launch; several copies are ambiguous", () => {
    const db = dbFile();
    addSession(db, { id: "20261002_7", name: "parent@rig", userSet: true, cwd: CWD, createdAt: "2026-10-02 10:00:00" });
    addSession(db, { id: "20261003_5", name: "parent@rig", userSet: false, cwd: CWD, createdAt: "2026-10-03 03:40:02" });
    const input = { dbPath: db, deps, seatName: "child@rig", cwd: CWD, launchStartedAt: LAUNCH, forkParent: "20261002_7" };
    expect(captureGooseSessionId(input)).toBe("20261003_5");
    addSession(db, { id: "20261003_6", name: "parent@rig", userSet: false, cwd: CWD, createdAt: "2026-10-03 03:40:03" });
    expect(captureGooseSessionId(input)).toBeNull();
    expect(captureGooseSessionId({ ...input, forkParent: "20261001_1" })).toBeNull(); // parent gone
  });

  it("never throws on an unreadable database", () => {
    const db = dbFile();
    fs.writeFileSync(db, "not a database");
    expect(captureGooseSessionId({ dbPath: db, deps, seatName: "dev@rig", cwd: CWD, launchStartedAt: LAUNCH })).toBeNull();
    expect(gooseSessionPresence(db, ID, deps)).toBe("unknown");
  });

  it("resume target presence: present, missing row, missing database", () => {
    const db = dbFile();
    addSession(db, { id: ID, name: "dev@rig", userSet: true, cwd: CWD, createdAt: "2026-10-03 03:38:34" });
    expect(gooseSessionPresence(db, ID, deps)).toBe("present");
    expect(gooseSessionPresence(db, MISSING_ID, deps)).toBe("missing");
    expect(gooseSessionPresence(`${db}.absent`, ID, deps)).toBe("missing");
  });
});

describe("readGooseTranscript (feature 5)", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });
  const deps = { exists: (p: string) => fs.existsSync(p) };

  /** messages rows in goose 1.53.0's format (MessageContentBlock serde,
   *  tool_result_serde), synthesized from source, not captured live. */
  function dbWithMessages(): string {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-goose-tx-"));
    const dbPath = nodePath.join(root, "sessions.db");
    addSession(dbPath, { id: ID, name: "dev@rig", userSet: true, cwd: "/w", createdAt: "2026-10-03 03:38:34" });
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT)`);
    const add = db.prepare("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)");
    const t = Date.parse("2026-10-03T03:40:00.000Z") / 1000;
    const visible = JSON.stringify({ userVisible: true, agentVisible: true });
    add.run("m1", ID, "user", JSON.stringify([{ type: "text", text: "Add a health route." }]), t, visible);
    add.run("m2", ID, "assistant", JSON.stringify([
      { type: "thinking", thinking: "hidden plan", signature: "s" },
      { type: "text", text: "Adding GET /health." },
      { type: "toolRequest", id: "c1", toolCall: { status: "success", value: { name: "developer__text_editor", arguments: { command: "write", path: "src/health.ts" } } } },
    ]), t + 5, visible);
    add.run("m3", ID, "user", JSON.stringify([
      { type: "toolResponse", id: "c1", toolResult: { status: "success", value: { content: [{ type: "text", text: "Wrote src/health.ts" }], isError: false } } },
      { type: "toolResponse", id: "c2", toolResult: { status: "error", error: "-32602: bad arguments" } },
    ]), t + 6, visible);
    add.run("m4", ID, "user", JSON.stringify([{ type: "text", text: "internal summary" }]), t + 7, JSON.stringify({ userVisible: false, agentVisible: true }));
    add.run("m5", "20261003_8", "user", JSON.stringify([{ type: "text", text: "another session" }]), t + 8, visible);
    db.close();
    return dbPath;
  }

  it("maps text, tool requests and responses, and leaves thinking and hidden messages out", () => {
    expect(readGooseTranscript({ dbPath: dbWithMessages(), deps, sessionId: ID })).toEqual({
      source: GOOSE_TRANSCRIPT_SOURCE,
      entries: [
        { role: "user", text: "Add a health route.", at: "2026-10-03T03:40:00.000Z" },
        { role: "assistant", text: "Adding GET /health.", at: "2026-10-03T03:40:05.000Z" },
        { role: "tool", text: 'developer__text_editor({"command":"write","path":"src/health.ts"})', at: "2026-10-03T03:40:05.000Z" },
        { role: "tool", text: "Wrote src/health.ts", at: "2026-10-03T03:40:06.000Z" },
        { role: "tool", text: "error: -32602: bad arguments", at: "2026-10-03T03:40:06.000Z" },
      ],
    });
  });

  it("filters by since and is null without a valid session id or a database", () => {
    const dbPath = dbWithMessages();
    expect(readGooseTranscript({ dbPath, deps, sessionId: ID, since: new Date("2026-10-03T03:40:06.000Z") })?.entries).toHaveLength(2);
    // The bound is in the SQL: the newest messages, in conversation order.
    expect(readGooseTranscript({ dbPath, deps, sessionId: ID, maxMessages: 2 })?.entries.map((e) => e.text))
      .toEqual(["Wrote src/health.ts", "error: -32602: bad arguments"]);
    expect(readGooseTranscript({ dbPath, deps, sessionId: null })).toBeNull();
    expect(readGooseTranscript({ dbPath, deps, sessionId: "x; drop" })).toBeNull();
    expect(readGooseTranscript({ dbPath: `${dbPath}.absent`, deps, sessionId: ID })).toBeNull();
    expect(typeof GOOSE_REGISTRATION.descriptor.readTranscript).toBe("function");
  });
});

describe("readGooseUsage (feature 1)", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });
  const deps = { exists: (p: string) => fs.existsSync(p) };

  /** A session row as goose 1.53.0 keeps it after a few turns (schema from a
   *  live sessions.db; the numbers are illustrative). */
  function dbWithUsage(): string {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-goose-usage-"));
    const dbPath = nodePath.join(root, "sessions.db");
    addSession(dbPath, { id: ID, name: "dev@rig", userSet: true, cwd: "/w", createdAt: "2026-10-03 03:38:34" });
    const db = new Database(dbPath);
    db.prepare(`UPDATE sessions SET updated_at = ?, total_tokens = ?, accumulated_input_tokens = ?, accumulated_output_tokens = ?,
      accumulated_cache_read_tokens = ?, accumulated_cache_write_tokens = ?, accumulated_cost = ?, provider_name = ?, model_config_json = ?
      WHERE id = ?`).run("2026-10-03 04:10:00", 18_400, 52_000, 6_100, 31_000, 2_200, 0.4125, "anthropic",
      JSON.stringify({ model_name: "claude-sonnet-4-5", temperature: null, max_tokens: null, toolshim: false, toolshim_model: null }), ID);
    db.close();
    return dbPath;
  }

  it("reads the session totals, goose's own cost, the context fill, and the model", () => {
    expect(readGooseUsage({ dbPath: dbWithUsage(), deps, sessionId: ID })).toEqual({
      inputTokens: 52_000, outputTokens: 6_100, cacheReadTokens: 31_000, cacheWriteTokens: 2_200,
      costUsd: 0.4125, costSource: "cli_reported", contextUsedTokens: 18_400,
      model: "anthropic/claude-sonnet-4-5", observedAt: "2026-10-03T04:10:00.000Z", source: GOOSE_USAGE_SOURCE,
    });
  });

  it("is null without a session id, a database, or a row, and before the first turn", () => {
    const dbPath = dbWithUsage();
    expect(readGooseUsage({ dbPath, deps, sessionId: null })).toBeNull();
    expect(readGooseUsage({ dbPath, deps, sessionId: "../x" })).toBeNull();
    expect(readGooseUsage({ dbPath, deps, sessionId: MISSING_ID })).toBeNull();
    expect(readGooseUsage({ dbPath: `${dbPath}.absent`, deps, sessionId: ID })).toBeNull();
    addSession(dbPath, { id: "20261003_9", name: "new@rig", userSet: true, cwd: "/w", createdAt: "2026-10-03 04:20:00" });
    expect(readGooseUsage({ dbPath, deps, sessionId: "20261003_9" })).toBeNull();
  });

  it("is the descriptor's readUsage, and goose declares both permission modes", () => {
    expect(typeof GOOSE_REGISTRATION.descriptor.readUsage).toBe("function");
    expect(GOOSE_REGISTRATION.descriptor.permissionModes).toEqual(["floor", "full_bypass"]);
  });
});

runTuiCliAdapterContract({
  registration: GOOSE_REGISTRATION,
  readyScreen: READY,
  gateScreens: [
    { screen: fixture("goose-80-telemetry.txt"), code: "startup_dialog" },
    { screen: fixture("goose-80-resumed.txt"), code: "startup_dialog" },
  ],
  earlyExit: { screen: fixture("goose-80-resume-missing.txt"), recovery: "retry_fresh" },
  validResumeToken: ID,
  invalidResumeToken: "20261003_3; rm -rf /",
  missingResumeToken: MISSING_ID,
  modelExample: "claude-sonnet-4-5",
  forkSourceValue: ID,
  seedResumeTarget: ({ homedir, cwd, token, seatStateDir }) => {
    addSession(seatDb(seatStateDir, homedir), { id: token, name: "dev@rig", userSet: true, cwd, createdAt: "2026-10-03 03:38:34" });
  },
  // goose creates the session row at startup; seeding writes that row.
  seedSession: ({ seatStateDir, cwd, homedir }) => {
    addSession(seatDb(seatStateDir, homedir), {
      id: "20261003_8", name: HARNESS_SESSION, userSet: true, cwd, createdAt: gooseTimestamp(new Date()),
    });
    return "20261003_8";
  },
});

describe("Goose adapter launch", () => {
  const running = { command: "goose", content: READY };

  it("types the named fresh launch and records where goose keeps sessions", async () => {
    const files = memFs();
    const pane = mockTmux([atShell(), running]);
    const adapter = GOOSE_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files, env: { XDG_DATA_HOME: "/xdg" } }));
    const result = await adapter.launchHarness(harnessBinding({ model: "claude-sonnet-4-5" }), { name: "x" });
    expect(result.ok).toBe(true);
    expect(pane.typed[0]).toContain(`'session' '--name' '${HARNESS_SESSION}' '--model' 'claude-sonnet-4-5'`);
    // The floor never inherits goose's own auto default.
    expect(pane.typed[0]).toMatch(/env 'GOOSE_TELEMETRY_OFF=1' 'GOOSE_MODE=smart_approve' /);
    const record = JSON.parse(files.files[nodePath.join(HARNESS_STATE_ROOT, "goose", HARNESS_SESSION, GOOSE_SEAT_FILE)]!);
    expect(record).toEqual({ sessionsDb: "/xdg/goose/sessions/sessions.db" });
  });

  it("both postures are observed for permission drift", () => {
    const observe = (posture: "floor" | "full_bypass") => GOOSE_SPEC.observeLaunch!({ binding: harnessBinding(), posture, seatStateDir: "/s" });
    expect(observe("floor")).toEqual({ runtime: "goose", axis: "permission", state: "observed", value: "GOOSE_MODE=smart_approve", reason: "emitted_launch_env" });
    expect(observe("full_bypass")).toMatchObject({ state: "observed", value: "GOOSE_MODE=auto" });
    const postureFor = GOOSE_REGISTRATION.descriptor.permissionPostureFor!;
    expect([postureFor("GOOSE_MODE=smart_approve"), postureFor("GOOSE_MODE=auto"), postureFor("GOOSE_MODE=chat")]).toEqual(["floor", "full_bypass", null]);
  });

  it("full_bypass types GOOSE_MODE=auto and records the observation", async () => {
    const pane = mockTmux([atShell(), running]);
    const adapter = GOOSE_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
    const result = await adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
    expect(result.ok).toBe(true);
    expect(pane.typed[0]).toMatch(/env 'GOOSE_TELEMETRY_OFF=1' 'GOOSE_MODE=auto' /);
    expect(GOOSE_REGISTRATION.descriptor.permissionPostureFor?.("GOOSE_MODE=auto")).toBe("full_bypass");
  });

  it("a fork records its parent so capture can find the copy", async () => {
    const files = memFs();
    const pane = mockTmux([atShell(), running]);
    const adapter = GOOSE_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files }));
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", forkSource: { kind: "native_id", value: ID } });
    expect(result.ok).toBe(true);
    expect(pane.typed[0]).toContain(`'--resume' '--session-id' '${ID}' '--fork'`);
    const record = JSON.parse(files.files[nodePath.join(HARNESS_STATE_ROOT, "goose", HARNESS_SESSION, GOOSE_SEAT_FILE)]!);
    expect(record.forkParent).toBe(ID);
    expect(record.sessionsDb).toBe(nodePath.join(HARNESS_HOME, ".local", "share", "goose", "sessions", "sessions.db"));
  });
});
