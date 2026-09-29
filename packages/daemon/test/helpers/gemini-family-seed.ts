// Seed Gemini CLI / Qwen Code session stores the way the real CLIs lay them
// out on disk (gemini 0.61.0, qwen 0.24.7), through any fs with writeFile.
// Used by the adapter tests for the resume precheck and late token capture.

import nodePath from "node:path";
import { qwenProjectDirName } from "../../src/adapters/cli/gemini-family/session-store.js";

export interface SeedFs {
  writeFile(path: string, content: string): void;
  mkdirp?(path: string): void;
}

function write(fs: SeedFs, path: string, content: string): void {
  fs.mkdirp?.(nodePath.dirname(path));
  fs.writeFile(path, content);
}

/** gemini: projects.json maps cwd -> slug; the session file sits in
 *  tmp/<slug>/chats with the full id on its first line. */
export function seedGeminiSession(fs: SeedFs, input: { homedir: string; cwd: string; token: string; slug?: string }): string {
  const root = nodePath.join(input.homedir, ".gemini");
  const slug = input.slug ?? "project";
  write(fs, nodePath.join(root, "projects.json"), `${JSON.stringify({ projects: { [nodePath.resolve(input.cwd)]: slug } }, null, 2)}\n`);
  const file = nodePath.join(root, "tmp", slug, "chats", `session-2026-09-29T12-00-${input.token.slice(0, 8)}.jsonl`);
  const meta = { sessionId: input.token, projectHash: "0".repeat(64), startTime: "2026-09-29T12:00:00.000Z", lastUpdated: "2026-09-29T12:00:00.000Z", kind: "main" };
  write(fs, file, `${JSON.stringify(meta)}\n`);
  return file;
}

function qwenChats(homedir: string, cwd: string): string {
  return nodePath.join(homedir, ".qwen", "projects", qwenProjectDirName(cwd), "chats");
}

/** qwen, at launch: <id>.runtime.json (started_at in epoch seconds). */
export function seedQwenRuntimeStatus(fs: SeedFs, input: { homedir: string; cwd: string; token: string; startedAt: Date }): string {
  const file = nodePath.join(qwenChats(input.homedir, input.cwd), `${input.token}.runtime.json`);
  write(fs, file, JSON.stringify({
    schema_version: 1, pid: 4242, session_id: input.token, work_dir: nodePath.resolve(input.cwd),
    hostname: "host", started_at: input.startedAt.getTime() / 1000, qwen_version: "0.24.7",
  }, null, 2));
  return file;
}

/** qwen, on the first message: the <id>.jsonl conversation file. */
export function seedQwenConversation(fs: SeedFs, input: { homedir: string; cwd: string; token: string }): string {
  const file = nodePath.join(qwenChats(input.homedir, input.cwd), `${input.token}.jsonl`);
  write(fs, file, `${JSON.stringify({ type: "user", sessionId: input.token })}\n`);
  return file;
}
