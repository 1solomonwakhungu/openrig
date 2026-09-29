// Hermetic tests for the OpenCode-family pure pieces (opencode, kilo): argv,
// posture, resume token format, per-seat env, guidance and skills targets,
// pane patterns against fixture captures, and session-database reads against
// a real SQLite file built from the live 1.18.33 schema. No CLI binaries.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KILO_VARIANT,
  OPENCODE_FAMILY_ERROR_PATTERNS,
  OPENCODE_FAMILY_GUIDANCE_FILE,
  OPENCODE_FAMILY_READY_PATTERNS,
  OPENCODE_VARIANT,
  buildOpencodeFamilyArgv,
  opencodeFamilyDbPath,
  opencodeFamilySeatEnv,
  opencodeFamilySkillsDir,
  validateOpencodeSessionId,
  type OpencodeFamilyVariant,
} from "../src/adapters/cli/opencode/family.js";
import {
  readCurrentSessionId,
  sessionPresence,
  type SessionStoreDeps,
} from "../src/adapters/cli/opencode/session-store.js";

const FIXTURES = nodePath.join(import.meta.dirname, "fixtures", "opencode-family");
const fixture = (name: string) => fs.readFileSync(nodePath.join(FIXTURES, name), "utf8");

const TOKEN = "ses_0197a2f0c3d4AbCdEfGhIjKlMn";
const OTHER_TOKEN = "ses_0197a2f0c3d5ZyXwVuTsRqPoNm";
const VARIANTS: Array<[string, OpencodeFamilyVariant]> = [["opencode", OPENCODE_VARIANT], ["kilo", KILO_VARIANT]];

const isReady = (pane: string) => OPENCODE_FAMILY_READY_PATTERNS.some((p) => p.test(pane));

