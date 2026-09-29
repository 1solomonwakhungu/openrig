// Stop-time process-tree reaping for runtimes whose CLI can outlive its pane
// (a relaunched node child keeps running after tmux kill-session or
// kill-server). Opt-in per descriptor (`reapProcessTreeOnStop`), so the
// built-in runtimes stop exactly as before.
//
// PID-scoped only: the pane pid, its process group, and its descendant tree
// are snapshotted BEFORE the kill. After the kill the pane's process group gets
// SIGTERM (only while its leader is the same process still leading it), then
// every surviving snapshot pid gets SIGTERM, then SIGKILL after a grace period.
// A pid is signalled only while its identity (start time and command) still
// matches the snapshot, so a reused pid is never hit. Never kills by name: the
// owner may run the same CLI outside OpenRig.

import nodePath from "node:path";
import type { TmuxResult } from "../adapters/tmux.js";
import { getRuntimeDescriptor, listRuntimeDescriptors, type RuntimeDescriptor } from "./runtime-registry.js";
import { LAUNCH_RECORD_FILE, seatStateDirFor } from "./runtime-capture.js";

export interface ReaperProcessRow {
  pid: number;
  ppid: number;
  command: string;
  /** Process group id; enables the group signal when the pane pid leads it. */
  pgid?: number;
  /** Process start time (ps lstart); part of the pid-reuse check when present. */
  startedAt?: string;
}

export interface ProcessTreeReaperDeps {
  getPanePid(sessionName: string): Promise<number | null>;
  listProcesses(): Promise<ReaperProcessRow[]>;
  /** A negative pid signals that process group (process.kill semantics). */
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between SIGTERM and SIGKILL. Default 1500ms. */
  graceMs?: number;
}

export interface ReapReport {
  snapshot: number[];
  /** The pane process group signalled with SIGTERM, when its leader still matched. */
  groupTerminated: number | null;
  terminated: number[];
  killed: number[];
}

const identity = (row: ReaperProcessRow): string => `${row.startedAt ?? ""}\u0000${row.command}`;

