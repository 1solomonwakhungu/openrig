// Feature 2: needs-input activity for registry CLI runtimes. classifyActivity
// reads gates (anywhere on screen), in-session prompts and busy markers (bottom
// status region), and ready markers; the seat activity sweep turns the result
// into needs-input chrome (authoritative) and pane-markers working/idle (trial).

import fs from "node:fs";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { activityMarkers } from "../src/adapters/cli/activity-markers.js";
import { harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { TUI_CLI_ACTIVITY_RUNG_INVENTORY, TMUX_GENERIC_RUNG_INVENTORY, runtimeRungInventory } from "../src/domain/activity-taxonomy.js";

const FIXTURES = nodePath.join(__dirname, "fixtures");
const read = (rel: string) => fs.readFileSync(nodePath.join(FIXTURES, rel), "utf-8");

async function classify(runtime: string, screen: string) {
  const registration = CLI_RUNTIME_REGISTRATIONS.find((r) => r.descriptor.id === runtime)!;
  const pane = mockTmux([{ command: "cli-under-test", content: screen }]);
  const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
  return adapter.classifyActivity!(harnessBinding());
}

const IDS = CLI_RUNTIME_REGISTRATIONS.map((r) => r.descriptor.id);

describe("classifyActivity on 80x24 screens", () => {
  it.each([
    ["cline", "cli-panes/cline/login-required-80x24.txt"],
    ["gemini", "gemini-family/80x24/gemini-auth.txt"],
    ["gemini", "gemini-family/80x24/gemini-trust.txt"],
    ["qwen", "gemini-family/80x24/qwen-auth.txt"],
  ])("%s gate high on the screen (%s) is needs_input", async (runtime, fixture) => {
    expect(await classify(runtime, read(fixture))).toBe("needs_input");
  });

  it.each(IDS)("%s busy marker reads as working", async (runtime) => {
    expect(activityMarkers(runtime).busyPatterns.length, runtime).toBeGreaterThan(0);
    expect(await classify(runtime, read(`cli-panes/activity/${runtime}-busy-80x24.txt`))).toBe("working");
  });

  it.each(IDS.filter((id) => id !== "aider"))("%s in-session prompt reads as needs_input", async (runtime) => {
    expect(await classify(runtime, read(`cli-panes/activity/${runtime}-prompt-80x24.txt`))).toBe("needs_input");
  });

  it("aider's mid-session (Y)es/(N)o confirm is already a gate", async () => {
    const confirm = "> fix it\n\nRun shell command? (Y)es/(N)o [Yes]: ";
    expect(await classify("aider", confirm)).toBe("needs_input");
  });

  it.each([
    ["copilot", "cli-panes/copilot-80-idle-derived.txt"],
    ["gemini", "gemini-family/80x24/gemini-ready-floor-long-cwd.txt"],
    ["qwen", "gemini-family/80x24/qwen-ready-floor-long-cwd.txt"],
    ["cline", "cli-panes/cline/home-ready-80x24.txt"],
  ])("%s ready screen reads as idle", async (runtime, fixture) => {
    expect(await classify(runtime, read(fixture))).toBe("idle");
  });

  it("an answered prompt left higher in the visible history does not read as needs_input", async () => {
    const answered = read("cli-panes/activity/gemini-prompt-80x24.txt").trimEnd().split("\n").slice(-10);
    const ready = read("gemini-family/80x24/gemini-ready-floor-long-cwd.txt").trimEnd().split("\n");
    const filler = Array.from({ length: 14 }, (_, i) => ` ✓ Shell npm test step ${i + 1}`);
    expect(await classify("gemini", [...answered, ...filler, ...ready.slice(-8)].join("\n"))).toBe("idle");
  });

  it("an old busy line above the status region does not read as working", async () => {
    const busy = " ⠋ Thinking... (esc to cancel)";
    const filler = Array.from({ length: 14 }, (_, i) => ` ● Step ${i + 1} done`);
    const ready = read("cli-panes/cline/home-ready-80x24.txt").trimEnd().split("\n").slice(-6);
    expect(await classify("cline", [busy, ...filler, ...ready].join("\n"))).toBe("idle");
  });

  it("a pane back at a shell is null, never a stale prompt", async () => {
    const registration = CLI_RUNTIME_REGISTRATIONS.find((r) => r.descriptor.id === "copilot")!;
    const pane = mockTmux([{ command: "zsh", content: read("cli-panes/activity/copilot-prompt-80x24.txt") }]);
    const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
    expect(await adapter.classifyActivity!(harnessBinding())).toBeNull();
  });

  it("no fixture is wider than 80 columns or taller than 24 rows", () => {
    for (const file of fs.readdirSync(nodePath.join(FIXTURES, "cli-panes/activity")).filter((f) => f.endsWith(".txt"))) {
      const lines = read(`cli-panes/activity/${file}`).replace(/\n$/, "").split("\n");
      expect(lines.length, file).toBeLessThanOrEqual(24);
      expect(Math.max(...lines.map((l) => [...l].length)), file).toBeLessThanOrEqual(80);
    }
  });
});

describe("seat activity sweep feeds the pane classification", () => {
  function sweepRig(states: Array<"working" | "idle" | "needs_input" | null>, runtime = "copilot") {
    let call = 0;
    const service = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => Math.floor(Date.now() / 1000) - 60 },
      defaultWindowSeconds: 3,
      paneClassifier: {
        supports: (r) => r === "copilot",
        classify: async () => states[Math.min(call++, states.length - 1)] ?? null,
      },
    });
    const db = {
      prepare: () => ({ all: () => [{ session_name: "dev-impl@rig", node_id: "node-1", runtime }] }),
    } as never;
    const state = () => service.getSeatState("node-1");
    return { service, db, state };
  }

  it("declares the TUI CLI inventory only for classified runtimes", () => {
    expect(runtimeRungInventory("copilot", true)).toBe(TUI_CLI_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("copilot", false)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory("claude-code", true).runtime).toBe("claude-code");
    expect(TUI_CLI_ACTIVITY_RUNG_INVENTORY.rungs).toEqual(expect.arrayContaining([
      expect.objectContaining({ rung: "needs-input-chrome", initialTrust: "authoritative" }),
      expect.objectContaining({ rung: "pane-markers", initialTrust: "trial" }),
    ]));
  });

  it("a visible prompt raises needs-input, and it clears on the next sweep once answered", async () => {
    const rig = sweepRig(["needs_input", "idle"]);
    await rig.service.pollAllRunningTmuxSeats(rig.db);
    expect(rig.state()).toMatchObject({ needsInput: { count: 1, reason: "prompt in pane" } });
    await rig.service.pollAllRunningTmuxSeats(rig.db);
    expect(rig.state()).toMatchObject({ needsInput: { count: 0 } });
  });

  it("a busy marker at trial never overrides sampling: an idle-sampled seat is not held at working", async () => {
    const rig = sweepRig(["working"]);
    await rig.service.pollAllRunningTmuxSeats(rig.db);
    expect(rig.state()).toMatchObject({ activity: "idle-at-prompt", needsInput: { count: 0 } });
  });

  it("runtimes the classifier does not support keep the sampling-only floor and no needs-input", async () => {
    const rig = sweepRig(["needs_input"], "some-other-cli");
    await rig.service.pollAllRunningTmuxSeats(rig.db);
    expect(rig.state()).toMatchObject({ needsInput: { count: 0 } });
  });
});

