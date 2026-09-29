// Shared, dependency-leaf helpers for runtime descriptors: the per-seat state
// dir layout and the never-throwing resume-token capture runner.
//
// Leaf on purpose: the TUI CLI base (adapters/cli/) runs capture after launch
// readiness and must not import runtime-registry.ts at runtime (see the import
// discipline note there). The registry, the refresher, restore, and adoption
// capture all go through runDescriptorTokenCapture too, so every call site has
// the same semantics.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { RuntimeDescriptor, RuntimeTokenCaptureOutcome } from "./runtime-registry.js";
import type { ResumeTokenCaptureDeps } from "./resume-token-capture.js";

/** Per-seat runtime state: <stateRoot>/<runtime id>/<session name>, where
 *  stateRoot is <OPENRIG_HOME>/state. */
export function seatStateDirFor(stateRoot: string, runtimeId: string, sessionName: string): string {
  return nodePath.join(stateRoot, runtimeId, sessionName);
}

/** Written by the TUI CLI base into the seat state dir before each launch, so
 *  late capture (refresher, restore) knows when the current session began. */
export const LAUNCH_RECORD_FILE = "launch.json";

export interface LaunchRecord {
  /** Unique per launch attempt. */
  launchId: string;
  runtimeId: string;
  sessionName: string;
  cwd: string;
  launchStartedAt: string;
  mode: "fresh" | "resume" | "fork";
  /** A token minted before launch (mintSessionToken), when the CLI accepts one. */
  presetToken?: string;
  /** Owner-config edits prepareLaunch made (owner-config.ts change records). */
  ownerConfigChanges?: unknown[];
}

/** Best-effort read of the seat's launch record. Null when absent or unreadable. */
export function readLaunchRecord(seatStateDir: string): Partial<LaunchRecord> | null {
  try {
    return JSON.parse(fs.readFileSync(nodePath.join(seatStateDir, LAUNCH_RECORD_FILE), "utf-8")) as Partial<LaunchRecord>;
  } catch {
    return null;
  }
}

/** Best-effort read of the launch record's start time. Null when absent or unreadable. */
export function readLaunchStartedAt(seatStateDir: string): Date | null {
  const record = readLaunchRecord(seatStateDir);
  const at = record?.launchStartedAt ? new Date(record.launchStartedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

export interface RuntimeTokenCaptureRequest {
  sessionName: string;
  cwd?: string | null;
  seatStateDir: string;
  launchStartedAt?: Date;
  /** Home directory for CLIs that keep sessions under ~. Default os.homedir(). */
  homedir?: string;
}

/**
 * Run a descriptor's capture hook and normalize its result. Never throws: a
 * throwing hook becomes `skipped` / `capture_error` with the reason logged
 * (the message never includes a token). A string result is a token, a null or
 * undefined result is `skipped` / `missing_sidecar`.
 */
export async function runDescriptorTokenCapture(
  descriptor: RuntimeDescriptor,
  request: RuntimeTokenCaptureRequest,
  deps: ResumeTokenCaptureDeps = {},
): Promise<RuntimeTokenCaptureOutcome> {
  if (!descriptor.captureResumeToken) return { outcome: "noop" };
  // Sibling-seat guard: a CLI whose capture is not keyed to this seat (for
  // example "newest session in this cwd") cannot tell two live seats in one
  // cwd apart, so it is not asked. A seat with a minted token is unaffected:
  // its capture returns that token.
  if (!descriptor.captureIsSessionScoped && request.cwd && deps.hasLiveSiblingSeat && !readLaunchRecord(request.seatStateDir)?.presetToken) {
    let shared = false;
    try {
      shared = deps.hasLiveSiblingSeat({ runtime: descriptor.id, cwd: request.cwd, sessionName: request.sessionName });
    } catch (err) {
      console.warn(`[openrig] ${descriptor.id} sibling-seat check failed for ${request.sessionName}: ${(err as Error).message}; skipping capture`);
      return { outcome: "skipped", reason: "ambiguous_seat" };
    }
    if (shared) {
      console.log(`[openrig] ${descriptor.id} resume-token capture skipped for ${request.sessionName}: another live ${descriptor.id} seat shares ${request.cwd}`);
      return { outcome: "skipped", reason: "ambiguous_seat" };
    }
  }
  try {
    // Late capture (refresher, restore, adoption) recovers the start time from
    // the launch record the base wrote before typing.
    const launchStartedAt = request.launchStartedAt ?? readLaunchStartedAt(request.seatStateDir) ?? undefined;
    const raw = await descriptor.captureResumeToken({ ...request, launchStartedAt, homedir: request.homedir ?? os.homedir() }, deps);
    if (raw === null || raw === undefined) return { outcome: "skipped", reason: "missing_sidecar" };
    if (typeof raw === "string") {
      const token = raw.trim();
      return token ? { outcome: "token", token } : { outcome: "skipped", reason: "missing_sidecar" };
    }
    return raw;
  } catch (err) {
    console.warn(`[openrig] ${descriptor.id} resume-token capture failed for ${request.sessionName}: ${(err as Error).message}`);
    return { outcome: "skipped", reason: "capture_error" };
  }
}
