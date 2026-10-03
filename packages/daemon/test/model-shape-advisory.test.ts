// Feature 7: per-runtime model shapes and the warn-only preflight advisory.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModelShape } from "../src/domain/runtime-capabilities.js";
import { getRuntimeDescriptor, listRuntimeDescriptors, BUILTIN_RUNTIME_IDS } from "../src/domain/runtime-registry.js";
import { CLI_RUNTIME_REGISTRATIONS } from "../src/adapters/cli/index.js";
import { modelShapeAdvisories } from "../src/domain/model-shape-advisory.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";

const fits = (runtime: string, model: string) => checkModelShape(getRuntimeDescriptor(runtime)!.modelShape!, model).ok;

describe("model shapes per runtime", () => {
  it("every CLI runtime declares one whose own example fits (except cline, which takes no model)", () => {
    for (const { descriptor } of CLI_RUNTIME_REGISTRATIONS) {
      const shape = descriptor.modelShape;
      expect(shape, descriptor.id).toBeDefined();
      if (descriptor.id === "cline") continue;
      expect(checkModelShape(shape!, shape!.example).ok, `${descriptor.id} example ${shape!.example}`).toBe(true);
    }
  });

  it("built-in runtimes are not checked", () => {
    for (const d of listRuntimeDescriptors().filter((x) => (BUILTIN_RUNTIME_IDS as readonly string[]).includes(x.id))) {
      expect(d.modelShape).toBeUndefined();
    }
  });

  it.each([
    ["opencode", "anthropic/claude-sonnet-5", true], ["opencode", "openrouter/x-ai/grok-4", true], ["opencode", "claude-sonnet-5", false],
    ["kilo", "anthropic/claude-sonnet-5", true], ["kilo", "sonnet", false],
    ["gemini", "pro", true], ["gemini", "flash-lite", true], ["gemini", "auto", true], ["gemini", "gemini-2.5-pro", true], ["gemini", "gpt-5", false],
    ["qwen", "qwen3-coder-plus", true], ["qwen", "qwen 3", false],
    ["goose", "claude-sonnet-4-5", true], ["goose", "gpt-5.4", true], ["goose", "claude sonnet", false],
    ["copilot", "gpt-5.4", true], ["copilot", "claude-sonnet-4.5", true], ["copilot", "openai/gpt-5", false],
    ["cursor", "gpt-5", true], ["cursor", "gpt-5[reasoning=high]", true], ["cursor", "anthropic/sonnet", false],
    ["aider", "sonnet", true], ["aider", "anthropic/claude-sonnet-5", true], ["aider", "son net", false],
    ["grok", "grok-4", true], ["grok", "gpt-5", false],
    ["antigravity", "gemini-3.5-flash-medium", true], ["antigravity", "Gemini Flash", false],
    ["cline", "anthropic/claude-sonnet-5", false],
  ])("%s: %j fits = %s", (runtime, model, ok) => {
    expect(fits(runtime, model)).toBe(ok);
  });
});

describe("modelShapeAdvisories", () => {
  const spec = (members: Array<{ id: string; runtime: string; model?: string }>) => ({ pods: [{ id: "dev", members }] });

  it("one warning per misfit seat, naming what is expected and an example", () => {
    const warnings = modelShapeAdvisories(spec([
      { id: "builder", runtime: "opencode", model: "claude-sonnet-5" },
      { id: "ok", runtime: "opencode", model: "anthropic/claude-sonnet-5" },
      { id: "reviewer", runtime: "gemini", model: " pro " },
    ]));
    expect(warnings).toEqual([
      'dev.builder: model "claude-sonnet-5" does not look like a opencode model (expected provider/model, e.g. anthropic/claude-sonnet-5); rig up continues, but the CLI may reject it',
    ]);
  });

  it("no model, an unknown runtime, or a built-in runtime is never flagged", () => {
    expect(modelShapeAdvisories(spec([
      { id: "a", runtime: "opencode" },
      { id: "b", runtime: "no-such-runtime", model: "x y" },
      { id: "c", runtime: "claude-code", model: "anything goes" },
      { id: "d", runtime: "codex", model: "gpt-6-astra" },
    ]))).toEqual([]);
  });

  it("cline: any model gets the advisory before launch refuses it", () => {
    expect(modelShapeAdvisories(spec([{ id: "x", runtime: "cline", model: "anthropic/claude-sonnet-5" }]))).toEqual([
      "dev.x: cline seats take no model: (set it with cline auth <provider> -m <model>); the launch refuses model:, so remove it",
    ]);
  });
});

describe("preflight consumer", () => {
  const yaml = (model: string) => `version: "0.2"
name: model-advisory
pods:
  - id: dev
    label: Dev
    members:
      - id: coder
        agent_ref: "local:../../../agents/development/implementer"
        profile: default
        runtime: opencode
        model: ${model}
        cwd: "."
    edges: []
edges: []
`;
  // Resolve the shipped implementer agent the way a built-in rig spec does.
  const rigRoot = resolve(import.meta.dirname, "../specs/rigs/launch/implementation-pair");
  const run = (model: string) => rigPreflight({
    rigSpecYaml: yaml(model), rigRoot, cwdOverride: "/workspace/project",
    fsOps: { readFile: (p) => readFileSync(p, "utf-8"), exists: (p) => existsSync(p) },
  });

  it("a misfit model is a warning, never an error: the rig stays ready", async () => {
    const result = await run("claude-sonnet-5");
    expect(result.errors).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.warnings.at(-1)).toContain('dev.coder: model "claude-sonnet-5" does not look like a opencode model');
  });

  it("a fitting model adds no warning", async () => {
    const result = await run("anthropic/claude-sonnet-5");
    expect(result.warnings.some((w) => w.includes("does not look like"))).toBe(false);
  });
});