describe("rig ps and the attention reconciler see a registry seat at a gate", () => {
  /** A copilot seat whose pane shows the live 80x24 sign-in screen, classified by
   *  the real copilot adapter through a real SeatActivityService sweep. */
  async function gatedSeat() {
    const db = createFullTestDb();
    const registration = CLI_RUNTIME_REGISTRATIONS.find((r) => r.descriptor.id === "copilot")!;
    const pane = mockTmux([{ command: "copilot", content: read("cli-panes/copilot-80-idle-unauth.txt") }]);
    const adapter = registration.createAdapter(harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
    const seatActivityService = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => Math.floor(Date.now() / 1000) - 60 },
      defaultWindowSeconds: 3,
      paneClassifier: {
        supports: (runtime) => runtime === "copilot",
        classify: async (_runtime, sessionName) => adapter.classifyActivity!(harnessBinding({ tmuxSession: sessionName })),
      },
    });
    const app = createTestApp(db, { seatActivityService });
    const rig = app.rigRepo.createRig("gate-rig");
    const node = app.rigRepo.addNode(rig.id, "dev.impl", { runtime: "copilot", cwd: "/work/repo" });
    const session = app.sessionRegistry.registerSession(node.id, "dev-impl@gate-rig");
    app.sessionRegistry.updateStatus(session.id, "running");
    await seatActivityService.pollAllRunningTmuxSeats(db);
    return { db, app, rig, node, session, seatActivityService };
  }

  it("the ps node API shows needs-input and the rig rollup counts the seat for attention", async () => {
    const { db, app, rig } = await gatedSeat();
    try {
      const nodes = await (await app.app.request(`/api/rigs/${rig.id}/nodes`)).json() as Array<{ activityState?: { display: string; needsInput: { count: number } } }>;
      expect(nodes[0]!.activityState).toMatchObject({ display: "needs-input", needsInput: { count: 1 } });
      const ps = await (await app.app.request("/api/ps")).json() as Array<{ rigId: string; attentionCount: number }>;
      expect(ps.find((r) => r.rigId === rig.id)?.attentionCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("the attention reconciler refuses to clear a seat at a gate (via the app route)", async () => {
    const { db, app, session } = await gatedSeat();
    try {
      app.sessionRegistry.updateStartupStatus(session.id, "attention_required");
      const res = await app.app.request(`/api/sessions/${encodeURIComponent("dev-impl@gate-rig")}/clear-attention`, { method: "POST" });
      const body = await res.json() as { ok: boolean; code?: string; detail?: string };
      expect(body).toMatchObject({ ok: false, code: "not_demonstrably_responsive" });
      expect(body.detail).toMatch(/needs-input/);
    } finally {
      db.close();
    }
  });

  it("the reconciler types no liveness probe into a gated pane", async () => {
    const { db, app, session, seatActivityService } = await gatedSeat();
    try {
      app.sessionRegistry.updateStartupStatus(session.id, "attention_required");
      const sendVerify = vi.fn(async () => ({ ok: true, outcome: "delivered" as const }));
      const reconciler = new SeatAttentionReconciler({
        sessionRegistry: app.sessionRegistry, eventBus: app.eventBus,
        agentActivityStore: { getLatestForNode: () => null } as never,
        seatActivity: seatActivityService, sendVerify: sendVerify as never,
      });
      expect(await reconciler.clearAttention("dev-impl@gate-rig")).toMatchObject({ ok: false });
      expect(sendVerify).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

