// Hermetic tests for the per-seat cline hub setup (adapters/cli/cline/hub.ts):
// the seat's hub paths, the stable preferred port, port reuse while the seat's
// own hub is alive, and the launch env that refuses to fall back to the
// shared hub.

import { describe, it, expect } from "vitest";
import {
  clineSeatHubPaths, clineSeatHubEnv, preferredClineHubPort, prepareClineSeatHub, readClineSeatHub,
  type ClineHubFs,
} from "../src/adapters/cli/cline/hub.js";

const SEAT = "/openrig-home/state/cline/dev-impl@my-rig";
const PATHS = clineSeatHubPaths(SEAT);

function memFs(files: Record<string, string> = {}): ClineHubFs & { files: Record<string, string> } {
  return {
    files,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files,
    mkdirp: () => {},
  };
}

describe("cline seat hub paths and preferred port", () => {
  it("keeps the hub's discovery file and port inside the seat state dir", () => {
    expect(PATHS).toEqual({
      dir: `${SEAT}/cline-hub`,
      discoveryFile: `${SEAT}/cline-hub/discovery.json`,
      portFile: `${SEAT}/cline-hub/port`,
    });
  });

  it("derives a stable, in-range preferred port per seat", () => {
    const a = preferredClineHubPort(SEAT);
    expect(preferredClineHubPort(SEAT)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(40_000);
    expect(a).toBeLessThan(60_000);
    expect(preferredClineHubPort("/openrig-home/state/cline/other@my-rig")).not.toBe(a);
  });
});

describe("prepareClineSeatHub", () => {
  it("allocates the seat's preferred port when no seat hub is running, and records it", async () => {
    const fs = memFs();
    const asked: number[] = [];
    const port = await prepareClineSeatHub(fs, SEAT, { allocatePort: async (preferred) => { asked.push(preferred); return preferred; } });
    expect(asked).toEqual([preferredClineHubPort(SEAT)]);
    expect(port).toBe(preferredClineHubPort(SEAT));
    expect(fs.files[PATHS.portFile]).toBe(`${port}\n`);
  });

  it("keeps the running seat hub's port on a relaunch instead of starting a second hub", async () => {
    const fs = memFs({ [PATHS.discoveryFile]: JSON.stringify({ pid: 4242, port: 47811, url: "ws://127.0.0.1:47811/hub" }) });
    const port = await prepareClineSeatHub(fs, SEAT, {
      isAlive: (pid) => pid === 4242,
      allocatePort: async () => { throw new Error("must not allocate"); },
    });
    expect(port).toBe(47811);
    expect(fs.files[PATHS.portFile]).toBe("47811\n");
  });

  it("allocates afresh when the recorded seat hub is gone or the record is unusable", async () => {
    for (const record of [JSON.stringify({ pid: 4242, port: 47811 }), "{not json", JSON.stringify({ pid: 4242, port: 80 })]) {
      const fs = memFs({ [PATHS.discoveryFile]: record });
      const port = await prepareClineSeatHub(fs, SEAT, { isAlive: () => false, allocatePort: async () => 52_000 });
      expect(port).toBe(52_000);
    }
  });

  it("rejects an invalid allocated port", async () => {
    await expect(prepareClineSeatHub(memFs(), SEAT, { allocatePort: async () => 0 })).rejects.toThrow(/invalid cline hub port/);
  });

  it("readClineSeatHub returns only a well-formed record", () => {
    expect(readClineSeatHub(memFs(), SEAT)).toBeNull();
    expect(readClineSeatHub(memFs({ [PATHS.discoveryFile]: JSON.stringify({ pid: 7, port: 47811 }) }), SEAT)).toEqual({ pid: 7, port: 47811 });
    expect(readClineSeatHub(memFs({ [PATHS.discoveryFile]: JSON.stringify({ pid: -1, port: 47811 }) }), SEAT)).toBeNull();
  });
});

describe("clineSeatHubEnv", () => {
  it("points cline at the seat's own discovery file and port", () => {
    expect(clineSeatHubEnv(memFs({ [PATHS.portFile]: "47811\n" }), SEAT)).toEqual({
      CLINE_HUB_DISCOVERY_PATH: PATHS.discoveryFile,
      CLINE_HUB_PORT: "47811",
    });
  });

  it("refuses (never falls back to the shared hub) when no valid port is recorded", () => {
    expect(() => clineSeatHubEnv(memFs(), SEAT)).toThrow(/own cline hub/);
    expect(() => clineSeatHubEnv(memFs({ [PATHS.portFile]: "not-a-port" }), SEAT)).toThrow(/own cline hub/);
  });
});
