// Gemini CLI runtime (`runtime: gemini`). See docs/reference/runtimes/gemini.md.
//
// Interactive TUI in the seat pane, launched with an OpenRig-minted
// `--session-id` so the resume token is known up front. No fork primitive.

import nodePath from "node:path";
import { TuiCliRuntimeAdapter } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import { GEMINI_DIALECT, validateSessionToken } from "../gemini-family/launch-args.js";
import { GEMINI_PANE_PATTERNS } from "../gemini-family/pane-patterns.js";
import { checkGeminiResumeTarget, findGeminiSessionFile } from "../gemini-family/session-store.js";
import { createGeminiFamilyCapture, createGeminiFamilySpec, nodeEngineFloorVerify } from "../gemini-family/runtime.js";

export const GEMINI_DESCRIPTOR: RuntimeDescriptor = {
  id: "gemini",
  displayName: "Gemini CLI",
  kind: "agent",
  binary: "gemini",
  installHint: "npm install -g @google/gemini-cli",
  // @google/gemini-cli engines: node >= 20.
  verify: nodeEngineFloorVerify("Gemini CLI", 20),
  resumeType: "gemini_session_id",
  validateResumeToken: validateSessionToken,
  // gemini writes the session file at launch (first line carries the id).
  captureResumeToken: createGeminiFamilyCapture({
    sessionExists: (ctx, id) => findGeminiSessionFile(ctx, id) !== null,
  }),
  supportsFork: false,
  // Gemini reads GEMINI.md by default, not AGENTS.md.
  guidanceFile: "GEMINI.md",
  // Project skills; read because managed launches pass --skip-trust.
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".gemini", "skills"),
  // The pane shows `node`; the script basename is the identity (`node .../bin/gemini`).
  processMatch: "gemini",
  // The bin's parent ignores SIGHUP/SIGTERM and waits on a child that never
  // finishes its SIGHUP cleanup, so both outlive kill-session (verified live).
  reapProcessTreeOnStop: true,
};

export const GEMINI_REGISTRATION: CliRuntimeRegistration = {
  descriptor: GEMINI_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(createGeminiFamilySpec(GEMINI_DESCRIPTOR, {
    dialect: GEMINI_DIALECT,
    patterns: GEMINI_PANE_PATTERNS,
    checkResumeTarget: checkGeminiResumeTarget,
  }, deps), deps),
};
