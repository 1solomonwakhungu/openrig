// Stop-time process-tree reaping, hermetic: an injected process table and
// signaller stand in for ps and kill. The main fixture is the live gemini
// 0.61.0 shape: the pane pid is a session and group leader that ignores
// SIGHUP/SIGTERM and waits on a child in the same group, and both survive
// tmux kill-session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeStopHook, killSessionAndProcessTree, processTree, reapingRuntimeForSession,
  type ProcessTreeReaperDeps, type ReaperProcessRow,
} from "../src/domain/process-tree-reaper.js";
import { registerRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE } from "../src/domain/runtime-capture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { EXAMPLE_CLI_DESCRIPTOR } from "./helpers/example-cli-runtime.js";

const T0 = "Tue Sep 29 12:00:00 2026";
const PANE = 4100;

/** gemini 0.61.0 after launch: parent = pane pid (group leader), child in the same group. */
function geminiShape(): ReaperProcessRow[] {
  return [
    { pid: 1, ppid: 0, command: "launchd", pgid: 1, startedAt: T0 },
    { pid: 900, ppid: 1, command: "tmux -L seat new-session", pgid: 900, startedAt: T0 },
    { pid: PANE, ppid: 900, command: "node /opt/gemini/bin/gemini --yolo", pgid: PANE, startedAt: T0 },
    { pid: 4101, ppid: PANE, command: "/opt/node/bin/node /opt/gemini/dist/index.js --yolo", pgid: PANE, startedAt: T0 },
    { pid: 5000, ppid: 1, command: "node /opt/gemini/bin/gemini", pgid: 5000, startedAt: T0 }, // owner's own gemini
  ];
}

/** A process table that obeys signals: group signals hit every member. */
function fakeTable(initial: ReaperProcessRow[], opts: { ignoreTerm?: number[] } = {}) {
  let rows = [...initial];
  const signals: Array<[number, string]> = [];
  const deps: ProcessTreeReaperDeps = {
    getPanePid: async () => PANE,
    listProcesses: async () => rows.map((row) => ({ ...row })),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const targets = pid < 0 ? rows.filter((row) => row.pgid === -pid) : rows.filter((row) => row.pid === pid);
      if (targets.length === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      const dies = (row: ReaperProcessRow) => signal === "SIGKILL" || !(opts.ignoreTerm ?? []).includes(row.pid);
      const dead = new Set(targets.filter(dies).map((row) => row.pid));
      rows = rows.filter((row) => !dead.has(row.pid));
    },
    sleep: async () => {},
  };
  return { deps, signals, alive: () => rows.map((row) => row.pid) };
}

describe("killSessionAndProcessTree", () => {
  it("snapshots before the kill, then SIGTERMs the verified pane group (gemini shape)", async () => {
    const table = fakeTable(geminiShape());
    const order: string[] = [];
    const listed = table.deps.listProcesses;
    table.deps.listProcesses = async () => { order.push("ps"); return listed(); };
    const kill = vi.fn(async () => { order.push("kill-session"); return { ok: true as const }; });
    const result = await killSessionAndProcessTree("dev@rig", kill, table.deps);
    expect(order[0]).toBe("ps");
    expect(order[1]).toBe("kill-session");
    expect(result).toMatchObject({ ok: true, reap: { snapshot: [PANE, 4101], groupTerminated: PANE, terminated: [], killed: [] } });
    expect(table.signals).toEqual([[-PANE, "SIGTERM"]]);
    expect(table.alive()).toEqual([1, 900, 5000]); // the owner's own gemini is untouched
  });

  it("falls back to per-pid SIGTERM when the leader is gone, then SIGKILLs survivors", async () => {
    const rows = geminiShape().filter((row) => row.pid !== PANE);
    const table = fakeTable(rows, { ignoreTerm: [4101] });
    table.deps.getPanePid = async () => PANE;
    // Snapshot sees the leader; it dies with the kill-session.
    const withLeader = geminiShape();
    let first = true;
    const listed = table.deps.listProcesses;
    table.deps.listProcesses = async () => { if (first) { first = false; return withLeader; } return listed(); };
    const result = await killSessionAndProcessTree("dev@rig", async () => ({ ok: true }), table.deps);
    expect(result.reap).toEqual({ snapshot: [PANE, 4101], groupTerminated: null, terminated: [4101], killed: [4101] });
    expect(table.alive()).toEqual([1, 900, 5000]);
  });

  it("never signals a reused pid", async () => {
    const reused = geminiShape().map((row) => row.pid === 4101 ? { ...row, command: "vim notes.txt", startedAt: "Tue Sep 29 12:05:00 2026" } : row)
      .filter((row) => row.pid !== PANE);
    const table = fakeTable(reused);
    let first = true;
    const listed = table.deps.listProcesses;
    table.deps.listProcesses = async () => { if (first) { first = false; return geminiShape(); } return listed(); };
    const result = await killSessionAndProcessTree("dev@rig", async () => ({ ok: true }), table.deps);
    expect(result.reap).toMatchObject({ groupTerminated: null, terminated: [], killed: [] });
    expect(table.signals).toEqual([]);
  });

  it("skips the group signal when the leader no longer leads its group", async () => {
    const regrouped = geminiShape().map((row) => row.pid === PANE ? { ...row, pgid: 7777 } : row);
    const table = fakeTable(regrouped);
    let first = true;
    const listed = table.deps.listProcesses;
    table.deps.listProcesses = async () => { if (first) { first = false; return geminiShape(); } return listed(); };
    const result = await killSessionAndProcessTree("dev@rig", async () => ({ ok: true }), table.deps);
    expect(result.reap?.groupTerminated).toBeNull();
    expect(table.signals.every(([pid]) => pid > 0)).toBe(true);
  });

  it("returns the kill result untouched when nothing survives or no snapshot exists", async () => {
    const table = fakeTable([]);
    table.deps.getPanePid = async () => null;
    expect(await killSessionAndProcessTree("x", async () => ({ ok: false, code: "session_not_found", message: "gone" }), table.deps))
      .toEqual({ ok: false, code: "session_not_found", message: "gone" });
  });

  it("walks the full descendant tree", () => {
    expect(processTree(geminiShape(), PANE).map((row) => row.pid)).toEqual([PANE, 4101]);
    expect(processTree(geminiShape(), 900).map((row) => row.pid)).toEqual([900, PANE, 4101]);
  });
});

