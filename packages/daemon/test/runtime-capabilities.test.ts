// F1 capability hooks: the type contract each feature PR implements, the
// never-throw runners every consumer calls, the pure model-shape check, and
// the TUI base's pane activity classifier. No core consumer is wired here.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkModelShape, runDescriptorAuthStatus, runDescriptorTranscriptRead, runDescriptorUsageRead,
  type RuntimeAuthContext, type RuntimeModelShape, type RuntimeUsageInput,
} from "../src/domain/runtime-capabilities.js";
import { LAUNCH_RECORD_FILE } from "../src/domain/runtime-capture.js";
import { getRuntimeDescriptor, listRuntimeDescriptors, type RuntimeDescriptor } from "../src/domain/runtime-registry.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { EXAMPLE_CLI_DESCRIPTOR, EXAMPLE_CLI_SPEC } from "./helpers/example-cli-runtime.js";
import { harnessBinding, harnessDeps, memFs, mockTmux, type PaneFrame } from "./helpers/tui-cli-adapter-harness.js";

const SEAT: RuntimeUsageInput = { sessionName: "dev@rig", cwd: "/w", seatStateDir: "/nonexistent/seat", homedir: "/home/x", resumeToken: null };
const descriptor = (extra: Partial<RuntimeDescriptor>): RuntimeDescriptor => ({ ...EXAMPLE_CLI_DESCRIPTOR, ...extra });

describe("capability hooks on existing runtimes", () => {
  it("changes no existing runtime: no built-in declares a capability hook yet", () => {
    for (const d of listRuntimeDescriptors()) {
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("readUsage failed for dev@rig: db locked"));
    warn.mockRestore();
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
      .toEqual({ state: "unknown", detail: "sign-in check failed: EACCES" });
    warn.mockRestore();
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
