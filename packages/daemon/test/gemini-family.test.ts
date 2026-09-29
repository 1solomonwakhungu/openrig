// Hermetic tests for the Gemini CLI family pure pieces (gemini + qwen): launch
// argv, pane patterns against live captures (test/fixtures/gemini-family/,
// recorded from gemini 0.61.0 and qwen 0.24.7 in an isolated tmux server),
// session-token format, and the read-only session-store lookups. No real
// binaries, no network.

import nodePath from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildGeminiFamilyArgv, GEMINI_DIALECT, QWEN_DIALECT, SESSION_ID_RE,
  mintSessionToken, validateSessionToken,
} from "../src/adapters/cli/gemini-family/launch-args.js";
import {
  GEMINI_PANE_PATTERNS, QWEN_PANE_PATTERNS, type GeminiFamilyPanePatterns,
} from "../src/adapters/cli/gemini-family/pane-patterns.js";
import {
  captureQwenForkChild, checkGeminiResumeTarget, checkQwenResumeTarget, findGeminiSessionFile,
  findQwenSessionFile, geminiChatsDir, qwenProjectDirName, qwenRuntimeBases,
  type SessionStoreContext, type SessionStoreFs,
} from "../src/adapters/cli/gemini-family/session-store.js";
import { ATTENTION_REQUIRED_READINESS_CODES } from "../src/domain/runtime-adapter.js";

const FIXTURES = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "gemini-family");
const fixture = (name: string) => readFileSync(nodePath.join(FIXTURES, name), "utf8");

const ID = "0b7c2f1e-5d4a-4c3b-9a8f-1e2d3c4b5a69";
const PARENT = "7f3e2d1c-0b9a-4876-a543-210fedcba987";
const HOME = "/home/user";
const CWD = "/home/user/project";

describe("gemini family launch argv", () => {
  it("gemini fresh floor: model, auto_edit, --skip-trust, minted session id", () => {
    expect(buildGeminiFamilyArgv(GEMINI_DIALECT, { model: "gemini-2.5-pro", posture: "floor", sessionToken: ID })).toEqual([
      "gemini", "--model", "gemini-2.5-pro", "--approval-mode", "auto_edit", "--skip-trust", "--session-id", ID,
    ]);
  });

  it("full_bypass passes the real auto-approve flag and floor never does", () => {
    for (const dialect of [GEMINI_DIALECT, QWEN_DIALECT]) {
      const bypass = buildGeminiFamilyArgv(dialect, { posture: "full_bypass" });
      const floor = buildGeminiFamilyArgv(dialect, { posture: "floor" });
      expect(bypass).toContain("--yolo");
      expect(bypass).not.toContain("--approval-mode");
      expect(floor).not.toContain("--yolo");
      expect(floor).not.toContain("yolo");
    }
  });

  it("qwen floor uses the hyphenated auto-edit and has no trust flag", () => {
    expect(buildGeminiFamilyArgv(QWEN_DIALECT, { posture: "floor", sessionToken: ID })).toEqual([
      "qwen", "--approval-mode", "auto-edit", "--session-id", ID,
    ]);
  });

  it("omits --model when the binding has none or only whitespace", () => {
    expect(buildGeminiFamilyArgv(GEMINI_DIALECT, { posture: "floor", model: "  " })).not.toContain("--model");
  });

  it("resume passes --resume and never --session-id (both CLIs reject the pair)", () => {
    for (const dialect of [GEMINI_DIALECT, QWEN_DIALECT]) {
      const argv = buildGeminiFamilyArgv(dialect, { posture: "floor", resumeToken: ID, sessionToken: PARENT });
      expect(argv.slice(-2)).toEqual(["--resume", ID]);
      expect(argv).not.toContain("--session-id");
    }
  });

  it("lowercases session ids (qwen stores them lowercased)", () => {
    const argv = buildGeminiFamilyArgv(QWEN_DIALECT, { posture: "floor", resumeToken: ID.toUpperCase() });
    expect(argv.at(-1)).toBe(ID);
  });

  it("qwen fork: --resume <parent> --fork-session, no preset child id", () => {
    expect(buildGeminiFamilyArgv(QWEN_DIALECT, { posture: "floor", forkParent: PARENT, sessionToken: ID })).toEqual([
      "qwen", "--approval-mode", "auto-edit", "--resume", PARENT, "--fork-session",
    ]);
  });

  it("gemini refuses fork with a clear error", () => {
    expect(() => buildGeminiFamilyArgv(GEMINI_DIALECT, { posture: "floor", forkParent: PARENT }))
      .toThrow(/gemini has no native fork primitive/);
  });

  it("refuses resume plus fork together", () => {
    expect(() => buildGeminiFamilyArgv(QWEN_DIALECT, { posture: "floor", resumeToken: ID, forkParent: PARENT }))
      .toThrow(/mutually exclusive/);
  });

  it("refuses non-UUID ids instead of passing them to the CLI", () => {
    expect(() => buildGeminiFamilyArgv(QWEN_DIALECT, { posture: "floor", resumeToken: "my title" })).toThrow(/session UUID/);
    expect(() => buildGeminiFamilyArgv(GEMINI_DIALECT, { posture: "floor", resumeToken: "5" })).toThrow(/session UUID/);
    expect(() => buildGeminiFamilyArgv(QWEN_DIALECT, { posture: "floor", forkParent: "latest" })).toThrow(/session UUID/);
  });
});

