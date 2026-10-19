// Fork: the runtime registry (runtime-registry.ts) is the catalog of runtimes OpenRig ships, so the built-in set is
// a live view of it. Built-ins, the CLI harness adapters under adapters/cli/, and any runtime a test registers are all
// "built in" here; only a name the registry doesn't know names a community agent app.
import { isRegisteredRuntime, listRuntimeDescriptors } from "./runtime-registry.js";

class RegisteredRuntimeSet implements ReadonlySet<string> {
  private ids(): string[] {
    return listRuntimeDescriptors().map((descriptor) => descriptor.id);
  }
  has(value: string): boolean {
    return isRegisteredRuntime(value);
  }
  get size(): number {
    return this.ids().length;
  }
  forEach(callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const id of this.ids()) callbackfn.call(thisArg, id, id, this);
  }
  entries(): SetIterator<[string, string]> {
    return new Set(this.ids()).entries();
  }
  keys(): SetIterator<string> {
    return new Set(this.ids()).keys();
  }
  values(): SetIterator<string> {
    return new Set(this.ids()).values();
  }
  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
}

/** The runtimes OpenRig ships (every registered runtime). Any other runtime name names a community agent app
 *  (`agent-app-presets.ts`), and a preset can't take one of these names. */
export const BUILT_IN_RUNTIMES: ReadonlySet<string> = new RegisteredRuntimeSet();

/** A runtime name that isn't built in names a community agent app. */
export function isAgentAppRuntime(runtime: string | null | undefined): runtime is string {
  return !!runtime && !BUILT_IN_RUNTIMES.has(runtime);
}

/** The community agent app a seat runs, from positive provenance only: the session was launched for that app
 *  (`sessions.agent_app`), and it's still the node's runtime. A free-text runtime name alone, an older session or a
 *  changed runtime gives null, so such a seat is treated as it always was. */
export function agentAppOf(agentApp: string | null | undefined, runtime: string | null | undefined): string | null {
  return agentApp && agentApp === runtime ? agentApp : null;
}
