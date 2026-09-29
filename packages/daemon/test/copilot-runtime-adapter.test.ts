// Hermetic tests for the GitHub Copilot CLI runtime adapter: the shared TUI
// CLI contract, launch argv and posture, token format, pane patterns against
// live captures, the on-disk session store, and folder-trust provisioning.
// No real `copilot` binary.

import fs, { readFileSync } from "node:fs";
import nodePath from "node:path";
import { describe, it, expect } from "vitest";
import { COPILOT_REGISTRATION, COPILOT_SEAT_FILE, COPILOT_SPEC } from "../src/adapters/cli/copilot/index.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { processMatches } from "../src/domain/session-fingerprinter.js";
import {
  HARNESS_CWD, HARNESS_HOME, HARNESS_SESSION, HARNESS_STATE_ROOT, atShell, harnessBinding, harnessDeps, memFs as harnessMemFs, mockTmux,
} from "./helpers/tui-cli-adapter-harness.js";
import {
  buildCopilotArgv, validateCopilotSessionId, COPILOT_READY_PATTERNS, COPILOT_GATE_PATTERNS,
  parseCopilotVersion, verifyCopilotVersionOutput, copilotHome, copilotSettingsPath, copilotWorkspaceFile,
  parseCopilotWorkspaceYaml, copilotResumeTargetExists, captureCopilotSessionId,
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

  it("a stale sign-in prompt with later output above the input box no longer gates", () => {
    expect(classify(fixture("copilot-after-login-derived.txt"))).toBe("ready");
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

// ── adapter on the TUI CLI base ─────────────────────────────────────────────

const READY = fixture("copilot-idle-derived.txt");
const SEEDED_ID = "5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

function workspaceFileUnder(homedir: string, id: string): string {
  return copilotWorkspaceFile(nodePath.join(homedir, ".copilot"), id);
}

runTuiCliAdapterContract({
  registration: COPILOT_REGISTRATION,
  readyScreen: READY,
  gateScreens: [
    { screen: fixture("copilot-first-run.txt"), code: "trust_gate" },
    { screen: fixture("copilot-idle-unauth.txt"), code: "login_required" },
  ],
  earlyExit: {
    // Live output of `copilot --resume=<unknown id>`, which then exits 1.
    screen: `Error: No session, task, or name matched '${MISSING_ID}'.\nTo resume by session or task ID:  copilot --resume=<id>`,
    recovery: "retry_fresh",
  },
  validResumeToken: SEEDED_ID,
  invalidResumeToken: "not-a-uuid; rm -rf /",
  missingResumeToken: MISSING_ID,
  modelExample: "gpt-5.4",
  seedResumeTarget: ({ fs: files, homedir, cwd, token }) => {
    const file = workspaceFileUnder(homedir, token);
    files.mkdirp(nodePath.dirname(file));
    files.writeFile(file, workspaceYaml(token, cwd, "2026-09-29T12:00:00Z"));
  },
  // Copilot is not lazy: the minted id is the token. Seeding writes the
  // session-state record Copilot creates at startup for that id.
  seedSession: ({ seatStateDir, cwd, homedir }) => {
    const launch = JSON.parse(fs.readFileSync(nodePath.join(seatStateDir, "launch.json"), "utf-8")) as { presetToken: string };
    const file = workspaceFileUnder(homedir, launch.presetToken);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, workspaceYaml(launch.presetToken, cwd, new Date().toISOString()));
    return launch.presetToken;
  },
});

describe("Copilot adapter launch", () => {
  const SETTINGS = nodePath.join(HARNESS_HOME, ".copilot", "settings.json");
  const running = { command: "copilot", content: READY };

  function launch(files = harnessMemFs(), env: NodeJS.ProcessEnv = {}) {
    const pane = mockTmux([atShell(), running]);
    const adapter = COPILOT_REGISTRATION.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: files, env }));
    return { adapter, pane, files };
  }

  it("mints the session id, types it, and reports it as the resume token", async () => {
    const { adapter, pane } = launch();
    const result = await adapter.launchHarness(harnessBinding({ model: "gpt-5.4" }), { name: "x" });
    expect(result.ok).toBe(true);
    const token = result.ok ? result.resumeToken : undefined;
    expect(validateCopilotSessionId(token ?? "").ok).toBe(true);
    expect(pane.typed[0]).toContain(`'--session-id' '${token}'`);
    expect(pane.typed[0]).toContain("'--model' 'gpt-5.4'");
    expect(pane.typed[0]).not.toContain("--yolo");
  });

  it("full_bypass types --yolo", async () => {
    const { adapter, pane } = launch();
    await adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
    expect(pane.typed[0]).toContain("--yolo");
  });

  it("trusts the seat cwd in the owner settings, merge-only", async () => {
    const files = harnessMemFs({ [SETTINGS]: JSON.stringify({ model: "gpt-5.4", trustedFolders: ["/elsewhere"] }) });
    await launch(files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(JSON.parse(files.files[SETTINGS]!)).toEqual({ model: "gpt-5.4", trustedFolders: ["/elsewhere", HARNESS_CWD] });
  });

  it("honors COPILOT_HOME for the settings file", async () => {
    const files = harnessMemFs();
    await launch(files, { COPILOT_HOME: "/data/copilot" }).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(JSON.parse(files.files["/data/copilot/settings.json"]!)).toEqual({ trustedFolders: [HARNESS_CWD] });
    expect(files.files[SETTINGS]).toBeUndefined();
  });

  it("leaves an unparseable settings file untouched and still launches", async () => {
    const files = harnessMemFs({ [SETTINGS]: "// user comment\n{ \"trustedFolders\": [] }" });
    const result = await launch(files).adapter.launchHarness(harnessBinding(), { name: "x" });
    expect(result.ok).toBe(true);
    expect(files.files[SETTINGS]).toBe("// user comment\n{ \"trustedFolders\": [] }");
  });

  it("records the COPILOT_HOME the launch resolved; capture and the resume check use it", async () => {
    const files = harnessMemFs();
    const { adapter } = launch(files, { COPILOT_HOME: "/data/copilot" });
    const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
    const token = result.ok ? result.resumeToken! : "";
    const seatStateDir = nodePath.join(HARNESS_STATE_ROOT, "copilot", HARNESS_SESSION);
    expect(JSON.parse(files.files[nodePath.join(seatStateDir, COPILOT_SEAT_FILE)]!)).toEqual({ copilotHome: "/data/copilot" });
    files.writeFile(copilotWorkspaceFile("/data/copilot", token), workspaceYaml(token, HARNESS_CWD, "2026-09-29T12:00:00Z"));
    // The daemon env has no COPILOT_HOME; the recorded one still finds the session.
    const check = await COPILOT_SPEC.validateResumeTarget!({
      token, cwd: HARNESS_CWD, seatStateDir, homedir: HARNESS_HOME, fs: files, binding: harnessBinding(),
    });
    expect(check).toEqual({ ok: true });
    const missing = await COPILOT_SPEC.validateResumeTarget!({
      token, cwd: HARNESS_CWD, seatStateDir: "/nowhere", homedir: HARNESS_HOME, fs: files, binding: harnessBinding(),
    });
    expect(missing).toMatchObject({ ok: false });
  });

  it("resumes an existing session by exact id without minting a new one", async () => {
    const files = harnessMemFs({ [workspaceFileUnder(HARNESS_HOME, SEEDED_ID)]: workspaceYaml(SEEDED_ID, HARNESS_CWD, "2026-09-29T12:00:00Z") });
    const { adapter, pane } = launch(files);
    const result = await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: SEEDED_ID });
    expect(result).toMatchObject({ ok: true, resumeToken: SEEDED_ID, resumeType: "copilot_session_id" });
    expect(pane.typed[0]).toContain(`--resume=${SEEDED_ID}`);
    expect(pane.typed[0]).not.toContain("--session-id");
  });

  it("describes discovery identity without claiming the generic node host", () => {
    const d = COPILOT_REGISTRATION.descriptor;
    expect(d.paneCommands).toEqual(["copilot"]);
    const matches = (command: string) => processMatches(command, d.processMatch!);
    expect(matches("node /opt/tools/node_modules/.bin/copilot --no-auto-update")).toBe(true);
    expect(matches("node /usr/local/lib/node_modules/@github/copilot/npm-loader.js")).toBe(true);
    expect(matches("/opt/tools/node_modules/@github/copilot-darwin-arm64/copilot --session-id x")).toBe(true);
    expect(matches("/opt/homebrew/bin/copilot")).toBe(true);
    expect(matches("node /home/u/code/copilot/server.js")).toBe(false);
    expect(matches("node /usr/local/bin/opencode --prompt copilot")).toBe(false);
    expect(matches("gh copilot suggest")).toBe(false);
    expect(d.reapProcessTreeOnStop).toBe(true);
  });
});
