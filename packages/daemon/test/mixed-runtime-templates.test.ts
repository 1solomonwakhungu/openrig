// The ready-made mixed-runtime rig templates under specs/rigs/mixed: each one
// mixes registered CLI runtimes, documents what must be installed and signed
// in, and is served by the built-in spec library (what `rig specs` lists).
// Review, canonical preflight, and edge checks run in spec-library-starters.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { getRuntimeDescriptor } from "../src/domain/runtime-registry.js";

const MIXED_ROOT = resolve(import.meta.dirname, "../specs/rigs/mixed");
const SPECS_ROOT = resolve(import.meta.dirname, "../specs");

const TEMPLATES: Record<string, string[]> = {
  "polyglot-dev": ["opencode", "gemini"],
  "review-pair": ["claude-code", "copilot"],
  "budget-team": ["opencode", "kilo"],
};

interface Member { id: string; runtime: string }
function runtimesOf(name: string): string[] {
  const spec = parseYaml(readFileSync(join(MIXED_ROOT, name, "rig.yaml"), "utf8")) as {
    name: string;
    pods: Array<{ members: Member[] }>;
  };
  expect(spec.name).toBe(name);
  return spec.pods.flatMap((pod) => pod.members.map((m) => m.runtime));
}

describe("mixed-runtime rig templates", () => {
  it.each(Object.entries(TEMPLATES))("%s uses its declared runtimes, all registered and public", (name, expected) => {
    const runtimes = runtimesOf(name);
    expect(runtimes).toEqual(expected);
    expect(new Set(runtimes).size).toBeGreaterThanOrEqual(2);
    for (const id of runtimes) {
      const descriptor = getRuntimeDescriptor(id);
      expect(descriptor, `${id} is registered`).toBeDefined();
      expect(descriptor!.internal ?? false).toBe(false);
    }
  });

  it.each(Object.keys(TEMPLATES))("%s documents every runtime it needs", (name) => {
    const readme = join(MIXED_ROOT, name, "README.md");
    expect(existsSync(readme)).toBe(true);
    const text = readFileSync(readme, "utf8");
    for (const id of TEMPLATES[name]!) expect(text).toContain(`\`${id}\``);
    expect(text).toMatch(/## Before `rig up`/);
  });

  it("the built-in library lists every template as a rig", () => {
    const lib = new SpecLibraryService({
      roots: [{ path: SPECS_ROOT, sourceType: "builtin" }],
      specReviewService: new SpecReviewService(),
    });
    lib.scan();
    const rigs = lib.list({ kind: "rig" });
    for (const name of Object.keys(TEMPLATES)) {
      const entry = rigs.find((r) => r.name === name);
      expect(entry, `${name} is listed`).toBeDefined();
      expect(entry!.sourceType).toBe("builtin");
    }
  });
});
