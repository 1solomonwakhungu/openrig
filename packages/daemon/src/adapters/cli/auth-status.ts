// Sign-in status for the registry CLI runtimes (feature 6, `rig runtimes` and
// `rig doctor`), from local signals only: environment variable NAMES and the
// presence or shape of each CLI's own credential or settings file. Never a
// network call, never a login, never the OS keychain, never a secret value in
// the result. "unknown" whenever a local check cannot decide.
//
// Where each CLI keeps its sign-in comes from its docs page under
// docs/reference/runtimes/ and the CLI's source; see the notes per function.

import nodePath from "node:path";
import type { RuntimeAuthContext, RuntimeAuthStatus } from "../../domain/runtime-capabilities.js";

/** Settings and credential files are small; never read more than this. */
const MAX_AUTH_FILE_BYTES = 256 * 1024;

/** Provider keys most CLIs accept from the environment. */
export const COMMON_PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
] as const;

/** The first of `names` set to a non-blank value. Returns the NAME only. */
export function firstSetEnv(ctx: RuntimeAuthContext, names: readonly string[]): string | null {
  for (const name of names) {
    if ((ctx.env[name] ?? "").trim()) return name;
  }
  return null;
}

/** A path as shown to people: `~/...` under the home directory. */
export function displayPath(ctx: RuntimeAuthContext, path: string): string {
  const rel = nodePath.relative(ctx.homedir, path);
  return rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel) ? `~/${rel}` : path;
}

/** Parsed JSON object from a size-capped read; null when missing, unreadable,
 *  oversized, or not an object. */
