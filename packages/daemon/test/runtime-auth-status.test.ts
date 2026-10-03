// Sign-in status for the registry CLI runtimes (feature 6): local signals only,
// never a secret value in the result, "unknown" when a local check cannot
// decide, and the probe command only under --probe.

import { existsSync } from "node:fs";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthContext, RuntimeAuthStatus } from "../src/domain/runtime-capabilities.js";
import { listRuntimeDescriptors } from "../src/domain/runtime-registry.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import {
  aiderAuthStatus,
  antigravityAuthStatus,
  clineAuthStatus,
  copilotAuthStatus,
  cursorAuthStatus,
  geminiAuthStatus,
  grokAuthStatus,
  opencodeFamilyAuthStatus,
  qwenAuthStatus,
} from "../src/adapters/cli/auth-status.js";

const HOME = "/home/op";
const CWD = "/work/repo";
const SECRET = "SECRET-VALUE-do-not-print";
const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");

function ctx(opts: { env?: Record<string, string>; files?: Record<string, string>; cwd?: string | null; probe?: RuntimeAuthContext["probe"] } = {}): RuntimeAuthContext {
  const files = opts.files ?? {};
  return {
    homedir: HOME,
    env: opts.env ?? {},
    ...(opts.cwd === null ? {} : { cwd: opts.cwd ?? CWD }),
    fs: {
      exists: (p) => p in files,
      readFile: (p, maxBytes) => (p in files && (maxBytes === undefined || files[p]!.length <= maxBytes) ? files[p]! : null),
    },
    ...(opts.probe ? { probe: opts.probe } : {}),
  };
}

/** Every result must be free of secret values, whatever it decided. */
function safe(result: RuntimeAuthStatus): RuntimeAuthStatus {
  expect(JSON.stringify(result)).not.toContain(SECRET);
  return result;
}

describe("opencode and kilo", () => {
  const oc = opencodeFamilyAuthStatus("opencode");
  const kilo = opencodeFamilyAuthStatus("kilo");

  it("a provider key in the env is signed in, by name only", () => {
    expect(safe(oc(ctx({ env: { ANTHROPIC_API_KEY: SECRET } })))).toEqual({ state: "signed_in", source: "env ANTHROPIC_API_KEY" });
    expect(safe(kilo(ctx({ env: { KILO_API_KEY: SECRET } })))).toEqual({ state: "signed_in", source: "env KILO_API_KEY" });
    expect(oc(ctx({ env: { KILO_API_KEY: SECRET } })).state).toBe("missing");
  });

  it("a non-empty auth.json from `auth login` is signed in; XDG_DATA_HOME moves it", () => {
    const auth = JSON.stringify({ anthropic: { type: "api", key: SECRET } });
    expect(safe(oc(ctx({ files: { [`${HOME}/.local/share/opencode/auth.json`]: auth } })))).toEqual({
      state: "signed_in", source: "~/.local/share/opencode/auth.json",
    });
    expect(kilo(ctx({ env: { XDG_DATA_HOME: "/xdg" }, files: { "/xdg/kilo/auth.json": auth } })).source).toBe("/xdg/kilo/auth.json");
    expect(oc(ctx({ files: { [`${HOME}/.local/share/opencode/auth.json`]: "{}" } })).state).toBe("missing");
    expect(oc(ctx({ files: { [`${HOME}/.local/share/opencode/auth.json`]: "not json" } })).state).toBe("missing");
  });

  it("missing says the CLI still runs on its free models", () => {
    expect(oc(ctx())).toMatchObject({ state: "missing", hint: expect.stringContaining("opencode auth login"), detail: expect.stringContaining("OpenCode Zen") });
    expect(kilo(ctx())).toMatchObject({ state: "missing", hint: expect.stringContaining("kilo auth login"), detail: expect.stringContaining("Auto Free") });
  });
});

