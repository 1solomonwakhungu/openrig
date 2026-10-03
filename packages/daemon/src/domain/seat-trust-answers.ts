// Visible trust answers: the dialogs OpenRig answered for a seat's current
// launch (TuiCliGateAnswer), read from the launch record the TUI CLI base
// writes in the seat state dir. Shared by seat status, whoami, and rig ps.

import { readLaunchRecord } from "./runtime-capture.js";
import { runtimeSeatStateDir } from "./runtime-registry.js";

export interface SeatTrustAnswer {
  /** The gate's readiness code, e.g. "trust_gate". */
  code: string;
  /** The option OpenRig chose, e.g. "Yes". */
  option: string;
  /** What the answer means, from the runtime adapter. */
  describe: string;
  answeredAt: string;
  /** The seat cwd the dialog named (the launch record's cwd). */
  folder: string | null;
  runtime: string;
  /** One line for people, e.g. "OpenRig trusted /repo for this session (copilot)". */
  summary: string;
}

/** Answers recorded for the seat's current launch only: the record must name
 *  this session (launch.json is rewritten on every launch). Never throws; an
 *  absent or unreadable record means no answers. */
export function readSeatTrustAnswers(runtime: string | null, sessionName: string | null, stateRoot?: string): SeatTrustAnswer[] {
  if (!runtime || !sessionName) return [];
  let record: ReturnType<typeof readLaunchRecord>;
  try {
    record = readLaunchRecord(runtimeSeatStateDir(runtime, sessionName, stateRoot));
  } catch {
    return [];
  }
  if (!record || record.sessionName !== sessionName || !Array.isArray(record.gateAnswers)) return [];
  const folder = typeof record.cwd === "string" ? record.cwd : null;
  return record.gateAnswers
    .filter((a) => a && typeof a.code === "string" && typeof a.option === "string")
    .map((a) => ({
      code: a.code,
      option: a.option,
      describe: typeof a.describe === "string" ? a.describe : "",
      answeredAt: typeof a.answeredAt === "string" ? a.answeredAt : "",
      folder,
      runtime,
      summary: a.code === "trust_gate"
        ? `OpenRig trusted ${folder ?? "the seat folder"} for this session (${runtime})`
        : `OpenRig answered ${a.code} with "${a.option}" for this session (${runtime})`,
    }));
}
