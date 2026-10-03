// Token and context usage for gemini and qwen seats, read from each CLI's own
// session file (located by session-store.ts). Neither CLI records a cost.
//
// - gemini (packages/core/src/services/chatRecordingTypes.ts TokensSummary):
//   each `gemini` message carries `tokens` { input, output, cached, thoughts,
//   tool, total } and `model`. `input` is the request's prompt tokens (it
//   includes `cached`), so the latest message's `input` is the context in use.
//   No context window is recorded.
// - qwen (packages/core/src/services/chatRecordingService.ts ChatRecord): each
//   `assistant` record carries `usageMetadata` { promptTokenCount,
//   candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount },
//   `model`, and `contextWindowSize`, the model's context window.
//
// Totals sum every request; context and model come from the latest one.
// Read-only; never throws.

import { compactUsage, usageNumber, type RuntimeUsageSnapshot } from "../usage-snapshot.js";
import { geminiSessionMessages } from "./session-store.js";

export const GEMINI_USAGE_SOURCE = "gemini_session_jsonl";
export const QWEN_USAGE_SOURCE = "qwen_chat_jsonl";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function sum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;
}

function isoOrNow(value: unknown, now: () => Date): string {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : now().toISOString();
}

/** gemini: the session file's text (session-store.ts findGeminiSessionFile). */
export function readGeminiUsage(text: string | null, now: () => Date = () => new Date()): RuntimeUsageSnapshot | null {
  if (!text) return null;
  const replies = geminiSessionMessages(text).filter((m) => m.type === "gemini" && isRecord(m.tokens));
  if (replies.length === 0) return null;
  const tokens = replies.map((m) => m.tokens as Record<string, unknown>);
  const latest = replies[replies.length - 1]!;
  const latestTokens = latest.tokens as Record<string, unknown>;
  return compactUsage({
    inputTokens: sum(tokens.map((t) => usageNumber(t.input))),
    outputTokens: sum(tokens.map((t) => usageNumber(t.output))),
    cacheReadTokens: sum(tokens.map((t) => usageNumber(t.cached))),
    reasoningTokens: sum(tokens.map((t) => usageNumber(t.thoughts))),
    contextUsedTokens: usageNumber(latestTokens.input),
    model: typeof latest.model === "string" ? latest.model : undefined,
    observedAt: isoOrNow(latest.timestamp, now),
    source: GEMINI_USAGE_SOURCE,
  });
}

/** qwen: the conversation file's text (<id>.jsonl, session-store.ts findQwenSessionFile). */
export function readQwenUsage(text: string | null, now: () => Date = () => new Date()): RuntimeUsageSnapshot | null {
  if (!text) return null;
  const replies: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (isRecord(record) && record.type === "assistant" && isRecord(record.usageMetadata)) replies.push(record);
    } catch {
      // a torn last line while qwen is writing: skip it
    }
  }
  if (replies.length === 0) return null;
  const usage = replies.map((r) => r.usageMetadata as Record<string, unknown>);
  const latest = replies[replies.length - 1]!;
  const latestUsage = latest.usageMetadata as Record<string, unknown>;
  return compactUsage({
    inputTokens: sum(usage.map((u) => usageNumber(u.promptTokenCount))),
    outputTokens: sum(usage.map((u) => usageNumber(u.candidatesTokenCount))),
    cacheReadTokens: sum(usage.map((u) => usageNumber(u.cachedContentTokenCount))),
    reasoningTokens: sum(usage.map((u) => usageNumber(u.thoughtsTokenCount))),
    contextUsedTokens: usageNumber(latestUsage.promptTokenCount),
    contextWindowTokens: usageNumber(latest.contextWindowSize),
    model: typeof latest.model === "string" ? latest.model : undefined,
    observedAt: isoOrNow(latest.timestamp, now),
    source: QWEN_USAGE_SOURCE,
  });
}
