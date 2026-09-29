// Keep managed Gemini CLI / Qwen Code seats from updating the operator's install.
//
// Both CLIs check npm on launch and, unless general.enableAutoUpdate is false,
// run the install command for how they were installed in the background. For a
// global npm install that is `npm install -g <pkg>@latest`, which from a seat
// writes the operator's npm global prefix (seen in a managed-seat smoke on
// gemini 0.61.0). Neither CLI has a flag or env var that turns this off.
//
// Two layers, both scoped to the seat (nothing the operator owns is written):
// 1. Containment, both CLIs: the launch env sets NPM_CONFIG_PREFIX (and
//    npm_config_prefix) to <seatStateDir>/npm-global, so a self-update's
//    `npm install -g` lands in the seat's own prefix. The seat keeps running the
//    operator's installed binary; the downloaded copy is never on its PATH.
//    NPM_CONFIG_CACHE points at <seatStateDir>/npm-cache, so ~/.npm is untouched.
// 2. qwen only: the launch env points QWEN_CODE_SYSTEM_DEFAULTS_PATH at a
//    seat-owned copy of the operator's system defaults with
//    general.enableAutoUpdate false, so qwen does not download at all. (gemini
//    skips any system settings or defaults file not owned by root, settings.ts
//    isFileAndDirectorySecureSync, and ignores the key in workspace settings,
//    so this layer cannot work for gemini.)
// An explicit user, workspace, or system setting still wins over the defaults
// layer. Operators who want no downloads at all set general.enableAutoUpdate
// false in their own ~/.gemini/settings.json or ~/.qwen/settings.json.

import nodePath from "node:path";

export interface AutoUpdateGuard {
  /** Env var the CLI reads for the system-defaults file path. */
  envVar: string;
  /** The CLI's own system settings dir (its system-defaults.json lives there). */
  systemDir: Readonly<Record<"darwin" | "linux", string>>;
  /** Setting overrides written into the seat's system-defaults copy. */
  settings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const QWEN_AUTO_UPDATE_GUARD: AutoUpdateGuard = {
  envVar: "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
  systemDir: { darwin: "/Library/Application Support/QwenCode", linux: "/etc/qwen-code" },
  settings: { general: { enableAutoUpdate: false } },
};

export const SEAT_SYSTEM_DEFAULTS_FILE = "system-defaults.json";

/** Per-seat npm global prefix that contains any self-update install. */
export function seatNpmPrefix(seatStateDir: string): string {
  return nodePath.join(seatStateDir, "npm-global");
}

/** Per-seat npm cache, so a self-update's download never touches ~/.npm. */
export function seatNpmCache(seatStateDir: string): string {
  return nodePath.join(seatStateDir, "npm-cache");
}

/** Launch env for the npm containment (npm reads either spelling). */
export function npmContainmentEnv(seatStateDir: string): Record<string, string> {
  const prefix = seatNpmPrefix(seatStateDir);
  const cache = seatNpmCache(seatStateDir);
  return { NPM_CONFIG_PREFIX: prefix, npm_config_prefix: prefix, NPM_CONFIG_CACHE: cache, npm_config_cache: cache };
}

export function seatSystemDefaultsPath(seatStateDir: string): string {
  return nodePath.join(seatStateDir, SEAT_SYSTEM_DEFAULTS_FILE);
}

/** The system-defaults file the CLI would read without the seat override: the
 *  operator's own env override when set, else the platform default. */
export function operatorSystemDefaultsPath(
  guard: AutoUpdateGuard,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env[guard.envVar]?.trim();
  if (configured) return configured;
  return nodePath.join(platform === "darwin" ? guard.systemDir.darwin : guard.systemDir.linux, SEAT_SYSTEM_DEFAULTS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Content for the seat's system-defaults file: the operator's defaults (when
 * the text parses as a JSON object) with the guard's settings applied on top.
 * Unparseable operator text is not copied (the CLI accepts JSONC, this does
 * not); the seat then gets only the guard settings, and `copied` says so.
 */
export function buildSeatSystemDefaults(
  guard: AutoUpdateGuard,
  operatorText: string | null,
): { content: string; copied: "none" | "operator_defaults" | "operator_defaults_unparseable" } {
  let base: Record<string, unknown> = {};
  let copied: "none" | "operator_defaults" | "operator_defaults_unparseable" = "none";
  if (operatorText !== null && operatorText.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(operatorText);
      if (isRecord(parsed)) {
        base = parsed;
        copied = "operator_defaults";
      } else {
        copied = "operator_defaults_unparseable";
      }
    } catch {
      copied = "operator_defaults_unparseable";
    }
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [section, values] of Object.entries(guard.settings)) {
    const current = merged[section];
    merged[section] = { ...(isRecord(current) ? current : {}), ...values };
  }
  return { content: `${JSON.stringify(merged, null, 2)}\n`, copied };
}
