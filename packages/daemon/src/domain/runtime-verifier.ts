import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ExecFn } from "../adapters/tmux.js";
import type { RuntimeVerification, RuntimeStatus } from "./bootstrap-types.js";
import { getRuntimeDescriptor, parseRuntimeVersion, type RuntimeDescriptor } from "./runtime-registry.js";

interface RuntimeVerifierDeps {
  exec: ExecFn;
  db: Database.Database;
}

// OPR.0.4.6.PI1: the Pi Node engine floor now lives on Pi's registry
// descriptor (its verify hook); re-exported for existing importers.
export { PI_NODE_ENGINE_FLOOR, meetsPiNodeEngineFloor } from "./runtime-registry.js";

/**
 * Verifies runtimes are usable — not just present on PATH.
 * Persists results to runtime_verifications table automatically.
 */
export class RuntimeVerifier {
  readonly db: Database.Database;
  private exec: ExecFn;

  constructor(deps: RuntimeVerifierDeps) {
    this.db = deps.db;
    this.exec = deps.exec;
  }

  /** Verify tmux: `tmux -V`, parse version from output. */
  async verifyTmux(): Promise<RuntimeVerification> {
    const result = await this.runProbe("tmux", async () => {
      const output = await this.exec("tmux -V");
      const version = this.parseVersion(output);
      if (!version) {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "unparseable version output" };
      }
      return { status: "verified" as RuntimeStatus, version, capabilitiesJson: null, error: null };
    });
    this.persist(result);
    return result;
  }

  /** Verify cmux: `cmux capabilities --json`, parse capabilities. */
  async verifyCmux(): Promise<RuntimeVerification> {
    const result = await this.runProbe("cmux", async () => {
      const output = await this.exec("cmux capabilities --json");
      const trimmed = output.trim();
      try {
        const parsed = JSON.parse(trimmed);
        const capsJson = JSON.stringify(parsed);
        return { status: "verified" as RuntimeStatus, version: null, capabilitiesJson: capsJson, error: null };
      } catch {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "invalid capabilities JSON" };
      }
    }, "degraded");
    this.persist(result);
    return result;
  }

  /** Verify Claude Code: `claude --version`, fallback to `claude --help`. */
  async verifyClaude(): Promise<RuntimeVerification> {
    return this.verifyRegistered(getRuntimeDescriptor("claude-code")!);
  }

  /** Verify Codex: `codex --version`, fallback to `codex --help`. */
  async verifyCodex(): Promise<RuntimeVerification> {
    return this.verifyRegistered(getRuntimeDescriptor("codex")!);
  }

  /** OPR.0.4.6.PI1 FR-1 — Verify Pi: `pi --version` (fallback `pi --help`)
   *  plus the Node engine floor Pi requires (>= 22.19.0), via Pi's descriptor
   *  verify hook. Provider/model resolvability is member-scoped and verified
   *  at launch, not here. */
  async verifyPi(): Promise<RuntimeVerification> {
    return this.verifyRegistered(getRuntimeDescriptor("pi")!);
  }

  /** Verify a registered runtime: the binary probe (version, then help
   *  fallback) followed by the descriptor's optional verify hook. */
  async verifyRegistered(descriptor: RuntimeDescriptor): Promise<RuntimeVerification> {
    let result = descriptor.binary
      ? await this.verifyVersionOrHelp(descriptor.binary, descriptor.id, descriptor.versionArgs)
      : this.buildVerification(descriptor.id, "not_found", null, null, `unknown runtime: ${descriptor.id}`);
    if (result.status === "not_found" && descriptor.binary && descriptor.installHint) {
      result = this.buildVerification(descriptor.id, "not_found", null, null, `${descriptor.binary} not found (install: ${descriptor.installHint})`);
    }
    if (result.status === "verified" && descriptor.verify) {
      const error = await descriptor.verify({ exec: this.exec, version: result.version });
      if (error) result = this.buildVerification(descriptor.id, "error", result.version, null, error);
    }
    this.persist(result);
    return result;
  }

  /**
   * Verify multiple runtimes. Returns results in input order.
   * @param runtimes - 'tmux', 'cmux', or any registered runtime id with a binary
   */
  async verifyAll(runtimes: string[]): Promise<RuntimeVerification[]> {
    const results: RuntimeVerification[] = [];
    for (const runtime of runtimes) {
      switch (runtime) {
        case "tmux": results.push(await this.verifyTmux()); break;
        case "cmux": results.push(await this.verifyCmux()); break;
        default: {
          const descriptor = getRuntimeDescriptor(runtime);
          if (descriptor?.binary) {
            results.push(await this.verifyRegistered(descriptor));
            break;
          }
          const v = this.buildVerification(runtime, "not_found", null, null, `unknown runtime: ${runtime}`);
          this.persist(v);
          results.push(v);
        }
      }
    }
    return results;
  }

  /**
   * Shared helper: try `{binary} --version`, fall back to `{binary} --help`.
   * Used for every registered runtime with a binary.
   */
  private async verifyVersionOrHelp(
    binary: string,
    canonicalName: string,
    versionArgs: readonly string[] = ["--version"],
  ): Promise<RuntimeVerification> {
    // Try --version first
    try {
      const output = await this.exec([binary, ...versionArgs].join(" "));
      const version = this.parseVersion(output);
      return this.buildVerification(canonicalName, "verified", version ?? null, null, null);
    } catch {
      // Fall back to --help
      try {
        await this.exec(`${binary} --help`);
        return this.buildVerification(canonicalName, "verified", null, null, null);
      } catch {
        return this.buildVerification(canonicalName, "not_found", null, null, `${binary} not found`);
      }
    }
  }

  /**
   * Run a probe with error handling. On exec failure, returns failStatus (default: not_found).
   */
  private async runProbe(
    runtime: string,
    fn: () => Promise<{ status: RuntimeStatus; version: string | null; capabilitiesJson: string | null; error: string | null }>,
    failStatus: RuntimeStatus = "not_found",
  ): Promise<RuntimeVerification> {
    try {
      const { status, version, capabilitiesJson, error } = await fn();
      return this.buildVerification(runtime, status, version, capabilitiesJson, error);
    } catch (err) {
      return this.buildVerification(runtime, failStatus, null, null, (err as Error).message);
    }
  }

  private buildVerification(
    runtime: string,
    status: RuntimeStatus,
    version: string | null,
    capabilitiesJson: string | null,
    error: string | null,
  ): RuntimeVerification {
    return {
      id: ulid(),
      runtime,
      version,
      capabilitiesJson,
      verifiedAt: new Date().toISOString(),
      status,
      error,
    };
  }

  /** Parse a semver-like version from output (e.g. "tmux 3.4" -> "3.4"). */
  private parseVersion(output: string): string | undefined {
    return parseRuntimeVersion(output);
  }

  /** Persist verification to runtime_verifications table. Upserts by runtime name. */
  private persist(v: RuntimeVerification): void {
    const existing = this.db
      .prepare("SELECT id FROM runtime_verifications WHERE runtime = ?")
      .get(v.runtime) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE runtime_verifications SET version = ?, capabilities_json = ?, verified_at = ?, status = ?, error = ? WHERE runtime = ?"
      ).run(v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error, v.runtime);
      v.id = existing.id;
    } else {
      this.db.prepare(
        "INSERT INTO runtime_verifications (id, runtime, version, capabilities_json, verified_at, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(v.id, v.runtime, v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error);
    }
  }
}
