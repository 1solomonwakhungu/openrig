// Hermetic tests for the per-runtime usage readers (feature 1). Fixtures are
// version-pinned (test/fixtures/usage/<runtime>-<version>.*) and follow each
// CLI's record format as its source defines it; the numbers are illustrative.
// The cline fixture has the shape of a live cline 3.0.65 session record (the
// live probe used a dummy key, so its counts were zero). opencode runs
// against a real temporary SQLite database with opencode's session and
// message columns.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { readClineUsage, CLINE_USAGE_SOURCE } from "../src/adapters/cli/cline/usage.js";
import { clineSessionMetadataPath } from "../src/adapters/cli/cline/sessions.js";
import { readOpencodeUsage } from "../src/adapters/cli/opencode/usage.js";
import { openSessionDbReadonly } from "../src/adapters/cli/opencode/session-store.js";
import { readGeminiUsage, readQwenUsage, GEMINI_USAGE_SOURCE, QWEN_USAGE_SOURCE } from "../src/adapters/cli/gemini-family/usage.js";
import { readAiderUsage, parseAiderTokenCount, AIDER_USAGE_SOURCE } from "../src/adapters/cli/aider/usage.js";
import { compactUsage } from "../src/adapters/cli/usage-snapshot.js";

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string) => fs.readFileSync(nodePath.join(FIXTURES, name), "utf8");
const NOW = () => new Date("2026-10-03T00:00:00.000Z");

const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-usage-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("compactUsage", () => {
  it("drops absent metrics and returns null when no metric is left", () => {
    expect(compactUsage({ inputTokens: 5, outputTokens: undefined, observedAt: "t", source: "s" })).toEqual({ inputTokens: 5, observedAt: "t", source: "s" });
    expect(compactUsage({ model: "m", observedAt: "t", source: "s" })).toBeNull();
  });
});

describe("cline (3.0.65 session record)", () => {
  const SESSIONS = "/home/u/.cline/data/sessions";
  const ID = "1790702191676_lovnf";
  const fsOf = (files: Record<string, string>) => ({ exists: (p: string) => p in files, readFile: (p: string) => files[p]! });

  it("reads the seat's aggregate usage (the session plus agents it spawned) and the model", () => {
    const files = { [clineSessionMetadataPath(SESSIONS, ID)]: fixture("cline-3.0.65-session.json") };
    expect(readClineUsage({ fs: fsOf(files), sessionsDir: SESSIONS, sessionId: ID, now: NOW })).toEqual({
      inputTokens: 1500, outputTokens: 410, cacheReadTokens: 9000, cacheWriteTokens: 2500, costUsd: 0.0482,
      model: "claude-sonnet-4-5", observedAt: NOW().toISOString(), source: CLINE_USAGE_SOURCE,
    });
  });

  it("returns null without a session id, a record, or usage, and for a malformed id", () => {
    const files = { [clineSessionMetadataPath(SESSIONS, ID)]: JSON.stringify({ metadata: {} }) };
    expect(readClineUsage({ fs: fsOf(files), sessionsDir: SESSIONS, sessionId: null })).toBeNull();
    expect(readClineUsage({ fs: fsOf({}), sessionsDir: SESSIONS, sessionId: ID })).toBeNull();
    expect(readClineUsage({ fs: fsOf(files), sessionsDir: SESSIONS, sessionId: ID })).toBeNull();
    expect(readClineUsage({ fs: fsOf(files), sessionsDir: SESSIONS, sessionId: "../x" })).toBeNull();
    expect(readClineUsage({ fs: fsOf({ [clineSessionMetadataPath(SESSIONS, ID)]: "{not json" }), sessionsDir: SESSIONS, sessionId: ID })).toBeNull();
  });
});