describe("gemini family session token", () => {
  it("mints v4 UUIDs that both CLIs accept", () => {
    const token = mintSessionToken();
    expect(token).toMatch(SESSION_ID_RE);
    expect(token).not.toBe(mintSessionToken());
  });

  it("validates and normalizes without echoing the token", () => {
    expect(validateSessionToken(` ${ID.toUpperCase()} `)).toEqual({ ok: true, token: ID });
    const bad = validateSessionToken("secret-looking-value");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain("secret-looking-value");
    // qwen treats non v1-5 UUIDs as titles; refuse them.
    expect(validateSessionToken("0b7c2f1e-5d4a-7c3b-9a8f-1e2d3c4b5a69").ok).toBe(false);
  });
});

function classify(patterns: GeminiFamilyPanePatterns, screen: string): string {
  const gate = patterns.gatePatterns.find((g) => g.pattern.test(screen));
  if (gate) return `gate:${gate.code}`;
  const error = patterns.errorPatterns.find((e) => e.pattern.test(screen));
  if (error) return `error:${error.recovery ?? "attention_required"}`;
  if (patterns.readyPatterns.some((p) => p.test(screen))) return "ready";
  return "pending";
}

describe("gemini family pane patterns (live fixtures)", () => {
  it.each([
    ["gemini-ready-floor.txt", "ready"],
    ["gemini-ready-yolo.txt", "ready"],
    ["gemini-trust.txt", "gate:trust_gate"],
    ["gemini-auth.txt", "gate:login_required"],
    ["gemini-api-key.txt", "gate:login_required"],
    ["gemini-resume-missing.txt", "error:retry_fresh"],
  ])("gemini %s -> %s", (file, expected) => {
    expect(classify(GEMINI_PANE_PATTERNS, fixture(file))).toBe(expected);
  });

  it.each([
    ["qwen-ready-floor.txt", "ready"],
    ["qwen-ready-yolo.txt", "ready"],
    ["qwen-trust.txt", "gate:trust_gate"],
    ["qwen-auth.txt", "gate:login_required"],
    ["qwen-resume-missing.txt", "error:retry_fresh"],
  ])("qwen %s -> %s", (file, expected) => {
    expect(classify(QWEN_PANE_PATTERNS, fixture(file))).toBe(expected);
  });

  it("a blank or booting pane is pending, never ready", () => {
    expect(classify(GEMINI_PANE_PATTERNS, "")).toBe("pending");
    expect(classify(QWEN_PANE_PATTERNS, "user@host project % qwen --approval-mode auto-edit")).toBe("pending");
  });

  it("gate codes are attention-required readiness codes", () => {
    for (const patterns of [GEMINI_PANE_PATTERNS, QWEN_PANE_PATTERNS]) {
      for (const gate of patterns.gatePatterns) expect(ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)).toBe(true);
    }
  });

  it("each CLI's trust dialog does not match the other's trust pattern (distinct wording)", () => {
    expect(classify(QWEN_PANE_PATTERNS, fixture("gemini-trust.txt"))).not.toBe("gate:trust_gate");
    expect(classify(GEMINI_PANE_PATTERNS, fixture("qwen-trust.txt"))).not.toBe("gate:trust_gate");
  });
});

