// Shared hermetic adapter tests for the OpenCode family (opencode, kilo): the
// TUI CLI contract suite plus runtime-specific checks of the exact typed
// command, the resume-target check against a real session database, and late
// token capture. Each runtime's test file calls runOpencodeFamilyAdapterTests.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTuiCliAdapterContract } from "./tui-cli-adapter-contract.js";
import {
  HARNESS_SESSION,
  atShell,
  harnessBinding,
  harnessDeps,
  memFs,
  mockTmux,
  type PaneFrame,
} from "./tui-cli-adapter-harness.js";
import { getRuntimeDescriptor } from "../../src/domain/runtime-registry.js";
import type { CliRuntimeRegistration } from "../../src/adapters/cli/types.js";
import type { OpencodeFamilyVariant } from "../../src/adapters/cli/opencode/family.js";

const FIXTURES = nodePath.join(import.meta.dirname, "..", "fixtures", "opencode-family");
export const fixture = (name: string) => fs.readFileSync(nodePath.join(FIXTURES, name), "utf8");

export const VALID_TOKEN = "ses_0197a2f0c3d4AbCdEfGhIjKlMn";
export const MISSING_TOKEN = "ses_0197a2f0c3d5ZyXwVuTsRqPoNm";
const MODEL = "anthropic/claude-sonnet-5";

/** Write a session row into a real session database, the way the CLI does
 *  on its first prompt. Returns the session id. */
export function seedSessionDb(dbPath: string, id: string, updatedAt = Date.now()): string {
  fs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get();
    if (!hasTable) db.exec(fixture("opencode-1.18.33-session-schema.sql"));
    db.prepare(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'proj', 'slug', '/work', 'title', '1.18.33', ?, ?)",
    ).run(id, updatedAt, updatedAt);
  } finally {
    db.close();
  }
  return id;
}

