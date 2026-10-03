import { describe, it, expect } from "vitest";
import { compactNodeProjection, fallbackRuntimeNotices, formatRuntime } from "../src/commands/ps.js";

// Runtime fallback: a seat that launched on a fallback runtime is flagged in
// the RUNTIME cell and named in a notice below the table.
describe("rig ps: runtime fallback", () => {
  const node = (over: Record<string, unknown> = {}) => ({
    rigName: "r", logicalId: "dev.impl", canonicalSessionName: "dev-impl@r", lifecycleState: "run",
    agentActivity: { state: "idle" }, hasAssignedWork: false, pendingWorkCount: 0, runtime: "claude-code", model: null,
    ...over,
  });

  it("marks a fallback runtime with * and leaves a declared runtime plain", () => {
    expect(formatRuntime({ runtime: "codex", declaredRuntime: "claude-code" })).toBe("codex*");
    expect(formatRuntime({ runtime: "claude-code", declaredRuntime: null })).toBe("claude-code");
    expect(formatRuntime({ runtime: null })).toBeNull();
  });

  it("prints a notice only for seats on a fallback runtime", () => {
    const notices = fallbackRuntimeNotices([
      node({ runtime: "codex", declaredRuntime: "claude-code" }),
      node({ canonicalSessionName: "dev-other@r" }),
    ] as never);
    expect(notices).toEqual(['! dev-impl@r runs on fallback runtime "codex" (declared "claude-code")']);
  });

  it("the compact projection carries declaredRuntime only when set", () => {
    const [fallback, plain] = compactNodeProjection([
      node({ runtime: "codex", declaredRuntime: "claude-code" }),
      node(),
    ] as never);
    expect(fallback.declaredRuntime).toBe("claude-code");
    expect(plain).not.toHaveProperty("declaredRuntime");
  });
});
