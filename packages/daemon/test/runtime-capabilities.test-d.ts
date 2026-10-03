// F1 type-level contract: the exact signature of each capability hook that
// feature PRs implement. Checked by tsc during `npm test` (vitest typecheck,
// test/**/*.test-d.ts), so changing a hook's shape fails the suite.

import { describe, expectTypeOf, it } from "vitest";
import type {
  RuntimeActivityState, RuntimeAuthContext, RuntimeAuthStatus, RuntimeModelShape,
  RuntimeTranscript, RuntimeTranscriptInput, RuntimeUsageInput, RuntimeUsageSnapshot,
} from "../src/domain/runtime-capabilities.js";
import type { RuntimeDescriptor } from "../src/domain/runtime-registry.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("capability hook types (the contract feature PRs implement)", () => {
  it("pins each optional hook's signature on RuntimeDescriptor", () => {
    expectTypeOf<RuntimeDescriptor["readUsage"]>().toEqualTypeOf<
      ((input: RuntimeUsageInput) => RuntimeUsageSnapshot | null | Promise<RuntimeUsageSnapshot | null>) | undefined
    >();
    expectTypeOf<RuntimeDescriptor["authStatus"]>().toEqualTypeOf<
      ((ctx: RuntimeAuthContext) => RuntimeAuthStatus | Promise<RuntimeAuthStatus>) | undefined
    >();
    expectTypeOf<RuntimeDescriptor["modelShape"]>().toEqualTypeOf<RuntimeModelShape | undefined>();
    expectTypeOf<RuntimeDescriptor["docsPath"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RuntimeDescriptor["readTranscript"]>().toEqualTypeOf<
      ((input: RuntimeTranscriptInput) => RuntimeTranscript | null | Promise<RuntimeTranscript | null>) | undefined
    >();
    expectTypeOf<RuntimeAdapter["classifyActivity"]>().toEqualTypeOf<
      ((binding: NodeBinding) => Promise<RuntimeActivityState | null>) | undefined
    >();
    expectTypeOf<RuntimeActivityState>().toEqualTypeOf<"working" | "idle" | "needs_input">();
    expectTypeOf<RuntimeAuthStatus["state"]>().toEqualTypeOf<"signed_in" | "missing" | "unknown">();
    expectTypeOf<RuntimeUsageSnapshot["observedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<RuntimeUsageSnapshot["costUsd"]>().toEqualTypeOf<number | undefined>();
  });

});