export function runOpencodeFamilyAdapterTests(input: {
  variant: OpencodeFamilyVariant;
  registration: CliRuntimeRegistration;
  readyFixture: string;
}): void {
  const { variant, registration } = input;
  const readyScreen = fixture(input.readyFixture);
  const descriptor = registration.descriptor;

  it("is the registered production descriptor", () => {
    expect(getRuntimeDescriptor(variant.id)).toBe(descriptor);
  });

  runTuiCliAdapterContract({
    registration,
    readyScreen,
    earlyExit: { screen: fixture("opencode-1.18.33-session-not-found.txt"), recovery: "retry_fresh" },
    validResumeToken: VALID_TOKEN,
    invalidResumeToken: "ses_bad;touch /tmp/pwned",
    missingResumeToken: MISSING_TOKEN,
    // OpenCode refuses a model without a provider.
    modelExample: MODEL,
    seedResumeTarget: ({ seatStateDir, token }) => { seedSessionDb(nodePath.join(seatStateDir, variant.dbFileName), token); },
    seedSession: ({ seatStateDir }) => seedSessionDb(nodePath.join(seatStateDir, variant.dbFileName), VALID_TOKEN),
  });

  describe(`${variant.id} runtime specifics`, () => {
    const ready: PaneFrame = { command: variant.paneCommands[0]!, content: readyScreen };
    let root: string;
    let stateRoot: string;
    let seatStateDir: string;
    let dbPath: string;

    beforeEach(() => {
      root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `openrig-${variant.id}-specifics-`));
      stateRoot = nodePath.join(root, "state");
      seatStateDir = nodePath.join(stateRoot, variant.id, HARNESS_SESSION);
      dbPath = nodePath.join(seatStateDir, variant.dbFileName);
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function launch(frames: PaneFrame[] = [ready], env: NodeJS.ProcessEnv = {}) {
      const pane = mockTmux([atShell(), ...frames]);
      const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs(), stateRoot, env }));
      return { adapter, pane };
    }

    const dbEnv = () => `'${variant.dbEnvVar}=${dbPath}'`;

    it("types the per-seat database env, the model, and no --auto at the floor", async () => {
      const { adapter, pane } = launch();
      const result = await adapter.launchHarness(harnessBinding({ model: MODEL }), { name: "x" });
      expect(result).toMatchObject({ ok: true });
      expect(pane.typed).toEqual([`exec env ${dbEnv()} '${variant.binary}' '-m' '${MODEL}'`]);
    });

    it("maps a full_bypass policy and OPENRIG_YOLO to --auto", async () => {
      const policy = launch();
      await policy.adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
      expect(policy.pane.typed).toEqual([`exec env ${dbEnv()} '${variant.binary}' '--auto'`]);

      const yolo = launch([ready], { OPENRIG_YOLO: "1" });
      await yolo.adapter.launchHarness(harnessBinding(), { name: "x" });
      expect(yolo.pane.typed[0]).toContain("'--auto'");

      const locked = launch([ready], { OPENRIG_YOLO: "1" });
      await locked.adapter.launchHarness(harnessBinding({ launchPosture: "floor" }), { name: "x" });
      expect(locked.pane.typed[0]).not.toContain("--auto");
    });

    it("refuses a model without a provider before typing", async () => {
      const { adapter, pane } = launch();
      const result = await adapter.launchHarness(harnessBinding({ model: "claude-sonnet-5" }), { name: "x" });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toMatch(/provider\/model/);
      expect(pane.typed).toEqual([]);
    });

    it("refuses fork clearly before typing", async () => {
      expect(descriptor.supportsFork).toBe(false);
      const { adapter, pane } = launch();
      const result = await adapter.launchHarness(harnessBinding(), {
        name: "x",
        forkSource: { kind: "native_id", value: VALID_TOKEN },
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toMatch(/fork/);
      expect(pane.typed).toEqual([]);
    });

    it("resumes a session present in the seat database with -s and the same env", async () => {
      seedSessionDb(dbPath, VALID_TOKEN);
      const { adapter, pane } = launch();
      const result = await adapter.launchHarness(harnessBinding({ model: MODEL }), { name: "x", resumeToken: VALID_TOKEN });
      expect(result).toMatchObject({ ok: true, resumeToken: VALID_TOKEN, resumeType: descriptor.resumeType });
      expect(pane.typed).toEqual([`exec env ${dbEnv()} '${variant.binary}' '-m' '${MODEL}' '-s' '${VALID_TOKEN}'`]);
    });

    it("refuses as retry_fresh, before typing, when the seat database lacks the session", async () => {
      seedSessionDb(dbPath, VALID_TOKEN);
      const missingRow = launch();
      const result = await missingRow.adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: MISSING_TOKEN });
      expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
      if (!result.ok) expect(result.error).not.toContain(MISSING_TOKEN);
      expect(missingRow.pane.typed).toEqual([]);

      fs.rmSync(dbPath);
      const missingDb = launch();
      expect(await missingDb.adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: VALID_TOKEN }))
        .toMatchObject({ ok: false, recovery: "retry_fresh" });
      expect(missingDb.pane.typed).toEqual([]);
    });

    it("captures the newest session updated since launch, never an older one", async () => {
      const launchStartedAt = new Date(Date.now() - 1_000);
      const input = { sessionName: HARNESS_SESSION, seatStateDir, homedir: root, launchStartedAt };
      expect(await descriptor.captureResumeToken!(input, {})).toBeNull();

      seedSessionDb(dbPath, MISSING_TOKEN, launchStartedAt.getTime() - 60_000);
      expect(await descriptor.captureResumeToken!(input, {})).toBeNull();
      expect(await descriptor.captureResumeToken!({ ...input, launchStartedAt: undefined }, {})).toBe(MISSING_TOKEN);

      seedSessionDb(dbPath, VALID_TOKEN);
      expect(await descriptor.captureResumeToken!(input, {})).toBe(VALID_TOKEN);
    });

    it("reports the applied launch posture for permission drift", async () => {
      const floor = launch();
      const floorResult = await floor.adapter.launchHarness(harnessBinding(), { name: "x" });
      expect(floorResult).toMatchObject({ ok: true, appliedLaunch: { runtime: variant.id, axis: "permission", state: "unknown" } });
      const bypass = launch();
      const bypassResult = await bypass.adapter.launchHarness(harnessBinding({ launchPosture: "full_bypass" }), { name: "x" });
      expect(bypassResult).toMatchObject({ ok: true, appliedLaunch: { runtime: variant.id, state: "observed", value: "auto" } });
    });
  });
}