describe("gemini", () => {
  const settings = (selectedType: string) => JSON.stringify({ security: { auth: { selectedType } } });
  const userFile = `${HOME}/.gemini/settings.json`;

  it("no chosen auth method is missing: every launch would stop at the auth dialog", () => {
    expect(geminiAuthStatus(ctx({ env: { GEMINI_API_KEY: SECRET } }))).toMatchObject({ state: "missing", detail: expect.stringContaining("auth dialog") });
  });

  it("the API key method needs GEMINI_API_KEY", () => {
    expect(safe(geminiAuthStatus(ctx({ env: { GEMINI_API_KEY: SECRET }, files: { [userFile]: settings("gemini-api-key") } })))).toEqual({
      state: "signed_in", source: "env GEMINI_API_KEY + ~/.gemini/settings.json",
    });
    expect(geminiAuthStatus(ctx({ files: { [userFile]: settings("gemini-api-key") } }))).toMatchObject({ state: "missing", hint: "set GEMINI_API_KEY" });
  });

  it("Vertex AI: an API key is signed in; project-only ADC is unknown; neither is missing", () => {
    const files = { [userFile]: settings("vertex-ai") };
    expect(safe(geminiAuthStatus(ctx({ env: { GOOGLE_API_KEY: SECRET }, files }))).state).toBe("signed_in");
    expect(geminiAuthStatus(ctx({ env: { GOOGLE_CLOUD_PROJECT: "p" }, files })).state).toBe("unknown");
    expect(geminiAuthStatus(ctx({ files })).state).toBe("missing");
  });

  it("Google sign-in and other methods are unknown locally", () => {
    expect(geminiAuthStatus(ctx({ files: { [userFile]: settings("oauth-personal") } }))).toMatchObject({ state: "unknown", detail: expect.stringContaining("2026-06-18") });
    expect(geminiAuthStatus(ctx({ files: { [userFile]: settings("gateway") } })).state).toBe("unknown");
  });

  it("reads the workspace settings first and honors GEMINI_CLI_HOME", () => {
    expect(geminiAuthStatus(ctx({ env: { GEMINI_API_KEY: SECRET }, files: { [`${CWD}/.gemini/settings.json`]: settings("gemini-api-key") } })).source)
      .toBe(`env GEMINI_API_KEY + ${CWD}/.gemini/settings.json`);
    expect(geminiAuthStatus(ctx({ env: { GEMINI_CLI_HOME: "/g", GEMINI_API_KEY: SECRET }, files: { "/g/settings.json": settings("gemini-api-key") } })).state)
      .toBe("signed_in");
  });
});

describe("qwen", () => {
  const file = `${HOME}/.qwen/settings.json`;

  it("the discontinued Qwen OAuth tier is missing", () => {
    expect(qwenAuthStatus(ctx({ files: { [file]: JSON.stringify({ security: { auth: { selectedType: "qwen-oauth" } } }) } })))
      .toMatchObject({ state: "missing", detail: expect.stringContaining("discontinued") });
  });

  it("a configured provider in settings is signed in", () => {
    expect(qwenAuthStatus(ctx({ files: { [file]: JSON.stringify({ security: { auth: { selectedType: "openai" } } }) } })).state).toBe("signed_in");
    expect(qwenAuthStatus(ctx({ files: { [file]: JSON.stringify({ modelProviders: { openai: [{ id: "m" }] } }) } })).state).toBe("signed_in");
  });

  it("env needs a complete provider set", () => {
    expect(safe(qwenAuthStatus(ctx({ env: { OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: "u", OPENAI_MODEL: "m" } })))).toEqual({ state: "signed_in", source: "env OPENAI_API_KEY" });
    expect(qwenAuthStatus(ctx({ env: { OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: "u" } })).state).toBe("missing");
    expect(qwenAuthStatus(ctx({ env: { GEMINI_API_KEY: SECRET, GEMINI_MODEL: "g" } })).state).toBe("signed_in");
    expect(qwenAuthStatus(ctx({ env: { ANTHROPIC_API_KEY: SECRET } })).state).toBe("missing");
  });
});

describe("copilot", () => {
  it("token env vars in precedence order are signed in; a login session is unknown, never missing", () => {
    expect(safe(copilotAuthStatus(ctx({ env: { GH_TOKEN: SECRET, GITHUB_TOKEN: SECRET } })))).toEqual({ state: "signed_in", source: "env GH_TOKEN" });
    expect(copilotAuthStatus(ctx({ env: { COPILOT_GITHUB_TOKEN: SECRET, GH_TOKEN: SECRET } })).source).toBe("env COPILOT_GITHUB_TOKEN");
    expect(copilotAuthStatus(ctx())).toMatchObject({ state: "unknown", hint: expect.stringContaining("copilot login") });
  });
});

describe("cursor", () => {
  it("CURSOR_API_KEY is signed in without running anything", async () => {
    const exec = vi.fn();
    expect(safe(await cursorAuthStatus(ctx({ env: { CURSOR_API_KEY: SECRET }, probe: { exec } })))).toEqual({ state: "signed_in", source: "env CURSOR_API_KEY" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("without --probe it never runs a command and says unknown", async () => {
    expect(await cursorAuthStatus(ctx())).toMatchObject({ state: "unknown", detail: expect.stringContaining("--probe") });
  });

  it("with --probe it reads `cursor-agent status`", async () => {
    const run = (code: number, stdout: string) => cursorAuthStatus(ctx({ probe: { exec: async () => ({ code, stdout }) } }));
    expect((await run(0, "Logged in as someone@example.com")).state).toBe("signed_in");
    expect((await run(1, "Not logged in")).state).toBe("missing");
    // Live output of cursor-agent 2026.10.01 for a signed-out account: exit 0.
    expect((await run(0, "Not logged in\n")).state).toBe("missing");
    expect((await run(0, "")).state).toBe("unknown");
    expect((await cursorAuthStatus(ctx({ probe: { exec: async () => null } }))).state).toBe("unknown");
  });

  it("the probe command is the documented status command with self-update off", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "Logged in" }));
    await cursorAuthStatus(ctx({ probe: { exec } }));
    expect(exec).toHaveBeenCalledWith(["cursor-agent", "--disable-auto-update", "status"], expect.any(Number));
  });
});

