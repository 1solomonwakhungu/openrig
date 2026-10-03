// Third-party CLI runtime registrations: one import and one list entry per
// runtime, kept alphabetical by id so parallel additions touch distinct lines.
// See docs/as-built/architecture/adapters-and-runtimes.md, "Adding a runtime
// adapter".

import type { CliRuntimeRegistration } from "./types.js";
import { AIDER_REGISTRATION } from "./aider/index.js";
import { ANTIGRAVITY_REGISTRATION } from "./antigravity/index.js";
import { CLINE_REGISTRATION } from "./cline/index.js";
import { COPILOT_REGISTRATION } from "./copilot/index.js";
import { CURSOR_REGISTRATION } from "./cursor/index.js";
import { GEMINI_REGISTRATION } from "./gemini/index.js";
import { GOOSE_REGISTRATION } from "./goose/index.js";
import { GROK_REGISTRATION } from "./grok/index.js";
import { KILO_REGISTRATION } from "./kilo/index.js";
import { KIRO_REGISTRATION } from "./kiro/index.js";
import { OPENCODE_REGISTRATION } from "./opencode/index.js";
import { QWEN_REGISTRATION } from "./qwen/index.js";

export const CLI_RUNTIME_REGISTRATIONS: readonly CliRuntimeRegistration[] = [
  AIDER_REGISTRATION,
  ANTIGRAVITY_REGISTRATION,
  CLINE_REGISTRATION,
  COPILOT_REGISTRATION,
  CURSOR_REGISTRATION,
  GEMINI_REGISTRATION,
  GOOSE_REGISTRATION,
  GROK_REGISTRATION,
  KILO_REGISTRATION,
  KIRO_REGISTRATION,
  OPENCODE_REGISTRATION,
  QWEN_REGISTRATION,
];
