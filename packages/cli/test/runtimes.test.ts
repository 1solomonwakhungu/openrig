// `rig runtimes`, the runtimes section of `rig doctor`, and the runtime list in
// `rig setup`: all read the same inventory rows (injected here; the real
// builder is tested in the daemon package).

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import type { RuntimeInventoryEntry } from "@openrig/daemon/runtime-inventory";
import { createProgram } from "../src/index.js";
import { formatRuntimesTable, runtimesCommand } from "../src/commands/runtimes.js";
import { buildRuntimeChecks } from "../src/commands/doctor.js";
import { runtimeChoiceLines } from "../src/commands/setup.js";

const row = (over: Partial<RuntimeInventoryEntry> & { id: string }): RuntimeInventoryEntry => ({
  displayName: over.id, kind: "agent", binary: over.id, installed: true, version: "1.0.0",
  auth: { state: "signed_in", source: "env K" }, resume: true, fork: false,
  guidanceFile: "AGENTS.md", docsPath: `docs/reference/runtimes/${over.id}.md`, installHint: `npm i -g ${over.id}`, ...over,
});

const ROWS: RuntimeInventoryEntry[] = [
  row({ id: "opencode", version: "1.18.33" }),
  row({ id: "gemini", auth: { state: "missing", hint: "set GEMINI_API_KEY", detail: "no auth method chosen" }, guidanceFile: "GEMINI.md" }),
  row({ id: "copilot", auth: { state: "unknown", detail: "a `copilot login` session cannot be checked without the keychain" } }),
  row({ id: "grok", installed: false, version: null }),
  row({ id: "terminal", kind: "terminal", binary: null, installed: null, version: null, auth: null, resume: false, guidanceFile: null, docsPath: null, installHint: null }),
];

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try { await fn(); } finally { console.log = orig; }
  return logs.join("\n");
}

describe("rig runtimes", () => {
  it("is wired into the program", () => {
    expect(createProgram().commands.find((c) => c.name() === "runtimes")).toBeDefined();
  });

  it("the table shows installed/version, signed in, resume, fork, and guidance per runtime", () => {
    const out = formatRuntimesTable(ROWS);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^RUNTIME\s+INSTALLED\s+SIGNED IN\s+RESUME\s+FORK\s+GUIDANCE$/);
    expect(lines.find((l) => l.startsWith("opencode"))).toMatch(/opencode\s+1\.18\.33\s+yes\s+yes\s+no\s+AGENTS\.md/);
    expect(lines.find((l) => l.startsWith("gemini"))).toMatch(/gemini\s+1\.0\.0\s+no\s+/);
    expect(lines.find((l) => l.startsWith("copilot"))).toMatch(/copilot\s+1\.0\.0\s+unknown\s+/);
    expect(lines.find((l) => l.startsWith("grok"))).toMatch(/grok\s+no\s+/);
    expect(lines.find((l) => l.startsWith("terminal"))).toMatch(/terminal\s+-\s+-\s+no\s+no\s+-/);
  });

  it("notes say what to do: install hints, sign-in hints, unknown reasons, and docs", () => {
    const out = formatRuntimesTable(ROWS);
    expect(out).toContain("grok: not installed; install: npm i -g grok");
    expect(out).toContain("gemini: not signed in; set GEMINI_API_KEY (no auth method chosen)");
    expect(out).toContain("copilot: sign-in unknown; a `copilot login` session cannot be checked without the keychain");
    expect(out).toContain("opencode: docs docs/reference/runtimes/opencode.md");
    expect(out).not.toContain("grok: docs");
  });

  it("--json prints the rows; --probe is passed to the inventory", async () => {
    const calls: boolean[] = [];
    const program = new Command().addCommand(runtimesCommand({ inventory: async ({ probe }) => { calls.push(probe); return ROWS; } }));
    const json = await capture(() => program.parseAsync(["node", "rig", "runtimes", "--json"]));
    expect(JSON.parse(json).map((r: RuntimeInventoryEntry) => r.id)).toEqual(["opencode", "gemini", "copilot", "grok", "terminal"]);
    await capture(() => program.parseAsync(["node", "rig", "runtimes", "--probe"]));
    expect(calls).toEqual([false, true]);
  });
});

describe("rig doctor runtimes section", () => {
  it("one check per installed runtime, warn-only, plus one skipped line for what is not installed", async () => {
    const checks = await buildRuntimeChecks(async () => ROWS);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["runtime:opencode", "pass"],
      ["runtime:gemini", "warn"],
      ["runtime:copilot", "pass"],
      ["runtimes", "skipped"],
    ]);
    expect(checks.find((c) => c.name === "runtime:gemini")?.fix).toBe("See docs/reference/runtimes/gemini.md");
    expect(checks.find((c) => c.name === "runtimes")?.message).toContain("Not installed: grok");
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("an inventory failure is a skipped check, never a failed doctor", async () => {
    expect(await buildRuntimeChecks(async () => { throw new Error("boom"); })).toEqual([
      { name: "runtimes", status: "skipped", message: "Could not list agent runtimes" },
    ]);
  });
});

describe("rig setup runtime list", () => {
  it("lists every agent runtime with installed and sign-in state", () => {
    const lines = runtimeChoiceLines(ROWS);
    expect(lines[0]).toContain("rig runtimes");
    expect(lines.join("\n")).toMatch(/opencode\s+installed 1\.18\.33, signed in/);
    expect(lines.join("\n")).toMatch(/gemini\s+installed 1\.0\.0, not signed in/);
    expect(lines.join("\n")).toMatch(/copilot\s+installed 1\.0\.0, sign-in unknown/);
    expect(lines.join("\n")).toMatch(/grok\s+not installed/);
    expect(lines.join("\n")).not.toContain("terminal");
  });
});
