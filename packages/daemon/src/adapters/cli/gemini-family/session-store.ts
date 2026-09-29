// Read-only lookups into the on-disk session stores of Gemini CLI and Qwen
// Code. Used for the resume precheck (a missing session is refused before
// anything is typed, never silently started fresh) and for capturing the
// child id of a qwen fork, which qwen picks at random.
//
// Layouts (source of gemini 0.61.0 and qwen 0.24.7):
// - gemini: <GEMINI_CLI_HOME or home>/.gemini/tmp/<slug>/chats/
//   session-<YYYY-MM-DDTHH-MM>-<id first 8>.jsonl, first line
//   {"sessionId": "<full id>", ...}. <slug> comes from the cwd -> slug map in
//   <root>/projects.json (written on first launch in that cwd).
// - qwen: <runtime base>/projects/<cwd with [^A-Za-z0-9] -> "-">/chats/
//   <id>.jsonl (created on the first message) and <id>.runtime.json
//   (written at launch: session_id, work_dir, started_at in epoch seconds,
//   pid). The runtime base is QWEN_RUNTIME_DIR, else settings
//   advanced.runtimeOutputDir, else QWEN_HOME, else ~/.qwen.
//
// Every function here reads only and never throws: an unreadable or
// unparseable file counts as "not found".

import nodePath from "node:path";

export interface SessionStoreFs {
  readFile(path: string): string;
  exists(path: string): boolean;
  /** Recursive relative file listing; absent = listing unsupported. */
  listFiles?(dirPath: string): string[];
}

export interface SessionStoreContext {
  cwd: string;
  homedir: string;
  fs: SessionStoreFs;
  /** Environment the CLI runs with (defaults to process.env at call sites). */
  env: NodeJS.ProcessEnv;
}

export type ResumeTargetCheck = { ok: true } | { ok: false; reason: string };

