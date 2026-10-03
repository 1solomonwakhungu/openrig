// A registry CLI seat stopped at a gate or in-session prompt carries its
// needs-input only in the arbitrated activityState (no hook agentActivity):
// rig ps must still flag it for attention and say why.

import { describe, expect, it } from "vitest";
import { compactNodeProjection } from "../src/commands/ps.js";

const base = {
  rigId: "rig-1", rigName: "gate-rig", logicalId: "dev.impl", canonicalSessionName: "dev-impl@gate-rig",
  lifecycleState: "running", startupStatus: "ready", runtime: "copilot",
  hasAssignedWork: false, assignedWorkCount: 0, pendingWorkCount: 0,
};

describe("rig ps compact projection with arbitrated needs-input", () => {
  it("flags a seat whose arbitrated state shows needs-input and carries the reason", () => {
    const [row] = compactNodeProjection([{
      ...base,
      agentActivity: { state: "unknown" },
      activityState: { activity: "idle-at-prompt", display: "needs-input", needsInput: { count: 1, reason: "prompt in pane" } },
    } as never]);
    expect(row).toMatchObject({ needsInput: { count: 1, reason: "prompt in pane" } });
  });

  it("does not flag a seat whose arbitrated state shows no needs-input", () => {
    const [row] = compactNodeProjection([{
      ...base,
      agentActivity: { state: "idle" },
      activityState: { activity: "idle-at-prompt", display: "idle", needsInput: { count: 0, reason: null } },
    } as never]);
    expect(row).not.toHaveProperty("needsInput");
  });
});
