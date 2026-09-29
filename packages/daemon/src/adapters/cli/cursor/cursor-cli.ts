// Cursor CLI (`cursor-agent`): the runtime-specific pieces of the adapter.
//
// Everything here is pure (or takes an injected read-only fs) so it can be
// tested without a real binary. Facts were verified against release
// 2026.09.28-64d2043 (`--help`, a live TUI run in an isolated tmux server with
// a throwaway HOME, unauthenticated, and the shipped JS bundle, since the CLI is
// closed source):
// - Launch `cursor-agent`, never bare `agent`: on hosts with Grok Build,
//   `agent` on PATH is Grok's symlink. `--version` prints only the release
//   ("2026.09.28-64d2043"), which is how identity is checked.
// - `--trust` writes the workspace trust marker before the interactive trust
//   modal would show; `--force`/`--yolo` do NOT skip that modal interactively.
// - `--force` (alias `--yolo`) is the auto-approve flag.
// - Chats live at <config dir>/chats/<md5(absolute cwd)>/<chat id>/store.db,
//   where the config dir is CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor,
//   else ~/.cursor. `--resume <chatId>` reopens an exact chat.
// - There is no fork flag.

import nodePath from "node:path";
import { createHash } from "node:crypto";
import type { ForkSource } from "../../../domain/runtime-adapter.js";
import type { ResolvedLaunchPosture } from "../../yolo-mode.js";

export const CURSOR_RUNTIME_ID = "cursor";
export const CURSOR_BINARY = "cursor-agent";
export const CURSOR_RESUME_TYPE = "cursor_chat_id";
export const CURSOR_GUIDANCE_FILE = "AGENTS.md";
/** Cursor discovers skills under .cursor, .claude, .codex, .grok and .agents
 *  (`skills` subdir each, from the bundle); .agents/skills is the shared
 *  cross-runtime location the Codex adapter already projects into. */
export const CURSOR_SKILLS_SUBDIR = [".agents", "skills"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TokenFormatResult = { ok: true; token: string } | { ok: false; error: string };

/** Cursor chat ids are lowercase UUIDs. The error never quotes the token. */
export function validateCursorChatId(token: string): TokenFormatResult {
  const trimmed = token.trim();
  if (!UUID_RE.test(trimmed)) {
    return { ok: false, error: "Cursor chat id must be a lowercase UUID (8-4-4-4-12 hex)." };
  }
  return { ok: true, token: trimmed };
}

// ── launch argv ─────────────────────────────────────────────────────────────

export interface CursorLaunchInput {
  model?: string | null;
  posture: ResolvedLaunchPosture;
  resumeToken?: string;
  forkSource?: ForkSource;
  /** Defaults to `cursor-agent`; a resolved absolute path is also fine. */
  binary?: string;
}

/**
 * argv for an interactive Cursor launch. Throws (refusing the launch) on a
 * fork request, a malformed token, or a bare `agent` binary.
 * - Every launch passes `--trust` (workspace trust is neutral plumbing, as the
 *   Claude adapter's hasTrustDialogAccepted provisioning is).
 * - full_bypass: `--force`. floor: no approval flag, so Cursor keeps its own
 *   allowlist default.
 */
export function buildCursorArgv(input: CursorLaunchInput): string[] {
  if (input.forkSource) {
    throw new Error("cursor has no native fork primitive; remove session_source for cursor members");
  }
  const binary = input.binary ?? CURSOR_BINARY;
  if (nodePath.basename(binary) === "agent") {
    throw new Error("cursor launch: use `cursor-agent`, not `agent` (`agent` can resolve to another CLI)");
  }
  const argv = [binary, "--trust"];
  if (input.resumeToken !== undefined) {
    const token = validateCursorChatId(input.resumeToken);
    if (!token.ok) throw new Error(`cursor resume: ${token.error}`);
    argv.push("--resume", token.token);
  }
  const model = input.model?.trim();
  if (model) {
    if (model.startsWith("-")) throw new Error("cursor launch: model must not start with '-'");
    argv.push("--model", model);
  }
  if (input.posture === "full_bypass") argv.push("--force");
  return argv;
}

// ── pane patterns (live captures and bundle strings; see test fixtures) ──────

export const CURSOR_READY_PATTERNS: readonly RegExp[] = [
  // Composer placeholder: new chat, then follow-up turns.
  /Plan, search, build anything/,
  /Add a follow-up/,
];

export const CURSOR_GATE_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string; reason: string }> = [
  {
    pattern: /Press any key to log in/,
    code: "login_required",
    reason: "cursor-agent is not signed in (run `cursor-agent login` or set CURSOR_API_KEY)",
  },
  {
    pattern: /Workspace Trust Required|Do you trust the contents of this directory\?/,
    code: "trust_gate",
    reason: "cursor-agent is asking to trust the workspace",
  },
];