describe("opencode / kilo (seat session database)", () => {
  let dbCount = 0;
  function makeDb(withUsageColumns: boolean): string {
    const path = nodePath.join(tmp, `opencode-${withUsageColumns ? "new" : "old"}-${dbCount++}.db`);
    const db = new Database(path);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER, model TEXT${
      withUsageColumns ? ", cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL" : ""
    })`);
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
    const model = JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" });
    if (withUsageColumns) {
      db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("ses_1", "t", 1, Date.parse("2026-10-02T10:00:00Z"), model, 0.42, 30000, 2100, 400, 120000, 9000);
    } else {
      db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("ses_1", "t", 1, 2, model);
    }
    const msg = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
    msg.run("m1", "ses_1", 10, 10, JSON.stringify({ role: "assistant", tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 20000, write: 3000 } } }));
    msg.run("m2", "ses_1", 20, 20, JSON.stringify({ role: "user" }));
    msg.run("m3", "ses_1", 30, 30, JSON.stringify({ role: "assistant", tokens: { input: 1200, output: 80, reasoning: 0, cache: { read: 41000, write: 0 } } }));
    db.close();
    return path;
  }

  it("reads the session totals, the model, and the latest request's context", () => {
    const db = openSessionDbReadonly(makeDb(true));
    try {
      expect(readOpencodeUsage({ db, sessionId: "ses_1", source: "opencode_session_db", now: NOW })).toEqual({
        inputTokens: 30000, outputTokens: 2100, reasoningTokens: 400, cacheReadTokens: 120000, cacheWriteTokens: 9000,
        costUsd: 0.42, contextUsedTokens: 1200 + 41000, model: "anthropic/claude-sonnet-4-5",
        observedAt: "2026-10-02T10:00:00.000Z", source: "opencode_session_db",
      });
    } finally {
      db.close();
    }
  });

  it("returns null for an opencode database older than the usage columns, an unknown session, or no database", () => {
    const old = openSessionDbReadonly(makeDb(false));
    try {
      expect(readOpencodeUsage({ db: old, sessionId: "ses_1", source: "opencode_session_db" })).toBeNull();
    } finally {
      old.close();
    }
    const db = openSessionDbReadonly(makeDb(true));
    try {
      expect(readOpencodeUsage({ db, sessionId: "ses_missing", source: "opencode_session_db" })).toBeNull();
    } finally {
      db.close();
    }
    expect(readOpencodeUsage({ db: null, sessionId: "ses_1", source: "opencode_session_db" })).toBeNull();
  });
});

describe("gemini (0.61.0 session jsonl)", () => {
  it("sums replies after checkpoints and rewinds, and reads context and model from the latest", () => {
    expect(readGeminiUsage(fixture("gemini-0.61.0-session.jsonl"), NOW)).toEqual({
      inputTokens: 5200 + 5900, outputTokens: 300 + 90, cacheReadTokens: 4000 + 5000, reasoningTokens: 120 + 40,
      contextUsedTokens: 5900, model: "gemini-3.5-pro", observedAt: "2026-09-29T12:01:30.000Z", source: GEMINI_USAGE_SOURCE,
    });
  });

  it("returns null with no replies carrying tokens", () => {
    expect(readGeminiUsage(null)).toBeNull();
    expect(readGeminiUsage('{"sessionId":"x"}\n{"id":"m1","type":"user","content":"hi"}\n')).toBeNull();
  });
});

describe("qwen (0.24.7 chat jsonl)", () => {
  it("sums assistant usage, reads the context window, and skips a torn last line", () => {
    expect(readQwenUsage(fixture("qwen-0.24.7-chat.jsonl"), NOW)).toEqual({
      inputTokens: 4100 + 4600, outputTokens: 210 + 95, cacheReadTokens: 3000 + 4100, reasoningTokens: 15,
      contextUsedTokens: 4600, contextWindowTokens: 1_000_000, model: "qwen3-coder-plus",
      observedAt: "2026-09-29T12:00:40.000Z", source: QWEN_USAGE_SOURCE,
    });
  });

  it("returns null without assistant usage", () => {
    expect(readQwenUsage(null)).toBeNull();
    expect(readQwenUsage('{"type":"user"}\n')).toBeNull();
  });
});

describe("aider (0.86.2 chat history)", () => {
  it("parses aider's rounded token figures", () => {
    expect(parseAiderTokenCount("950")).toBe(950);
    expect(parseAiderTokenCount("2.1k")).toBe(2100);
    expect(parseAiderTokenCount("15k")).toBe(15000);
    expect(parseAiderTokenCount("lots")).toBeUndefined();
  });

  it("sums requests, sums each process segment's session cost, and marks the result approximate", () => {
    expect(readAiderUsage(fixture("aider-0.86.2-chat.history.md"), NOW)).toEqual({
      inputTokens: 2100 + 3400 + 12000, outputTokens: 120 + 250 + 80, cacheWriteTokens: 1500, cacheReadTokens: 900,
      costUsd: 0.02 + 0.03, contextUsedTokens: 12000, observedAt: NOW().toISOString(), source: AIDER_USAGE_SOURCE, approximate: true,
    });
  });

  it("returns null for a history with no usage lines", () => {
    expect(readAiderUsage(null)).toBeNull();
    expect(readAiderUsage("# aider chat started at 2026-09-29 12:19:22\n\n#### hi\n")).toBeNull();
  });
});