/** The pane pid and all its descendants, from one process-table snapshot. */
export function processTree(rows: readonly ReaperProcessRow[], rootPid: number): ReaperProcessRow[] {
  const byParent = new Map<number, ReaperProcessRow[]>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const tree: ReaperProcessRow[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = rows.find((row) => row.pid === pid);
    if (self) tree.push(self);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return tree;
}

/**
 * Snapshot the pane's process tree, run `kill` (tmux kill-session), then
 * SIGTERM snapshot pids that survived with the same identity, and SIGKILL the
 * ones still alive after the grace period. The kill result is returned as-is;
 * reaping problems are logged, never turned into a stop failure.
 */
export async function killSessionAndProcessTree(
  sessionName: string,
  kill: () => Promise<TmuxResult>,
  deps: ProcessTreeReaperDeps,
): Promise<TmuxResult & { reap?: ReapReport }> {
  let snapshot: ReaperProcessRow[] = [];
  let panePid: number | null = null;
  try {
    panePid = await deps.getPanePid(sessionName);
    if (panePid) snapshot = processTree(await deps.listProcesses(), panePid);
  } catch (err) {
    console.warn(`[openrig] reap: could not snapshot ${sessionName}'s process tree (${(err as Error).message})`);
  }

  const result = await kill();
  if (snapshot.length === 0) return result;

  const report: ReapReport = { snapshot: snapshot.map((row) => row.pid), groupTerminated: null, terminated: [], killed: [] };
  // The pane pid leads its own process group (a tmux pane's session leader);
  // CLIs that ignore SIGHUP keep their children in that group.
  const leader = snapshot.find((row) => row.pid === panePid);
  const groupId = leader && leader.pgid === leader.pid ? leader.pid : null;
  const expected = new Map(snapshot.map((row) => [row.pid, identity(row)]));
  const survivors = async (): Promise<number[]> => {
    const rows = await deps.listProcesses();
    return rows.filter((row) => expected.get(row.pid) === identity(row)).map((row) => row.pid);
  };
  const send = (pid: number, signal: "SIGTERM" | "SIGKILL"): boolean => {
    try {
      deps.signal(pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  };

  try {
    if (groupId !== null) {
      // Group signal only while the leader is still the same process leading
      // the same group; otherwise fall through to per-pid signals.
      const current = (await deps.listProcesses()).find((row) => row.pid === groupId);
      if (current && current.pgid === groupId && identity(current) === expected.get(groupId) && send(-groupId, "SIGTERM")) {
        report.groupTerminated = groupId;
      }
    }
    for (const pid of await survivors()) if (send(pid, "SIGTERM")) report.terminated.push(pid);
    if (report.terminated.length > 0 || report.groupTerminated !== null) {
      await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(deps.graceMs ?? 1500);
      for (const pid of await survivors()) if (send(pid, "SIGKILL")) report.killed.push(pid);
    }
  } catch (err) {
    console.warn(`[openrig] reap: ${sessionName} process tree reaping stopped early (${(err as Error).message})`);
  }
  if (report.terminated.length > 0 || report.groupTerminated !== null) {
    console.log(`[openrig] reap: ${sessionName} SIGTERM ${report.groupTerminated !== null ? `group ${report.groupTerminated} ` : ""}${report.terminated.join(",")}${report.killed.length ? `; SIGKILL ${report.killed.join(",")}` : ""}`);
  }
  return { ...result, reap: report };
}

/**
 * The reap-enabled runtime for a session, if any. The seat's CURRENT runtime
 * comes from the session registry (`resolveSessionRuntime`); a seat that was
 * re-specced to another runtime is judged by that runtime, whatever stale
 * launch.json files remain. Only when the registry does not know the session
 * does the seat's launch.json decide, and then only if its runtimeId and
 * sessionName both match (restart-safe for sessions the DB lost).
 */
export function reapingRuntimeForSession(
  sessionName: string,
  input: {
    stateRoot: string;
    readFile: (path: string) => string | null;
    resolveSessionRuntime?: (sessionName: string) => string | null | undefined;
  },
): RuntimeDescriptor | undefined {
  const current = input.resolveSessionRuntime?.(sessionName);
  if (current) {
    const descriptor = getRuntimeDescriptor(current);
    return descriptor?.reapProcessTreeOnStop ? descriptor : undefined;
  }
  return listRuntimeDescriptors().find((descriptor) => {
    if (!descriptor.reapProcessTreeOnStop) return false;
    const raw = input.readFile(nodePath.join(seatStateDirFor(input.stateRoot, descriptor.id, sessionName), LAUNCH_RECORD_FILE));
    if (!raw) return false;
    try {
      const record = JSON.parse(raw) as { runtimeId?: unknown; sessionName?: unknown };
      return record.runtimeId === descriptor.id && record.sessionName === sessionName;
    } catch {
      return false;
    }
  });
}

/**
 * The TmuxAdapter stop hook: every killSession call (teardown, seat stop,
 * restore rollback, launch cleanup, node removal) consults the seat's runtime
 * descriptor and reaps the process tree only for opted-in runtimes.
 */
export function createRuntimeStopHook(input: {
  stateRoot: string;
  readFile: (path: string) => string | null;
  resolveSessionRuntime?: (sessionName: string) => string | null | undefined;
  reaper: ProcessTreeReaperDeps;
}): (sessionName: string, kill: () => Promise<TmuxResult>) => Promise<TmuxResult> {
  return (sessionName, kill) => {
    let reap = false;
    try {
      reap = !!reapingRuntimeForSession(sessionName, input);
    } catch (err) {
      console.warn(`[openrig] reap: could not resolve ${sessionName}'s runtime (${(err as Error).message}); plain stop`);
    }
    return reap ? killSessionAndProcessTree(sessionName, kill, input.reaper) : kill();
  };
}
