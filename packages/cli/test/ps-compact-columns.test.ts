// Compact `rig ps` columns: a value as long as its column must stay separated
// from the next one (builder smoke printed "needs-input x1no").

import { describe, expect, it } from "vitest";
import { padCompactNodeRow, padNodeRow } from "../src/commands/ps.js";

describe("rig ps compact columns", () => {
  it("keeps needs-input counts apart from WORK", () => {
    const rows = [
      padCompactNodeRow("RIG", "SESSION", "LIFECYCLE", "ACTIVITY", "WORK", "REASON"),
      padCompactNodeRow("openrig", "build-builder-2@openrig", "running", "needs-input x1", "no", "prompt in pane"),
      padCompactNodeRow("openrig", "review-reviewer-1@openrig", "running", "needs-input x12", "3", "-"),
      padCompactNodeRow("openrig", "intake-lead@openrig", "running", "working", "no", "-"),
    ].map((row) => row.trimEnd());
    expect(rows.join("\n")).toMatchInlineSnapshot(`
      "RIG                   SESSION                               LIFECYCLE  ACTIVITY        WORK  REASON
      openrig               build-builder-2@openrig               running    needs-input x1  no    prompt in pane
      openrig               review-reviewer-1@openrig             running    needs-input x12 3     -
      openrig               intake-lead@openrig                   running    working         no    -"
    `);
    for (const row of rows.slice(1)) expect(row).not.toMatch(/x\d+(?:no|yes)/);
  });

  it("keeps a gutter after a cell that fills its column exactly", () => {
    const session = "s".repeat(38);
    const row = padCompactNodeRow("r".repeat(22), session, "lifecycle-x", "a".repeat(16), "w".repeat(6), "reason");
    expect(row.split(/ +/)).toHaveLength(6);
    expect(row).toContain(`${"s".repeat(36)}… `);
  });

  it("the full view shows needs-input x1 whole, apart from CTX", () => {
    const row = padNodeRow("rig", "pod", "member", "s@rig", "codex", "-", "ready", "ready", "yes", "running", "active", "no", "needs-input x1", "12%", "-", "-", "-");
    expect(row).toMatch(/needs-input x1 +12%/);
  });
});
