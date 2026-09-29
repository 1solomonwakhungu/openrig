import nodePath from "node:path";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ScannedPane } from "./tmux-discovery-scanner.js";
import type { RuntimeHint, Confidence } from "./discovery-types.js";
import { listRuntimeDescriptors } from "./runtime-registry.js";

/** Evidence collected during fingerprinting */
export interface FingerprintEvidence {
  layerUsed: number;
  cmuxSignal?: { runtime: string; pid: number };
  processSignal?: { command: string; matched: string };
  paneContentSignal?: { pattern: string; matchedLine: string };
  configSignal?: { claudeDir: boolean; agentsDir: boolean };
}

/** Result of fingerprinting a single pane */
export interface FingerprintResult {
  runtimeHint: RuntimeHint;
  confidence: Confidence;
  evidence: FingerprintEvidence;
}

const SHELL_NAMES = new Set(["bash", "zsh", "fish", "sh", "dash", "tcsh", "csh"]);

const CLAUDE_PROCESS_PATTERNS = ["claude", "claude-code"];
const CODEX_PROCESS_PATTERNS = ["codex"];

const CLAUDE_PANE_PATTERNS = [
  { label: "Claude Code", test: (line: string) => /^\s*Claude Code\b/i.test(line) },
  { label: "claude>", test: (line: string) => /^\s*claude>\s*/i.test(line) },
  { label: "╭─ Claude", test: (line: string) => /^\s*╭─ Claude\b/i.test(line) },
];

const CODEX_PANE_PATTERNS = [
  { label: "Codex CLI", test: (line: string) => /^\s*Codex CLI\b/i.test(line) },
  { label: "codex>", test: (line: string) => /^\s*codex>\s*/i.test(line) },
  { label: "╭─ Codex", test: (line: string) => /^\s*╭─ Codex\b/i.test(line) },
];

/**
 * Four-layer runtime detection pipeline.
 * Layer 0: cmux agent PID (highest confidence)
 * Layer 1: Process tree / active command (high)
 * Layer 2: Pane content heuristics (medium)
 * Layer 3: CWD/config context (low-medium, boost only)
 */
export class SessionFingerprinter {
  private cmux: CmuxAdapter;
  private tmux: TmuxAdapter;
  private fsExists: (path: string) => boolean;
  private cachedAgentPIDs: Map<number, { runtime: string; pid: number }> | null = null;

  constructor(deps: {
    cmuxAdapter: CmuxAdapter;
    tmuxAdapter: TmuxAdapter;
    fsExists: (path: string) => boolean;
    /** Process census for registered runtimes' processMatch (ps). Absent =
     *  processMatch is skipped. Only consulted when a registered runtime
     *  declares processMatch and the pane command did not already decide. */
    listProcesses?: ProcessLister;
  }) {
    this.cmux = deps.cmuxAdapter;
    this.tmux = deps.tmuxAdapter;
    this.fsExists = deps.fsExists;
    this.listProcesses = deps.listProcesses;
  }

  private listProcesses: ProcessLister | undefined;
  private processCache: { at: number; rows: ProcessRow[] } | null = null;

  /** One census per 2s window, so a scan over many panes spawns one ps. */
  private async processRows(): Promise<ProcessRow[]> {
    if (!this.listProcesses) return [];
    const now = Date.now();
    if (this.processCache && now - this.processCache.at < 2000) return this.processCache.rows;
    let rows: ProcessRow[] = [];
    try { rows = await this.listProcesses(); } catch { rows = []; }
    this.processCache = { at: now, rows };
    return rows;
  }

  /** Pre-fetch cmux agent PIDs for batch use. Call before fingerprinting multiple panes. */
  async refreshCmuxSignals(): Promise<void> {
    const result = await this.cmux.queryAgentPIDs();
    this.cachedAgentPIDs = result.ok ? result.data : null;
  }

  /** Fingerprint a single scanned pane. */
  async fingerprint(pane: ScannedPane): Promise<FingerprintResult> {
    const evidence: FingerprintEvidence = { layerUsed: -1 };

    // --- Layer 0: cmux agent PID ---
    if (this.cachedAgentPIDs === null) {
      await this.refreshCmuxSignals();
    }

    if (this.cachedAgentPIDs && pane.pid) {
      const cmuxMatch = this.cachedAgentPIDs.get(pane.pid);
      if (cmuxMatch) {
        evidence.layerUsed = 0;
        evidence.cmuxSignal = cmuxMatch;
        const hint = cmuxMatch.runtime.includes("claude") ? "claude-code" as RuntimeHint
          : cmuxMatch.runtime.includes("codex") ? "codex" as RuntimeHint
          : "unknown" as RuntimeHint;
        return { runtimeHint: hint, confidence: "highest", evidence };
      }
    }

    // --- Layer 1: Process tree / active command ---
    if (pane.activeCommand) {
      const cmd = pane.activeCommand.toLowerCase();

      for (const pattern of CLAUDE_PROCESS_PATTERNS) {
        if (cmd.includes(pattern)) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: pane.activeCommand, matched: pattern };
          return { runtimeHint: "claude-code", confidence: "high", evidence };
        }
      }

