// OMP with no model credentials (release smoke): OMP prints "No models
// available. Use /login or set an API key environment variable ..." on stderr
// and exits before its RPC transport starts. The runner must report that as a
// sign-in problem (never "not a credential problem") and record it, and the
// adapter must surface it as attention_required with attentionCode
// login_required, the code runtime fallback (fallback_runtimes) acts on.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { OMP_NO_CREDENTIALS_RE, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { isFallbackAttentionCode } from "../src/domain/runtime-fallback.js";

/** OMP's stderr in the no-credentials smoke run, verbatim. */
const NO_CREDENTIALS_STDERR = [
  "No models available. Use /login or set an API key environment variable. Then use /model to select a model.",
  "Set an API key environment variable:",
  "  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.",
  "Or create /seat/agent/models.yml",
];

const RUNNER = nodePath.join(__dirname, "..", "src", "adapters", "pi-runner.ts");

describe("OMP runner: exit with no model credentials", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

  /** Run the real runner against a fake `omp` that prints `stderr` and exits 1. */
  function runWithFakeOmp(stderr: string[]) {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-nocred-"));
    const bin = nodePath.join(root, "bin");
    fs.mkdirSync(bin);
    const omp = nodePath.join(bin, "omp");
    fs.writeFileSync(omp, `#!/bin/sh\n${stderr.map((line) => `printf '%s\\n' '${line}' >&2`).join("\n")}\nexit 1\n`, { mode: 0o755 });
    const stateRoot = nodePath.join(root, "state", "omp");
    const result = spawnSync(process.execPath, [
      "--import", "tsx", RUNNER,
      "--session-name", "dev@rig", "--state-root", stateRoot, "--cwd", root,
      "--launch-id", "launch-1", "--runtime", "omp", "--approval-mode", "always-ask",
    ], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: os.tmpdir() },
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    const statePath = piSeatPaths(stateRoot, "dev@rig").runnerStatePath;
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) as { exited?: { code: number | null; reason?: string } } : null;
    return { output: `${result.stdout}${result.stderr}`, state };
  }

  it("reports a sign-in problem and records exited.reason login_required", () => {
    const { output, state } = runWithFakeOmp(NO_CREDENTIALS_STDERR);
    expect(output).toContain("[omp:err] No models available.");
    expect(output).toContain("[omp-runner] ERROR OMP has no model credentials for this seat.");
    expect(output).toContain("PI_CODING_AGENT_DIR=<seat-root>/agent omp and /login");
    expect(output).not.toContain("not a credential problem");
    expect(state?.exited).toMatchObject({ code: 1, reason: "login_required" });
  }, 40_000);

  it("any other early exit stays a launch failure, without claiming anything about credentials", () => {
    const { output, state } = runWithFakeOmp(["error: unknown option --mode"]);
    expect(output).toContain("[omp-runner] ERROR OMP exited before its RPC transport started");
    expect(output).not.toContain("credential");
    expect(state?.exited?.code).toBe(1);
    expect(state?.exited?.reason).toBeUndefined();
  }, 40_000);

  it("matches OMP's notice only", () => {
    expect(OMP_NO_CREDENTIALS_RE.test(NO_CREDENTIALS_STDERR[0]!)).toBe(true);
    expect(OMP_NO_CREDENTIALS_RE.test("Set an API key environment variable:")).toBe(false);
    expect(OMP_NO_CREDENTIALS_RE.test("No models matched your filter")).toBe(false);
  });
});

describe("OMP adapter: a no-credentials exit is a sign-in gate", () => {
  const stateRoot = "/openrig/state/omp";
  const seat = "dev@rig";
  const paths = piSeatPaths(stateRoot, seat);

  function seatWithExit(exited: { code: number; reason?: "login_required" }) {
    const files: Record<string, string> = {};
    const fsOps = {
      readFile: (path: string) => files[path]!,
      writeFile: (path: string, content: string) => { files[path] = content; },
      exists: (path: string) => path in files,
      mkdirp: () => {},
    };
    const tmux = {
      sendText: vi.fn(async (_session: string, command: string) => {
        const launchId = /--launch-id '([^']+)'/.exec(command)?.[1];
        files[paths.runnerStatePath] = JSON.stringify({ ready: false, launchId, updatedAt: "t", exited: { ...exited, at: "t" } });
        return { ok: true };
      }),
      sendKeys: vi.fn(async () => ({ ok: true })),
      capturePaneContent: vi.fn(async () => "[omp:err] No models available. Use /login or set an API key environment variable."),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "zsh"),
    } as unknown as TmuxAdapter;
    const adapter = new OmpRuntimeAdapter({ tmux, fsOps, stateRoot, runnerEntryPath: "/runner.js" });
    const binding = { tmuxSession: seat, cwd: "/w" } as NodeBinding;
    return { adapter, binding };
  }

  it("launch fails as attention_required with attentionCode login_required, which runtime fallback acts on", async () => {
    const { adapter, binding } = seatWithExit({ code: 1, reason: "login_required" });
    const result = await adapter.launchHarness(binding, { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", attentionCode: "login_required" });
    expect(result.ok ? "" : result.error).toContain("omp is not signed in: OMP has no model credentials for this seat.");
    expect(result.ok ? "" : result.evidence).toContain("No models available");
    expect(isFallbackAttentionCode(result.ok ? undefined : result.attentionCode)).toBe(true);
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "login_required" });
  });

  it("an exit without that reason keeps the plain launch failure (no fallback)", async () => {
    const { adapter, binding } = seatWithExit({ code: 1 });
    const result = await adapter.launchHarness(binding, { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(result.ok ? "x" : result.attentionCode).toBeUndefined();
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
  });
});
