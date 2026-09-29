// Hermetic tests for the GitHub Copilot CLI runtime pieces: launch argv and
// posture, token format, pane patterns against live captures, the on-disk
// session store, and the merge-only trust edit. No real `copilot` binary.

import nodePath from "node:path";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  buildCopilotArgv, validateCopilotSessionId, COPILOT_READY_PATTERNS, COPILOT_GATE_PATTERNS,
  parseCopilotVersion, verifyCopilotVersionOutput, copilotHome, copilotSettingsPath, copilotWorkspaceFile,
  parseCopilotWorkspaceYaml, copilotResumeTargetExists, captureCopilotSessionId, addCopilotTrustedFolder,
  type ReadOnlyFs,
} from "../src/adapters/cli/copilot/copilot-cli.js";

const ID = "0cb916db-26aa-40f2-86b5-1ba81b225fd2";
const OTHER_ID = "bdd5f092-02b7-4b34-91d1-54edf153ba32";
const HOME = "/home/user/.copilot";
const CWD = "/home/user/work";

function fixture(name: string): string {
  return readFileSync(nodePath.join(__dirname, "fixtures", "cli-panes", name), "utf-8");
}

function classify(pane: string): string {
  for (const gate of COPILOT_GATE_PATTERNS) if (gate.pattern.test(pane)) return gate.code;
  return COPILOT_READY_PATTERNS.some((p) => p.test(pane)) ? "ready" : "pending";
}

