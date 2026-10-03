export type RuntimeBrandId = "claude-code" | "codex" | "pi" | "omp" | "terminal" | "unknown";

export interface RuntimeBrand {
  id: RuntimeBrandId;
  label: string;
  shortLabel: string;
  tone: "sand" | "green" | "slate" | "violet" | "neutral";
}

const RUNTIME_BRANDS: Record<RuntimeBrandId, RuntimeBrand> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude",
    shortLabel: "Claude",
    tone: "sand",
  },
  codex: {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    tone: "green",
  },
  // OPR.0.4.6.PI1 — the Pi coding agent (earendil-works/pi), RPC-first runtime.
  pi: {
    id: "pi",
    label: "Pi",
    shortLabel: "Pi",
    tone: "slate",
  },
  omp: {
    id: "omp",
    label: "Oh My Pi",
    shortLabel: "OMP",
    tone: "violet",
  },
  terminal: {
    id: "terminal",
    label: "Terminal",
    shortLabel: "TTY",
    tone: "slate",
  },
  unknown: {
    id: "unknown",
    label: "Unknown",
    shortLabel: "Unknown",
    tone: "neutral",
  },
};

export function normalizeRuntimeBrandId(runtime: string | null | undefined): RuntimeBrandId {
  const normalized = runtime?.toLowerCase().trim() ?? "";
  if (normalized === "claude" || normalized === "claude-code" || normalized.includes("claude")) return "claude-code";
  if (normalized === "codex" || normalized.includes("codex") || normalized.includes("openai")) return "codex";
  // Exact/prefixed match only — never a bare `includes("pi")` (api/pilot/…).
  if (normalized === "pi" || normalized.startsWith("pi-")) return "pi";
  if (normalized === "omp" || normalized.startsWith("omp-") || normalized === "oh-my-pi") return "omp";
  if (normalized === "terminal" || normalized === "tmux" || normalized === "shell") return "terminal";
  return "unknown";
}

// A runtime id as the daemon registry accepts it (lowercase, digits, '-').
const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Generic brand for a runtime without a brand entry (a newly registered CLI
 *  runtime): the label comes from its id, the mark stays the neutral glyph. */
function genericRuntimeBrand(runtime: string): RuntimeBrand | null {
  const id = runtime.toLowerCase().trim();
  if (!RUNTIME_ID_RE.test(id)) return null;
  const words = id.split("-").filter(Boolean);
  return {
    id: "unknown",
    label: words.map(titleCase).join(" "),
    shortLabel: titleCase(words[0] ?? id),
    tone: "neutral",
  };
}

export function runtimeBrand(runtime: string | null | undefined): RuntimeBrand {
  const id = normalizeRuntimeBrandId(runtime);
  if (id === "unknown" && runtime) return genericRuntimeBrand(runtime) ?? RUNTIME_BRANDS.unknown;
  return RUNTIME_BRANDS[id];
}

export function formatRuntimeModel(runtime: string | null | undefined, model?: string | null): string {
  const brand = runtimeBrand(runtime);
  if (brand === RUNTIME_BRANDS.unknown) return model ?? "Runtime unknown";
  return model ? `${brand.label} / ${model}` : brand.label;
}
