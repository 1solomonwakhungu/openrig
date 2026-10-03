// Qwen Code runtime (`runtime: qwen`). See docs/reference/runtimes/qwen.md.
//
// Qwen Code is a Gemini CLI fork; it shares the gemini-family launch, pane,
// and session-store pieces. Fresh launches take an OpenRig-minted
// `--session-id`; forks use `--resume <parent> --fork-session` and the child
// id qwen picks is captured from its runtime.json.

import nodePath from "node:path";
import { TuiCliRuntimeAdapter, type TuiCliPrepareContext } from "../tui-cli-runtime-adapter.js";
import type { CliRuntimeRegistration } from "../types.js";
import type { RuntimeDescriptor } from "../../../domain/runtime-registry.js";
import { QWEN_DIALECT, validateSessionToken } from "../gemini-family/launch-args.js";
import { QWEN_PANE_PATTERNS } from "../gemini-family/pane-patterns.js";
import { QWEN_AUTO_UPDATE_GUARD } from "../gemini-family/auto-update.js";
import {
  captureQwenForkChild, checkQwenResumeTarget, findQwenSessionFile, type SessionStoreContext,
} from "../gemini-family/session-store.js";
import { readQwenUsage } from "../gemini-family/usage.js";
import { createGeminiFamilyCapture, createGeminiFamilySpec, geminiFamilyPermissionPosture, nodeEngineFloorVerify, readSessionText } from "../gemini-family/runtime.js";
import { qwenAuthStatus } from "../auth-status.js";

/** <QWEN_HOME or ~/.qwen> */
function qwenHome(store: SessionStoreContext): string {
  const configured = store.env.QWEN_HOME?.trim();
  if (!configured) return nodePath.join(store.homedir, ".qwen");
  return configured.startsWith("~/") ? nodePath.join(store.homedir, configured.slice(2)) : configured;
}

/**
 * Qwen has no per-session trust flag. When the operator enabled folder trust
 * (security.folderTrust.enabled, default false), record the seat cwd as
 * TRUST_FOLDER in qwen's trust file, merge-only: an existing entry for the
 * cwd (including DO_NOT_TRUST) is never changed, so the trust gate then
 * surfaces for the operator. Same stance as the Claude adapter pre-accepting
 * its trust dialog for the managed cwd.
 */
export function prepareQwenLaunch(ctx: TuiCliPrepareContext, store: SessionStoreContext): void {
  let enabled = false;
  try {
    const settingsPath = nodePath.join(qwenHome(store), "settings.json");
    if (ctx.fs.exists(settingsPath)) {
      const settings = JSON.parse(ctx.fs.readFile(settingsPath)) as { security?: { folderTrust?: { enabled?: unknown } } };
      enabled = settings.security?.folderTrust?.enabled === true;
    }
  } catch {
    // Unparseable settings (qwen accepts comments): leave trust to the operator.
  }
  if (!enabled) return;
  const trustFile = store.env.QWEN_CODE_TRUSTED_FOLDERS_PATH?.trim() || nodePath.join(qwenHome(store), "trustedFolders.json");
  ctx.mergeOwnerConfig(trustFile, "json", (config) => {
    config.setIfAbsent([nodePath.resolve(ctx.binding.cwd)], "TRUST_FOLDER");
  });
}

/**
 * Qwen opens its "Welcome back!" dialog on every launch (resume included) in a
 * cwd that has .qwen/PROJECT_SUMMARY.md, which only the /summary command
 * writes. When that file exists, disable the dialog for this cwd in the
 * workspace settings, merge-only: an operator's own ui.enableWelcomeBack value
 * is kept (the pane pattern then fails fast with evidence).
 */
export function suppressQwenWelcomeBack(ctx: TuiCliPrepareContext): void {
  const qwenDir = nodePath.join(ctx.binding.cwd, ".qwen");
  if (!ctx.fs.exists(nodePath.join(qwenDir, "PROJECT_SUMMARY.md"))) return;
  ctx.mergeOwnerConfig(nodePath.join(qwenDir, "settings.json"), "json", (config) => {
    config.setIfAbsent(["ui", "enableWelcomeBack"], false);
  });
}

export const QWEN_DESCRIPTOR: RuntimeDescriptor = {
  id: "qwen",
  displayName: "Qwen Code",
  kind: "agent",
  binary: "qwen",
  installHint: "npm install -g @qwen-code/qwen-code@latest",
  authStatus: qwenAuthStatus,
  docsPath: "docs/reference/runtimes/qwen.md",
  // @qwen-code/qwen-code engines: node >= 22.
  verify: nodeEngineFloorVerify("Qwen Code", 22),
  resumeType: "qwen_session_id",
  validateResumeToken: validateSessionToken,
  captureResumeToken: createGeminiFamilyCapture({
    // The conversation file, the same test as the resume precheck: a seat that
    // never got a message has only runtime.json, so no token; restore then stops
    // for an explicit --fresh (the no-token policy) and never resumes a wrong conversation.
    sessionExists: (ctx, id) => findQwenSessionFile(ctx, id) !== null,
    captureForkChild: (ctx, launchStartedAt) => captureQwenForkChild(ctx, { launchStartedAt }),
  }),
  // Maps the recorded approval mode back to a posture for permission drift.
  permissionPostureFor: geminiFamilyPermissionPosture(QWEN_DIALECT),
  // Usage (feature 1): usageMetadata and the context window from the seat
  // session's conversation file.
  readUsage: ({ resumeToken, cwd, homedir }) => {
    if (!resumeToken || !cwd) return null;
    return readQwenUsage(readSessionText((ctx) => findQwenSessionFile(ctx, resumeToken.trim()), { cwd, homedir }));
  },
  supportsFork: true,
  // Each posture maps to distinct launch flags, so a seat may select either.
  permissionModes: ["floor", "full_bypass"],
  // Qwen reads QWEN.md and AGENTS.md; QWEN.md keeps OpenRig blocks apart from
  // Codex/Pi seats sharing the cwd AGENTS.md.
  guidanceFile: "QWEN.md",
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".qwen", "skills"),
  // The pane shows `node`; the script basename is the identity (`node .../bin/qwen`).
  processMatch: "qwen",
  // Qwen exits cleanly on kill-session (verified live): no tree reap.
};

export const QWEN_REGISTRATION: CliRuntimeRegistration = {
  descriptor: QWEN_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(createGeminiFamilySpec(QWEN_DESCRIPTOR, {
    dialect: QWEN_DIALECT,
    patterns: QWEN_PANE_PATTERNS,
    checkResumeTarget: checkQwenResumeTarget,
    // Independent steps: a failure in one never skips the other; the base
    // logs a thrown error and still launches.
    prepareLaunch: (ctx, store) => {
      const errors: unknown[] = [];
      for (const step of [() => prepareQwenLaunch(ctx, store), () => suppressQwenWelcomeBack(ctx)]) {
        try { step(); } catch (err) { errors.push(err); }
      }
      if (errors.length > 0) throw errors[0];
    },
    autoUpdateGuard: QWEN_AUTO_UPDATE_GUARD,
  }, deps), deps),
};
