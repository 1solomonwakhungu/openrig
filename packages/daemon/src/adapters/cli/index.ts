// Third-party CLI runtime registrations: one import and one list entry per
// runtime, kept alphabetical by id so parallel additions touch distinct lines.
// See docs/as-built/architecture/adapters-and-runtimes.md, "Adding a runtime
// adapter".

import type { CliRuntimeRegistration } from "./types.js";
import { GEMINI_REGISTRATION } from "./gemini/index.js";
import { KILO_REGISTRATION } from "./kilo/index.js";
import { OPENCODE_REGISTRATION } from "./opencode/index.js";
import { QWEN_REGISTRATION } from "./qwen/index.js";

export const CLI_RUNTIME_REGISTRATIONS: readonly CliRuntimeRegistration[] = [
  GEMINI_REGISTRATION,
  KILO_REGISTRATION,
  OPENCODE_REGISTRATION,
  QWEN_REGISTRATION,
];
