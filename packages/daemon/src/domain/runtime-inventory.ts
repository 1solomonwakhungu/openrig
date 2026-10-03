// Runtime inventory (feature 6): one row per registered, non-internal runtime
// with whether its CLI is installed, its version, its sign-in status, and what
// it supports. `rig runtimes`, the runtimes section of `rig doctor`, and
// `rig setup` all read this one builder, so they never disagree.
//
// Local checks only: the binary probe runs `<binary> <versionArgs>` (the same
// probe preflight uses) and sign-in comes from each descriptor's authStatus
// hook (local files and env names; a documented read-only status command only
// when `probe` is set). Never throws: a failed probe is "not installed" and a
// failed sign-in check is "unknown".

import { listRuntimeDescriptors, parseRuntimeVersion, type RuntimeDescriptor } from "./runtime-registry.js";
import { runDescriptorAuthStatus, type RuntimeAuthContext, type RuntimeAuthStatus } from "./runtime-capabilities.js";

export const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

/** Runs argv (never a shell string). Null when it could not run at all (for
 *  example, the binary is not on PATH). */
export type RuntimeInventoryExec = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string } | null>;

export interface RuntimeInventoryDeps {
  exec: RuntimeInventoryExec;
  /** Sign-in context for the authStatus hooks (probe is added only when `probe`). */
  auth: Omit<RuntimeAuthContext, "probe">;
  /** Allow each runtime's documented read-only status command. Default false. */
  probe?: boolean;
  /** Defaults to every registered runtime. */
  descriptors?: readonly RuntimeDescriptor[];
}

export interface RuntimeInventoryEntry {
  id: string;
  displayName: string;
  kind: RuntimeDescriptor["kind"];
  binary: string | null;
  /** Null when there is no binary to probe (the terminal runtime). */
  installed: boolean | null;
  version: string | null;
  /** Null when sign-in does not apply (no binary, e.g. the terminal runtime). */
  auth: RuntimeAuthStatus | null;
  resume: boolean;
  fork: boolean;
  guidanceFile: string | null;
  docsPath: string | null;
  installHint: string | null;
}

async function probeInstalled(
  descriptor: RuntimeDescriptor,
  exec: RuntimeInventoryExec,
): Promise<{ installed: boolean | null; version: string | null }> {
  if (!descriptor.binary) return { installed: null, version: null };
  try {
    const result = await exec([descriptor.binary, ...(descriptor.versionArgs ?? ["--version"])], RUNTIME_PROBE_TIMEOUT_MS);
    if (!result) return { installed: false, version: null };
    // It ran, so it is installed; a version comes only from a clean exit.
    return { installed: true, version: result.code === 0 ? parseRuntimeVersion(result.stdout) ?? null : null };
  } catch {
    return { installed: false, version: null };
  }
}

export async function buildRuntimeInventory(deps: RuntimeInventoryDeps): Promise<RuntimeInventoryEntry[]> {
  const descriptors = (deps.descriptors ?? listRuntimeDescriptors()).filter((d) => !d.internal);
  const ctx: RuntimeAuthContext = deps.probe
    ? { ...deps.auth, probe: { exec: (argv, timeoutMs) => deps.exec(argv, timeoutMs).catch(() => null) } }
    : { ...deps.auth };
  return Promise.all(descriptors.map(async (descriptor): Promise<RuntimeInventoryEntry> => {
    const [probe, auth] = await Promise.all([
      probeInstalled(descriptor, deps.exec),
      descriptor.binary ? runDescriptorAuthStatus(descriptor, ctx) : Promise.resolve(null),
    ]);
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      kind: descriptor.kind,
      binary: descriptor.binary ?? null,
      installed: probe.installed,
      version: probe.version,
      auth,
      resume: !!descriptor.resumeType,
      fork: descriptor.supportsFork,
      guidanceFile: descriptor.guidanceFile ?? null,
      docsPath: descriptor.docsPath ?? null,
      installHint: descriptor.installHint ?? null,
    };
  }));
}

/** Read-only, size-capped file access for the authStatus hooks, on node fs. */
export function nodeAuthFs(readFile: (path: string) => Buffer, exists: (path: string) => boolean): RuntimeAuthContext["fs"] {
  return {
    exists: (path) => {
      try {
        return exists(path);
      } catch {
        return false;
      }
    },
    readFile: (path, maxBytes) => {
      try {
        if (!exists(path)) return null;
        const buffer = readFile(path);
        if (maxBytes !== undefined && buffer.length > maxBytes) return null;
        return buffer.toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

/** One row's doctor verdict: installed and signed in passes; installed but
 *  not signed in warns; not installed is informational (skipped). */
export function runtimeDoctorStatus(entry: RuntimeInventoryEntry): { status: "pass" | "warn" | "skipped"; message: string } {
  const name = `${entry.displayName} (${entry.id})`;
  if (entry.installed === null) return { status: "skipped", message: `${name}: no CLI to check` };
  if (!entry.installed) {
    return { status: "skipped", message: `${name}: not installed${entry.installHint ? ` (install: ${entry.installHint})` : ""}` };
  }
  const version = entry.version ? ` ${entry.version}` : "";
  if (entry.auth?.state === "missing") {
    return { status: "warn", message: `${name}${version}: installed, not signed in${entry.auth.hint ? ` (${entry.auth.hint})` : ""}` };
  }
  if (entry.auth?.state === "unknown") {
    return { status: "pass", message: `${name}${version}: installed; sign-in not checked${entry.auth.detail ? ` (${entry.auth.detail})` : ""}` };
  }
  return { status: "pass", message: `${name}${version}: installed and signed in${entry.auth?.source ? ` (${entry.auth.source})` : ""}` };
}