function readJson(fs: SessionStoreFs, path: string): unknown {
  try {
    if (!fs.exists(path)) return undefined;
    return JSON.parse(fs.readFile(path));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(path: string, homedir: string): string {
  if (path === "~") return homedir;
  if (path.startsWith("~/")) return nodePath.join(homedir, path.slice(2));
  return path;
}

// ── Gemini ───────────────────────────────────────────────────────────────────

export function geminiRoot(ctx: Pick<SessionStoreContext, "homedir" | "env">): string {
  const home = ctx.env.GEMINI_CLI_HOME?.trim() || ctx.homedir;
  return nodePath.join(home, ".gemini");
}

/** The chats dir gemini uses for `cwd`, or null when gemini has never run there. */
export function geminiChatsDir(ctx: SessionStoreContext): string | null {
  const root = geminiRoot(ctx);
  const registry = readJson(ctx.fs, nodePath.join(root, "projects.json"));
  if (!isRecord(registry) || !isRecord(registry.projects)) return null;
  const slug = registry.projects[nodePath.resolve(ctx.cwd)];
  if (typeof slug !== "string" || !/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  return nodePath.join(root, "tmp", slug, "chats");
}

/** Absolute path of the gemini session file for `sessionId`, or null. */
export function findGeminiSessionFile(ctx: SessionStoreContext, sessionId: string): string | null {
  const chatsDir = geminiChatsDir(ctx);
  if (!chatsDir || !ctx.fs.listFiles) return null;
  let files: string[];
  try {
    if (!ctx.fs.exists(chatsDir)) return null;
    files = ctx.fs.listFiles(chatsDir);
  } catch {
    return null;
  }
  const suffix = new RegExp(`^session-[0-9T-]+-${sessionId.slice(0, 8)}\\.jsonl?$`, "i");
  for (const name of files) {
    if (name.includes("/") || !suffix.test(name)) continue;
    const path = nodePath.join(chatsDir, name);
    try {
      const firstLine = ctx.fs.readFile(path).split("\n", 1)[0] ?? "";
      const meta: unknown = JSON.parse(firstLine);
      if (isRecord(meta) && typeof meta.sessionId === "string" && meta.sessionId.toLowerCase() === sessionId.toLowerCase()) {
        return path;
      }
    } catch {
      // Not a JSONL metadata line; keep looking.
    }
  }
  return null;
}

/** A model reply in the session file. gemini writes the file at launch but
 *  only resumes a session with a real exchange (chatRecordingService
 *  hasResumableContent); the injected session-context user message alone does
 *  not count, and a model reply only follows a real prompt. */
const GEMINI_MODEL_REPLY_RE = /"type"\s*:\s*"gemini"/;

/** Whether gemini can resume `sessionId` from this cwd: the session file
 *  exists and holds a model reply. */
export function geminiSessionIsResumable(ctx: SessionStoreContext, sessionId: string): boolean {
  const path = findGeminiSessionFile(ctx, sessionId);
  if (!path) return false;
  try {
    return GEMINI_MODEL_REPLY_RE.test(ctx.fs.readFile(path));
  } catch {
    return false;
  }
}

/** Resume precheck. The same test as late capture, so a seat whose token was
 *  captured is also one this accepts. gemini itself still guards with
 *  "Error resuming session:" (pane error pattern, retry_fresh). */
export function checkGeminiResumeTarget(ctx: SessionStoreContext, sessionId: string): ResumeTargetCheck {
  if (geminiSessionIsResumable(ctx, sessionId)) return { ok: true };
  return { ok: false, reason: "gemini has no resumable session with that id for this cwd (no stored exchange)" };
}

// ── Qwen ─────────────────────────────────────────────────────────────────────

/** Candidate runtime bases, most specific first. All are checked so a daemon
 *  env that differs from the pane env does not cause a false refusal. */
export function qwenRuntimeBases(ctx: SessionStoreContext): string[] {
  const bases: string[] = [];
  // Relative values resolve against the project cwd, as qwen's Storage does.
  const add = (path: string | undefined) => {
    const trimmed = path?.trim();
    if (trimmed) {
      const resolved = nodePath.resolve(ctx.cwd, expandHome(trimmed, ctx.homedir));
      if (!bases.includes(resolved)) bases.push(resolved);
    }
  };
  add(ctx.env.QWEN_RUNTIME_DIR);
  const qwenHome = ctx.env.QWEN_HOME?.trim() || nodePath.join(ctx.homedir, ".qwen");
  const settings = readJson(ctx.fs, nodePath.join(expandHome(qwenHome, ctx.homedir), "settings.json"));
  if (isRecord(settings) && isRecord(settings.advanced) && typeof settings.advanced.runtimeOutputDir === "string") {
    add(settings.advanced.runtimeOutputDir);
  }
  add(qwenHome);
  add(nodePath.join(ctx.homedir, ".qwen"));
  return bases;
}

/** qwen's sanitizeCwd (POSIX; Windows is not an OpenRig host). */
export function qwenProjectDirName(cwd: string): string {
  return nodePath.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

export function qwenChatsDirs(ctx: SessionStoreContext): string[] {
  const project = qwenProjectDirName(ctx.cwd);
  return qwenRuntimeBases(ctx).map((base) => nodePath.join(base, "projects", project, "chats"));
}

/** Absolute path of the qwen conversation file for `sessionId`, or null. */
export function findQwenSessionFile(ctx: SessionStoreContext, sessionId: string): string | null {
  const id = sessionId.toLowerCase();
  for (const dir of qwenChatsDirs(ctx)) {
    const path = nodePath.join(dir, `${id}.jsonl`);
    try {
      if (ctx.fs.exists(path)) return path;
    } catch {
      // Unreadable candidate; try the next base.
    }
  }
  return null;
}

/** Resume precheck: qwen writes <id>.jsonl on the first message, so a seat
 *  that never received one has nothing to resume. */
export function checkQwenResumeTarget(ctx: SessionStoreContext, sessionId: string): ResumeTargetCheck {
  if (findQwenSessionFile(ctx, sessionId)) return { ok: true };
  return { ok: false, reason: "qwen has no stored conversation with that id for this cwd" };
}

/** runtime.json started_at is epoch seconds (a float) in qwen 0.24.7; an ISO
 *  string is accepted too in case a later release switches. */
function parseStartedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

/** Clock skew tolerated between the daemon's launch timestamp and qwen's. */
const FORK_CAPTURE_SKEW_MS = 5_000;

/**
 * The child session id of a `qwen --resume <parent> --fork-session` launch:
 * the one runtime.json in this cwd's chats dir started at or after the launch
 * and not the parent (when known; the parent's runtime.json predates the
 * launch anyway). Returns null when zero or several candidates match (a
 * pod-mate launching in the same cwd after this seat), never a guess.
 */
export function captureQwenForkChild(
  ctx: SessionStoreContext,
  input: { parentId?: string; launchStartedAt: Date },
): string | null {
  const parent = input.parentId?.toLowerCase();
  const since = input.launchStartedAt.getTime() - FORK_CAPTURE_SKEW_MS;
  const cwd = nodePath.resolve(ctx.cwd);
  const found = new Set<string>();
  for (const dir of qwenChatsDirs(ctx)) {
    if (!ctx.fs.listFiles) break;
    let files: string[];
    try {
      if (!ctx.fs.exists(dir)) continue;
      files = ctx.fs.listFiles(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (name.includes("/") || !name.endsWith(".runtime.json")) continue;
      const status = readJson(ctx.fs, nodePath.join(dir, name));
      if (!isRecord(status)) continue;
      const id = typeof status.session_id === "string" ? status.session_id.toLowerCase() : "";
      const startedAt = parseStartedAt(status.started_at);
      const workDir = typeof status.work_dir === "string" ? nodePath.resolve(status.work_dir) : "";
      if (!id || id === parent || workDir !== cwd || !(startedAt >= since)) continue;
      // The fork copies the parent history into <child>.jsonl; without it the
      // child is not resumable, so it is not reported.
      if (!findQwenSessionFile(ctx, id)) continue;
      found.add(id);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}