function memFs(files: Record<string, string>): SessionStoreFs & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    readFile(path) {
      const v = map.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    exists(path) {
      if (map.has(path)) return true;
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return [...map.keys()].some((k) => k.startsWith(prefix));
    },
    listFiles(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...map.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
  };
}

function ctx(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): SessionStoreContext {
  return { cwd: CWD, homedir: HOME, fs: memFs(files), env };
}

const GEMINI_ROOT = `${HOME}/.gemini`;
const GEMINI_CHATS = `${GEMINI_ROOT}/tmp/project/chats`;
const GEMINI_REGISTRY = { [`${GEMINI_ROOT}/projects.json`]: JSON.stringify({ projects: { [CWD]: "project" } }) };
const geminiSession = (id: string) => `${JSON.stringify({ sessionId: id, projectHash: "abc", kind: "main" })}\n{"$set":{}}\n`;

describe("gemini session store", () => {
  it("resolves the chats dir from projects.json and honors GEMINI_CLI_HOME", () => {
    expect(geminiChatsDir(ctx(GEMINI_REGISTRY))).toBe(GEMINI_CHATS);
    const alt = { "/alt/.gemini/projects.json": JSON.stringify({ projects: { [CWD]: "p-1" } }) };
    expect(geminiChatsDir(ctx(alt, { GEMINI_CLI_HOME: "/alt" }))).toBe("/alt/.gemini/tmp/p-1/chats");
  });

  it("finds the session file by id prefix and the full id on its first line", () => {
    const path = `${GEMINI_CHATS}/session-2026-09-29T17-15-${ID.slice(0, 8)}.jsonl`;
    const c = ctx({ ...GEMINI_REGISTRY, [path]: geminiSession(ID) });
    expect(findGeminiSessionFile(c, ID)).toBe(path);
    expect(checkGeminiResumeTarget(c, ID)).toEqual({ ok: true });
  });

  it("does not accept a file whose 8-char prefix collides but full id differs", () => {
    const other = `${ID.slice(0, 8)}-0000-4000-8000-000000000000`;
    const path = `${GEMINI_CHATS}/session-2026-09-29T17-15-${ID.slice(0, 8)}.jsonl`;
    const check = checkGeminiResumeTarget(ctx({ ...GEMINI_REGISTRY, [path]: geminiSession(other) }), ID);
    expect(check.ok).toBe(false);
  });

  it("refuses when gemini never ran in the cwd, or files are unparseable", () => {
    expect(checkGeminiResumeTarget(ctx({}), ID).ok).toBe(false);
    expect(checkGeminiResumeTarget(ctx({ [`${GEMINI_ROOT}/projects.json`]: "{not json" }), ID).ok).toBe(false);
    const path = `${GEMINI_CHATS}/session-2026-09-29T17-15-${ID.slice(0, 8)}.jsonl`;
    expect(checkGeminiResumeTarget(ctx({ ...GEMINI_REGISTRY, [path]: "garbage" }), ID).ok).toBe(false);
  });

  it("ignores a slug that could escape the tmp dir", () => {
    const evil = { [`${GEMINI_ROOT}/projects.json`]: JSON.stringify({ projects: { [CWD]: "../../etc" } }) };
    expect(geminiChatsDir(ctx(evil))).toBeNull();
  });
});