      for (const pattern of CODEX_PROCESS_PATTERNS) {
        if (cmd.includes(pattern)) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: pane.activeCommand, matched: pattern };
          return { runtimeHint: "codex", confidence: "high", evidence };
        }
      }

      // Registered runtimes (adapters/cli/) declare exact foreground process
      // names. Built-ins keep their pattern tables above.
      const registered = registeredRuntimeForCommand(cmd);
      if (registered) {
        evidence.layerUsed = 1;
        evidence.processSignal = { command: pane.activeCommand, matched: registered.command };
        return { runtimeHint: registered.id, confidence: "high", evidence };
      }

      // processMatch: CLIs whose pane command is a generic host ("node" for
      // npm-installed CLIs) are identified by the argv of the pane's process
      // tree. "node" alone never identifies a runtime.
      if (pane.pid && !SHELL_NAMES.has(cmd)) {
        const byProcess = await this.registeredRuntimeForProcessTree(pane.pid);
        if (byProcess) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: byProcess.command, matched: byProcess.id };
          return { runtimeHint: byProcess.id, confidence: "high", evidence };
        }
      }

      if (SHELL_NAMES.has(cmd)) {
        evidence.layerUsed = 1;
        evidence.processSignal = { command: pane.activeCommand, matched: "shell" };
        return { runtimeHint: "terminal", confidence: "high", evidence };
      }
    }

    // --- Layer 2: Pane content heuristics ---
    const content = await this.tmux.capturePaneContent(pane.tmuxPane);
    if (content) {
      const lines = content.split("\n");

      for (const line of lines) {
        for (const pattern of CLAUDE_PANE_PATTERNS) {
          if (pattern.test(line)) {
            evidence.layerUsed = 2;
            evidence.paneContentSignal = { pattern: pattern.label, matchedLine: line.trim() };
            return { runtimeHint: "claude-code", confidence: "medium", evidence };
          }
        }

        for (const pattern of CODEX_PANE_PATTERNS) {
          if (pattern.test(line)) {
            evidence.layerUsed = 2;
            evidence.paneContentSignal = { pattern: pattern.label, matchedLine: line.trim() };
            return { runtimeHint: "codex", confidence: "medium", evidence };
          }
        }
      }
    }

    // --- Layer 3: CWD/config context (boost only) ---
    let configBoost: RuntimeHint = "unknown";
    if (pane.cwd) {
      const hasClaudeDir = this.fsExists(`${pane.cwd}/.claude`);
      const hasAgentsDir = this.fsExists(`${pane.cwd}/.agents`);
      evidence.configSignal = { claudeDir: hasClaudeDir, agentsDir: hasAgentsDir };

      if (hasClaudeDir && !hasAgentsDir) configBoost = "claude-code";
      else if (hasAgentsDir && !hasClaudeDir) configBoost = "codex";
    }

    if (configBoost !== "unknown") {
      evidence.layerUsed = 3;
      return { runtimeHint: configBoost, confidence: "low", evidence };
    }

    // --- No signal ---
    evidence.layerUsed = -1;
    return { runtimeHint: "unknown", confidence: "low", evidence };
  }

  private async registeredRuntimeForProcessTree(panePid: number): Promise<{ id: string; command: string } | null> {
    const matchers = listRuntimeDescriptors().filter((d) => d.kind === "agent" && d.processMatch && !PATTERN_TABLE_RUNTIMES.has(d.id));
    if (matchers.length === 0) return null;
    const rows = await this.processRows();
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const tree: ProcessRow[] = [];
    const queue = [panePid];
    const seen = new Set<number>();
    while (queue.length > 0 && tree.length < 256) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const self = rows.find((row) => row.pid === pid);
      if (self) tree.push(self);
      for (const child of children.get(pid) ?? []) queue.push(child.pid);
    }
    for (const descriptor of matchers) {
      const hit = tree.find((row) => processMatches(row.command, descriptor.processMatch!));
      if (hit) return { id: descriptor.id, command: hit.command };
    }
    return null;
  }
}

const PATTERN_TABLE_RUNTIMES = new Set(["claude-code", "codex"]);

/** Exact paneCommands match against registered non-built-in runtimes. */
function registeredRuntimeForCommand(cmd: string): { id: string; command: string } | null {
  for (const descriptor of listRuntimeDescriptors()) {
    if (PATTERN_TABLE_RUNTIMES.has(descriptor.id) || descriptor.kind !== "agent") continue;
    const command = descriptor.paneCommands?.find((name) => name.toLowerCase() === cmd);
    if (command) return { id: descriptor.id, command };
  }
  return null;
}

interface ProcessRow { pid: number; ppid: number; command: string }
type ProcessLister = () => ProcessRow[] | Promise<ProcessRow[]>;

/** Interpreters whose first script argument, not the interpreter, is the
 *  program: node/bun/deno/ruby/python/pypy with an optional version suffix
 *  (node22, python3.12) in any case (macOS framework builds run as "Python"). */
const SCRIPT_HOST_RE = /^(?:node|nodejs|bun|deno|ruby|python|pypy)(?:\d+(?:\.\d+)*)?$/i;

/**
 * Match a descriptor's processMatch against one ps command line, anchored to
 * the program: argv[0], or the script path when argv[0] is an interpreter
 * ("node /usr/lib/node_modules/@github/copilot/index.js"). Other arguments
 * never count, so `vim gemini-notes.md` cannot match "gemini". A string
 * matches a path by its basename or a trailing or inner path segment run
 * ("@github/copilot"); a RegExp is tested against each program path.
 */
export function processMatches(command: string, match: string | RegExp): boolean {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return false;
  const programs = [argv[0]!];
  if (SCRIPT_HOST_RE.test(nodePath.basename(argv[0]!))) {
    const script = argv.slice(1).find((arg) => !arg.startsWith("-"));
    if (script) programs.push(script);
  }
  return programs.some((program) => {
    if (typeof match !== "string") return match.test(program);
    const anchored = `/${program.replace(/^\/+/, "")}`;
    return nodePath.basename(program) === match || anchored.endsWith(`/${match}`) || anchored.includes(`/${match}/`);
  });
}
