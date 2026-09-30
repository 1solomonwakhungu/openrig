// A per-seat cline hub.
//
// cline runs its sessions through a background hub daemon (`.cline
// --cline-hub-daemon`) that it starts on demand and detaches, so it outlives
// the TUI and `rig down`. By default every cline process on the host shares one
// hub (discovery file ~/.cline/data/locks/hub/production.json, a fixed port),
// including the owner's own cline, so a seat must never stop that hub.
//
// Verified live against cline 3.0.65: with CLINE_HUB_DISCOVERY_PATH and
// CLINE_HUB_PORT set, the TUI starts its OWN hub on that port, records it in
// that discovery file (pid, url, authToken, startedAt, with an instance lock
// beside it), and never touches the shared hub. The discovery path alone is not
// enough: the TUI then attaches to the shared hub on the default port. `--id`
// resume works through the seat hub. While the TUI runs, the seat hub is its
// child, so the PID-scoped, start-time-checked stop reaper stops exactly this
// seat's hub; SIGTERM makes it exit cleanly and remove its discovery file.
// There is no flag or env to run cline without a hub.

import net from "node:net";
import nodePath from "node:path";
import { createHash } from "node:crypto";

export const CLINE_SEAT_HUB_DIR = "cline-hub";

export interface ClineSeatHubPaths {
  dir: string;
  /** CLINE_HUB_DISCOVERY_PATH: cline writes the running hub's record here. */
  discoveryFile: string;
  /** The port OpenRig chose for this seat's hub (CLINE_HUB_PORT). */
  portFile: string;
}

export function clineSeatHubPaths(seatStateDir: string): ClineSeatHubPaths {
  const dir = nodePath.join(seatStateDir, CLINE_SEAT_HUB_DIR);
  return { dir, discoveryFile: nodePath.join(dir, "discovery.json"), portFile: nodePath.join(dir, "port") };
}

export interface ClineHubFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function validPort(value: unknown): number | null {
  const port = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/** The seat hub cline recorded, or null when absent or unreadable. */
export function readClineSeatHub(fs: ClineHubFs, seatStateDir: string): { pid: number; port: number } | null {
  const { discoveryFile } = clineSeatHubPaths(seatStateDir);
  if (!fs.exists(discoveryFile)) return null;
  try {
    const record = JSON.parse(fs.readFile(discoveryFile)) as { pid?: unknown; port?: unknown };
    const port = validPort(record.port);
    const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
    return port && pid ? { pid, port } : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Preferred ports live in [PREFERRED_BASE, PREFERRED_BASE + PREFERRED_SPAN). */
const PREFERRED_BASE = 40_000;
const PREFERRED_SPAN = 20_000;

/** A stable preferred port for a seat (a hash of its state dir), so a seat
 *  keeps the same hub port across launches when it is free. */
export function preferredClineHubPort(seatStateDir: string): number {
  const digest = createHash("sha256").update(seatStateDir).digest();
  return PREFERRED_BASE + (digest.readUInt32BE(0) % PREFERRED_SPAN);
}

/** Bind `port` (0 = let the OS choose) on 127.0.0.1, close at once, and
 *  return the bound port; rejects when the port is taken. */
function probeLoopbackPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : 0;
      server.close(() => (validPort(bound) ? resolve(bound) : reject(new Error("no loopback port available"))));
    });
  });
}

/** A free loopback port: the seat's preferred port when free, else one the OS picks. */
export async function allocateLoopbackPort(preferred?: number): Promise<number> {
  if (preferred !== undefined && validPort(preferred)) {
    try {
      return await probeLoopbackPort(preferred);
    } catch {
      // taken: fall through to an OS-chosen port
    }
  }
  return probeLoopbackPort(0);
}

export interface ClineSeatHubDeps {
  isAlive?: (pid: number) => boolean;
  /** Allocate a free port, preferring `preferred` when it is free. */
  allocatePort?: (preferred: number) => Promise<number>;
}

/**
 * Choose and record this seat's hub port before launch. A seat hub that is
 * still running (for example a relaunch after the TUI exited) keeps its port,
 * so the new TUI reuses it instead of starting a second one; otherwise the
 * seat's stable preferred port is used when free, else any free loopback port.
 */
export async function prepareClineSeatHub(fs: ClineHubFs, seatStateDir: string, deps: ClineSeatHubDeps = {}): Promise<number> {
  const paths = clineSeatHubPaths(seatStateDir);
  const running = readClineSeatHub(fs, seatStateDir);
  const port = running && (deps.isAlive ?? processAlive)(running.pid)
    ? running.port
    : await (deps.allocatePort ?? allocateLoopbackPort)(preferredClineHubPort(seatStateDir));
  if (!validPort(port)) throw new Error(`invalid cline hub port ${String(port)}`);
  fs.mkdirp(paths.dir);
  fs.writeFile(paths.portFile, `${port}\n`);
  return port;
}

/**
 * The launch env that gives the seat its own hub. Throws when no port was
 * recorded: launching without it would attach the seat to the shared hub,
 * which the stop reaper could then kill, so the launch is refused instead.
 */
export function clineSeatHubEnv(fs: ClineHubFs, seatStateDir: string): Record<string, string> {
  const paths = clineSeatHubPaths(seatStateDir);
  let port: number | null = null;
  try {
    port = fs.exists(paths.portFile) ? validPort(fs.readFile(paths.portFile)) : null;
  } catch {
    port = null;
  }
  if (!port) throw new Error("could not set up the seat's own cline hub (no hub port recorded for this seat)");
  return { CLINE_HUB_DISCOVERY_PATH: paths.discoveryFile, CLINE_HUB_PORT: String(port) };
}
