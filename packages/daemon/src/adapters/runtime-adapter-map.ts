import type { RuntimeAdapter } from "../domain/runtime-adapter.js";
import { CLI_RUNTIME_REGISTRATIONS } from "./cli/index.js";
import type { CliRuntimeAdapter, CliRuntimeAdapterDeps, CliRuntimeRegistration } from "./cli/types.js";

/** Instantiate every registered CLI runtime adapter. */
export function createCliRuntimeAdapters(
  deps: CliRuntimeAdapterDeps,
  registrations: readonly CliRuntimeRegistration[] = CLI_RUNTIME_REGISTRATIONS,
): CliRuntimeAdapter[] {
  return registrations.map((registration) => {
    const adapter = registration.createAdapter(deps);
    if (adapter.runtime !== registration.descriptor.id) {
      throw new Error(`CLI runtime "${registration.descriptor.id}" created an adapter for "${adapter.runtime}"`);
    }
    return adapter;
  });
}

export interface BuiltinRuntimeAdapters {
  claudeCode: RuntimeAdapter;
  codex: RuntimeAdapter;
  pi: RuntimeAdapter;
  stub: RuntimeAdapter;
  terminal: RuntimeAdapter;
}

/**
 * The single runtime-id to adapter map. Every consumer (pod instantiation,
 * restore, seat lifecycle, handover) receives this same object.
 */
export function buildRuntimeAdapters(
  builtins: BuiltinRuntimeAdapters,
  cli: readonly RuntimeAdapter[] = [],
): Record<string, RuntimeAdapter> {
  const map: Record<string, RuntimeAdapter> = {
    "claude-code": builtins.claudeCode,
    codex: builtins.codex,
    pi: builtins.pi,
    stub: builtins.stub,
    terminal: builtins.terminal,
  };
  for (const adapter of cli) {
    if (adapter.runtime in map) throw new Error(`Duplicate runtime adapter for "${adapter.runtime}"`);
    map[adapter.runtime] = adapter;
  }
  return map;
}
