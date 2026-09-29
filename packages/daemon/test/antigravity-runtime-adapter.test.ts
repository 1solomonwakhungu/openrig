// Antigravity CLI (agy) runtime adapter: the shared TUI CLI contract plus
// agy-specific argv, resume target, and the guarded late capture from agy's
// last-conversation cache. Hermetic: no agy binary, no network. Pane text is
// from agy 1.1.27 binary strings (the TUI was not launched; see the runtime doc).

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_DESCRIPTOR, ANTIGRAVITY_REGISTRATION, ANTIGRAVITY_SPEC, antigravityAppDir, antigravityConversationPath,
  validateAntigravityConversationId,
} from "../src/adapters/cli/antigravity/index.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE } from "../src/domain/runtime-capture.js";
import { runTuiCliAdapterContract } from "./helpers/tui-cli-adapter-contract.js";
import { HARNESS_SESSION, atShell, harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

const READY = "  Antigravity CLI\n\n  > \n  [accept-edits]                                  ? for shortcuts";
const TOKEN = "5f0c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f";

function seedConversation(homedir: string, id: string, cwd?: string): void {
  fs.mkdirSync(nodePath.dirname(antigravityConversationPath(homedir, id)), { recursive: true });
  fs.writeFileSync(antigravityConversationPath(homedir, id), "");
  if (cwd) {
    const cache = nodePath.join(antigravityAppDir(homedir), "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(nodePath.join(cache, "last_conversations.json"), JSON.stringify({ [cwd]: id }));
  }
}

runTuiCliAdapterContract({
  registration: ANTIGRAVITY_REGISTRATION,
  readyScreen: READY,
  gateScreens: [
    { screen: "  Do you trust the contents of this project?\n  > Yes   No", code: "trust_gate" },
    { screen: "  Select login method:\n  > Google account\n    Other sign-in options", code: "login_required" },
    { screen: "Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/o/oauth2/auth?x\nWaiting for authentication (timeout 60s)...", code: "login_required" },
  ],
  errorScreens: ["[Auth Error] failed to refresh token"],
  earlyExit: { screen: "Error: conversation not found", recovery: "retry_fresh" },
  validResumeToken: TOKEN,
  invalidResumeToken: "latest; rm -rf /",
  missingResumeToken: "5f0c2a1e-0000-4000-8000-000000000000",
  seedResumeTarget: ({ homedir, token }) => seedConversation(homedir, token),
  seedSession: ({ homedir, cwd }) => {
    seedConversation(homedir, TOKEN, cwd);
    return TOKEN;
  },
});

describe("antigravity adapter", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  function dirs() {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-agy-"));
    roots.push(root);
    const home = nodePath.join(root, "home");
    const runtimeDir = nodePath.join(root, "state", "antigravity");
    return { home, runtimeDir, seat: nodePath.join(runtimeDir, HARNESS_SESSION), cwd: "/work/project" };
  }
  function launch() {
    const pane = mockTmux([atShell(), { command: "agy", content: READY }]);
    return { pane, adapter: new TuiCliRuntimeAdapter(ANTIGRAVITY_SPEC, harnessDeps({ tmux: pane.tmux, fsOps: memFs() })) };
  }
  function launchRecord(seat: string, cwd: string, at: Date): void {
    fs.mkdirSync(seat, { recursive: true });
    fs.writeFileSync(nodePath.join(seat, LAUNCH_RECORD_FILE), JSON.stringify({ cwd, launchStartedAt: at.toISOString() }));
  }

  it("is registered in production", () => {
    expect(getRuntimeDescriptor("antigravity")).toBe(ANTIGRAVITY_DESCRIPTOR);
  });

  it("launches with the floor posture and no browser, and cannot know the token yet", async () => {
    const { pane, adapter } = launch();
    expect(await adapter.launchHarness(harnessBinding(), { name: "x" })).toEqual({ ok: true });
    expect(pane.typed[0]).toBe("exec env 'BROWSER=true' 'agy' '--mode' 'accept-edits'");
  });

  it("maps full_bypass to --dangerously-skip-permissions, passes the model, resumes by conversation", async () => {
    const bypass = launch();
    await bypass.adapter.launchHarness(harnessBinding({ model: "gemini-3.5-flash-medium", launchPosture: "full_bypass" }), { name: "x" });
    expect(bypass.pane.typed[0]).toBe("exec env 'BROWSER=true' 'agy' '--model' 'gemini-3.5-flash-medium' '--dangerously-skip-permissions'");
    const { home } = dirs();
    seedConversation(home, TOKEN);
    const pane = mockTmux([atShell(), { command: "agy", content: READY }]);
    const adapter = new TuiCliRuntimeAdapter(ANTIGRAVITY_SPEC, harnessDeps({ tmux: pane.tmux, fsOps: memFs(), homedir: home }));
    expect(await adapter.launchHarness(harnessBinding(), { name: "x", resumeToken: TOKEN })).toEqual({ ok: true, resumeToken: TOKEN, resumeType: "antigravity_conversation_id" });
    expect(pane.typed[0]!.endsWith(`'--mode' 'accept-edits' '--conversation' '${TOKEN}'`)).toBe(true);
  });

  it("fails toward attention_required, never a false ready, on an unrecognized or initializing screen", async () => {
    for (const content of ["  initializing...\n  ? for shortcuts", "  Antigravity CLI\n  loading workspace"]) {
      const pane = mockTmux([atShell(), { command: "agy", content }]);
      const adapter = new TuiCliRuntimeAdapter(ANTIGRAVITY_SPEC, harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
      const result = await adapter.launchHarness(harnessBinding(), { name: "x" });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required", evidence: expect.stringContaining(content.split("\n")[1]!.trim()) });
    }
  });

  it("validates conversation ids as UUIDs", () => {
    expect(validateAntigravityConversationId(TOKEN.toUpperCase())).toEqual({ ok: true, token: TOKEN });
    expect(validateAntigravityConversationId("-c").ok).toBe(false);
  });

  describe("late capture from last_conversations.json", () => {
    const capture = (d: ReturnType<typeof dirs>, launchStartedAt?: Date) =>
      ANTIGRAVITY_DESCRIPTOR.captureResumeToken!({ sessionName: HARNESS_SESSION, cwd: d.cwd, seatStateDir: d.seat, homedir: d.home, launchStartedAt }, {});

    it("returns the workspace's last conversation when written after the launch", async () => {
      const d = dirs();
      const launchedAt = new Date(Date.now() - 60_000);
      launchRecord(d.seat, d.cwd, launchedAt);
      expect(await capture(d, launchedAt)).toBeNull(); // lazy: nothing yet
      seedConversation(d.home, TOKEN, d.cwd);
      expect(await capture(d, launchedAt)).toBe(TOKEN);
    });

    it("ignores another workspace's entry and a conversation older than the launch", async () => {
      const d = dirs();
      seedConversation(d.home, TOKEN, "/some/other/repo");
      expect(await capture(d)).toBeNull();
      seedConversation(d.home, TOKEN, d.cwd);
      expect(await capture(d, new Date(Date.now() + 60_000))).toBeNull();
    });

    it("is ambiguous (null) when another agy seat launched in the same cwd recently", async () => {
      const d = dirs();
      const launchedAt = new Date(Date.now() - 60_000);
      launchRecord(d.seat, d.cwd, launchedAt);
      seedConversation(d.home, TOKEN, d.cwd);
      launchRecord(nodePath.join(d.runtimeDir, "dev-review@rig"), d.cwd, new Date(Date.now() - 30_000));
      expect(await capture(d, launchedAt)).toBeNull();
    });

    it("ignores a sibling seat from long ago or in another cwd", async () => {
      const d = dirs();
      const launchedAt = new Date(Date.now() - 60_000);
      launchRecord(d.seat, d.cwd, launchedAt);
      seedConversation(d.home, TOKEN, d.cwd);
      launchRecord(nodePath.join(d.runtimeDir, "old@rig"), d.cwd, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
      launchRecord(nodePath.join(d.runtimeDir, "elsewhere@rig"), "/other", new Date());
      expect(await capture(d, launchedAt)).toBe(TOKEN);
    });
  });
});
