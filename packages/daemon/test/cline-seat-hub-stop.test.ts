// Real-tmux proof that a cline seat's own hub stops with the seat and the
// owner's shared hub does not. An isolated tmux server (its own -L socket,
// throwaway HOME) runs the seat through the production cline spec (per-seat
// CLINE_HUB_DISCOVERY_PATH and CLINE_HUB_PORT) and stops it through the
// production stop hook (kill-session plus the PID-scoped, start-time checked
// process-tree reap), exactly as `rig down` does.
//
// - Always: a stand-in `cline` on the pane's PATH that detaches a hub child the
//   way cline does (its own session, a listener on CLINE_HUB_PORT, the
//   discovery file), next to a stand-in "shared hub" started outside the pane.
// - With OPENRIG_TEST_CLINE_BIN (the real cline launcher) and
//   OPENRIG_TEST_CLINE_HOME (a HOME with a provider configured): the same proof
//   against real cline 3.x, including a real shared hub started by a second,
//   non-isolated cline TUI.
// Skips cleanly when tmux is absent. No network beyond 127.0.0.1.

import { exec as execCb, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TuiCliRuntimeAdapter } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
import { createClineSpec } from "../src/adapters/cli/cline/index.js";
import { allocateLoopbackPort, clineSeatHubPaths } from "../src/adapters/cli/cline/hub.js";
import { createRuntimeStopHook } from "../src/domain/process-tree-reaper.js";
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";
import { seatStateDirFor } from "../src/domain/runtime-capture.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const execAsync = promisify(execCb);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REAL_BIN = process.env.OPENRIG_TEST_CLINE_BIN?.trim() || "";
const REAL_HOME = process.env.OPENRIG_TEST_CLINE_HOME?.trim() || "";
const SOCKET = `openrig-cline-hub-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(200);
    value = await read();
  }
  return value;
}

function readDiscovery(file: string): { pid: number; port: number } | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; port?: number };
    return typeof record.pid === "number" && typeof record.port === "number" ? { pid: record.pid, port: record.port } : null;
  } catch {
    return null;
  }
}

/** Processes whose command line names this discovery path or hub port. */
async function processesFor(discoveryFile: string, port: number): Promise<number[]> {
  const rows = await listNativeProcesses();
  return rows
    .filter((row) => row.command.includes(discoveryFile) || new RegExp(`--port ${port}(?:\\s|$)`).test(row.command))
    .map((row) => row.pid);
}

describe.skipIf(!tmuxAvailable())("cline seat hub stops with the seat (real tmux)", () => {
  let root: string;
  let tmux: TmuxAdapter;
  const cleanupPids: number[] = [];

  const run = async (cmd: string): Promise<string> => {
    const pinned = cmd.startsWith("tmux ") ? `tmux -L ${SOCKET} ${cmd.slice(5)}` : cmd;
    const { stdout } = await execAsync(pinned, { encoding: "utf8" });
    return stdout;
  };

  function binding(session: string, cwd: string): NodeBinding {
    return {
      id: "b", nodeId: "n", tmuxSession: session, tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: new Date().toISOString(), cwd,
    };
  }

  async function pane(session: string, cwd: string, home: string, binDir: string): Promise<void> {
    const pathVar = `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    const env = `env -i PATH=${JSON.stringify(pathVar)} HOME=${JSON.stringify(home)} SHELL=/bin/sh TERM=xterm-256color`;
    await run(`tmux -f /dev/null new-session -d -s ${session} -x 80 -y 24 -c ${JSON.stringify(cwd)} "${env} /bin/sh"`);
    for (let i = 0; i < 50; i++) {
      if (/^(sh|bash|dash)$/.test((await run(`tmux display-message -p -t ${session} "#{pane_current_command}"`)).trim())) return;
      await sleep(100);
    }
    throw new Error("isolated pane never reached a shell");
  }

  function adapterFor(stateRoot: string, home: string) {
    const stopHook = createRuntimeStopHook({
      stateRoot,
      readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
      resolveSessionRuntime: () => "cline",
      reaper: {
        getPanePid: (session) => tmux.getPanePid(session),
        listProcesses: listNativeProcesses,
        signal: (pid, signal) => { process.kill(pid, signal); },
      },
    });
    tmux.stopHook = stopHook;
    const fsOps = createNodeFsOps();
    return new TuiCliRuntimeAdapter(createClineSpec({}, fsOps), { tmux, fsOps, stateRoot, homedir: home });
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-cline-hub-"));
    tmux = new TmuxAdapter(run);
  });

  afterAll(async () => {
    await run("tmux kill-server").catch(() => {});
    for (const pid of cleanupPids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stand-in cline: kill-session plus reap stops the seat's detached hub, never the shared hub", async () => {
    const binDir = path.join(root, "fake-bin");
    const work = path.join(root, "fake-work");
    const stateRoot = path.join(root, "fake-state");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const hubScript = path.join(binDir, "fake-hub.js");
    // A hub like cline's: its own session (detached), a listener on the port,
    // the discovery record; SIGTERM removes the record and exits.
    fs.writeFileSync(hubScript, [
      "const fs = require('fs'); const net = require('net');",
      "const [discovery, port] = process.argv.slice(2).filter((a) => !a.startsWith('--'));",
      "const server = net.createServer(() => {}).listen(Number(port), '127.0.0.1', () => {",
      "  fs.writeFileSync(discovery, JSON.stringify({ pid: process.pid, port: Number(port) }));",
      "});",
      "process.on('SIGTERM', () => { try { fs.unlinkSync(discovery); } catch {} process.exit(0); });",
    ].join("\n"));
    const cline = path.join(binDir, "cline");
    fs.writeFileSync(cline, [
      "#!/usr/bin/env node",
      "const { spawn } = require('child_process'); const path = require('path');",
      "const d = process.env.CLINE_HUB_DISCOVERY_PATH, p = process.env.CLINE_HUB_PORT;",
      "if (d && p) spawn(process.execPath, [path.join(__dirname, 'fake-hub.js'), '--cline-hub-daemon', d, p], { detached: true, stdio: 'ignore' }).unref();",
      "process.stdout.write('\\u276f What can I do for you?\\nAuto-approve all disabled (Shift+Tab)\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    fs.chmodSync(cline, 0o755);

    // The owner's shared hub, started outside any seat.
    const sharedPort = await allocateLoopbackPort();
    const sharedDiscovery = path.join(root, "owner-production.json");
    const shared = spawn(process.execPath, [hubScript, "--cline-hub-daemon", sharedDiscovery, String(sharedPort)], { detached: true, stdio: "ignore" });
    shared.unref();
    cleanupPids.push(shared.pid!);
    expect(await until(() => listening(sharedPort), Boolean, 5000)).toBe(true);

    const session = "fake-seat";
    await pane(session, work, root, binDir);
    const adapter = adapterFor(stateRoot, root);
    const launched = await adapter.launchHarness(binding(session, work), { name: session });
    expect(launched.ok).toBe(true);

    const { discoveryFile } = clineSeatHubPaths(seatStateDirFor(stateRoot, "cline", session));
    const hub = await until(() => readDiscovery(discoveryFile), (v) => v !== null, 5000);
    expect(hub, "the seat started its own hub").not.toBeNull();
    cleanupPids.push(hub!.pid);
    expect(hub!.port).not.toBe(sharedPort);
    expect(await listening(hub!.port)).toBe(true);

    await tmux.killSession(session);

    expect(await until(() => alive(hub!.pid), (v) => !v, 5000), "seat hub pid survived").toBe(false);
    expect(await listening(hub!.port)).toBe(false);
    expect(await processesFor(discoveryFile, hub!.port)).toEqual([]);
    expect(alive(shared.pid!), "the shared hub was stopped").toBe(true);
    expect(await listening(sharedPort)).toBe(true);
  }, 60_000);

  it.skipIf(!REAL_BIN || !REAL_HOME)("real cline: the seat hub stops with the seat; a real shared hub survives", async () => {
    const binDir = path.join(root, "real-bin");
    const work = path.join(root, "real-work");
    const stateRoot = path.join(root, "real-state");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.symlinkSync(REAL_BIN, path.join(binDir, "cline"));

    // A real shared hub: a non-isolated cline TUI in its own pane starts it.
    const sharedSession = "owner-cline";
    await pane(sharedSession, work, REAL_HOME, binDir);
    await run(`tmux send-keys -t ${sharedSession} -l "exec env BROWSER=true CLINE_DISABLE_CLINE_PASS_NOTICE=1 CLINE_NO_AUTO_UPDATE=1 cline --auto-approve false"`);
    await run(`tmux send-keys -t ${sharedSession} Enter`);
    const sharedDiscovery = path.join(REAL_HOME, ".cline", "data", "locks", "hub", "production.json");
    const shared = await until(() => readDiscovery(sharedDiscovery), (v) => v !== null && alive(v.pid), 30_000);
    expect(shared, "a real shared hub is running").not.toBeNull();
    cleanupPids.push(shared!.pid);

    const session = "real-seat";
    await pane(session, work, REAL_HOME, binDir);
    const adapter = adapterFor(stateRoot, REAL_HOME);
    const launched = await adapter.launchHarness(binding(session, work), { name: session });
    expect(launched.ok).toBe(true);

    const { discoveryFile } = clineSeatHubPaths(seatStateDirFor(stateRoot, "cline", session));
    const hub = await until(() => readDiscovery(discoveryFile), (v) => v !== null, 30_000);
    expect(hub, "the seat started its own hub").not.toBeNull();
    cleanupPids.push(hub!.pid);
    expect(hub!.pid).not.toBe(shared!.pid);
    expect(hub!.port).not.toBe(shared!.port);

    await tmux.killSession(session);

    expect(await until(() => alive(hub!.pid), (v) => !v, 10_000), "seat hub pid survived").toBe(false);
    expect(await listening(hub!.port)).toBe(false);
    expect(await processesFor(discoveryFile, hub!.port)).toEqual([]);
    expect(alive(shared!.pid), "the shared hub was stopped").toBe(true);
    expect(await listening(shared!.port)).toBe(true);
  }, 120_000);
});
