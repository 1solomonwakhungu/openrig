// Cline's native transcript reader (feature 5). The fixture follows the
// record cline 3.0.65 writes (persistSessionMessages: { version, updated_at,
// agent, sessionId, origin, messages, system_prompt }), synthesized from the
// bundle's writer and reader, not captured from a live session.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLINE_TRANSCRIPT_MAX_BYTES, CLINE_TRANSCRIPT_SOURCE, clineMessagesPath, parseClineMessages, readClineTranscript,
} from "../src/adapters/cli/cline/transcript.js";
import { CLINE_DESCRIPTOR } from "../src/adapters/cli/cline/index.js";
import { createNodeFsOps } from "../src/adapters/node-fs-ops.js";

const SID = "1790997600000_abcde";
const RECORD = fs.readFileSync(nodePath.join(__dirname, "fixtures", "cline-sessions", `${SID}.messages.json`), "utf-8");

describe("parseClineMessages", () => {
  it("maps text, tool calls, and tool results, and leaves thinking out", () => {
    expect(parseClineMessages(RECORD)).toEqual([
      { role: "user", text: "Add a health check to the API." },
      { role: "assistant", text: "I will add GET /health.", at: "2026-10-03T03:20:01.000Z" },
      { role: "tool", text: 'write_to_file({"path":"src/health.ts","content":"export const ok = true;"})', at: "2026-10-03T03:20:01.000Z" },
      { role: "tool", text: "File written." },
      { role: "assistant", text: "Done. The route returns 200.", at: "2026-10-03T03:20:05.000Z" },
    ]);
    expect(JSON.stringify(parseClineMessages(RECORD))).not.toContain("plan the change");
  });

  it("accepts the bare-array form cline's reader also accepts, and refuses non-records", () => {
    const messages = JSON.parse(RECORD).messages;
    expect(parseClineMessages(JSON.stringify(messages))).toEqual(parseClineMessages(RECORD));
    expect(parseClineMessages("not json")).toBeNull();
    expect(parseClineMessages('{"version":1}')).toBeNull();
  });

  it("caps long tool inputs and marks tool errors", () => {
    const record = JSON.stringify({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "execute_command", input: { command: "x".repeat(1000) } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "permission denied" }] },
    ] });
    const [call, result] = parseClineMessages(record)!;
    expect(call!.text.length).toBeLessThan(340);
    expect(call!.text.endsWith("...)")).toBe(true);
    expect(result).toEqual({ role: "tool", text: "error: permission denied" });
  });
});

describe("readClineTranscript", () => {
  let root: string | null = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

  function store(): string {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-cline-tx-"));
    const dir = nodePath.join(root, SID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(clineMessagesPath(root, SID), RECORD);
    fs.writeFileSync(nodePath.join(dir, `${SID}.json`), JSON.stringify({
      version: 1, session_id: SID, source: "cli", interactive: true, cwd: "/work/api", started_at: "2026-10-03T03:20:00.000Z",
    }));
    return root;
  }
  const size = (path: string) => { try { return fs.statSync(path).size; } catch { return null; } };

  it("reads the seat's session by its resume token", () => {
    const sessionsDir = store();
    const transcript = readClineTranscript({ fs: createNodeFsOps(), fileSize: size, sessionsDir, resumeToken: SID, cwd: null });
    expect(transcript?.source).toBe(CLINE_TRANSCRIPT_SOURCE);
    expect(transcript?.entries).toHaveLength(5);
  });

  it("without a token, reads the one session this launch created (capture's attribution)", () => {
    const sessionsDir = store();
    const input = { fs: createNodeFsOps(), fileSize: size, sessionsDir, resumeToken: null, cwd: "/work/api" };
    expect(readClineTranscript({ ...input, launchStartedAt: new Date("2026-10-03T03:19:59.000Z") })?.entries).toHaveLength(5);
    expect(readClineTranscript({ ...input, launchStartedAt: new Date("2026-10-03T04:00:00.000Z") })).toBeNull();
    expect(readClineTranscript({ ...input, cwd: "/work/other", launchStartedAt: new Date("2026-10-03T03:19:59.000Z") })).toBeNull();
    expect(readClineTranscript(input)).toBeNull();
  });

  it("filters by since, and returns null for a missing, oversized, or malformed record", () => {
    const sessionsDir = store();
    const base = { fs: createNodeFsOps(), fileSize: size, sessionsDir, resumeToken: SID, cwd: null };
    expect(readClineTranscript({ ...base, since: new Date("2026-10-03T03:20:03.000Z") })?.entries.map((e) => e.text))
      .toEqual(["Add a health check to the API.", "File written.", "Done. The route returns 200."]);
    expect(readClineTranscript({ ...base, resumeToken: "1790997600001_zzzzz" })).toBeNull();
    expect(readClineTranscript({ ...base, fileSize: () => CLINE_TRANSCRIPT_MAX_BYTES + 1 })).toBeNull();
    fs.writeFileSync(clineMessagesPath(sessionsDir, SID), "{ torn");
    expect(readClineTranscript(base)).toBeNull();
  });

  it("is the cline descriptor's readTranscript hook", () => {
    expect(typeof CLINE_DESCRIPTOR.readTranscript).toBe("function");
  });
});
