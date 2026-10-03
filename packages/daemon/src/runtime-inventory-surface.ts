// Narrow public surface for the runtime inventory (feature 6), so `rig runtimes`,
// `rig doctor`, and `rig setup` read the same rows the daemon's registry defines.
// Lane rule: exports map + dist + cli tsconfig paths, all three. Re-export only.
export * from "./domain/runtime-inventory.js";
