// Visible trust answers: seat status reports the dialogs OpenRig answered for
// the seat's current launch, read from the launch record the TUI CLI base
// writes (TuiCliGateAnswer -> launch.json gateAnswers).

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { LAUNCH_RECORD_FILE, seatStateDirFor } from "../src/domain/runtime-capture.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";

const SESSION = "dev-impl@seat-rig";
const ANSWER = { code: "trust_gate", option: "Yes", describe: "trusted the seat's cwd for this Copilot session only", answeredAt: "2026-10-03T03:30:00.000Z" };

describe("seat status trust answers", () => {
  let db: Database.Database;
  let stateRoot: string;
  let service: SeatStatusService;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    stateRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-trust-answers-"));
    service = new SeatStatusService({ rigRepo, stateRoot });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  function seat(runtime: string) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime, cwd: "/work/repo" });
    registry.registerSession(node.id, SESSION);
  }

  function writeRecord(runtime: string, record: Record<string, unknown>) {
    const dir = seatStateDirFor(stateRoot, runtime, SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, LAUNCH_RECORD_FILE), JSON.stringify(record));
  }

  function trustAnswers() {
    const result = service.getStatus(SESSION);
    if (!result.ok) throw new Error(result.message);
    return result.status.trust_answers;
  }

  it("reports the trust answer recorded for the current launch with a plain summary", () => {
    seat("copilot");
    writeRecord("copilot", { sessionName: SESSION, cwd: "/work/repo", runtimeId: "copilot", gateAnswers: [ANSWER] });
    expect(trustAnswers()).toEqual([{
      code: "trust_gate", option: "Yes", describe: ANSWER.describe, answeredAt: ANSWER.answeredAt,
      folder: "/work/repo", runtime: "copilot", summary: "OpenRig trusted /work/repo for this session (copilot)",
    }]);
  });

  it("is empty with no launch record, no answers, or a record for another session", () => {
    seat("copilot");
    expect(trustAnswers()).toEqual([]);
    writeRecord("copilot", { sessionName: SESSION, cwd: "/work/repo" });
    expect(trustAnswers()).toEqual([]);
    writeRecord("copilot", { sessionName: "someone-else@seat-rig", cwd: "/work/repo", gateAnswers: [ANSWER] });
    expect(trustAnswers()).toEqual([]);
  });

  it("ignores a corrupt record and malformed entries rather than failing status", () => {
    seat("copilot");
    const dir = seatStateDirFor(stateRoot, "copilot", SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, LAUNCH_RECORD_FILE), "{ not json");
    expect(trustAnswers()).toEqual([]);
    writeRecord("copilot", { sessionName: SESSION, cwd: "/work/repo", gateAnswers: [null, { code: 7 }, ANSWER] });
    expect(trustAnswers().map((a) => a.code)).toEqual(["trust_gate"]);
  });

  it("built-in runtimes without launch records report none", () => {
    seat("codex");
    expect(trustAnswers()).toEqual([]);
  });

  it("whoami carries the same answers, and omits the key when there are none", () => {
    seat("copilot");
    const whoami = new WhoamiService({
      db, rigRepo, sessionRegistry: registry,
      transcriptStore: new TranscriptStore({ transcriptsRoot: nodePath.join(stateRoot, "transcripts"), enabled: false }),
      runtimeStateRoot: stateRoot,
    });
    expect(whoami.resolve({ sessionName: SESSION, compact: true })).not.toHaveProperty("trustAnswers");
    writeRecord("copilot", { sessionName: SESSION, cwd: "/work/repo", gateAnswers: [ANSWER] });
    expect(whoami.resolve({ sessionName: SESSION, compact: true })?.trustAnswers).toEqual([
      expect.objectContaining({ code: "trust_gate", summary: "OpenRig trusted /work/repo for this session (copilot)" }),
    ]);
  });

  it("app routes for seat status and whoami read the app's state root, which defaults to a temp dir", async () => {
    const { app, rigRepo: repo, sessionRegistry, runtimeStateRoot } = createTestApp(db);
    expect(nodePath.resolve(runtimeStateRoot).startsWith(nodePath.resolve(os.tmpdir()))).toBe(true);
    const rig = repo.createRig("app-rig");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "copilot", cwd: "/work/repo" });
    sessionRegistry.registerSession(node.id, "dev-impl@app-rig");
    const status = async () => (await (await app.request(`/api/seat/status/${encodeURIComponent("dev-impl@app-rig")}`)).json()) as { trust_answers: unknown[] };
    const whoami = async () => (await (await app.request(`/api/whoami?sessionName=${encodeURIComponent("dev-impl@app-rig")}&compact=1`)).json()) as { trustAnswers?: unknown[] };
    expect((await status()).trust_answers).toEqual([]);
    expect(await whoami()).not.toHaveProperty("trustAnswers");
    const dir = seatStateDirFor(runtimeStateRoot, "copilot", "dev-impl@app-rig");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, LAUNCH_RECORD_FILE), JSON.stringify({ sessionName: "dev-impl@app-rig", cwd: "/work/repo", gateAnswers: [ANSWER] }));
    const summary = "OpenRig trusted /work/repo for this session (copilot)";
    expect((await status()).trust_answers).toEqual([expect.objectContaining({ summary })]);
    expect((await whoami()).trustAnswers).toEqual([expect.objectContaining({ summary })]);
    fs.rmSync(runtimeStateRoot, { recursive: true, force: true });
  });
});
