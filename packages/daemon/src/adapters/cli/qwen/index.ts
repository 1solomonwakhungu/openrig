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
import {
  captureQwenForkChild, checkQwenResumeTarget, qwenRuntimeStatusExists, type SessionStoreContext,
} from "../gemini-family/session-store.js";
import { createGeminiFamilyCapture, createGeminiFamilySpec, nodeEngineFloorVerify } from "../gemini-family/runtime.js";

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

export const QWEN_DESCRIPTOR: RuntimeDescriptor = {
  id: "qwen",
  displayName: "Qwen Code",
  kind: "agent",
  binary: "qwen",
  // @qwen-code/qwen-code engines: node >= 22.
  verify: nodeEngineFloorVerify("Qwen Code", 22),
  resumeType: "qwen_session_id",
  validateResumeToken: validateSessionToken,
  captureResumeToken: createGeminiFamilyCapture({
    sessionExists: qwenRuntimeStatusExists,
    captureForkChild: (ctx, launchStartedAt) => captureQwenForkChild(ctx, { launchStartedAt }),
  }),
  supportsFork: true,
  // Qwen reads QWEN.md and AGENTS.md; QWEN.md keeps OpenRig blocks apart from
  // Codex/Pi seats sharing the cwd AGENTS.md.
  guidanceFile: "QWEN.md",
  skillsDir: ({ cwd }) => nodePath.join(cwd, ".qwen", "skills"),
  // The pane shows `node`; the bin path is the identity (`node .../bin/qwen`).
  processMatch: /(?:^|[\s/])qwen(?:\s|$)/,
  // Qwen exits cleanly on kill-session (verified live): no tree reap.
};

export const QWEN_REGISTRATION: CliRuntimeRegistration = {
  descriptor: QWEN_DESCRIPTOR,
  createAdapter: (deps) => new TuiCliRuntimeAdapter(createGeminiFamilySpec(QWEN_DESCRIPTOR, {
    dialect: QWEN_DIALECT,
    patterns: QWEN_PANE_PATTERNS,
    checkResumeTarget: checkQwenResumeTarget,
    prepareLaunch: prepareQwenLaunch,
  }, deps), deps),
};
