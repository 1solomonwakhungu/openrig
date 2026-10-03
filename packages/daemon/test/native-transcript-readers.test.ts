// Native transcript readers (feature 5) for gemini, qwen, opencode, and kilo.
// Fixtures follow each CLI's record at the version the adapter pins (formats
// read from source: gemini v0.61.0 chatRecordingTypes.ts, qwen v0.24.7
// chatRecordingService.ts, opencode v1.18.33 session/sql.ts and
// message-v2.ts); they are synthesized, not captured from live sessions.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GEMINI_TRANSCRIPT_SOURCE, QWEN_TRANSCRIPT_SOURCE, readGeminiTranscript, readQwenTranscript, readSessionTranscript } from "../src/adapters/cli/gemini-family/transcript.js";
import { NATIVE_TRANSCRIPT_MAX_BYTES } from "../src/adapters/cli/transcript-text.js";
import { vi } from "vitest";
import { OPENCODE_TRANSCRIPT_PARTS_SQL, readOpencodeTranscript } from "../src/adapters/cli/opencode/transcript.js";
import { openSessionDbReadonly } from "../src/adapters/cli/opencode/session-store.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { renderTranscriptEntries } from "../src/domain/native-transcript.js";

const fixture = (name: string) => fs.readFileSync(nodePath.join(__dirname, "fixtures", "transcripts", name), "utf8");

describe("gemini (0.61.0 session jsonl)", () => {
  it("replays $set and $rewindTo, maps text, tool calls, results, and notices, and leaves thoughts out", () => {
    const transcript = readGeminiTranscript(fixture("gemini-0.61.0-session.jsonl"));
    expect(transcript?.source).toBe(GEMINI_TRANSCRIPT_SOURCE);
    expect(transcript?.entries).toEqual([
      { role: "user", text: "Add a health route.", at: "2026-10-03T03:00:10.000Z" },
      { role: "assistant", text: "Adding GET /health.", at: "2026-10-03T03:00:20.000Z" },
      { role: "tool", text: 'write_file({"file_path":"src/health.ts","content":"export const ok = true;"})', at: "2026-10-03T03:00:21.000Z" },
      { role: "tool", text: "Wrote src/health.ts", at: "2026-10-03T03:00:21.000Z" },
      { role: "tool", text: 'run_shell_command({"command":"npm test"})', at: "2026-10-03T03:00:25.000Z" },
      { role: "tool", text: "error: exit 1", at: "2026-10-03T03:00:25.000Z" },
      { role: "system", text: "Request cancelled.", at: "2026-10-03T03:00:30.000Z" },
      { role: "assistant", text: "Done; tests need a fix.", at: "2026-10-03T03:01:00.000Z" },
    ]);
    const text = JSON.stringify(transcript);
    for (const hidden of ["thinking about it", "secret plan", "rewound away"]) expect(text).not.toContain(hidden);
  });

  it("filters by since and returns null without a file", () => {
    expect(readGeminiTranscript(fixture("gemini-0.61.0-session.jsonl"), new Date("2026-10-03T03:00:30.000Z"))?.entries.map((e) => e.role))
      .toEqual(["system", "assistant"]);
    expect(readGeminiTranscript(null)).toBeNull();
  });
});

describe("qwen (0.24.7 chat jsonl)", () => {
  it("maps text, function calls, and function responses, skipping thoughts, system records, and a torn last line", () => {
    const transcript = readQwenTranscript(fixture("qwen-0.24.7-chat.jsonl"));
    expect(transcript?.source).toBe(QWEN_TRANSCRIPT_SOURCE);
    expect(transcript?.entries).toEqual([
      { role: "user", text: "Add a health route.", at: "2026-10-03T03:00:10.000Z" },
      { role: "assistant", text: "Adding GET /health.", at: "2026-10-03T03:00:20.000Z" },
      { role: "tool", text: 'write_file({"file_path":"src/health.ts"})', at: "2026-10-03T03:00:20.000Z" },
      { role: "tool", text: "Wrote src/health.ts", at: "2026-10-03T03:00:25.000Z" },
      { role: "assistant", text: "Done.", at: "2026-10-03T03:00:40.000Z" },
    ]);
    expect(JSON.stringify(transcript)).not.toContain("private reasoning");
    expect(readQwenTranscript(null)).toBeNull();
  });
});

