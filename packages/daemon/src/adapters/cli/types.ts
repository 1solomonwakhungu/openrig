// Registration contract for third-party CLI runtimes (adapters/cli/<id>/).
//
// Type-only imports: domain/runtime-registry.ts imports the registration index
// at runtime, so modules under adapters/cli/ must not import the registry at
// runtime (see the import discipline note in runtime-registry.ts).

import type { TmuxAdapter } from "../tmux.js";
import type { RuntimeAdapter, RuntimeResumeAdapter } from "../../domain/runtime-adapter.js";
import type { RuntimeDescriptor } from "../../domain/runtime-registry.js";

/** Node-backed file operations handed to CLI adapters (see node-fs-ops.ts). */
export interface CliAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  /** Recursive relative file listing; absent = listing unsupported. */
  listFiles?(dirPath: string): string[];
  /** Atomic replace; required by owner-config writes (owner-config.ts). */
  rename?(from: string, to: string): void;
  /** Resolve symlinks; owner-config writes follow a linked dotfile. */
  realpath?(path: string): string;
  /** File mode; owner-config writes keep it across the atomic replace. */
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export interface CliRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: CliAdapterFsOps;
  /** Root for per-seat runtime state: <OPENRIG_HOME>/state. A runtime keeps
   *  its own seats under <stateRoot>/<runtime id>/. */
  stateRoot: string;
  homedir: string;
  /** Environment for the YOLO/posture decision. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** A CLI runtime serves both the launch contract and restore-time resume. */
export type CliRuntimeAdapter = RuntimeAdapter & RuntimeResumeAdapter;

export interface CliRuntimeRegistration {
  descriptor: RuntimeDescriptor;
  createAdapter(deps: CliRuntimeAdapterDeps): CliRuntimeAdapter;
}
