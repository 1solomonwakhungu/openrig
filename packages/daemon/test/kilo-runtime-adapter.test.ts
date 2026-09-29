// Hermetic tests for the kilo runtime adapter (no binary, no network).

import { describe } from "vitest";
import { KILO_VARIANT } from "../src/adapters/cli/opencode/family.js";
import { KILO_REGISTRATION } from "../src/adapters/cli/kilo/index.js";
import { runOpencodeFamilyAdapterTests } from "./helpers/opencode-family-adapter-tests.js";

describe("kilo runtime adapter", () => {
  runOpencodeFamilyAdapterTests({
    variant: KILO_VARIANT,
    registration: KILO_REGISTRATION,
    readyFixture: "kilo-7.8.1-home-idle.txt",
  });
});
