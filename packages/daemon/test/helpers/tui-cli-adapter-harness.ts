// Hermetic harness for TUI CLI runtime adapters (adapters/cli/<id>/): a
// scriptable tmux mock, an in-memory fs, and a no-op sleep. No real CLI
// binary, tmux server, or network is ever touched.

import nodePath from "node:path";
import { vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../../src/adapters/tmux.js";
import type { CliAdapterFsOps, CliRuntimeAdapterDeps } from "../../src/adapters/cli/types.js";
import type { NodeBinding } from "../../src/domain/runtime-adapter.js";

export const HARNESS_STATE_ROOT = "/openrig-home/state";
export const HARNESS_HOME = "/home/operator";
export const HARNESS_CWD = "/work/project";
export const HARNESS_SESSION = "dev-impl@harness-rig";
export const HARNESS_NOW = new Date("2026-09-29T12:00:00.000Z");

export interface PaneFrame {
  /** pane_current_command, e.g. the CLI binary or "zsh". */
  command: string;
  content: string;
}

/** The pane before a launch: an idle shell prompt. */
export function atShell(content = "$ "): PaneFrame {
  return { command: "zsh", content };
}

export interface MockTmux {
  tmux: TmuxAdapter;
  /** Every shell command typed via sendShellCommand, in order. */
  typed: string[];
  /** Every sendText payload, in order. */
  texts: string[];
  /** Replace the pane script: frames are served in order, the last repeats. */
  setFrames(frames: PaneFrame[]): void;
  /** Make the next sendShellCommand fail. */
  failNextSend(message: string): void;
}

/** A tmux mock whose pane is a script of frames. Each getPaneCommand call
 *  advances to the next frame; capturePaneContent reads the current one. A
 *  launch reads the first frame before typing (the base refuses unless it is
 *  a shell), so launch scripts start with a shell frame (atShell()).
 *
 *  Positions model scrollback: the first frame is what was on screen before
 *  the launch, and every later frame is the output printed after it. The
 *  launch position is the first frame's last line (the prompt the command is
 *  typed on), and capturePaneFromLine returns the first frame followed by the
 *  current frame, from that line on. */
export function mockTmux(frames: PaneFrame[] = [{ command: "zsh", content: "" }], alive = true): MockTmux {
  let script = frames;
  let index = -1;
  let pendingFailure: string | null = null;
  const typed: string[] = [];
  const texts: string[] = [];
  const current = (): PaneFrame => script[Math.max(0, Math.min(index, script.length - 1))]!;
  const ok = async (): Promise<TmuxResult> => ({ ok: true });
  const tmux = {
    sendShellCommand: vi.fn(async (_target: string, command: string): Promise<TmuxResult> => {
      if (pendingFailure !== null) {
        const message = pendingFailure;
        pendingFailure = null;
        return { ok: false, code: "send_failed", message } as TmuxResult;
      }
      typed.push(command);
      return { ok: true };
    }),
    sendText: vi.fn(async (_target: string, text: string): Promise<TmuxResult> => { texts.push(text); return { ok: true }; }),
    sendKeys: vi.fn(ok),
    hasSession: vi.fn(async () => alive),
    getPaneCommand: vi.fn(async () => { index = Math.min(index + 1, script.length - 1); return current().command; }),
    capturePaneContent: vi.fn(async () => current().content),
    getPaneLinePosition: vi.fn(async () => script[0]!.content.split("\n").length - 1),
    capturePaneFromLine: vi.fn(async (_target: string, line: number) => {
      const scrollback = index <= 0 ? script[0]!.content : `${script[0]!.content}\n${current().content}`;
      return scrollback.split("\n").slice(line).join("\n");
    }),
    createSession: vi.fn(ok),
    killSession: vi.fn(ok),
    listSessions: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
  return {
    tmux,
    typed,
    texts,
    setFrames(next) { script = next; index = -1; },
    failNextSend(message) { pendingFailure = message; },
  };
}

export type MemFs = CliAdapterFsOps & { files: Record<string, string>; dirs: Set<string> };

/** In-memory fs keyed by absolute path. listFiles returns paths relative to
 *  the directory, recursively, like the node-backed implementation. */
export function memFs(files: Record<string, string> = {}): MemFs {
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, content) => { files[p] = content; },
    exists: (p) => p in files || dirs.has(p) || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    mkdirp: (p) => { dirs.add(p); },
    rename: (from, to) => {
      if (!(from in files)) throw new Error(`ENOENT: ${from}`);
      files[to] = files[from]!;
      delete files[from];
    },
    listFiles: (dir) => Object.keys(files)
      .filter((f) => f.startsWith(`${dir}/`))
      .map((f) => nodePath.relative(dir, f))
      .sort(),
  };
}

export const noSleep = async (_ms: number): Promise<void> => {};

export function harnessDeps(overrides: Partial<CliRuntimeAdapterDeps> & { tmux: TmuxAdapter; fsOps: CliAdapterFsOps }): CliRuntimeAdapterDeps {
  return {
    stateRoot: HARNESS_STATE_ROOT,
    homedir: HARNESS_HOME,
    env: {},
    sleep: noSleep,
    now: () => HARNESS_NOW,
    ...overrides,
  };
}

export function harnessBinding(overrides: Partial<NodeBinding> = {}): NodeBinding {
  return {
    id: "binding-1",
    nodeId: "node-1",
    tmuxSession: HARNESS_SESSION,
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: HARNESS_NOW.toISOString(),
    cwd: HARNESS_CWD,
    ...overrides,
  };
}
