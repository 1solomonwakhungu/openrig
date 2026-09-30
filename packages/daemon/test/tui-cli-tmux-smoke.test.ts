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

  async function freshPane(width = 120, height = 30): Promise<void> {
    await run(`tmux kill-session -t ${SESSION}`).catch(() => {});
    const env = `env -i PATH=${JSON.stringify(process.env.PATH ?? "/usr/bin:/bin")} HOME=${JSON.stringify(root)} SHELL=/bin/sh TERM=xterm-256color`;
    await run(`tmux -f /dev/null new-session -d -s ${SESSION} -x ${width} -y ${height} -c ${JSON.stringify(root)} "${env} /bin/sh"`);
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

  it("reads a full-screen (alternate screen) TUI whole, even above the launch line", async () => {
    await freshPane();
    await run(`tmux send-keys -t ${SESSION} "printf 'line1\\nline2\\nline3\\n'" Enter`);
    const altCli = path.join(root, "smoke-alt.mjs");
    fs.writeFileSync(altCli, [
      "#!/usr/bin/env node",
      // Switch to the alternate screen and draw the marker on its top row.
      "process.stdout.write('\\x1b[?1049h\\x1b[H\\x1b[2Jsmoke-cli ready> ');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    fs.chmodSync(altCli, 0o755);
    const adapter = new TuiCliRuntimeAdapter(spec([altCli]), { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
    expect(await adapter.launchHarness(binding(), { name: SESSION })).toEqual({ ok: true });
  }, 30_000);

  it("a stale alternate screen left by a previous process is not the new CLI's", async () => {
    await freshPane();
    // A previous TUI switched to the alternate screen, drew a ready marker, and
    // exited without restoring the normal screen.
    await run(`tmux send-keys -t ${SESSION} "printf '\\033[?1049h\\033[Hsmoke-cli ready> (stale)\\n'" Enter`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await run(`tmux display-message -p -t ${SESSION} "#{alternate_on}"`)).trim()).toBe("1");
    const silentCli = path.join(root, "smoke-silent.mjs");
    fs.writeFileSync(silentCli, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    fs.chmodSync(silentCli, 0o755);
    const adapter = new TuiCliRuntimeAdapter({ ...spec([silentCli]), launchTimeoutMs: 2_000 }, { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
    expect(await adapter.launchHarness(binding(), { name: SESSION })).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
  }, 30_000);

  describe("soft-wrapped output on an 80x24 pane (capture -J)", () => {
    // 75 x's then the marker: at 80 columns the terminal wraps inside
    // "smoke-cli", so without -J the marker is split across two rows.
    const WRAPPED = `${"x".repeat(75)}smoke-cli ready> `;

    async function inlineCli(name: string, output: string): Promise<string> {
      const file = path.join(root, name);
      fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\nsetInterval(() => {}, 1000);\n`);
      fs.chmodSync(file, 0o755);
      return file;
    }
    const printLong = (text: string) => run(`tmux send-keys -t ${SESSION} ${JSON.stringify(`printf '%s\\n' '${text}'`)} Enter`);

    it("the recorded position still marks where new output starts when history holds wrapped rows", async () => {
      await freshPane(80, 24);
      for (let i = 0; i < 3; i++) await printLong(`OLD-${i}-${"o".repeat(190)}`); // 3 physical rows each
      await new Promise((resolve) => setTimeout(resolve, 300));
      const position = await tmux.getPaneLinePosition(SESSION);
      await run(`tmux send-keys -t ${SESSION} "printf 'AFTER-MARKER\\n'" Enter`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const joined = (await tmux.capturePaneFromLine(SESSION, position!, { joinWrapped: true }))!;
      expect(joined).toContain("AFTER-MARKER");
      expect(joined).not.toMatch(/OLD-\d/);
      // The window starts at the prompt row the command was typed on.
      expect(joined.split("\n")[0]).toContain("printf 'AFTER-MARKER");
    }, 30_000);

    it("reads a marker the terminal wrapped mid-token as ready", async () => {
      await freshPane(80, 24);
      const cli = await inlineCli("smoke-wrap.mjs", `Smoke CLI\n${WRAPPED}`);
      const adapter = new TuiCliRuntimeAdapter(spec([cli]), { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
      expect(await adapter.launchHarness(binding(), { name: SESSION })).toEqual({ ok: true });
      // The raw capture really is split; only the joined capture has the marker.
      const raw = (await run(`tmux capture-pane -p -t ${SESSION}`));
      expect(raw).not.toContain("smoke-cli ready>");
      expect(await tmux.capturePaneContent(SESSION, 40, { joinWrapped: true })).toContain("smoke-cli ready>");
      expect(await adapter.checkReady(binding())).toEqual({ ready: true });
    }, 30_000);

    it("never counts the same wrapped marker left in scrollback before the launch", async () => {
      await freshPane(80, 24);
      await printLong(WRAPPED.trimEnd());
      await new Promise((resolve) => setTimeout(resolve, 300));
      const silent = await inlineCli("smoke-quiet.mjs", "Smoke CLI\n");
      const adapter = new TuiCliRuntimeAdapter({ ...spec([silent]), launchTimeoutMs: 2_000 }, { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
      expect(await adapter.launchHarness(binding(), { name: SESSION })).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
    }, 30_000);
  });

  it("fails fast, well inside the timeout, when the binary is missing", async () => {
    await freshPane();
    const adapter = new TuiCliRuntimeAdapter(spec([path.join(root, "no-such-cli")]), { tmux, fsOps: createNodeFsOps(), stateRoot: path.join(root, "state"), homedir: root });
    const started = Date.now();
    const result = await adapter.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringMatching(/binary was not found/) });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);
});
