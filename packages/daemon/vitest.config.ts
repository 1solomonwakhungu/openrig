import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // P6/D12-residue: many daemon suites spawn REAL child processes (stub-runner-*,
    // precompact-hook, bridge, restore-from-jsonl — 20+ files). Under fold-gate
    // contention (parallel files + fleet load) a single node spawn can take 5-10s,
    // exceeding vitest's 5s default and flaking on TIMEOUT (not on any assertion).
    // A generous ceiling makes these deterministic; fast tests still finish in ms,
    // so the only cost is a slower surfacing of a genuine hang.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Type-level contract tests (*.test-d.ts) are checked by tsc during the
    // normal run, so a contract change fails `npm test`, not only --typecheck.
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.typecheck.json",
    },
  },
});
