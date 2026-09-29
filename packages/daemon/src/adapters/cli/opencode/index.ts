// OpenCode (`opencode`) runtime registration. See docs/reference/runtimes/opencode.md.

import { OPENCODE_VARIANT } from "./family.js";
import { createOpencodeFamilyRegistration } from "./registration.js";

export const OPENCODE_REGISTRATION = createOpencodeFamilyRegistration(OPENCODE_VARIANT);
