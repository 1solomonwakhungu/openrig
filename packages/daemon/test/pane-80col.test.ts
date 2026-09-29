// Grok and Antigravity patterns on 80x24 panes (the OpenRig daemon's pane
// size): long cwds, resumed sessions, and text the TUI wraps or boxes. Every
// fixture is checked to fit 80 columns and 24 rows, then run through the real
// launch path of the TUI CLI base.

import { describe, expect, it } from "vitest";
import { TuiCliRuntimeAdapter, type TuiCliRuntimeSpec } from "../src/adapters/cli/tui-cli-runtime-adapter.js";
import { GROK_SPEC } from "../src/adapters/cli/grok/index.js";
import { ANTIGRAVITY_READY_RE, ANTIGRAVITY_SPEC } from "../src/adapters/cli/antigravity/index.js";
import { anyPanePhrase, panePhrase } from "../src/adapters/cli/pane-phrase.js";
import { atShell, harnessBinding, harnessDeps, memFs, mockTmux } from "./helpers/tui-cli-adapter-harness.js";

const screen = (...lines: string[]) => lines.join("\n");

function fits80x24(content: string): void {
  const lines = content.split("\n");
  expect(lines.length).toBeLessThanOrEqual(24);
  for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(80);
}

async function launch(spec: TuiCliRuntimeSpec, command: string, content: string) {
  fits80x24(content);
  const pane = mockTmux([atShell(), { command, content }]);
  const adapter = new TuiCliRuntimeAdapter(spec, harnessDeps({ tmux: pane.tmux, fsOps: memFs() }));
  return adapter.launchHarness(harnessBinding({ cwd: "/Users/operator/Projects/clients/acme/very-long-monorepo-name/services/api" }), { name: "x" });
}

describe("panePhrase", () => {
  it("matches across wraps and box borders, but not inside other words", () => {
    const trust = panePhrase("Do you trust the contents of this directory?");
    expect(trust.test("│ Do you trust the contents of │\n│ this directory?              │")).toBe(true);
    expect(trust.test("Do you trust the\n  contents of this directory?")).toBe(true);
    expect(trust.test("Do you trust the contents of this directory")).toBe(false);
    expect(anyPanePhrase(["Waiting for approval...", "Paste your token here"]).test("Paste your\ntoken here")).toBe(true);
    expect(panePhrase("(y/n)").test("Discard changes? (y/n)")).toBe(true);
  });
});

describe("grok on an 80x24 pane", () => {
  const readyResumed = screen(
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ Resumed session 0198a2f0-1c2d-7e3f-8a9b-0c1d2e3f4a5b                         │",
    "│ Last turn: refactor the request router and add tests for the retry path      │",
    "╰──────────────────────────────────────────────────────────────────────────────╯",
    "",
    "  ● Updated services/api/src/router.ts (+42 -17)",
    "  ● All 318 tests passed",
    "",
    "",
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ > Build                                                                      │",
    "│   anything                                                                   │",
    "╰──────────────────────────────────────────────────────────────────────────────╯",
    "  grok-4 · ~/Projects/clients/acme/very-long-monorepo-name/services/api · ? for",
    "  help",
  );

  it("is ready with a resumed session, a long cwd, and a wrapped placeholder", async () => {
    expect(await launch(GROK_SPEC, "grok", readyResumed)).toMatchObject({ ok: true });
  });

  it("maps the box-wrapped trust prompt to trust_gate", async () => {
    const trust = screen(
      "  ╭────────────────────────────────────╮",
      "  │ Do you trust the contents of this  │",
      "  │ directory?                         │",
      "  │ Grok Build may run or modify       │",
      "  │ contents in this directory, posing │",
      "  │ security risks.                    │",
      "  │                                    │",
      "  │ > Yes, proceed        No, exit     │",
      "  ╰────────────────────────────────────╯",
    );
    expect(await launch(GROK_SPEC, "grok", trust)).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("trust") });
  });

  it("maps the device-code sign-in screen to login_required", async () => {
    const signIn = screen(
      "                  Approve in your browser to finish",
      "                  signing in.",
      "                            RYAG-7P8A",
      "                  Make sure your browser shows this code.",
      "                  Waiting for approval...",
      "                                              ctrl+q  quit",
    );
    expect(await launch(GROK_SPEC, "grok", signIn)).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("sign-in") });
  });

  it("maps a wrapped missing-session error to retry_fresh", async () => {
    const missing = screen("  Error: No session found with", "  id 0198a2f0-0000-7000-8000-000000000000.");
    expect(await launch(GROK_SPEC, "grok", missing)).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });
});

describe("antigravity on an 80x24 pane", () => {
  const readyNarrow = screen(
    "  Antigravity CLI · gemini-3.5-flash-medium",
    "  Workspace: /Users/operator/Projects/clients/acme/very-long-monorepo-name/",
    "  services/api",
    "",
    "  Resumed conversation 5f0c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f",
    "",
    "",
    "╭──────────────────────────────────────────────────────────────────────────────╮",
    "│ >                                                                            │",
    "╰──────────────────────────────────────────────────────────────────────────────╯",
    "  [accept-edits]  ~/Projects/clients/acme/very-long-monorepo-name/.../api  ? for",
    "  shortcuts",
  );

  it("is ready with a resumed conversation, a long cwd, and a wrapped status line", async () => {
    expect(ANTIGRAVITY_READY_RE.test(readyNarrow)).toBe(true);
    expect(await launch(ANTIGRAVITY_SPEC, "agy", readyNarrow)).toMatchObject({ ok: true });
  });

  it("never reads a box-wrapped permission dialog as ready", async () => {
    const dialog = screen(
      "  ╭──────────────────────────────────────╮",
      "  │ Allow agy to create files in this    │",
      "  │ workspace?                           │",
      "  │ > Yes, allow                         │",
      "  │   creation                           │",
      "  │   No, deny                           │",
      "  │   creation                           │",
      "  ╰──────────────────────────────────────╯",
      "  [accept-edits]                                                ? for shortcuts",
    );
    expect(ANTIGRAVITY_READY_RE.test(dialog)).toBe(false);
    expect(await launch(ANTIGRAVITY_SPEC, "agy", dialog)).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("maps the box-wrapped trust prompt and the wrapped sign-in message", async () => {
    const trust = screen(
      "  ╭──────────────────────────────────╮",
      "  │ Do you trust the contents of     │",
      "  │ this project?                    │",
      "  │ > Yes   No                       │",
      "  ╰──────────────────────────────────╯",
    );
    expect(await launch(ANTIGRAVITY_SPEC, "agy", trust)).toMatchObject({ ok: false, error: expect.stringContaining("trust") });
    const signIn = screen(
      "Authentication required. Please visit the URL to",
      "log in:",
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=0000000000-abcdefghijklm",
      "nopqrstuvwxyz.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A",
      "Waiting for authentication (timeout 60s)...",
    );
    expect(await launch(ANTIGRAVITY_SPEC, "agy", signIn)).toMatchObject({ ok: false, error: expect.stringContaining("sign-in") });
  });

  it("maps a wrapped missing-conversation error to retry_fresh", async () => {
    const missing = screen("  Error: failed to resume: conversation", "  not found");
    expect(await launch(ANTIGRAVITY_SPEC, "agy", missing)).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });
});