export function readJsonObject(ctx: RuntimeAuthContext, path: string): Record<string, unknown> | null {
  const text = ctx.fs.readFile(path, MAX_AUTH_FILE_BYTES);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nested(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

const signedIn = (source: string, detail?: string): RuntimeAuthStatus =>
  detail ? { state: "signed_in", source, detail } : { state: "signed_in", source };

// ── OpenCode and Kilo ───────────────────────────────────────────────────────

/** `opencode auth login` / `kilo auth login` write <data dir>/<cli>/auth.json
 *  (data dir: XDG_DATA_HOME or ~/.local/share); provider keys also work. With
 *  neither, both CLIs run on their free models, so "missing" says so. */
export function opencodeFamilyAuthStatus(cli: "opencode" | "kilo") {
  return (ctx: RuntimeAuthContext): RuntimeAuthStatus => {
    const keys = cli === "kilo" ? ["KILO_API_KEY", ...COMMON_PROVIDER_KEYS] : COMMON_PROVIDER_KEYS;
    const key = firstSetEnv(ctx, keys);
    if (key) return signedIn(`env ${key}`);
    const dataDir = (ctx.env.XDG_DATA_HOME ?? "").trim() || nodePath.join(ctx.homedir, ".local", "share");
    const authFile = nodePath.join(dataDir, cli, "auth.json");
    if (isNonEmpty(readJsonObject(ctx, authFile))) return signedIn(displayPath(ctx, authFile));
    return {
      state: "missing",
      hint: `run \`${cli} auth login\` or set a provider key such as ANTHROPIC_API_KEY`,
      detail: cli === "kilo"
        ? "runs on Kilo's free \"Auto Free\" model until signed in"
        : "runs on the free OpenCode Zen models until signed in",
    };
  };
}

// ── Gemini CLI ──────────────────────────────────────────────────────────────

/** Interactive gemini needs `security.auth.selectedType` in
 *  <GEMINI_CLI_HOME or ~/.gemini>/settings.json (or the workspace's
 *  .gemini/settings.json) before it starts; values from the 0.61 source:
 *  gemini-api-key, vertex-ai, oauth-personal, and others. Google sign-in for
 *  personal accounts is refused server-side since 2026-06-18, which no local
 *  file can show. */
export function geminiAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  const home = (ctx.env.GEMINI_CLI_HOME ?? "").trim() || nodePath.join(ctx.homedir, ".gemini");
  const files = [nodePath.join(home, "settings.json")];
  if (ctx.cwd) files.unshift(nodePath.join(ctx.cwd, ".gemini", "settings.json"));
  let selected: string | undefined;
  let source = "";
  for (const file of files) {
    const value = nested(readJsonObject(ctx, file), ["security", "auth", "selectedType"]);
    if (typeof value === "string" && value.trim()) {
      selected = value.trim();
      source = displayPath(ctx, file);
      break;
    }
  }
  const hint = "set GEMINI_API_KEY (or Vertex AI credentials), then run `gemini` once and choose that method";
  if (!selected) {
    return { state: "missing", hint, detail: "no auth method chosen in gemini settings; every launch would stop at the auth dialog" };
  }
  if (selected === "gemini-api-key") {
    return firstSetEnv(ctx, ["GEMINI_API_KEY"])
      ? signedIn(`env GEMINI_API_KEY + ${source}`)
      : { state: "missing", source, hint: "set GEMINI_API_KEY", detail: "settings choose the API key method but GEMINI_API_KEY is not set" };
  }
  if (selected === "vertex-ai") {
    if (firstSetEnv(ctx, ["GOOGLE_API_KEY"])) return signedIn(`env GOOGLE_API_KEY + ${source}`);
    if (firstSetEnv(ctx, ["GOOGLE_CLOUD_PROJECT"])) {
      return { state: "unknown", source, detail: "Vertex AI with application default credentials, which are not checked" };
    }
    return { state: "missing", source, hint: "set GOOGLE_API_KEY, or GOOGLE_CLOUD_PROJECT with application default credentials", detail: "settings choose Vertex AI but no Vertex credentials are set" };
  }
  if (selected === "oauth-personal") {
    return { state: "unknown", source, detail: "Google sign-in: personal accounts are refused since 2026-06-18; Code Assist Standard or Enterprise still works" };
  }
  return { state: "unknown", source, detail: `auth method "${selected}" is not checked locally` };
}

// ── Qwen Code ───────────────────────────────────────────────────────────────

/** Qwen picks `security.auth.selectedType` or `modelProviders` from
 *  ~/.qwen/settings.json, else complete provider env sets (docs/reference/
 *  runtimes/qwen.md). The Qwen OAuth tier was discontinued on 2026-04-15. */
export function qwenAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  const file = nodePath.join(ctx.homedir, ".qwen", "settings.json");
  const settings = readJsonObject(ctx, file);
  const selected = nested(settings, ["security", "auth", "selectedType"]);
  if (selected === "qwen-oauth") {
    return { state: "missing", source: displayPath(ctx, file), hint: "configure a model provider (see docs/reference/runtimes/qwen.md)", detail: "settings point at the discontinued Qwen OAuth tier" };
  }
  if ((typeof selected === "string" && selected.trim()) || isNonEmpty(nested(settings, ["modelProviders"]))) {
    return signedIn(displayPath(ctx, file), "a model provider is configured in qwen settings");
  }
  const sets: Array<readonly string[]> = [
    ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
    ["GEMINI_API_KEY", "GEMINI_MODEL"],
  ];
  for (const set of sets) {
    if (set.every((name) => firstSetEnv(ctx, [name]))) {
      if (set[0] === "OPENAI_API_KEY" && !firstSetEnv(ctx, ["OPENAI_MODEL", "QWEN_MODEL"])) continue;
      return signedIn(`env ${set[0]}`);
    }
  }
  return { state: "missing", hint: "configure a model provider with `qwen` (/auth) or set a complete provider env set (see docs/reference/runtimes/qwen.md)" };
}

// ── GitHub Copilot CLI ──────────────────────────────────────────────────────

/** Token env vars in Copilot's precedence order. A `copilot login` session is
 *  stored by the native CLI where a local file check cannot confirm it (the
 *  npm package is only a loader), so that case is "unknown", never "missing". */
