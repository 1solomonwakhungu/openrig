// Feature 1: `rig ps --nodes --full` shows a COST column from the daemon's
// runtimeUsage block (registry CLI runtimes that report cost).

import { describe, it, expect } from "vitest";
import { formatRuntimeCost, padNodeRow } from "../src/commands/ps.js";

/** The mark rig ps uses for an empty cell. */
const EMPTY_CELL = "\u2014";

describe("rig ps COST column", () => {
  it("formats a reported cost, marks an estimated one, and shows a dash when unknown", () => {
    expect(formatRuntimeCost({ costUsd: 0.4231 })).toBe("$0.42");
    expect(formatRuntimeCost({ costUsd: 12.5 })).toBe("$12.50");
    expect(formatRuntimeCost({ costUsd: 250 })).toBe("$250");
    expect(formatRuntimeCost({ costUsd: 0.004 })).toBe("$<0.01");
    expect(formatRuntimeCost({ costUsd: 0 })).toBe("$0.00");
    expect(formatRuntimeCost({ costUsd: 0.05, costSource: "estimated" })).toBe("~$0.05");
    // aider's counts are rounded, but its cost is what aider printed: not marked.
    expect(formatRuntimeCost({ costUsd: 0.05, costSource: "cli_reported", approximate: true })).toBe("$0.05");
    expect(formatRuntimeCost(undefined)).toBe(EMPTY_CELL);
    expect(formatRuntimeCost({ inputTokens: 100 })).toBe(EMPTY_CELL);
    expect(formatRuntimeCost({ costUsd: Number.NaN })).toBe(EMPTY_CELL);
  });

  it("puts COST between CTX and RESTORE in the full node header", () => {
    const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "MODEL(DECLARED)", "STATUS",
      "STARTUP", "ORIENTED", "LIFECYCLE", "TERMINAL", "WORK", "ACTIVITY", "CTX", "COST", "RESTORE", "ERROR");
    expect(header.indexOf("CTX")).toBeLessThan(header.indexOf("COST"));
    expect(header.indexOf("COST")).toBeLessThan(header.indexOf("RESTORE"));
  });
});