describe.each(VARIANTS)("%s argv", (_name, variant) => {
  it("fresh launch with no model is the bare binary at the floor", () => {
    expect(buildOpencodeFamilyArgv(variant, { posture: "floor" })).toEqual([variant.binary]);
  });

  it("passes the model as -m provider/model", () => {
    expect(buildOpencodeFamilyArgv(variant, { posture: "floor", model: " anthropic/claude-sonnet-5 " }))
      .toEqual([variant.binary, "-m", "anthropic/claude-sonnet-5"]);
    expect(buildOpencodeFamilyArgv(variant, { posture: "floor", model: "openrouter/x-ai/grok-4" }))
      .toEqual([variant.binary, "-m", "openrouter/x-ai/grok-4"]);
  });

  it.each(["claude-sonnet-5", "-m/x", "anthropic/", "a b/c", "anthropic/model;rm -rf"])(
    "refuses a malformed model %j",
    (model) => {
      expect(() => buildOpencodeFamilyArgv(variant, { posture: "floor", model })).toThrow(/provider\/model/);
    },
  );

  it("full_bypass maps to --auto; floor never passes it", () => {
    expect(buildOpencodeFamilyArgv(variant, { posture: "full_bypass" })).toEqual([variant.binary, "--auto"]);
    for (const input of [
      { posture: "floor" as const },
      { posture: "floor" as const, model: "anthropic/claude-sonnet-5" },
      { posture: "floor" as const, resumeToken: TOKEN },
    ]) {
      expect(buildOpencodeFamilyArgv(variant, input)).not.toContain("--auto");
    }
  });

  it("resume passes -s with the validated session id, keeping model and posture", () => {
    expect(buildOpencodeFamilyArgv(variant, {
      posture: "full_bypass",
      model: "anthropic/claude-sonnet-5",
      resumeToken: ` ${TOKEN} `,
    })).toEqual([variant.binary, "-m", "anthropic/claude-sonnet-5", "-s", TOKEN, "--auto"]);
  });

  it("refuses a malformed resume token without echoing it", () => {
    const bad = "ses_short;touch /tmp/x";
    let message = "";
    try {
      buildOpencodeFamilyArgv(variant, { posture: "floor", resumeToken: bad });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(new RegExp(`^${variant.id} resume: `));
    expect(message).not.toContain(bad);
    expect(message).not.toContain("touch");
  });

  it("never uses --continue (it would pick an arbitrary last session)", () => {
    expect(buildOpencodeFamilyArgv(variant, { posture: "floor", resumeToken: TOKEN })).not.toContain("-c");
  });

  it("refuses fork clearly, and refuses resume plus fork together", () => {
    expect(() => buildOpencodeFamilyArgv(variant, { posture: "floor", forkSource: { kind: "native_id", value: TOKEN } }))
      .toThrow(new RegExp(`${variant.id} fork is not supported`));
    expect(() => buildOpencodeFamilyArgv(variant, {
      posture: "floor",
      resumeToken: TOKEN,
      forkSource: { kind: "native_id", value: TOKEN },
    })).toThrow(/mutually exclusive/);
  });
});

describe("session id format", () => {
  it("accepts ses_ + 26 base62 characters", () => {
    expect(validateOpencodeSessionId(TOKEN)).toEqual({ ok: true, token: TOKEN });
  });

  it.each(["", "ses_", "msg_0197a2f0c3d4AbCdEfGhIjKlMn", `${TOKEN}x`, "ses_0197a2f0c3d4AbCdEfGhIjK-n", "../ses_0197a2f0c3d4AbCdEfGhIj"])(
    "rejects %j without quoting it",
    (token) => {
      const result = validateOpencodeSessionId(token);
      expect(result.ok).toBe(false);
      if (!result.ok && token.length > 4) expect(result.error).not.toContain(token);
    },
  );
});

describe("per-seat env, guidance, skills, identity", () => {
  const seat = "/openrig-home/state/opencode/dev-impl@rig";

  it("isolates the session database per seat", () => {
    expect(opencodeFamilySeatEnv(OPENCODE_VARIANT, seat)).toEqual({ OPENCODE_DB: `${seat}/opencode.db` });
    expect(opencodeFamilySeatEnv(KILO_VARIANT, "/s/kilo/k@rig")).toEqual({ KILO_DB: "/s/kilo/k@rig/kilo.db" });
    // An absolute path: both CLIs join a relative value onto their shared data dir instead.
    expect(nodePath.isAbsolute(opencodeFamilyDbPath(OPENCODE_VARIANT, seat))).toBe(true);
  });

  it("merges guidance into AGENTS.md and projects skills into the native project dir", () => {
    expect(OPENCODE_FAMILY_GUIDANCE_FILE).toBe("AGENTS.md");
    expect(opencodeFamilySkillsDir(OPENCODE_VARIANT, "/work/repo")).toBe("/work/repo/.opencode/skills");
    expect(opencodeFamilySkillsDir(KILO_VARIANT, "/work/repo")).toBe("/work/repo/.kilo/skills");
  });

  it("never treats node as identity; the npm launcher is matched by argv", () => {
    for (const variant of [OPENCODE_VARIANT, KILO_VARIANT]) expect(variant.paneCommands).not.toContain("node");
    expect(OPENCODE_VARIANT.processMatch.test("node /usr/local/lib/node_modules/opencode-ai/bin/opencode -m a/b")).toBe(true);
    expect(OPENCODE_VARIANT.processMatch.test("node /usr/local/bin/opencoder")).toBe(false);
    expect(KILO_VARIANT.processMatch.test("node /opt/npm/node_modules/.bin/kilo")).toBe(true);
    expect(KILO_VARIANT.processMatch.test("/opt/npm/node_modules/@kilocode/cli/bin/.kilo --auto")).toBe(true);
    expect(KILO_VARIANT.processMatch.test("node /srv/kilobyte-server.js")).toBe(false);
  });
});

describe("pane patterns (fixture captures)", () => {
  it("home idle screens are ready (live captures: opencode 1.18.33, kilo 7.8.1)", () => {
    const opencode = fixture("opencode-1.18.33-home-idle.txt");
    const kilo = fixture("kilo-7.8.1-home-idle.txt");
    expect(opencode).toContain("Ask anything…"); // Unicode ellipsis
    expect(kilo).toContain("Ask anything..."); // ASCII dots
    expect(isReady(opencode)).toBe(true);
    expect(isReady(kilo)).toBe(true);
  });

  it("a resumed session (no placeholder) is ready by its prompt footer", () => {
    const pane = fixture("opencode-session-idle.source-derived.txt");
    expect(pane).not.toContain("Ask anything");
    expect(isReady(pane)).toBe(true);
  });

  it("a shell prompt or a boot splash is not ready", () => {
    expect(isReady("user@host project % opencode\n")).toBe(false);
    expect(isReady("INFO  2026-09-29T17:00:00 +0ms service=default version=7.8.1 kilo\n")).toBe(false);
  });

  it("a missing resume session classifies as retry_fresh", () => {
    const pane = fixture("opencode-1.18.33-session-not-found.txt");
    const hit = OPENCODE_FAMILY_ERROR_PATTERNS.find((p) => p.pattern.test(pane));
    expect(hit?.recovery).toBe("retry_fresh");
    expect(isReady(pane)).toBe(false);
  });
});

describe("session database reads", () => {
  let dir: string;
  let dbPath: string;
  const deps: SessionStoreDeps = { exists: (p) => fs.existsSync(p) };

  function createDb(rows: Array<{ id: string; parent?: string; updated: number; archived?: number }>): void {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    db.exec(fixture("opencode-1.18.33-session-schema.sql"));
    const insert = db.prepare(
      "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, 'proj', ?, 'slug', '/work/repo', 'title', '1.18.33', ?, ?, ?)",
    );
    for (const row of rows) insert.run(row.id, row.parent ?? null, row.updated - 1, row.updated, row.archived ?? null);
    db.close();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "opencode-family-"));
    dbPath = nodePath.join(dir, "opencode.db");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports missing_db before the CLI has created its database", () => {
    expect(readCurrentSessionId(dbPath, deps)).toEqual({ ok: false, reason: "missing_db" });
  });

  it("reports no_session while the TUI is idle before the first prompt", () => {
    createDb([]);
    expect(readCurrentSessionId(dbPath, deps)).toEqual({ ok: false, reason: "no_session" });
  });

  it("returns the most recently updated top-level, unarchived session", () => {
    const child = "ses_0197a2f0c3d6SubagentChild01";
    const archived = "ses_0197a2f0c3d7ArchivedSess01";
    createDb([
      { id: OTHER_TOKEN, updated: 1_000 },
      { id: TOKEN, updated: 2_000 },
      { id: child, parent: TOKEN, updated: 3_000 },
      { id: archived, updated: 4_000, archived: 4_001 },
    ]);
    expect(readCurrentSessionId(dbPath, deps)).toEqual({ ok: true, token: TOKEN });
  });

  it("refuses a malformed id in the database instead of persisting it", () => {
    createDb([{ id: "ses_bad", updated: 1 }]);
    expect(readCurrentSessionId(dbPath, deps)).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("reports read_error for an unreadable database, never throwing", () => {
    fs.writeFileSync(dbPath, "not a sqlite database");
    expect(readCurrentSessionId(dbPath, deps)).toEqual({ ok: false, reason: "read_error" });
    expect(sessionPresence(dbPath, TOKEN, deps)).toBe("unknown");
  });

  it("opens read-only and closes the reader", () => {
    createDb([{ id: TOKEN, updated: 1 }]);
    const before = fs.readFileSync(dbPath);
    let closed = 0;
    const result = readCurrentSessionId(dbPath, {
      ...deps,
      openReadonly: (p) => {
        const db = new Database(p, { readonly: true, fileMustExist: true });
        expect(() => db.exec("CREATE TABLE openrig_write_probe (x)")).toThrow(/readonly/);
        return { get: (sql, params) => db.prepare(sql).get(...params) as Record<string, unknown> | undefined, close: () => { closed++; db.close(); } };
      },
    });
    expect(result).toEqual({ ok: true, token: TOKEN });
    expect(closed).toBe(1);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("checks a resume target before typing: present, missing row, missing database", () => {
    expect(sessionPresence(dbPath, TOKEN, deps)).toBe("missing");
    createDb([{ id: TOKEN, updated: 1 }]);
    expect(sessionPresence(dbPath, TOKEN, deps)).toBe("present");
    expect(sessionPresence(dbPath, OTHER_TOKEN, deps)).toBe("missing");
  });
});