// ── identity / version ──────────────────────────────────────────────────────

/** `cursor-agent --version` prints just the release, e.g. "2026.09.28-64d2043". */
export function parseCursorVersion(output: string): string | null {
  const match = output.trim().match(/^v?(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)$/);
  return match?.[1] ?? null;
}

/** null = the binary is the Cursor CLI; otherwise the reason it is not. */
export function verifyCursorVersionOutput(output: string): string | null {
  return parseCursorVersion(output)
    ? null
    : "`cursor-agent --version` did not report a Cursor CLI release; install it from https://cursor.com/docs/cli/installation";
}

// ── on-disk chat store ──────────────────────────────────────────────────────

export interface ReadOnlyFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Recursive relative file listing. */
  listFiles?(dirPath: string): string[];
}

export function cursorConfigDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const override = env.CURSOR_CONFIG_DIR?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? nodePath.join(xdg, "cursor") : nodePath.join(homedir, ".cursor");
}

/** <config dir>/chats/<md5 hex of the absolute cwd> */
export function cursorChatsDirForCwd(configDir: string, cwd: string): string {
  const digest = createHash("md5").update(nodePath.resolve(cwd)).digest("hex");
  return nodePath.join(configDir, "chats", digest);
}

/** Chat ids that have a store.db under the cwd's chats dir, sorted. */
export function listCursorChatIds(fs: ReadOnlyFs, chatsDir: string): string[] {
  try {
    if (!fs.listFiles || !fs.exists(chatsDir)) return [];
    const ids = new Set<string>();
    for (const rel of fs.listFiles(chatsDir)) {
      const parts = rel.split(/[\\/]/);
      if (parts.length === 2 && parts[1] === "store.db" && UUID_RE.test(parts[0]!)) ids.add(parts[0]!);
    }
    return [...ids].sort();
  } catch {
    return [];
  }
}

export function cursorResumeTargetExists(fs: ReadOnlyFs, chatsDir: string, chatId: string): boolean {
  const id = validateCursorChatId(chatId);
  return id.ok && fs.exists(nodePath.join(chatsDir, id.token, "store.db"));
}

/**
 * Cursor creates the chat id itself, so capture diffs the cwd's chats dir
 * against a snapshot taken just before launch. Exactly one new chat is this
 * seat's; zero (not created yet) or several (another seat in the same cwd
 * launched concurrently) return null rather than a guess.
 */
export function pickNewCursorChat(before: readonly string[], after: readonly string[]): string | null {
  const known = new Set(before);
  const fresh = after.filter((id) => !known.has(id));
  return fresh.length === 1 ? fresh[0]! : null;
}

/** Snapshot file content (seat state dir) and its tolerant parser. */
export function serializeCursorChatSnapshot(ids: readonly string[]): string {
  return `${JSON.stringify({ chatIds: [...ids] })}\n`;
}

export function parseCursorChatSnapshot(content: string): string[] | null {
  try {
    const parsed = JSON.parse(content) as { chatIds?: unknown };
    if (!Array.isArray(parsed.chatIds) || !parsed.chatIds.every((id) => typeof id === "string")) return null;
    return parsed.chatIds as string[];
  } catch {
    return null;
  }
}
