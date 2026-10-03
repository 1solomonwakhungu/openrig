// Builds the runtime inventory on this machine (no daemon needed): the binary
// probe runs argv directly (never through a shell), and sign-in checks read
// local files and environment variable names only.

import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  buildRuntimeInventory,
  nodeAuthFs,
  type RuntimeInventoryEntry,
  type RuntimeInventoryExec,
} from "@openrig/daemon/runtime-inventory";

/** Keep at most this much probe output; versions and status lines are short. */
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

/** Runs argv with a timeout. Null when it cannot start (not on PATH) or times
 *  out. stdin is closed so an interactive CLI cannot wait for input. */
export const nodeRuntimeExec: RuntimeInventoryExec = (argv, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { code: number; stdout: string } | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BROWSER: "true", NO_COLOR: "1" },
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const take = (chunk: Buffer) => {
      if (out.length < MAX_PROBE_OUTPUT_BYTES) out += chunk.toString("utf8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish({ code: code ?? 1, stdout: out.slice(0, MAX_PROBE_OUTPUT_BYTES) }));
  });

export function localRuntimeInventory(opts: { probe?: boolean } = {}): Promise<RuntimeInventoryEntry[]> {
  return buildRuntimeInventory({
    exec: nodeRuntimeExec,
    probe: opts.probe ?? false,
    auth: {
      homedir: os.homedir(),
      env: process.env,
      cwd: process.cwd(),
      fs: nodeAuthFs((p) => readFileSync(p), existsSync),
    },
  });
}
