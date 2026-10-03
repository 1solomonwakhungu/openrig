import { Command } from "commander";
import type { RuntimeInventoryEntry } from "@openrig/daemon/runtime-inventory";
import { localRuntimeInventory } from "../runtime-inventory-local.js";

export interface RuntimesDeps {
  inventory: (opts: { probe: boolean }) => Promise<RuntimeInventoryEntry[]>;
}

function signedInLabel(entry: RuntimeInventoryEntry): string {
  if (!entry.auth) return "-";
  if (entry.auth.state === "signed_in") return "yes";
  if (entry.auth.state === "missing") return "no";
  return "unknown";
}

function installedLabel(entry: RuntimeInventoryEntry): string {
  if (entry.installed === null) return "-";
  if (!entry.installed) return "no";
  return entry.version ?? "yes";
}

/** Fixed-width table: one row per runtime, then notes for what needs action. */
export function formatRuntimesTable(entries: readonly RuntimeInventoryEntry[]): string {
  const header = ["RUNTIME", "INSTALLED", "SIGNED IN", "RESUME", "FORK", "GUIDANCE"];
  const rows = entries.map((e) => [
    e.id,
    installedLabel(e),
    signedInLabel(e),
    e.resume ? "yes" : "no",
    e.fork ? "yes" : "no",
    e.guidanceFile ?? "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [line(header), ...rows.map(line)];

  const notes: string[] = [];
  for (const e of entries) {
    if (e.installed === false && e.installHint) notes.push(`${e.id}: not installed; install: ${e.installHint}`);
    else if (e.installed && e.auth?.state === "missing") {
      notes.push(`${e.id}: not signed in${e.auth.hint ? `; ${e.auth.hint}` : ""}${e.auth.detail ? ` (${e.auth.detail})` : ""}`);
    } else if (e.installed && e.auth?.state === "unknown" && e.auth.detail) {
      notes.push(`${e.id}: sign-in unknown; ${e.auth.detail}`);
    }
    if (e.installed && e.docsPath) notes.push(`${e.id}: docs ${e.docsPath}`);
  }
  if (notes.length > 0) out.push("", ...notes);
  return out.join("\n");
}

export function runtimesCommand(depsOverride?: RuntimesDeps): Command {
  const deps: RuntimesDeps = depsOverride ?? { inventory: localRuntimeInventory };
  return new Command("runtimes")
    .description("List agent runtimes: installed, version, signed in, resume and fork support (local checks only)")
    .option("--json", "JSON output for agents")
    .option("--probe", "Also run each CLI's documented read-only status command where one exists")
    .action(async (opts: { json?: boolean; probe?: boolean }) => {
      const entries = await deps.inventory({ probe: !!opts.probe });
      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      console.log(formatRuntimesTable(entries));
    });
}
