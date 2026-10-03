// F1 capability hooks: the type contract each feature PR implements, the
// never-throw runners every consumer calls, the pure model-shape check, and
// the TUI base's pane activity classifier. No core consumer is wired here.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_TIMEOUTS_MS, checkModelShape, runDescriptorAuthStatus, runDescriptorTranscriptRead, runDescriptorUsageRead,
  type RuntimeAuthContext, type RuntimeModelShape, type RuntimeUsageInput,
} from "../src/domain/runtime-capabilities.js";
import { LAUNCH_RECORD_FILE } from "../src/domain/runtime-capture.js";
import { BUILTIN_RUNTIME_IDS, getRuntimeDescriptor, type RuntimeDescriptor } from "../src/domain/runtime-registry.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { ACTIVITY_STATUS_LINES, TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { EXAMPLE_CLI_DESCRIPTOR, EXAMPLE_CLI_SPEC } from "./helpers/example-cli-runtime.js";
import { harnessBinding, harnessDeps, memFs, mockTmux, type PaneFrame } from "./helpers/tui-cli-adapter-harness.js";

const SEAT: RuntimeUsageInput = { sessionName: "dev@rig", cwd: "/w", seatStateDir: "/nonexistent/seat", homedir: "/home/x", resumeToken: null };
const descriptor = (extra: Partial<RuntimeDescriptor>): RuntimeDescriptor => ({ ...EXAMPLE_CLI_DESCRIPTOR, ...extra });

describe("capability hooks on existing runtimes", () => {
  // Built-ins only: feature PRs add hooks to the CLI registrations.
  it("changes no existing runtime: no built-in declares a capability hook", () => {
    for (const id of BUILTIN_RUNTIME_IDS) {
      const d = getRuntimeDescriptor(id);
      expect(d, id).toBeDefined();
      if (!d) continue;
      expect([d.readUsage, d.authStatus, d.modelShape, d.docsPath, d.readTranscript].every((hook) => hook === undefined), d.id).toBe(true);
    }
  });
});

