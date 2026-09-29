// "example-cli": a TEST-ONLY fixture runtime proving the TUI CLI base and the
// contract suite. It is never added to adapters/cli/index.ts. Its module shape
// is the one a real adapter under adapters/cli/<id>/index.ts exports.
//
// It behaves like the lazy-session CLIs (opencode, kilo): the session file
// appears on the first prompt, so launch-time capture finds nothing and the
// token arrives through late capture (refresher, restore).

import fs from "node:fs";
import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../../src/adapters/cli/tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../../src/adapters/cli/types.js";
import type { RuntimeDescriptor } from "../../src/domain/runtime-registry.js";
import { validateIdShapedToken } from "../../src/domain/resume-token-formats.js";

/** Where the fixture CLI records its active session id. */
export const EXAMPLE_SESSION_POINTER = "last-session";

export const EXAMPLE_CLI_DESCRIPTOR: RuntimeDescriptor = {
  id: "example-cli",
  displayName: "Example CLI",
  kind: "agent",
  binary: "example-cli",
  resumeType: "example_session_id",
  validateResumeToken: validateIdShapedToken,
  // Read-only: the session pointer the CLI writes into its per-seat state dir
  // (EXAMPLE_HOME), only when written after the current launch started.
  captureResumeToken: ({ seatStateDir, launchStartedAt }) => {
    const pointer = nodePath.join(seatStateDir, EXAMPLE_SESSION_POINTER);
    if (!fs.existsSync(pointer)) return null;
    if (launchStartedAt && fs.statSync(pointer).mtimeMs < launchStartedAt.getTime()) return null;
    return fs.readFileSync(pointer, "utf-8").trim() || null;
  },
  supportsFork: true,
  guidanceFile: "EXAMPLE.md",
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".example", "skills"),
  paneCommands: ["example-cli"],
};

export const EXAMPLE_CLI_SPEC: TuiCliRuntimeSpec = {
  descriptor: EXAMPLE_CLI_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource, sessionToken }) => {
    const argv = ["example-cli"];
    if (binding.model) argv.push("--model", binding.model);
    argv.push(posture === "full_bypass" ? "--yolo" : "--approval=ask");
    if (sessionToken) argv.push("--session-id", sessionToken);
    if (resumeToken) argv.push("--resume", resumeToken);
    if (forkSource) {
      if (forkSource.kind !== "native_id" || !forkSource.value) throw new Error(`fork ref.kind="${forkSource.kind}" is not supported`);
      argv.push("--fork", forkSource.value);
    }
    return argv;
  },
  env: {
    denyByDefault: true,
    allow: ["EXAMPLE_API_KEY"],
    set: ({ seatStateDir }) => ({ EXAMPLE_HOME: seatStateDir }),
  },
  // Trust the seat cwd in the CLI's own config (owner-state-safe merge).
  prepareLaunch: ({ binding, homedir, mergeOwnerConfig }) => {
    mergeOwnerConfig(nodePath.join(homedir, ".example", "config.json"), "json", (config) => {
      config.addToList(["trustedFolders"], binding.cwd);
    });
  },
  // The fixture CLI keeps each session at <EXAMPLE_HOME>/sessions/<id>.
  validateResumeTarget: ({ token, seatStateDir, fs: files }) => files.exists(exampleSessionPath(seatStateDir, token))
    ? { ok: true }
    : { ok: false, reason: `no saved session ${token.length}-char id in the seat's session store` },
  readyPatterns: [/example-cli ready>/],
  gatePatterns: [
    { pattern: /Do you trust the files in this folder\?/, code: "trust_gate", reason: "example-cli is asking to trust the workspace" },
    { pattern: /Please log in/, code: "login_required", reason: "example-cli needs a login" },
  ],
  errorPatterns: [
    { pattern: /No saved session found/, reason: "example-cli could not find the session", recovery: "retry_fresh", code: "session_missing" },
    { pattern: /^FATAL:/m, reason: "example-cli reported a fatal error" },
  ],
  launchTimeoutMs: 2_000,
  pollIntervalMs: 250,
};

export const EXAMPLE_CLI_REGISTRATION: CliRuntimeRegistration = {
  descriptor: EXAMPLE_CLI_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(EXAMPLE_CLI_SPEC, deps),
};

/** Where the fixture CLI stores a session. */
export function exampleSessionPath(seatStateDir: string, token: string): string {
  return nodePath.join(seatStateDir, "sessions", token);
}

/** Seed a session the way the fixture CLI would on its first prompt. */
export function seedExampleSession(seatStateDir: string, token: string): void {
  fs.mkdirSync(seatStateDir, { recursive: true });
  fs.writeFileSync(nodePath.join(seatStateDir, EXAMPLE_SESSION_POINTER), `${token}\n`);
  fs.mkdirSync(exampleSessionPath(seatStateDir, token), { recursive: true });
}
