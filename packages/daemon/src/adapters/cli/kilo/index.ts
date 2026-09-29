// Kilo CLI (`kilo`) runtime registration. Kilo is an OpenCode fork, so it
// reuses the OpenCode family pieces with its own variant data. See
// docs/reference/runtimes/kilo.md.

import { KILO_VARIANT } from "../opencode/family.js";
import { createOpencodeFamilyRegistration } from "../opencode/registration.js";

export const KILO_REGISTRATION = createOpencodeFamilyRegistration(KILO_VARIANT);
