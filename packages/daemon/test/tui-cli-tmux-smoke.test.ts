// Real-tmux smoke test for the TUI CLI base: an isolated tmux server (its own
// -L socket, throwaway HOME, /bin/sh pane shell) runs a fake CLI (a node
// script that prints a ready marker and stays up). Proves the base types an
// `exec` launch the real shell runs, that pane_current_command becomes the CLI,
// that launch and checkReady both report ready, and that a missing binary fails
// fast. No real agent CLI, no network. Skips cleanly when tmux is absent.

import { exec as execCb, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";
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

const SOCKET = `openrig-smoke-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION = "smoke";

describe.skipIf(!tmuxAvailable())("TUI CLI base on a real tmux server", () => {
  let root: string;
  let tmux: TmuxAdapter;
  let fakeCli: string;

  // Every tmux command the adapter runs is pinned to the isolated socket.
  const run = async (cmd: string): Promise<string> => {
    const pinned = cmd.startsWith("tmux ") ? `tmux -L ${SOCKET} ${cmd.slice(5)}` : cmd;
    const { stdout } = await execAsync(pinned, { encoding: "utf8" });
    return stdout;
  };

  function spec(argv: string[]): TuiCliRuntimeSpec {
    return {
      descriptor: { id: "smoke-cli", displayName: "Smoke CLI", kind: "agent", binary: "smoke-cli", supportsFork: false },
      buildLaunchCommand: () => argv,
      readyPatterns: [/smoke-cli ready>/],
      launchTimeoutMs: 15_000,
      pollIntervalMs: 200,
    };
  }

  function binding(): NodeBinding {
    return {
      id: "b", nodeId: "n", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: new Date().toISOString(), cwd: root,
    };
  }

  async function freshPane(): Promise<void> {
    await run(`tmux kill-session -t ${SESSION}`).catch(() => {});
    const env = `env -i PATH=${JSON.stringify(process.env.PATH ?? "/usr/bin:/bin")} HOME=${JSON.stringify(root)} SHELL=/bin/sh TERM=xterm-256color`;
    await run(`tmux -f /dev/null new-session -d -s ${SESSION} -x 120 -y 30 -c ${JSON.stringify(root)} "${env} /bin/sh"`);
    for (let i = 0; i < 50; i++) {
      if (/^(sh|bash|dash)$/.test((await run(`tmux display-message -p -t ${SESSION} "#{pane_current_command}"`)).trim())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("isolated pane never reached a shell");
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-smoke-"));
    fakeCli = path.join(root, "smoke-cli.mjs");
    fs.writeFileSync(fakeCli, [
      "#!/usr/bin/env node",
      "process.stdout.write('Smoke CLI 0.0.1\\nsmoke-cli ready> ');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    fs.chmodSync(fakeCli, 0o755);
    tmux = new TmuxAdapter(run);
  });

  afterAll(async () => {
    await run("tmux kill-server").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("launches with exec, the CLI holds the pane, and launch plus checkReady report ready", async () => {
    await freshPane();
    // An old ready marker in the reused pane's scrollback must not count.
    await run(`tmux send-keys -t ${SESSION} "printf 'smoke-cli ready> (old)\\\\n'" Enter`);
    const adapter = new TuiCliRuntimeAdapter(spec([fakeCli]), { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
    const result = await adapter.launchHarness(binding(), { name: SESSION });
    expect(result).toEqual({ ok: true });
    expect((await run(`tmux display-message -p -t ${SESSION} "#{pane_current_command}"`)).trim()).toBe("node");
    expect(await adapter.checkReady(binding())).toEqual({ ready: true });
  }, 30_000);

  it("fails fast, well inside the timeout, when the binary is missing", async () => {
    await freshPane();
    const adapter = new TuiCliRuntimeAdapter(spec([path.join(root, "no-such-cli")]), { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
    const started = Date.now();
    const result = await adapter.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringMatching(/binary was not found/) });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);
});