describe("bounded session-file reads (gemini and qwen)", () => {
  it("reads a located file asynchronously within the cap", async () => {
    const text = fixture("qwen-0.24.7-chat.jsonl");
    const ops = { stat: async () => ({ size: text.length }), readFile: vi.fn(async () => text) };
    const transcript = await readSessionTranscript("qwen", () => "/q/chats/s1.jsonl", { cwd: "/w", homedir: "/h", fileOps: ops }, (t) => readQwenTranscript(t));
    expect(transcript?.entries).toHaveLength(5);
    expect(ops.readFile).toHaveBeenCalledWith("/q/chats/s1.jsonl");
  });

  it("over the cap returns null without reading, and logs why", async () => {
    const ops = { stat: async () => ({ size: NATIVE_TRANSCRIPT_MAX_BYTES + 1 }), readFile: vi.fn(async () => "") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await readSessionTranscript("gemini", () => "/g/chats/session-x.jsonl", { cwd: "/w", homedir: "/h", fileOps: ops }, (t) => readGeminiTranscript(t))).toBeNull();
      expect(ops.readFile).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("gemini native transcript skipped: session-x.jsonl 32 MiB is over the 32 MiB cap"));
    } finally {
      warn.mockRestore();
    }
  });

  it("no located file, or a missing one, is null and quiet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = { stat: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, readFile: async () => "" };
    try {
      expect(await readSessionTranscript("qwen", () => null, { cwd: "/w", homedir: "/h" }, (t) => readQwenTranscript(t))).toBeNull();
      expect(await readSessionTranscript("qwen", () => "/q/x.jsonl", { cwd: "/w", homedir: "/h", fileOps: missing }, (t) => readQwenTranscript(t))).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("opencode / kilo (seat session database, v1.18.33 schema)", () => {
  let tmp: string | null = null;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; });

  function seatDb(): string {
    tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-oc-tx-"));
    const path = nodePath.join(tmp, "opencode.db");
    const db = new Database(path);
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
    db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
    const t0 = Date.parse("2026-10-03T03:00:00.000Z");
    const msg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    msg.run("msg_1", "ses_1", t0 + 10_000, t0 + 10_000, JSON.stringify({ role: "user", time: { created: t0 + 10_000 } }));
    part.run("prt_1", "msg_1", "ses_1", t0, t0, JSON.stringify({ type: "text", text: "Add a health route." }));
    part.run("prt_2", "msg_1", "ses_1", t0, t0, JSON.stringify({ type: "text", text: "<system reminder>", synthetic: true }));
    msg.run("msg_2", "ses_1", t0 + 20_000, t0 + 20_000, JSON.stringify({ role: "assistant", tokens: { input: 1 } }));
    part.run("prt_3", "msg_2", "ses_1", t0, t0, JSON.stringify({ type: "reasoning", text: "hidden reasoning" }));
    part.run("prt_4", "msg_2", "ses_1", t0, t0, JSON.stringify({ type: "text", text: "Adding GET /health." }));
    part.run("prt_5", "msg_2", "ses_1", t0, t0, JSON.stringify({ type: "tool", tool: "write", callID: "c1", state: { status: "completed", input: { filePath: "src/health.ts" }, output: "Wrote file" } }));
    part.run("prt_6", "msg_2", "ses_1", t0, t0, JSON.stringify({ type: "tool", tool: "bash", callID: "c2", state: { status: "error", input: { command: "npm test" }, error: "exit 1" } }));
    part.run("prt_7", "msg_2", "ses_1", t0, t0, JSON.stringify({ type: "step-finish" }));
    msg.run("msg_9", "ses_other", t0 + 5_000, t0 + 5_000, JSON.stringify({ role: "user" }));
    part.run("prt_9", "msg_9", "ses_other", t0, t0, JSON.stringify({ type: "text", text: "another session" }));
    db.close();
    return path;
  }

  it("orders parts by message, maps text and tool parts, and leaves reasoning, synthetic text, and other sessions out", () => {
    const db = openSessionDbReadonly(seatDb());
    try {
      expect(readOpencodeTranscript({ db, sessionId: "ses_1", source: "kilo_session_db" })).toEqual({
        source: "kilo_session_db",
        entries: [
          { role: "user", text: "Add a health route.", at: "2026-10-03T03:00:10.000Z" },
          { role: "assistant", text: "Adding GET /health.", at: "2026-10-03T03:00:20.000Z" },
          { role: "tool", text: 'write({"filePath":"src/health.ts"})', at: "2026-10-03T03:00:20.000Z" },
          { role: "tool", text: "Wrote file", at: "2026-10-03T03:00:20.000Z" },
          { role: "tool", text: 'bash({"command":"npm test"})', at: "2026-10-03T03:00:20.000Z" },
          { role: "tool", text: "error: exit 1", at: "2026-10-03T03:00:20.000Z" },
        ],
      });
      expect(readOpencodeTranscript({ db, sessionId: "ses_1", source: "x", since: new Date("2026-10-03T03:00:15.000Z") })?.entries).toHaveLength(5);
      expect(readOpencodeTranscript({ db, sessionId: "ses_missing", source: "x" })?.entries).toEqual([]);
      // The bound is in the SQL: the newest parts, returned in conversation order.
      expect(readOpencodeTranscript({ db, sessionId: "ses_1", source: "x", maxParts: 2 })?.entries.map((e) => e.text))
        .toEqual(['bash({"command":"npm test"})', "error: exit 1"]);
    } finally {
      db.close();
    }
  });

  it("returns null without a session, a reader, or the expected tables", () => {
    expect(readOpencodeTranscript({ db: null, sessionId: "ses_1", source: "x" })).toBeNull();
    const empty = { get: () => undefined, all: () => { throw new Error("no such table: part"); }, close: () => {} };
    expect(readOpencodeTranscript({ db: empty, sessionId: "ses_1", source: "x" })).toBeNull();
    expect(readOpencodeTranscript({ db: { get: () => undefined, close: () => {} }, sessionId: "ses_1", source: "x" })).toBeNull();
    expect(OPENCODE_TRANSCRIPT_PARTS_SQL).toMatch(/WHERE p\.session_id = \? ORDER BY .* DESC LIMIT \?$/);
  });
});

describe("registered readers", () => {
  it("cline, opencode, kilo, gemini, and qwen declare readTranscript; antigravity does not (its store is unverified)", () => {
    for (const id of ["cline", "opencode", "kilo", "gemini", "qwen"]) expect(typeof getRuntimeDescriptor(id)?.readTranscript, id).toBe("function");
    expect(getRuntimeDescriptor("antigravity")?.readTranscript).toBeUndefined();
  });

  it("renders a mapped transcript as one prefixed line per entry", () => {
    const transcript = readQwenTranscript(fixture("qwen-0.24.7-chat.jsonl"))!;
    expect(renderTranscriptEntries(transcript.entries).split("\n")[0]).toBe("[2026-10-03T03:00:10.000Z] user ▸ Add a health route.");
  });
});