function memFs(files: Record<string, string>): ReadOnlyFs {
  return {
    exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    listFiles: (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
  };
}

function workspaceYaml(id: string, cwd: string, createdAt: string): string {
  return `id: ${id}\ncwd: ${cwd}\ngit_root: ${cwd}\nbranch: main\ncreated_at: ${createdAt}\nupdated_at: ${createdAt}\n`;
}

describe("buildCopilotArgv", () => {
  it("fresh launch mints the session id and passes the model; floor adds no permission flag", () => {
    expect(buildCopilotArgv({ posture: "floor", newSessionId: ID, model: "gpt-5.4" }))
      .toEqual(["copilot", "--session-id", ID, "--model", "gpt-5.4"]);
  });

  it("full_bypass maps to --yolo and floor never passes it", () => {
    expect(buildCopilotArgv({ posture: "full_bypass", newSessionId: ID })).toContain("--yolo");
    const floor = buildCopilotArgv({ posture: "floor", newSessionId: ID });
    expect(floor).not.toContain("--yolo");
    expect(floor).not.toContain("--allow-all");
  });

  it("resume uses the exact-id form, never the bare picker", () => {
    const argv = buildCopilotArgv({ posture: "floor", resumeToken: ID });
    expect(argv).toEqual(["copilot", `--resume=${ID}`]);
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--continue");
  });

  it("refuses fork, malformed tokens, mixed fresh/resume, and flag-like models", () => {
    expect(() => buildCopilotArgv({ posture: "floor", forkSource: { kind: "native_id", value: ID } }))
      .toThrow(/no native fork primitive/);
    expect(() => buildCopilotArgv({ posture: "floor", resumeToken: "abc; rm -rf /" })).toThrow(/lowercase UUID/);
    expect(() => buildCopilotArgv({ posture: "floor", resumeToken: ID, newSessionId: OTHER_ID })).toThrow(/mutually exclusive/);
    expect(() => buildCopilotArgv({ posture: "floor", model: "--yolo" })).toThrow(/must not start with '-'/);
  });

  it("ignores a blank model and honors a resolved binary path", () => {
    expect(buildCopilotArgv({ posture: "floor", model: "  ", binary: "/opt/copilot/bin/copilot" }))
      .toEqual(["/opt/copilot/bin/copilot"]);
  });
});

describe("validateCopilotSessionId", () => {
  it("accepts a lowercase UUID (trimmed) and rejects anything else without echoing it", () => {
    expect(validateCopilotSessionId(` ${ID}\n`)).toEqual({ ok: true, token: ID });
    const bad = validateCopilotSessionId("SECRET-TOKEN-VALUE");
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("SECRET");
    expect(validateCopilotSessionId(ID.toUpperCase()).ok).toBe(false);
  });
});

describe("Copilot pane patterns (live captures)", () => {
  it("first run in an untrusted folder is a trust gate", () => {
    expect(classify(fixture("copilot-first-run.txt"))).toBe("trust_gate");
  });

  it("an unauthenticated idle prompt is login_required, not ready", () => {
    expect(classify(fixture("copilot-idle-unauth.txt"))).toBe("login_required");
    expect(classify(fixture("copilot-after-trust.txt"))).toBe("login_required");
  });

  it("the idle footer is ready once signed in", () => {
    expect(classify(fixture("copilot-idle-derived.txt"))).toBe("ready");
  });

  it("gate codes are attention-required readiness codes", async () => {
    const { ATTENTION_REQUIRED_READINESS_CODES } = await import("../src/domain/runtime-adapter.js");
    for (const gate of COPILOT_GATE_PATTERNS) expect(ATTENTION_REQUIRED_READINESS_CODES.has(gate.code)).toBe(true);
  });
});

describe("Copilot version identity", () => {
  it("parses the Copilot banner and rejects other CLIs", () => {
    expect(parseCopilotVersion("GitHub Copilot CLI 1.0.89.\nRun 'copilot update' to check for updates.")).toBe("1.0.89");
    expect(verifyCopilotVersionOutput("GitHub Copilot CLI 1.0.89.")).toBeNull();
    expect(verifyCopilotVersionOutput("grok 1.0.25 (f7e67d6988e2)")).toMatch(/install it with/);
  });
});

describe("Copilot session store", () => {
  it("resolves COPILOT_HOME over the default and builds store paths", () => {
    expect(copilotHome({}, "/home/user")).toBe("/home/user/.copilot");
    expect(copilotHome({ COPILOT_HOME: " /data/copilot " }, "/home/user")).toBe("/data/copilot");
    expect(copilotSettingsPath(HOME)).toBe(`${HOME}/settings.json`);
    expect(copilotWorkspaceFile(HOME, ID)).toBe(`${HOME}/session-state/${ID}/workspace.yaml`);
  });

  it("parses the live workspace.yaml shape", () => {
    expect(parseCopilotWorkspaceYaml(workspaceYaml(ID, CWD, "2026-09-29T17:14:50.458Z")))
      .toEqual({ id: ID, cwd: CWD, createdAt: "2026-09-29T17:14:50.458Z" });
    expect(parseCopilotWorkspaceYaml("cwd: /x\n")).toBeNull();
  });

  it("a resume target exists only when its workspace.yaml names the same id", () => {
    const fs = memFs({ [copilotWorkspaceFile(HOME, ID)]: workspaceYaml(ID, CWD, "2026-09-29T17:14:50Z") });
    expect(copilotResumeTargetExists(fs, HOME, ID)).toBe(true);
    expect(copilotResumeTargetExists(fs, HOME, OTHER_ID)).toBe(false);
    expect(copilotResumeTargetExists(fs, HOME, "not-a-uuid")).toBe(false);
    const mismatched = memFs({ [copilotWorkspaceFile(HOME, ID)]: workspaceYaml(OTHER_ID, CWD, "2026-09-29T17:14:50Z") });
    expect(copilotResumeTargetExists(mismatched, HOME, ID)).toBe(false);
  });

  it("capture confirms a minted id on disk, and is null until Copilot writes it", () => {
    expect(captureCopilotSessionId({ fs: memFs({}), home: HOME, cwd: CWD, mintedSessionId: ID })).toBeNull();
    const fs = memFs({ [copilotWorkspaceFile(HOME, ID)]: workspaceYaml(ID, CWD, "2026-09-29T17:14:50Z") });
    expect(captureCopilotSessionId({ fs, home: HOME, cwd: CWD, mintedSessionId: ID })).toBe(ID);
  });

  it("capture without a minted id picks the unique session for this cwd since launch, else null", () => {
    const since = new Date("2026-09-29T17:00:00Z");
    const files = {
      [copilotWorkspaceFile(HOME, ID)]: workspaceYaml(ID, CWD, "2026-09-29T17:14:50Z"),
      [copilotWorkspaceFile(HOME, OTHER_ID)]: workspaceYaml(OTHER_ID, "/elsewhere", "2026-09-29T17:15:00Z"),
      [`${HOME}/session-state/${ID}/checkpoints/index.md`]: "x",
    };
    expect(captureCopilotSessionId({ fs: memFs(files), home: HOME, cwd: CWD, launchStartedAt: since })).toBe(ID);
    expect(captureCopilotSessionId({ fs: memFs(files), home: HOME, cwd: CWD, launchStartedAt: new Date("2026-09-29T18:00:00Z") })).toBeNull();
    const ambiguous = { ...files, [copilotWorkspaceFile(HOME, OTHER_ID)]: workspaceYaml(OTHER_ID, CWD, "2026-09-29T17:15:00Z") };
    expect(captureCopilotSessionId({ fs: memFs(ambiguous), home: HOME, cwd: CWD, launchStartedAt: since })).toBeNull();
  });

  it("capture never throws on a broken store", () => {
    const fs: ReadOnlyFs = { exists: () => true, readFile: () => { throw new Error("EACCES"); }, listFiles: () => [`${ID}/workspace.yaml`] };
    expect(captureCopilotSessionId({ fs, home: HOME, cwd: CWD })).toBeNull();
  });
});

describe("addCopilotTrustedFolder", () => {
  it("creates the entry when settings.json is absent or empty", () => {
    expect(JSON.parse(addCopilotTrustedFolder(null, CWD)!)).toEqual({ trustedFolders: [CWD] });
    expect(JSON.parse(addCopilotTrustedFolder("  \n", CWD)!)).toEqual({ trustedFolders: [CWD] });
  });

  it("appends to existing folders and keeps every other key", () => {
    const next = addCopilotTrustedFolder(JSON.stringify({ model: "gpt-5.4", trustedFolders: ["/a"] }), CWD);
    expect(JSON.parse(next!)).toEqual({ model: "gpt-5.4", trustedFolders: ["/a", CWD] });
  });

  it("does not write when already trusted or when the file is not safe to merge", () => {
    expect(addCopilotTrustedFolder(JSON.stringify({ trustedFolders: [CWD] }), CWD)).toBeNull();
    expect(addCopilotTrustedFolder("// comment\n{}", CWD)).toBeNull();
    expect(addCopilotTrustedFolder("[]", CWD)).toBeNull();
    expect(addCopilotTrustedFolder(JSON.stringify({ trustedFolders: "/a" }), CWD)).toBeNull();
    expect(addCopilotTrustedFolder(JSON.stringify({ trustedFolders: [1] }), CWD)).toBeNull();
  });
});
