// Warn-only preflight advisory (feature 7): a seat whose `model:` does not fit
// its runtime's modelShape gets one warning naming what is expected and an
// example. It never blocks `rig up`; a runtime without a modelShape (the
// built-ins) is never checked.

import { getRuntimeDescriptor } from "./runtime-registry.js";
import { checkModelShape } from "./runtime-capabilities.js";

interface ModelAdvisoryMember {
  id: string;
  runtime?: string;
  model?: string | null;
}
interface ModelAdvisorySpec {
  pods: Array<{ id: string; members: ModelAdvisoryMember[] }>;
}

export function modelShapeAdvisories(spec: ModelAdvisorySpec): string[] {
  const warnings: string[] = [];
  for (const pod of spec.pods) {
    for (const member of pod.members) {
      const model = typeof member.model === "string" ? member.model.trim() : "";
      if (!model || !member.runtime) continue;
      const shape = getRuntimeDescriptor(member.runtime)?.modelShape;
      if (!shape) continue;
      const result = checkModelShape(shape, model);
      if (result.ok) continue;
      warnings.push(
        `${pod.id}.${member.id}: model "${model}" does not look like a ${member.runtime} model `
        + `(expected ${result.expected}, e.g. ${result.example}); rig up continues, but the CLI may reject it`,
      );
    }
  }
  return warnings;
}