describe("runners never throw", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

  it("usage: null without a reader, the snapshot when present, null plus a log on a throw", async () => {
    expect(await runDescriptorUsageRead(descriptor({}), SEAT)).toBeNull();
    const snapshot = { inputTokens: 10, observedAt: "2026-10-03T03:00:00.000Z", source: "example_json" };
    expect(await runDescriptorUsageRead(descriptor({ readUsage: async () => snapshot }), SEAT)).toEqual(snapshot);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runDescriptorUsageRead(descriptor({ readUsage: () => { throw new Error("db locked"); } }), SEAT)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("readUsage failed for dev@rig: Error"));
    expect(String(warn.mock.calls[0]![0])).not.toContain("db locked");
    warn.mockRestore();
  });

  it("usage: keeps a cost only with its provenance", async () => {
    const base = { inputTokens: 10, observedAt: "2026-10-03T03:00:00.000Z", source: "example_json" };
    for (const costSource of ["cli_reported", "estimated"] as const) {
      expect(await runDescriptorUsageRead(descriptor({ readUsage: () => ({ ...base, costUsd: 0.42, costSource }) }), SEAT))
        .toEqual({ ...base, costUsd: 0.42, costSource });
    }
    expect(await runDescriptorUsageRead(descriptor({ readUsage: () => ({ ...base, costUsd: 0.42 }) }), SEAT)).toEqual(base);
  });

  it("usage: fills launchStartedAt from the seat's launch.json and homedir when omitted", async () => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-cap-"));
    fs.writeFileSync(nodePath.join(root, LAUNCH_RECORD_FILE), JSON.stringify({ launchStartedAt: "2026-10-03T02:00:00.000Z" }));
    const seen: RuntimeUsageInput[] = [];
    await runDescriptorUsageRead(descriptor({ readUsage: (input) => { seen.push(input); return null; } }), { ...SEAT, seatStateDir: root, homedir: "" });
    expect(seen[0]!.launchStartedAt?.toISOString()).toBe("2026-10-03T02:00:00.000Z");
    expect(seen[0]!.homedir).toBe(os.homedir());
  });

  it("auth: unknown without a check, the status when present, unknown with detail on a throw", async () => {
    const ctx: RuntimeAuthContext = { homedir: "/home/x", env: {}, fs: { exists: () => false, readFile: () => null } };
    expect(await runDescriptorAuthStatus(descriptor({}), ctx)).toEqual({ state: "unknown" });
    expect(await runDescriptorAuthStatus(descriptor({ authStatus: () => ({ state: "signed_in", source: "env EXAMPLE_API_KEY" }) }), ctx))
      .toEqual({ state: "signed_in", source: "env EXAMPLE_API_KEY" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runDescriptorAuthStatus(descriptor({ authStatus: async () => { throw new Error("EACCES"); } }), ctx))
      .toEqual({ state: "unknown", detail: "sign-in check failed: Error" });
    const denied = Object.assign(new Error("EACCES: permission denied, open '/home/x/.example/auth.json'"), { code: "EACCES" });
    expect(await runDescriptorAuthStatus(descriptor({ authStatus: () => { throw denied; } }), ctx))
      .toEqual({ state: "unknown", detail: "sign-in check failed: Error (EACCES)" });
    warn.mockRestore();
  });

  it("never surfaces key text: a malformed credential file's JSON.parse error stays out of logs and detail", async () => {
    const key = "sk-test-FAKEKEY0123456789abcdefFAKE";
    const ctx: RuntimeAuthContext = {
      homedir: "/home/x", env: {},
      fs: { exists: () => true, readFile: () => `{"api_key": ${key}}` }, // unquoted value: invalid JSON
    };
    const parsing = descriptor({ authStatus: (c) => { JSON.parse(c.fs.readFile("/home/x/.example/auth.json") ?? ""); return { state: "signed_in" }; } });
    const usage = descriptor({ readUsage: () => JSON.parse(`{"token": ${key}}`) });
    const transcript = descriptor({ readTranscript: () => JSON.parse(`{"text": ${key}}`) });
    // Precondition: the raw parse error does quote the key, so the runner's filtering is what is under test.
    expect(() => JSON.parse(`{"api_key": ${key}}`)).toThrow(/FAKEKEY|sk-test/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const status = await runDescriptorAuthStatus(parsing, ctx);
    expect(status).toEqual({ state: "unknown", detail: "sign-in check failed: SyntaxError" });
    expect(await runDescriptorUsageRead(usage, SEAT)).toBeNull();
    expect(await runDescriptorTranscriptRead(transcript, SEAT)).toBeNull();
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warn).toHaveBeenCalledTimes(3);
    for (const text of [logged, JSON.stringify(status)]) {
      expect(text).not.toContain("FAKEKEY");
      expect(text).not.toContain("sk-test");
    }
    warn.mockRestore();
  });

  it("bounds every hook with a deadline: a hook that never resolves yields the unknown value", async () => {
    const never = () => new Promise<never>(() => {});
    const ctx: RuntimeAuthContext = { homedir: "/home/x", env: {}, fs: { exists: () => false, readFile: () => null } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runDescriptorUsageRead(descriptor({ readUsage: never }), SEAT, { timeoutMs: 20 })).toBeNull();
    expect(await runDescriptorTranscriptRead(descriptor({ readTranscript: never }), SEAT, { timeoutMs: 20 })).toBeNull();
    expect(await runDescriptorAuthStatus(descriptor({ authStatus: never }), ctx, { timeoutMs: 20 }))
      .toEqual({ state: "unknown", detail: "sign-in check failed: timed out after 20ms" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("readUsage failed for dev@rig: timed out after 20ms"));
    warn.mockRestore();
  });

  it("applies the default deadlines when the caller passes none", async () => {
    expect(CAPABILITY_TIMEOUTS_MS).toEqual({ auth: 2_000, usage: 5_000, transcript: 5_000 });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = runDescriptorUsageRead(descriptor({ readUsage: () => new Promise<never>(() => {}) }), SEAT);
      await vi.advanceTimersByTimeAsync(CAPABILITY_TIMEOUTS_MS.usage);
      expect(await pending).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out after 5000ms"));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("transcript: null without a source, newest maxEntries kept and marked truncated, null on a throw", async () => {
    const entries = [1, 2, 3, 4].map((n) => ({ role: "assistant" as const, text: `line ${n}` }));
    expect(await runDescriptorTranscriptRead(descriptor({}), SEAT)).toBeNull();
    const d = descriptor({ readTranscript: () => ({ source: "example_log", entries }) });
    expect(await runDescriptorTranscriptRead(d, { ...SEAT, maxEntries: 2 }))
      .toEqual({ source: "example_log", entries: entries.slice(-2), truncated: true });
    expect(await runDescriptorTranscriptRead(d, SEAT)).toEqual({ source: "example_log", entries });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runDescriptorTranscriptRead(descriptor({ readTranscript: () => { throw new Error("bad json"); } }), SEAT)).toBeNull();
    warn.mockRestore();
  });
});

