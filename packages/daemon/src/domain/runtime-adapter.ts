import type { Binding, StartupFile } from "./types.js";
import type { ProjectionPlan } from "./projection-planner.js";

// -- Bridge type: NodeBinding extends Binding with cwd --
// Interim repo type. The current repo only has Binding in types.ts.
// The startup orchestrator (AS-T07) constructs NodeBinding from Binding + node.cwd.

export interface NodeBinding extends Binding {
  cwd: string;
  model?: string;
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 Seam B: the seat's RESOLVED launch posture from its permission_policy
   * attachment (member > rig precedence, resolved by the core resolver at materialize /
   * restore). Absent = no policy attached → the env-driven floor/YOLO decision stands.
   * Present = authoritative for this seat (overrides the env read in BOTH directions). */
  launchPosture?: "floor" | "full_bypass";
  /** Explicit Claude native mode; checked against the bound managed executable. */
  permissionMode?: string;
  /** Reserved successor generation; current tenure remains the input fence until commit. */
  launchGeneration?: string;
  /** #25: the rig's `managed_blocks.claude-code` file. Absent = CLAUDE.md. Only the Claude adapter reads it. */
  claudeManagedBlockFile?: import("./managed-blocks.js").ClaudeManagedBlockFile;
}

// -- Resolved startup file with source-root provenance --

export interface ResolvedStartupFile {
  path: string;
  absolutePath: string;
  ownerRoot: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
  /** Optional discriminator; startup artifacts are files only. */
  kind?: "file";
}

// -- Adapter result types --

export interface InstalledResource {
  effectiveId: string;
  category: string;
  installedPath: string;
}

export interface ProjectionResult {
  projected: string[];
  skipped: string[];
  failed: Array<{ effectiveId: string; error: string }>;
}

export interface StartupDeliveryResult {
  delivered: number;
  failed: Array<{ path: string; error: string }>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  code?: string;
}

export const ATTENTION_REQUIRED_READINESS_CODES = new Set([
  "trust_gate",
  "hook_trust_gate",
  "update_gate",
  "login_required",
  "mcp_gate",
  // Codex auth refusal (stored OAuth token can no longer be refreshed).
  // Defensive: row 6's verifyResumeLaunch patch propagates attention_required
  // through the launch path so the readiness fallback shouldn't see this code,
  // but adding it here keeps the two paths semantically aligned.
  "codex_auth_refusal",
  "codex_client_incompatible",
  // A CLI's first-run or startup dialog (gemini/qwen) that needs an operator.
  "startup_dialog",
  // A CLI began updating the operator's install through a package manager
  // OpenRig does not contain (gemini/qwen): the operator should check it.
  "self_update",
]);

export function isAttentionRequiredReadinessCode(code: string | undefined): boolean {
  return !!code && ATTENTION_REQUIRED_READINESS_CODES.has(code);
}

// -- Harness launch result --

export type HarnessLaunchRecovery = "retry_fresh" | "attention_required";

export type HarnessLaunchResult =
  | { ok: true; resumeToken?: string; resumeType?: string; appliedLaunch?: import("./permission-drift.js").AppliedLaunchObservation }
  // `evidence` carries the last-N pane lines for `attention_required` outcomes
  // so the failure can flow honest evidence through to RestoreNodeResult's
  // attentionEvidence field. Omitted for non-attention recoveries.
  | { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence?: string };

// -- Shared concrete-hint resolver --

/**
 * Resolve 'auto' delivery hint to a concrete hint.
 * Single source of truth — used by both the startup partition and adapter delivery.
 * Rules match existing adapter logic byte-for-byte.
 */
export function resolveConcreteHint(
  path: string,
  content: string,
): "guidance_merge" | "skill_install" | "send_text" {
  if (path.endsWith("SKILL.md") || content.startsWith("# SKILL")) return "skill_install";
  if (path.endsWith(".md")) return "guidance_merge";
  return "send_text";
}

// -- Runtime adapter contract --

/**
 * Member-level fork-source input translated by the startup orchestrator from
 * the rigspec member's `sessionSource` field. v1 narrow MVP: kind="native_id"
 * only; other shapes are rejected at schema validation today.
 *
 * Adapters that support fork (claude-code, codex) build their respective
 * fork command from this input and capture the NEW post-fork token, never
 * the parent. Adapters that don't support fork (terminal) refuse with a
 * clear runtime-mismatch error.
 */
export interface ForkSource {
  kind: "native_id" | "artifact_path" | "name" | "last";
  value?: string;
}

/**
 * The five-method runtime adapter contract.
 * Adapters own projection, delivery, harness launch, reconciliation, and readiness.
 * Startup action execution is NOT part of this contract — that belongs
 * to the startup orchestrator after checkReady().
 */
export interface RuntimeAdapter {
  /** Claude's managed capability/launch seam, shared with seat selection. */
  readonly claudeManagedLaunch?: import("./claude-managed-launch.js").ClaudeManagedLaunch;
  readonly runtime: string;
  /** The file an adapter's project() writes for a skill when it lives outside
   *  the Claude project tree, for "already in place" detection. Absent = the
   *  instantiator's default target. */
  skillTargetPath?(tmuxSession: string | null, effectiveId: string): string | null;

  /** List currently installed/projected resources for a node. */
  listInstalled(binding: NodeBinding): Promise<InstalledResource[]>;

  /** Project resources from a projection plan to the runtime target locations. */
  project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult>;

  /** Deliver startup files to the runtime. */
  deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult>;

  /**
   * Launch the harness (claude/codex/terminal) inside the tmux session.
   *
   * `resumeToken` and `forkSource` are mutually exclusive. If both are
   * provided, adapters MUST refuse with a clear error rather than guess.
   * `forkSource` triggers a fork from the named source; the captured
   * resumeToken in the result is the NEW post-fork token, never the parent.
   */
  launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult>;

  /** Check if the runtime harness is responsive and ready. */
  checkReady(binding: NodeBinding): Promise<ReadinessResult>;

  /** Optional (F1, feature 2): the seat's activity read from its pane, for
   *  registry runtimes. Null = no confident read; callers keep their generic
   *  source. claude-code, codex, and pi keep their existing activity sources. */
  classifyActivity?(binding: NodeBinding): Promise<import("./runtime-capabilities.js").RuntimeActivityState | null>;
}

// -- Restore-time resume contract --

/** Everything the restore orchestrator knows when it resumes a seat. Each
 *  adapter reads the fields its runtime understands and ignores the rest. */
export interface RuntimeResumeRequest {
  nodeId: string;
  sessionName: string;
  resumeType: string | null;
  resumeToken: string | null;
  cwd: string;
  codexConfigProfile?: string | null;
  model?: string | null;
  resolvedPosture?: "floor" | "full_bypass";
  permissionMode?: string;
}

export type RuntimeResumeResult =
  | { ok: true; appliedLaunch?: import("./permission-drift.js").AppliedLaunchObservation }
  | { ok: false; code: "attention_required"; message: string; evidence?: string }
  | { ok: false; code: string; message: string };

/**
 * A runtime's restore-time resume adapter. The restore orchestrator walks its
 * registered resume adapters in order and uses the first whose canResume()
 * accepts the persisted (resumeType, resumeToken) pair. `code: "retry_fresh"`
 * maps to the awaiting-decision stop-and-ask; `code: "attention_required"`
 * maps to an attention outcome carrying `evidence`.
 */
export interface RuntimeResumeAdapter {
  readonly runtime: string;
  canResume(resumeType: string | null, resumeToken: string | null): boolean;
  resume(request: RuntimeResumeRequest): Promise<RuntimeResumeResult>;
}