export function copilotAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  const key = firstSetEnv(ctx, ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
  if (key) return signedIn(`env ${key}`);
  return {
    state: "unknown",
    hint: "run `copilot login`, or set COPILOT_GITHUB_TOKEN",
    detail: "a `copilot login` session cannot be checked without the keychain",
  };
}

// ── Cursor CLI ──────────────────────────────────────────────────────────────

/** CURSOR_API_KEY, else `cursor-agent --disable-auto-update status` under
 *  --probe (the documented account check; without the flag the CLI's
 *  background updater can reinstall and re-link the owner's install about 2 s
 *  after start), else "unknown". Verified live on 2026.10.01: a signed-out
 *  account prints "Not logged in" and exits 0. */
export async function cursorAuthStatus(ctx: RuntimeAuthContext): Promise<RuntimeAuthStatus> {
  if (firstSetEnv(ctx, ["CURSOR_API_KEY"])) return signedIn("env CURSOR_API_KEY");
  const hint = "run `cursor-agent login`, or set CURSOR_API_KEY";
  if (ctx.probe) {
    const result = await ctx.probe.exec(["cursor-agent", "--disable-auto-update", "status"], 10_000);
    if (result) {
      // Checked first: "Not logged in" also contains "logged in".
      if (/not (logged|signed) in|login required/i.test(result.stdout)) {
        return { state: "missing", source: "cursor-agent status", hint };
      }
      if (result.code === 0 && /(logged|signed) in/i.test(result.stdout)) return signedIn("cursor-agent status");
    }
    return { state: "unknown", source: "cursor-agent status", hint, detail: "`cursor-agent status` gave no clear answer" };
  }
  return { state: "unknown", hint, detail: "a `cursor-agent login` session is checked only with --probe" };
}

// ── Cline ───────────────────────────────────────────────────────────────────

/** `cline auth` stores providers in <data dir>/settings/providers.json (data
 *  dir: CLINE_DATA_DIR, else <CLINE_DIR or ~/.cline>/data). */
export function clineAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  if (firstSetEnv(ctx, ["CLINE_API_KEY"])) return signedIn("env CLINE_API_KEY");
  const clineDir = (ctx.env.CLINE_DIR ?? "").trim() || nodePath.join(ctx.homedir, ".cline");
  const dataDir = (ctx.env.CLINE_DATA_DIR ?? "").trim() || nodePath.join(clineDir, "data");
  const file = nodePath.join(dataDir, "settings", "providers.json");
  if (isNonEmpty(readJsonObject(ctx, file))) return signedIn(displayPath(ctx, file));
  return { state: "missing", hint: "run `cline auth` to configure a provider" };
}

// ── Aider ───────────────────────────────────────────────────────────────────

/** `KEY=value` on one line; horizontal whitespace only, so a blank value never
 *  borrows the next line. */
const ENV_KEY_LINE = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*_API_KEY)[ \t]*=[ \t]*[^\s#]/m;

/** Provider env keys, a `.env` with an `*_API_KEY=` line (aider loads the
 *  repo/cwd and home `.env`), or ~/.aider/oauth-keys.env from its OpenRouter
 *  sign-in. Without any, aider offers an OpenRouter sign-in in the pane. */
export function aiderAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  const key = firstSetEnv(ctx, COMMON_PROVIDER_KEYS);
  if (key) return signedIn(`env ${key}`);
  const files = [
    ...(ctx.cwd ? [nodePath.join(ctx.cwd, ".env")] : []),
    nodePath.join(ctx.homedir, ".env"),
    nodePath.join(ctx.homedir, ".aider", "oauth-keys.env"),
  ];
  for (const file of files) {
    const match = ENV_KEY_LINE.exec(ctx.fs.readFile(file, MAX_AUTH_FILE_BYTES) ?? "");
    if (match) return signedIn(`${match[1]} in ${displayPath(ctx, file)}`);
  }
  return {
    state: "missing",
    hint: "set a provider key such as ANTHROPIC_API_KEY and a `model:` for the seat",
    detail: "with no key, aider offers an OpenRouter sign-in in the pane",
  };
}