describe("runtime stop hook", () => {
  let root: string | null = null;
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.(); unregister = null;
    if (root) fs.rmSync(root, { recursive: true, force: true }); root = null;
  });

  function seat(runtimeId: string, session: string, record: Record<string, unknown> = { runtimeId, sessionName: session }) {
    root ??= fs.mkdtempSync(path.join(os.tmpdir(), "openrig-reap-"));
    const dir = path.join(root, runtimeId, session);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LAUNCH_RECORD_FILE), JSON.stringify(record));
    return root;
  }
  const readFile = (p: string) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };

  it("reaps a seat whose current runtime opts in, through every killSession", async () => {
    unregister = registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, reapProcessTreeOnStop: true });
    const stateRoot = seat("example-cli", "dev@rig");
    const table = fakeTable(geminiShape());
    const exec = vi.fn(async () => "");
    const tmux = new TmuxAdapter(exec);
    const runtimes: Record<string, string> = { "dev@rig": "example-cli", "other@rig": "codex" };
    tmux.stopHook = createRuntimeStopHook({ stateRoot, readFile, resolveSessionRuntime: (s) => runtimes[s] ?? null, reaper: table.deps });

    await tmux.killSession("dev@rig");
    expect(exec).toHaveBeenCalledWith("tmux kill-session -t 'dev@rig'");
    expect(table.signals).toEqual([[-PANE, "SIGTERM"]]);

    table.signals.length = 0;
    await tmux.killSession("other@rig"); // claude/codex/pi and unknown seats: plain kill
    expect(table.signals).toEqual([]);
  });

  it("a stale launch.json never reaps a seat re-specced to a built-in", () => {
    unregister = registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, reapProcessTreeOnStop: true });
    const stateRoot = seat("example-cli", "dev@rig"); // left over from when the seat ran example-cli
    expect(reapingRuntimeForSession("dev@rig", { stateRoot, readFile, resolveSessionRuntime: () => "claude-code" })).toBeUndefined();
    expect(reapingRuntimeForSession("dev@rig", { stateRoot, readFile, resolveSessionRuntime: () => "example-cli" })?.id).toBe("example-cli");
  });

  it("falls back to launch.json only when the registry does not know the session and the record matches", () => {
    unregister = registerRuntimeDescriptor({ ...EXAMPLE_CLI_DESCRIPTOR, reapProcessTreeOnStop: true });
    const stateRoot = seat("example-cli", "dev@rig");
    seat("example-cli", "moved@rig", { runtimeId: "example-cli", sessionName: "someone-else@rig" });
    seat("example-cli", "renamed@rig", { runtimeId: "gemini", sessionName: "renamed@rig" });
    const unknown = () => null;
    expect(reapingRuntimeForSession("dev@rig", { stateRoot, readFile, resolveSessionRuntime: unknown })?.id).toBe("example-cli");
    expect(reapingRuntimeForSession("moved@rig", { stateRoot, readFile, resolveSessionRuntime: unknown })).toBeUndefined();
    expect(reapingRuntimeForSession("renamed@rig", { stateRoot, readFile, resolveSessionRuntime: unknown })).toBeUndefined();
    expect(reapingRuntimeForSession("absent@rig", { stateRoot, readFile, resolveSessionRuntime: unknown })).toBeUndefined();
  });

  it("built-ins never opt in", () => {
    const stateRoot = seat("codex", "dev@rig");
    expect(reapingRuntimeForSession("dev@rig", { stateRoot, readFile, resolveSessionRuntime: () => "codex" })).toBeUndefined();
    expect(reapingRuntimeForSession("dev@rig", { stateRoot, readFile })).toBeUndefined();
  });

  it("a runtime-resolution failure stops plainly", async () => {
    const table = fakeTable(geminiShape());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = createRuntimeStopHook({ stateRoot: "/nope", readFile, resolveSessionRuntime: () => { throw new Error("no such table: sessions"); }, reaper: table.deps });
    expect(await hook("dev@rig", async () => ({ ok: true }))).toEqual({ ok: true });
    expect(table.signals).toEqual([]);
    warn.mockRestore();
  });
});
