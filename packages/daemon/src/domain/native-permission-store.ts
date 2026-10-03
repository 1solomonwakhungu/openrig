import type Database from "better-sqlite3";
import type { NodeBinding } from "./runtime-adapter.js";
import { permissionBindingOverride, registryPermissionModes, type NativePermissionSelection } from "./native-permission-selection.js";

export interface StoredNativePermissionSelection extends NativePermissionSelection {
  actor: string;
  reason: string;
  updatedAt: string;
}

export interface SelectionFallback {
  selection: StoredNativePermissionSelection;
  /** True when the selection's posture applied to the fallback runtime. */
  applied: boolean;
}

/** Whether `runtime` takes `mode` as a per-seat posture: floor/full_bypass on
 *  claude-code and codex, or a mode the registry runtime declares. */
function runtimeAcceptsMode(runtime: string, mode: string): boolean {
  if (mode !== "floor" && mode !== "full_bypass") return false;
  return runtime === "claude-code" || runtime === "codex" || registryPermissionModes(runtime).includes(mode);
}

/** The stable node owns the desired setting. Native history and current processes are untouched. */
export class NativePermissionStore {
  constructor(private readonly db: Database.Database) {}

  read(nodeId: string): StoredNativePermissionSelection | null {
    const row = this.db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").get(nodeId) as {
      runtime: string; mode: string; actor: string; reason: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    const builtin = row.runtime === "codex" || row.runtime === "claude-code";
    if ((!builtin && !registryPermissionModes(row.runtime).includes(row.mode)) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.mode)
      || (row.runtime === "codex" && row.mode !== "floor" && row.mode !== "full_bypass")) {
      throw new Error("Invalid persisted native permission selection; launch refused.");
    }
    return { runtime: row.runtime, mode: row.mode, actor: row.actor, reason: row.reason, updatedAt: row.updated_at };
  }

  write(nodeId: string, selection: NativePermissionSelection | null, actor: string, reason: string): void {
    if (!selection) {
      this.db.prepare("DELETE FROM node_permission_selections WHERE node_id = ?").run(nodeId);
      return;
    }
    this.db.prepare(`INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET runtime=excluded.runtime, mode=excluded.mode,
        actor=excluded.actor, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(nodeId, selection.runtime, selection.mode, actor, reason);
  }

  apply(binding: NodeBinding, runtime: string): NodeBinding {
    return this.resolve(binding, runtime).binding;
  }

  /** The binding with the seat's selection applied for `runtime`; see overrideFor. */
  resolve(binding: NodeBinding, runtime: string): { binding: NodeBinding; fallback?: SelectionFallback } {
    const { override, fallback } = this.overrideFor(binding.nodeId, runtime);
    return { binding: { ...binding, ...override }, ...(fallback ? { fallback } : {}) };
  }

  /**
   * The launch override from the seat's selection for `runtime`. Runtime
   * fallback: when the selection was made for another runtime in the seat's own
   * candidates (its declared runtime and fallback_runtimes), a floor/full_bypass
   * selection carries over if `runtime` accepts that mode; otherwise the policy
   * posture applies. `fallback` reports that decision so callers can record it.
   * Any other runtime change still refuses the launch.
   */
  overrideFor(nodeId: string, runtime: string): { override: ReturnType<typeof permissionBindingOverride>; fallback?: SelectionFallback } {
    const selection = this.read(nodeId);
    if (!selection || selection.runtime === runtime) return { override: permissionBindingOverride(selection) };
    const candidates = this.runtimeCandidates(nodeId);
    if (!candidates.includes(selection.runtime) || !candidates.includes(runtime)) {
      throw new Error("Seat runtime changed since permission selection; explicitly select again or inherit.");
    }
    const applied = runtimeAcceptsMode(runtime, selection.mode);
    return {
      override: applied ? { launchPosture: selection.mode as "floor" | "full_bypass" } : {},
      fallback: { selection, applied },
    };
  }

  /** The seat's declared runtime then its fallback_runtimes ([] before migration 502). */
  private runtimeCandidates(nodeId: string): string[] {
    const columns = (this.db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes("declared_runtime") || !columns.includes("fallback_runtimes")) return [];
    const row = this.db.prepare("SELECT runtime, declared_runtime, fallback_runtimes FROM nodes WHERE id = ?").get(nodeId) as
      { runtime: string; declared_runtime: string | null; fallback_runtimes: string | null } | undefined;
    if (!row) return [];
    let fallbacks: unknown = [];
    try { fallbacks = row.fallback_runtimes ? JSON.parse(row.fallback_runtimes) : []; } catch { fallbacks = []; }
    if (!Array.isArray(fallbacks) || fallbacks.length === 0) return [];
    return [row.declared_runtime ?? row.runtime, ...fallbacks.filter((value): value is string => typeof value === "string")];
  }
}
