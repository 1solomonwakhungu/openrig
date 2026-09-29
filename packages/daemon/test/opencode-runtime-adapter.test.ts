// Hermetic tests for the opencode runtime adapter (no binary, no network).

import { describe } from "vitest";
import { OPENCODE_VARIANT } from "../src/adapters/cli/opencode/family.js";
import { OPENCODE_REGISTRATION } from "../src/adapters/cli/opencode/index.js";
import { runOpencodeFamilyAdapterTests } from "./helpers/opencode-family-adapter-tests.js";

describe("opencode runtime adapter", () => {
  runOpencodeFamilyAdapterTests({
    variant: OPENCODE_VARIANT,
    registration: OPENCODE_REGISTRATION,
    readyFixture: "opencode-1.18.33-home-idle.txt",
  });
});
