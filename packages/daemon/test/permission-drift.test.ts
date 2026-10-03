import { describe, expect, it } from "vitest";
import {
  diagnoseRuntimePosture,
  observeClaudePermission,
  observeCodexSandbox,
  observePiResourceTrust,
  parseClaudePermissionModes,
  renderPermissionDriftSummary,
  type PermissionDriftFs,
} from "../src/domain/permission-drift.js";

function fsFixture(files: Record<string, string | Error>, cwdReadable: boolean | null = true): PermissionDriftFs {
  return {
    readFile(path) {
      const value = files[path];
      if (value === undefined) {
        const err = new Error(`missing: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (value instanceof Error) throw value;
      return value;
    },
    cwdReadable: () => cwdReadable,
    commandAvailable: () => true,
    claudePermissionModes: () => ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
  };
}

const cwd = "/tmp/w3-project";
const settingsPath = `${cwd}/.claude/settings.local.json`;

describe("applied launch observations retain the emitted argument value", () => {
  it("preserves Claude permission vocabulary", () => {
    expect(observeClaudePermission("--permission-mode acceptEdits")).toEqual({
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "acceptEdits",
      reason: "emitted_launch_arguments",
    });
    expect(observeClaudePermission("--dangerously-skip-permissions").value).toBe("bypassPermissions");
  });

  it("preserves Codex sandbox vocabulary and refuses to guess named-profile semantics", () => {
    expect(observeCodexSandbox(" -s workspace-write")).toMatchObject({ axis: "sandbox", state: "observed", value: "workspace-write" });
    expect(observeCodexSandbox(" -s danger-full-access")).toMatchObject({ axis: "sandbox", state: "observed", value: "danger-full-access" });
    expect(observeCodexSandbox(" -p cautious")).toMatchObject({ axis: "sandbox", state: "unknown", value: null, reason: "named_profile_unresolved" });
  });

  it("preserves Pi resource-trust vocabulary and never calls it permission", () => {
    const observation = observePiResourceTrust("approve");
    expect(observation).toEqual({ runtime: "pi", axis: "resource_trust", state: "observed", value: "approve" });
    expect(JSON.stringify(observation)).not.toMatch(/permission/i);
  });
});

describe("read-only configuration comparison and unknown native enforcement", () => {
  it("derives Claude permission vocabulary from the live help shape", () => {
    expect(parseClaudePermissionModes([
      "--permission-mode <mode>  Permission mode to use",
      "  (choices: \"acceptEdits\", \"auto\", \"bypassPermissions\",",
      "  \"manual\", \"dontAsk\", \"plan\")",
    ].join("\n"))).toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
    expect(parseClaudePermissionModes("no permission surface")).toBeNull();
  });

  it("reports a narrowed Claude project policy as drift with the exact file and independent axes", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({
        [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual", allow: ["Read(.)"], deny: ["Read(/tmp/**)"] } }),
      }),
    });

    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe("visible");
    expect(diagnostic.commandPath.state).toBe("available");
    expect(diagnostic.configuration).toMatchObject({
      comparison: "drift",
      expected: "acceptEdits",
      sourcePath: settingsPath,
    });
    expect(diagnostic.configuration?.observed).toEqual({
      defaultMode: "manual",
      allow: ["Read(.)"],
      ask: [],
      deny: ["Read(/tmp/**)"],
    });
  });

  it("reports a matching Claude defaultMode as aligned", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }),
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "aligned", expected: "acceptEdits" });
    expect(diagnostic.enforcement).toMatchObject({ state: "unknown", effective: null });
  });

  it("keeps bypass arguments separate from observed project settings", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--dangerously-skip-permissions"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual", deny: ["Read(/**)"] } }) }),
    });
    expect(diagnostic.enforcement).toMatchObject({
      axis: "permission",
      state: "unknown",
      expected: "bypassPermissions",
      effective: null,
      sourcePath: null,
      reason: "native_permission_effect_unverified",
    });
  });

  it("does not let ordinary acceptEdits bypass a narrowed project policy", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual" } }) }),
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "drift", expected: "acceptEdits" });
    expect(diagnostic.enforcement.state).toBe("unknown");
  });

  it("reports UNKNOWN-EFFECTIVE when live harness semantics cannot be resolved", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }),
        claudePermissionModes: () => null,
      },
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "unknown", reason: "harness_semantics_unknown" });
  });

  it.each([
    ["missing", {}, "settings_missing"],
    ["malformed", { [settingsPath]: "{" }, "settings_unparseable"],
    ["top-level array", { [settingsPath]: "[]" }, "settings_invalid_shape"],
    ["scalar permissions", { [settingsPath]: JSON.stringify({ permissions: "denyAll" }) }, "permissions_invalid_shape"],
    ["unsupported mode", { [settingsPath]: JSON.stringify({ permissions: { defaultMode: "futureMode" } }) }, "unsupported_default_mode"],
    ["conflicting rule", { [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits", allow: ["Read(/**)"], deny: ["Read(/**)"] } }) }, "conflicting_rules"],
  ])("keeps %s UNKNOWN-EFFECTIVE", (_name, files, reason) => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture(files as Record<string, string>),
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "unknown", reason, sourcePath: settingsPath });
  });

  it.each([
    ["cwd/read", false, true, "denied", "available"],
    ["command/PATH", true, false, "visible", "missing"],
  ] as const)("isolates the %s axis while every other local axis stays healthy", (_axis, cwdVisible, commandPresent, cwdState, commandState) => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }, cwdVisible),
        commandAvailable: () => commandPresent,
      },
    });
    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe(cwdState);
    expect(diagnostic.commandPath.state).toBe(commandState);
    expect(diagnostic.enforcement.state).toBe("unknown");
    expect(diagnostic.configuration?.comparison).toBe("aligned");
  });

  it("keeps unreadable settings separate from healthy transport, cwd, and command axes", () => {
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: denied }, true),
        commandAvailable: () => true,
      },
    });
    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe("visible");
    expect(diagnostic.commandPath.state).toBe("available");
    expect(diagnostic.configuration).toMatchObject({ comparison: "unknown", reason: "settings_unreadable" });
  });

  it("does not render Pi resource trust in a permissions column", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "pi",
      cwd,
      applied: observePiResourceTrust("no-approve"),
      fs: fsFixture({}),
    });
    const text = renderPermissionDriftSummary(diagnostic);
    expect(text).toContain("resource trust");
    expect(text).not.toMatch(/permission(?:s)?\s*:/i);
  });
});

describe("registry CLI runtimes: launch posture drift", () => {
  const permission = (runtime: string, value: string) =>
    ({ runtime, axis: "permission", state: "observed", value, reason: "emitted_launch_arguments" }) as const;
  const diagnose = (runtime: string, applied: ReturnType<typeof permission> | null, expectedPosture?: "floor" | "full_bypass" | null) =>
    diagnoseRuntimePosture({ runtime, cwd, applied, fs: fsFixture({}), expectedPosture }).enforcement;

  it("gemini: the recorded approval mode matches the seat's policy posture", () => {
    expect(diagnose("gemini", permission("gemini", "auto_edit"), "floor")).toEqual({
      axis: "permission", state: "aligned", expected: "floor", effective: "floor", sourcePath: null, reason: "launch_posture_compared",
    });
    expect(diagnose("gemini", permission("gemini", "yolo"), "full_bypass")).toMatchObject({ state: "aligned", effective: "full_bypass" });
    expect(diagnose("qwen", permission("qwen", "auto-edit"), "floor")).toMatchObject({ state: "aligned" });
  });

  it("gemini: a mismatch between the emitted mode and the policy posture is drift", () => {
    expect(diagnose("gemini", permission("gemini", "yolo"), "floor")).toMatchObject({
      axis: "permission", state: "drift", expected: "floor", effective: "full_bypass",
    });
    expect(diagnose("qwen", permission("qwen", "auto-edit"), "full_bypass")).toMatchObject({ state: "drift" });
  });

  it("opencode: the full_bypass observation matches, and a floor policy flags it as drift", () => {
    expect(diagnose("opencode", permission("opencode", "auto"), "full_bypass")).toMatchObject({ state: "aligned", effective: "full_bypass" });
    expect(diagnose("kilo", permission("kilo", "auto"), "floor")).toMatchObject({ state: "drift", expected: "floor", effective: "full_bypass" });
  });

  it("goose: both emitted modes compare against the policy posture", () => {
    expect(diagnose("goose", permission("goose", "GOOSE_MODE=auto"), "full_bypass")).toMatchObject({ state: "aligned", effective: "full_bypass" });
    expect(diagnose("goose", permission("goose", "GOOSE_MODE=smart_approve"), "floor")).toMatchObject({ state: "aligned", effective: "floor" });
    expect(diagnose("goose", permission("goose", "GOOSE_MODE=auto"), "floor")).toMatchObject({ state: "drift", expected: "floor", effective: "full_bypass" });
    expect(diagnose("goose", permission("goose", "GOOSE_MODE=smart_approve"), "full_bypass")).toMatchObject({ state: "drift", effective: "floor" });
  });

  it("stays unknown without a policy posture, and never guesses from an unrecognized value", () => {
    expect(diagnose("gemini", permission("gemini", "auto_edit"), null)).toMatchObject({ state: "unknown", reason: "expected_posture_unknown" });
    expect(diagnose("gemini", permission("gemini", "plan"), "floor")).toMatchObject({ state: "unknown", reason: "unrecognized_launch_value" });
  });

  it("a registry runtime with no observation stays not_applicable", () => {
    expect(diagnose("gemini", null, "floor")).toMatchObject({ axis: "not_applicable", state: "unknown", reason: "applied_launch_unknown" });
    // The opencode floor passes no permission flag: its observation is state unknown.
    const floor = { runtime: "opencode", axis: "permission", state: "unknown", value: null, reason: "cli_config_governs" } as const;
    expect(diagnoseRuntimePosture({ runtime: "opencode", cwd, applied: floor, fs: fsFixture({}), expectedPosture: "floor" }).enforcement)
      .toMatchObject({ axis: "not_applicable", state: "unknown" });
  });

  it("an observation from another runtime is never compared", () => {
    expect(diagnose("gemini", permission("qwen", "auto-edit"), "floor")).toMatchObject({ axis: "not_applicable", state: "unknown" });
  });

  it("leaves built-in runtimes on their existing paths", () => {
    const codex = diagnoseRuntimePosture({ runtime: "codex", cwd, applied: observeCodexSandbox(" -s workspace-write"), fs: fsFixture({}), expectedPosture: "floor" });
    expect(codex.enforcement).toMatchObject({ axis: "sandbox", state: "unknown", reason: "native_permission_effect_unverified" });
    const pi = diagnoseRuntimePosture({ runtime: "pi", cwd, applied: observePiResourceTrust("no-approve"), fs: fsFixture({}), expectedPosture: "full_bypass" });
    expect(pi.enforcement).toMatchObject({ axis: "resource_trust", state: "aligned", reason: "generation_matched_launch_effect" });
  });
});