const QWEN_CHATS = `${HOME}/.qwen/projects/-home-user-project/chats`;

describe("qwen session store", () => {
  it("sanitizes the cwd the way qwen does", () => {
    expect(qwenProjectDirName("/Users/a/my_proj.v2")).toBe("-Users-a-my-proj-v2");
  });

  it("checks QWEN_RUNTIME_DIR, settings runtimeOutputDir (relative to cwd), QWEN_HOME, and ~/.qwen", () => {
    const c = ctx(
      { "/qh/settings.json": JSON.stringify({ advanced: { runtimeOutputDir: ".qwen-out" } }) },
      { QWEN_RUNTIME_DIR: "/rt", QWEN_HOME: "/qh" },
    );
    expect(qwenRuntimeBases(c)).toEqual(["/rt", `${CWD}/.qwen-out`, "/qh", `${HOME}/.qwen`]);
  });

  it("tolerates unparseable settings", () => {
    expect(qwenRuntimeBases(ctx({ [`${HOME}/.qwen/settings.json`]: "// jsonc\n{" }))).toEqual([`${HOME}/.qwen`]);
  });

  it("finds <id>.jsonl, and refuses when only runtime.json exists (no message yet)", () => {
    const withConversation = ctx({ [`${QWEN_CHATS}/${ID}.jsonl`]: "{}\n" });
    expect(findQwenSessionFile(withConversation, ID.toUpperCase())).toBe(`${QWEN_CHATS}/${ID}.jsonl`);
    expect(checkQwenResumeTarget(withConversation, ID)).toEqual({ ok: true });
    const launchedOnly = ctx({ [`${QWEN_CHATS}/${ID}.runtime.json`]: "{}" });
    expect(checkQwenResumeTarget(launchedOnly, ID).ok).toBe(false);
  });

  describe("fork child capture", () => {
    const launchStartedAt = new Date("2026-09-29T17:20:00.000Z");
    const epoch = (iso: string) => Date.parse(iso) / 1000;
    const status = (id: string, startedAtIso: string, workDir = CWD) =>
      JSON.stringify({ schema_version: 1, pid: 1, session_id: id, work_dir: workDir, started_at: epoch(startedAtIso), qwen_version: "0.24.7" });

    it("returns the single new runtime.json that is not the parent", () => {
      const c = ctx({
        [`${QWEN_CHATS}/${PARENT}.runtime.json`]: status(PARENT, "2026-09-29T17:20:01.000Z"),
        [`${QWEN_CHATS}/${ID}.runtime.json`]: status(ID, "2026-09-29T17:20:02.500Z"),
        [`${QWEN_CHATS}/11111111-1111-4111-8111-111111111111.runtime.json`]: status("11111111-1111-4111-8111-111111111111", "2026-09-29T16:00:00.000Z"),
      });
      expect(captureQwenForkChild(c, { parentId: PARENT, launchStartedAt })).toBe(ID);
    });

    it("returns null when two seats launched in the same cwd at once (no guessing)", () => {
      const c = ctx({
        [`${QWEN_CHATS}/${ID}.runtime.json`]: status(ID, "2026-09-29T17:20:02.000Z"),
        [`${QWEN_CHATS}/22222222-2222-4222-8222-222222222222.runtime.json`]: status("22222222-2222-4222-8222-222222222222", "2026-09-29T17:20:03.000Z"),
      });
      expect(captureQwenForkChild(c, { parentId: PARENT, launchStartedAt })).toBeNull();
    });

    it("ignores other work dirs, stale launches, and unparseable files", () => {
      const c = ctx({
        [`${QWEN_CHATS}/${ID}.runtime.json`]: status(ID, "2026-09-29T17:20:02.000Z", "/elsewhere"),
        [`${QWEN_CHATS}/33333333-3333-4333-8333-333333333333.runtime.json`]: "{broken",
      });
      expect(captureQwenForkChild(c, { parentId: PARENT, launchStartedAt })).toBeNull();
    });
  });
});