describe("checkModelShape", () => {
  const shape: RuntimeModelShape = { pattern: /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/, example: "anthropic/claude-sonnet-4", note: "provider/model", aliases: ["default"] };
  it("accepts the pattern and aliases, and explains a miss", () => {
    expect(checkModelShape(shape, " anthropic/claude-sonnet-4 ")).toEqual({ ok: true });
    expect(checkModelShape(shape, "default")).toEqual({ ok: true });
    expect(checkModelShape(shape, "claude-sonnet-4")).toEqual({ ok: false, expected: "provider/model", example: "anthropic/claude-sonnet-4" });
  });

  it("gives the same answer on repeated checks when a runtime declares a g or y flag", () => {
    for (const flags of ["g", "y", "gy", "gi"]) {
      const stateful: RuntimeModelShape = { pattern: new RegExp("^[a-z]+/[a-z0-9-]+$", flags), example: "openai/gpt-5" };
      expect([1, 2, 3].map(() => checkModelShape(stateful, "openai/gpt-5")), flags).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      expect(stateful.pattern.lastIndex, flags).toBe(0);
    }
  });
});

describe("TuiCliRuntimeAdapter.classifyActivity", () => {
  const spec = { ...EXAMPLE_CLI_SPEC, busyPatterns: [/esc to interrupt/] };
  async function classify(frame: PaneFrame, withSpec = spec) {
    const adapter = new TuiCliRuntimeAdapter(withSpec, harnessDeps({ tmux: mockTmux([frame]).tmux, fsOps: memFs() }));
    return adapter.classifyActivity(harnessBinding());
  }

  it("reads gate, busy, and ready markers in that order", async () => {
    expect(await classify({ command: "example-cli", content: "example-cli ready>\nPlease log in" })).toBe("needs_input");
    expect(await classify({ command: "example-cli", content: "Thinking... (esc to interrupt)\nexample-cli ready>" })).toBe("working");
    expect(await classify({ command: "example-cli", content: "example-cli ready>" })).toBe("idle");
  });

  it("reads the visible screen only, never scrollback", async () => {
    const tmux = mockTmux([{ command: "example-cli", content: "example-cli ready>" }]).tmux;
    const adapter = new TuiCliRuntimeAdapter(spec, harnessDeps({ tmux, fsOps: memFs() }));
    expect(await adapter.classifyActivity(harnessBinding())).toBe("idle");
    expect(tmux.capturePaneScreen).toHaveBeenCalledWith(harnessBinding().tmuxSession, { joinWrapped: true });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("ignores a stale busy line above the bottom status region; a gate anywhere on screen counts", async () => {
    const filler = Array.from({ length: ACTIVITY_STATUS_LINES }, (_, n) => `answer line ${n + 1}`).join("\n");
    expect(await classify({ command: "example-cli", content: `Thinking... (esc to interrupt)\n${filler}\nexample-cli ready>` })).toBe("idle");
    // Gates are full-screen launch dialogs whose text can sit above the bottom
    // lines on an 80x24 pane (cline login, gemini auth/trust, qwen auth), so they
    // match the whole visible screen, as checkReady does.
    expect(await classify({ command: "example-cli", content: `Please log in\n${filler}\nexample-cli ready>` })).toBe("needs_input");
    // The same markers inside the region still count; blank lines do not push them out.
    expect(await classify({ command: "example-cli", content: `${filler}\nThinking... (esc to interrupt)\n\n\n\nexample-cli ready>` })).toBe("working");
    expect(await classify({ command: "example-cli", content: `${filler}\nPlease log in\n\n\n` })).toBe("needs_input");
  });

  it("returns null when unsure: pane at a shell, no marker, no busy patterns, no session", async () => {
    expect(await classify({ command: "zsh", content: "Thinking... (esc to interrupt)" })).toBeNull();
    expect(await classify({ command: "example-cli", content: "loading" })).toBeNull();
    expect(await classify({ command: "example-cli", content: "esc to interrupt" }, EXAMPLE_CLI_SPEC)).toBeNull();
    const adapter = new TuiCliRuntimeAdapter(spec, harnessDeps({ tmux: mockTmux().tmux, fsOps: memFs() }));
    expect(await adapter.classifyActivity(harnessBinding({ tmuxSession: null }))).toBeNull();
  });

  it("is optional on the adapter contract: built-in adapters keep their own activity sources", () => {
    expect(getRuntimeDescriptor("claude-code")).toBeDefined();
    const contract: Pick<RuntimeAdapter, "classifyActivity"> = {};
    expect(contract.classifyActivity).toBeUndefined();
  });
});
