// Permission-drift posture hooks for the registry CLI runtimes that lacked
// them after #10: each spec's observeLaunch records the permission value the
// launch actually emits, and each descriptor's permissionPostureFor maps it
// back to the OpenRig posture, so diagnoseRuntimePosture can compare it with
// the seat's policy. Hermetic: no binaries, no panes.

import { describe, expect, it } from "vitest";
import {
  diagnoseRuntimePosture,
  type AppliedLaunchObservation,
  type PermissionDriftFs,
} from "../src/domain/permission-drift.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";
import type { TuiCliLaunchInput, TuiCliRuntimeSpec } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { createClineSpec } from "../src/adapters/cli/cline/index.js";
import { createAiderSpec } from "../src/adapters/cli/aider/index.js";
import { GROK_SPEC } from "../src/adapters/cli/grok/index.js";
import { ANTIGRAVITY_SPEC } from "../src/adapters/cli/antigravity/index.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const cwd = "/work/project";
const fs: PermissionDriftFs = {
  readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  cwdReadable: () => true,
  commandAvailable: () => true,
  claudePermissionModes: () => [],
};

const binding: NodeBinding = {
  id: "b", nodeId: "n", tmuxSession: "dev-impl@rig", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "2026-09-30T00:00:00.000Z", cwd,
};

function input(posture: "floor" | "full_bypass"): TuiCliLaunchInput {
  return { binding, posture, seatStateDir: "/openrig-home/state/x/dev-impl@rig" };
}

function diagnose(runtime: string, applied: AppliedLaunchObservation | null, expectedPosture: "floor" | "full_bypass" | null) {
  return diagnoseRuntimePosture({ runtime, cwd, applied, fs, expectedPosture }).enforcement;
}

interface Case {
  runtime: string;
  spec: TuiCliRuntimeSpec;
  /** The argv tokens that carry each posture's permission value. */
  emits: { floor: string[] | null; full_bypass: string[] };
}

const CASES: Case[] = [
  { runtime: "cline", spec: createClineSpec({}), emits: { floor: ["--auto-approve", "false"], full_bypass: ["--auto-approve", "true"] } },
  { runtime: "aider", spec: createAiderSpec("/openrig-home/state", () => "id"), emits: { floor: null, full_bypass: ["--yes-always"] } },
  { runtime: "grok", spec: GROK_SPEC, emits: { floor: ["--permission-mode", "acceptEdits"], full_bypass: ["--always-approve"] } },
  { runtime: "antigravity", spec: ANTIGRAVITY_SPEC, emits: { floor: ["--mode", "accept-edits"], full_bypass: ["--dangerously-skip-permissions"] } },
];

function containsRun(argv: string[], run: string[]): boolean {
  return argv.some((_, i) => run.every((token, j) => argv[i + j] === token));
}

describe.each(CASES)("posture drift hooks: $runtime", ({ runtime, spec, emits }) => {
  const descriptor = getRuntimeDescriptor(runtime)!;
  const observe = (posture: "floor" | "full_bypass") => spec.observeLaunch!(input(posture))!;

  it("is registered with observeLaunch and permissionPostureFor", () => {
    expect(descriptor.permissionPostureFor).toBeTypeOf("function");
    expect(spec.observeLaunch).toBeTypeOf("function");
  });

  it("records the permission value the launch actually emits", () => {
    const bypass = observe("full_bypass");
    expect(bypass).toMatchObject({ runtime, axis: "permission", state: "observed", reason: "emitted_launch_arguments" });
    expect(containsRun(spec.buildLaunchCommand(input("full_bypass")), emits.full_bypass)).toBe(true);
    expect(descriptor.permissionPostureFor!(bypass.value!)).toBe("full_bypass");

    const floor = observe("floor");
    if (emits.floor) {
      expect(floor).toMatchObject({ runtime, axis: "permission", state: "observed", reason: "emitted_launch_arguments" });
      expect(containsRun(spec.buildLaunchCommand(input("floor")), emits.floor)).toBe(true);
      expect(descriptor.permissionPostureFor!(floor.value!)).toBe("floor");
    } else {
      // No permission flag on the floor: the CLI's own config governs.
      expect(floor).toEqual({ runtime, axis: "permission", state: "unknown", value: null, reason: "cli_config_governs" });
      expect(spec.buildLaunchCommand(input("floor"))).not.toContain(emits.full_bypass[0]);
    }
  });

  it("aligned full_bypass", () => {
    expect(diagnose(runtime, observe("full_bypass"), "full_bypass")).toEqual({
      axis: "permission", state: "aligned", expected: "full_bypass", effective: "full_bypass", sourcePath: null, reason: "launch_posture_compared",
    });
  });

  it("aligned floor (or unknown when the floor emits no permission flag)", () => {
    const result = diagnose(runtime, observe("floor"), "floor");
    if (emits.floor) {
      expect(result).toEqual({
        axis: "permission", state: "aligned", expected: "floor", effective: "floor", sourcePath: null, reason: "launch_posture_compared",
      });
    } else {
      expect(result).toMatchObject({ state: "unknown" });
      expect(result.state).not.toBe("drift");
    }
  });

  it("drift when the emitted posture differs from the policy", () => {
    expect(diagnose(runtime, observe("full_bypass"), "floor")).toMatchObject({
      axis: "permission", state: "drift", expected: "floor", effective: "full_bypass", reason: "launch_posture_compared",
    });
    if (emits.floor) {
      expect(diagnose(runtime, observe("floor"), "full_bypass")).toMatchObject({
        state: "drift", expected: "full_bypass", effective: "floor",
      });
    }
  });

  it("unknown for a value this runtime never emits, and without a policy posture", () => {
    const foreign: AppliedLaunchObservation = { runtime, axis: "permission", state: "observed", value: "plan", reason: "emitted_launch_arguments" };
    expect(descriptor.permissionPostureFor!("plan")).toBeNull();
    expect(diagnose(runtime, foreign, "floor")).toMatchObject({ state: "unknown", reason: "unrecognized_launch_value" });
    expect(diagnose(runtime, observe("full_bypass"), null)).toMatchObject({ state: "unknown", reason: "expected_posture_unknown" });
  });
});
