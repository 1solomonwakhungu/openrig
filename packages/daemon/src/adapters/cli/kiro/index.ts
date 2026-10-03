// Kiro CLI (`kiro-cli`, kirodotdev, closed source; formerly Amazon Q Developer
// CLI) runtime adapter.
//
// Verified against kiro-cli 2.27.1 (the checksum-verified macOS DMG bundle,
// never installed) on an isolated tmux server with a throwaway HOME and
// BROWSER=true: `--version`, `--help-all`, `chat --help`, and the
// unauthenticated launch, which stops at a sign-in prompt. Every useful path
// past that needs a signed-in account (browser login or a paid KIRO_API_KEY),
// so the ready screen, tool prompts, and the session store were NOT observed;
// those parts are derived from strings in the binaries. See
// docs/reference/runtimes/kiro.md, "Verified versus derived".
//
// Because of that:
// - readiness is strict and fails toward attention_required: a screen the
//   adapter does not recognize runs out the wait with pane evidence, never a
//   false ready;
// - there is no resume token. The session store format is unverified, and
//   `kiro-cli chat --resume-id <id>` with an unknown id was not observed, so
//   OpenRig never resumes a Kiro seat: restore stops for an explicit --fresh.

import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import { anyPanePhrase, panePhraseSource } from "../pane-phrase.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import type { AppliedLaunchObservation } from "../../../domain/permission-drift.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";

export const KIRO_RUNTIME_ID = "kiro";
export const KIRO_BINARY = "kiro-cli";

/** `kiro-cli --version` prints "kiro-cli 2.27.1" (live). */
export function parseKiroVersion(output: string): string | null {
  return output.trim().match(/^kiro-cli (\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

export function verifyKiroVersionOutput(output: string): string | null {
  return parseKiroVersion(output)
    ? null
    : "`kiro-cli --version` did not identify Kiro CLI; install it with `brew install --cask kiro-cli` or the installer at https://kiro.dev/cli";
}

/** The tool-trust argument each posture emits, as recorded for permission
 *  drift. Both come from `kiro-cli chat --help` (live): `--trust-tools=`
 *  trusts no tools, so Kiro asks before every tool call; `--trust-all-tools`
 *  runs every tool without asking. */
export const KIRO_PERMISSION_VALUES: Readonly<Record<ResolvedLaunchPosture, string>> = Object.freeze({
  floor: "--trust-tools=",
  full_bypass: "--trust-all-tools",
});

/** argv for an interactive Kiro chat. Throws (refusing the launch) on a
 *  dash-led model, a resume token, or a fork request. */
export function buildKiroArgv(input: { model?: string | null; posture: ResolvedLaunchPosture; resumeToken?: string; forkSource?: unknown }): string[] {
  if (input.resumeToken !== undefined) throw new Error("kiro: resume is not supported (the session store is unverified); restore with --fresh");
  if (input.forkSource) throw new Error("kiro has no fork support in OpenRig; remove session_source for kiro members");
  const argv = [KIRO_BINARY, "chat", KIRO_PERMISSION_VALUES[input.posture]];
  const model = input.model?.trim();
  if (model) {
    if (model.startsWith("-")) throw new Error("kiro launch: model must not start with '-'");
    argv.push("--model", model);
  }
  return argv;
}

/** The live sign-in prompt (kiro-cli 2.27.1, unauthenticated). */
const KIRO_SIGN_IN = ["Welcome to Kiro CLI, let's get you signed in!", "Press enter to continue to the browser"];

/**
 * Screen text that means a sign-in, dialog, or tool prompt is up even if the
 * input placeholder shows. The sign-in lines are live; the rest are derived
 * from kiro-cli-chat strings ("Opening browser...", "Allow this action?",
 * "Ctrl+C to cancel").
 */
export const KIRO_NOT_READY_RE = anyPanePhrase([...KIRO_SIGN_IN, "Opening browser", "Allow this action?", "Ctrl+C to cancel"], "i");

/** Ready: the chat input placeholder "Ask a question or describe a task"
 *  (derived from kiro-cli-chat strings) with no not-ready marker on screen. */
export const KIRO_READY_RE = new RegExp(
  `^(?![\\s\\S]*(?:${KIRO_NOT_READY_RE.source}))[\\s\\S]*${panePhraseSource("Ask a question or describe a task")}`,
  "i",
);

export const KIRO_DESCRIPTOR: RuntimeDescriptor = {
  id: KIRO_RUNTIME_ID,
  displayName: "Kiro CLI",
  kind: "agent",
  binary: KIRO_BINARY,
  installHint: "brew install --cask kiro-cli (or the installer at https://kiro.dev/cli)",
  verify: async ({ exec }) => {
    try {
      return verifyKiroVersionOutput(await exec(`${KIRO_BINARY} --version`));
    } catch (err) {
      return `\`${KIRO_BINARY} --version\` failed: ${(err as Error).message}`;
    }
  },
  // No resumeType: see the header. Restore stops for an explicit --fresh.
  supportsFork: false,
  // Each posture passes its own tool-trust argument, so a seat may select either.
  permissionModes: ["floor", "full_bypass"],
  // Kiro reads workspace AGENTS.md (derived) besides .kiro/steering.
  guidanceFile: "AGENTS.md",
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".kiro", "skills"),
  // Live: the pane's foreground command at the sign-in prompt is `kiro-cli`;
  // the chat engine may run as `kiro-cli-chat`.
  paneCommands: [KIRO_BINARY, "kiro-cli-chat"],
  // Kiro starts helper processes (the chat engine, MCP servers); reap the
  // pane's process tree on stop (PID-scoped; never by name).
  reapProcessTreeOnStop: true,
  permissionPostureFor: (observedValue): ResolvedLaunchPosture | null =>
    observedValue === KIRO_PERMISSION_VALUES.full_bypass ? "full_bypass"
      : observedValue === KIRO_PERMISSION_VALUES.floor ? "floor"
        : null,
};

export const KIRO_SPEC: TuiCliRuntimeSpec = {
  descriptor: KIRO_DESCRIPTOR,
  buildLaunchCommand: ({ binding, posture, resumeToken, forkSource }) =>
    buildKiroArgv({ model: binding.model, posture, resumeToken, forkSource }),
  env: {
    // Sign-in opens a browser; never open a tab on the operator's desktop.
    // KIRO_DISABLE_TELEMETRY (owner privacy) and KIRO_NO_AUTO_UPDATE (a managed
    // seat never replaces the operator's install) are derived from the
    // kiro-cli-chat strings; not behavior-proven live.
    set: () => ({ BROWSER: "true", KIRO_DISABLE_TELEMETRY: "1", KIRO_NO_AUTO_UPDATE: "1" }),
  },
  readyPatterns: [KIRO_READY_RE],
  gatePatterns: [
    {
      pattern: anyPanePhrase([...KIRO_SIGN_IN, "Opening browser"], "i"),
      code: "login_required",
      reason: "kiro-cli is not signed in (run `kiro-cli login` once, or set KIRO_API_KEY)",
    },
  ],
  observeLaunch: ({ posture }): AppliedLaunchObservation => ({
    runtime: KIRO_DESCRIPTOR.id,
    axis: "permission",
    state: "observed",
    value: KIRO_PERMISSION_VALUES[posture],
    reason: "emitted_launch_arguments",
  }),
};

export const KIRO_REGISTRATION: CliRuntimeRegistration = {
  descriptor: KIRO_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(KIRO_SPEC, deps),
};
