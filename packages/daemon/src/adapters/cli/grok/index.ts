// Grok Build (`grok`, xai-org/grok-build) runtime adapter.
//
// Verified against grok 1.0.25 (`grok --help`, embedded docs and strings in
// the binary, and one probe on an isolated tmux server with a throwaway HOME);
// see docs/reference/runtimes/grok.md for what was verified live.
//
// Session identity: grok accepts `-s/--session-id <uuid>` for a NEW session,
// and with `--resume <parent> --fork-session` it names the forked child. The
// adapter mints that UUID, so the token is known before launch and stays
// unambiguous when several seats share a cwd. Sessions live at
// <GROK_HOME or ~/.grok>/sessions/<url-encoded cwd>/<session-id>/.

import fs from "node:fs";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import { LAUNCH_RECORD_FILE } from "../../../domain/runtime-capture.js";
import type { ResumeTokenFormatResult } from "../../../domain/resume-token-formats.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Grok session ids are UUIDs (UUIDv7 when grok mints them, v4 from us). */
export function validateGrokSessionId(token: string): ResumeTokenFormatResult {
  return UUID_RE.test(token)
    ? { ok: true, token: token.toLowerCase() }
    : { ok: false, error: "Grok session id must be a UUID." };
}

/** grok keeps its state under GROK_HOME, default ~/.grok. */
export function grokHome(homedir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.GROK_HOME?.trim() || nodePath.join(homedir, ".grok");
}

/** Whether a session directory exists for this id in any working-directory group. */
export function grokSessionExists(home: string, sessionId: string): boolean {
  const root = nodePath.join(home, "sessions");
  let groups: string[];
  try {
    groups = fs.readdirSync(root);
  } catch {
    return false;
  }
  return groups.some((group) => fs.existsSync(nodePath.join(root, group, sessionId)));
}

export const GROK_DESCRIPTOR: RuntimeDescriptor = {
  id: "grok",
  displayName: "Grok Build",
  kind: "agent",
  binary: "grok",
  installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
  resumeType: "grok_session_id",
  validateResumeToken: validateGrokSessionId,
  // Late capture (adoption, refresher, restore): the id this seat's last launch
  // minted, once grok has written that session to disk. Never guesses from
  // other sessions in the same cwd.
  captureResumeToken: ({ seatStateDir, homedir }) => {
    let preset: unknown;
    try {
      preset = (JSON.parse(fs.readFileSync(nodePath.join(seatStateDir, LAUNCH_RECORD_FILE), "utf-8")) as { presetToken?: unknown }).presetToken;
    } catch {
      return null;
    }
    if (typeof preset !== "string" || !UUID_RE.test(preset)) return null;
    return grokSessionExists(grokHome(homedir), preset) ? preset : null;
  },
  supportsFork: true,
  // grok reads AGENTS.md (also AGENT.md, CLAUDE.md) from cwd up to the repo root.
  guidanceFile: "AGENTS.md",
  // Project skills (loaded once the folder is trusted).
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".grok", "skills"),
  // A native (Rust) binary: the pane's foreground command is `grok`.
  paneCommands: ["grok"],
  // Verified: no grok process survived tmux kill-server in the isolated probe.
  reapProcessTreeOnStop: false,
};

export const GROK_SPEC: TuiCliRuntimeSpec = {
  descriptor: GROK_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource, sessionToken }) => {
    // --no-alt-screen keeps output in the normal screen and its scrollback,
    // so transcripts and `rig capture` see it. --trust records folder trust for
    // the seat cwd, like the Claude adapter's trust acceptance.
    const argv = ["grok", "--no-alt-screen", "--trust"];
    if (binding.model) argv.push("--model", binding.model);
    argv.push(...(posture === "full_bypass" ? ["--always-approve"] : ["--permission-mode", "acceptEdits"]));
    if (resumeToken) {
      argv.push("--resume", resumeToken);
    } else if (forkSource) {
      const parent = forkSource.value?.trim();
      if (forkSource.kind !== "native_id" || !parent) {
        throw new Error(`grok fork: ref.kind="${forkSource.kind}" is not supported; use ref.kind="native_id" with the parent session id`);
      }
      argv.push("--resume", parent, "--fork-session");
      if (sessionToken) argv.push("--session-id", sessionToken);
    } else if (sessionToken) {
      argv.push("--session-id", sessionToken);
    }
    return argv;
  },
  env: {
    // No self-update prompts in managed seats; never open a browser tab for
    // sign-in on the operator's desktop (the device code shows in the pane).
    set: () => ({ GROK_DISABLE_AUTOUPDATER: "1", BROWSER: "true" }),
  },
  mintSessionToken: () => randomUUID(),
  validateResumeTarget: ({ token, homedir }) => grokSessionExists(grokHome(homedir), token)
    ? { ok: true }
    : { ok: false, reason: "no grok session with that id under the grok sessions directory" },
  readyPatterns: [/Build anything/],
  gatePatterns: [
    { pattern: /Do you trust the contents of this directory\?/, code: "trust_gate", reason: "grok is asking to trust the working directory" },
    {
      pattern: /Approve in your browser to finish signing in|Waiting for approval\.\.\.|Paste your token here/,
      code: "login_required",
      reason: "grok needs a sign-in (run `grok login` for this account, or set XAI_API_KEY)",
    },
  ],
  errorPatterns: [
    { pattern: /No session found with id/, reason: "grok could not find the session to resume", recovery: "retry_fresh", code: "session_missing" },
    { pattern: /No session found for current directory/, reason: "grok found no session for this directory", recovery: "retry_fresh", code: "session_missing" },
    { pattern: /must not already exist/, reason: "grok refused the minted session id" },
  ],
};

export const GROK_REGISTRATION: CliRuntimeRegistration = {
  descriptor: GROK_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(GROK_SPEC, deps),
};