// ── Grok Build ──────────────────────────────────────────────────────────────

/** XAI_API_KEY, or the `grok login` record at <GROK_HOME or ~/.grok>/auth.json. */
export function grokAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  if (firstSetEnv(ctx, ["XAI_API_KEY"])) return signedIn("env XAI_API_KEY");
  const home = (ctx.env.GROK_HOME ?? "").trim() || nodePath.join(ctx.homedir, ".grok");
  const file = nodePath.join(home, "auth.json");
  if (isNonEmpty(readJsonObject(ctx, file))) return signedIn(displayPath(ctx, file));
  return { state: "missing", hint: "run `grok login`, or set XAI_API_KEY" };
}

// ── Goose ───────────────────────────────────────────────────────────────────

const YAML_PROVIDER_LINE = /^GOOSE_PROVIDER:[ \t]*["']?([A-Za-z0-9._-]+)/m;

/** A provider from GOOSE_PROVIDER or `goose configure`'s
 *  <XDG_CONFIG_HOME or ~/.config>/goose/config.yaml, plus its key: a provider
 *  key in the env, or (with GOOSE_DISABLE_KEYRING) a non-empty secrets.yaml.
 *  Goose keeps keys in the system keychain by default, which is never read,
 *  so a configured provider without a visible key is "unknown". */
export function gooseAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  const configDir = nodePath.join((ctx.env.XDG_CONFIG_HOME ?? "").trim() || nodePath.join(ctx.homedir, ".config"), "goose");
  const configFile = nodePath.join(configDir, "config.yaml");
  const hint = "run `goose configure`, or set GOOSE_PROVIDER, GOOSE_MODEL, and the provider's key";
  const providerSource = firstSetEnv(ctx, ["GOOSE_PROVIDER"])
    ? "env GOOSE_PROVIDER"
    : YAML_PROVIDER_LINE.test(ctx.fs.readFile(configFile, MAX_AUTH_FILE_BYTES) ?? "") ? displayPath(ctx, configFile) : null;
  if (!providerSource) return { state: "missing", hint, detail: "no goose provider is configured" };
  const key = firstSetEnv(ctx, COMMON_PROVIDER_KEYS);
  if (key) return signedIn(`env ${key} + ${providerSource}`);
  if ((ctx.env.GOOSE_DISABLE_KEYRING ?? "").trim()) {
    const secrets = nodePath.join(configDir, "secrets.yaml");
    if ((ctx.fs.readFile(secrets, MAX_AUTH_FILE_BYTES) ?? "").trim()) return signedIn(`${displayPath(ctx, secrets)} + ${providerSource}`);
  }
  return { state: "unknown", source: providerSource, hint, detail: "a provider is configured; its key is in the system keychain, which OpenRig does not read" };
}

// ── Antigravity CLI ─────────────────────────────────────────────────────────

/** The API-key path (modelProvider "gemini" in
 *  ~/.gemini/antigravity-cli/settings.json plus GEMINI_API_KEY) is checkable;
 *  the Google sign-in lives in the OS keyring, which is never read. */
export function antigravityAuthStatus(ctx: RuntimeAuthContext): RuntimeAuthStatus {
  const file = nodePath.join(ctx.homedir, ".gemini", "antigravity-cli", "settings.json");
  if (readJsonObject(ctx, file)?.modelProvider === "gemini" && firstSetEnv(ctx, ["GEMINI_API_KEY"])) {
    return signedIn(`env GEMINI_API_KEY + ${displayPath(ctx, file)}`);
  }
  return {
    state: "unknown",
    hint: "run `agy` once to sign in, or use an API key (see docs/reference/runtimes/antigravity.md)",
    detail: "Google sign-in is kept in the OS keyring, which OpenRig does not read",
  };
}