describe("cline, aider, grok, antigravity", () => {
  it("cline: providers.json from `cline auth`, honoring CLINE_DATA_DIR and CLINE_DIR", () => {
    const providers = JSON.stringify({ anthropic: { apiKey: SECRET } });
    expect(safe(clineAuthStatus(ctx({ files: { [`${HOME}/.cline/data/settings/providers.json`]: providers } })))).toEqual({
      state: "signed_in", source: "~/.cline/data/settings/providers.json",
    });
    expect(clineAuthStatus(ctx({ env: { CLINE_DATA_DIR: "/d" }, files: { "/d/settings/providers.json": providers } })).state).toBe("signed_in");
    expect(clineAuthStatus(ctx({ env: { CLINE_DIR: "/c" }, files: { "/c/data/settings/providers.json": providers } })).state).toBe("signed_in");
    expect(clineAuthStatus(ctx())).toMatchObject({ state: "missing", hint: expect.stringContaining("cline auth") });
  });

  it("aider: env keys, then an *_API_KEY line in .env or the OpenRouter keys file", () => {
    expect(safe(aiderAuthStatus(ctx({ env: { OPENAI_API_KEY: SECRET } })))).toEqual({ state: "signed_in", source: "env OPENAI_API_KEY" });
    expect(safe(aiderAuthStatus(ctx({ files: { [`${CWD}/.env`]: `# keys\nexport ANTHROPIC_API_KEY=${SECRET}\n` } })))).toEqual({
      state: "signed_in", source: `ANTHROPIC_API_KEY in ${CWD}/.env`,
    });
    expect(aiderAuthStatus(ctx({ files: { [`${HOME}/.aider/oauth-keys.env`]: `OPENROUTER_API_KEY=${SECRET}\n` } })).source)
      .toBe("OPENROUTER_API_KEY in ~/.aider/oauth-keys.env");
    expect(aiderAuthStatus(ctx({ files: { [`${CWD}/.env`]: "ANTHROPIC_API_KEY=\nOTHER=1\n" } })).state).toBe("missing");
    expect(aiderAuthStatus(ctx())).toMatchObject({ state: "missing", detail: expect.stringContaining("OpenRouter") });
  });

  it("grok: XAI_API_KEY or the `grok login` record under GROK_HOME or ~/.grok", () => {
    expect(safe(grokAuthStatus(ctx({ env: { XAI_API_KEY: SECRET } })))).toEqual({ state: "signed_in", source: "env XAI_API_KEY" });
    expect(grokAuthStatus(ctx({ files: { [`${HOME}/.grok/auth.json`]: JSON.stringify({ token: SECRET }) } })).source).toBe("~/.grok/auth.json");
    expect(grokAuthStatus(ctx({ env: { GROK_HOME: "/gh" }, files: { "/gh/auth.json": JSON.stringify({ t: 1 }) } })).state).toBe("signed_in");
    expect(grokAuthStatus(ctx())).toMatchObject({ state: "missing", hint: expect.stringContaining("grok login") });
  });

  it("antigravity: only the API-key path is checkable; the keyring sign-in is unknown", () => {
    const file = `${HOME}/.gemini/antigravity-cli/settings.json`;
    expect(safe(antigravityAuthStatus(ctx({ env: { GEMINI_API_KEY: SECRET }, files: { [file]: JSON.stringify({ modelProvider: "gemini" }) } }))).state).toBe("signed_in");
    expect(antigravityAuthStatus(ctx({ env: { GEMINI_API_KEY: SECRET } }))).toMatchObject({ state: "unknown", detail: expect.stringContaining("keyring") });
  });

  it("oversized files are not read", () => {
    const huge = `ANTHROPIC_API_KEY=${SECRET}\n${"x".repeat(300 * 1024)}`;
    expect(aiderAuthStatus(ctx({ files: { [`${CWD}/.env`]: huge } })).state).toBe("missing");
  });
});

describe("registry wiring", () => {
  it("every CLI runtime has an authStatus hook and a docs page that exists", () => {
    for (const { descriptor } of CLI_RUNTIME_REGISTRATIONS) {
      expect(descriptor.authStatus, `${descriptor.id} authStatus`).toBeTypeOf("function");
      expect(descriptor.docsPath, `${descriptor.id} docsPath`).toBe(`docs/reference/runtimes/${descriptor.id}.md`);
      expect(existsSync(nodePath.join(REPO_ROOT, descriptor.docsPath!)), `${descriptor.docsPath} exists`).toBe(true);
    }
  });

  it("built-in runtimes are unchanged (no sign-in hook)", () => {
    for (const d of listRuntimeDescriptors().filter((x) => ["claude-code", "codex", "pi", "terminal"].includes(x.id))) {
      expect(d.authStatus).toBeUndefined();
    }
  });
});
