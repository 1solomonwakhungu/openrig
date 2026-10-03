// Token and cost usage for an aider seat, read from the seat's own chat
// history file (the resume token, or the launch's minted file).
//
// aider records usage only as tool output in the chat history (aider
// coders/base_coder.py calculate_and_show_tokens_and_cost), a quoted line per
// request:
//   > Tokens: 2.1k sent, 1.5k cache write, 900 cache hit, 120 received. Cost: $0.01 message, $0.03 session.
// Counts are rounded by utils.format_tokens (exact below 1000, one decimal
// "k" below 10000, whole "k" above), so totals are approximate. The cost
// figure is exact to the printed precision; "session" restarts with each aider
// process, so a resumed file (one "# aider chat started at" header per
// process) sums each segment's last session figure. aider prints no context
// window; the latest request's "sent" tokens approximate the context in use.
// Read-only; never throws.

import { compactUsage, type RuntimeUsageSnapshot } from "../usage-snapshot.js";

export const AIDER_USAGE_SOURCE = "aider_chat_history";

const SEGMENT_RE = /^# aider chat started at /;
const TOKENS_RE = /Tokens: ([\d.]+k?) sent(?:, ([\d.]+k?) cache write)?(?:, ([\d.]+k?) cache hit)?, ([\d.]+k?) received\./;
const COST_RE = /Cost: \$([\d.]+) message, \$([\d.]+) session\./;

/** Parse an aider format_tokens figure ("950", "2.1k", "15k"). */
export function parseAiderTokenCount(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(k?)$/.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] ? 1000 : 1);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

export function readAiderUsage(text: string | null, now: () => Date = () => new Date()): RuntimeUsageSnapshot | null {
  if (!text) return null;
  let sent = 0, received = 0, cacheWrite = 0, cacheHit = 0;
  let sawTokens = false, sawCacheWrite = false, sawCacheHit = false;
  let latestSent: number | undefined;
  let costTotal = 0, segmentCost: number | undefined, sawCost = false;
  for (const line of text.split("\n")) {
    if (SEGMENT_RE.test(line)) {
      if (segmentCost !== undefined) costTotal += segmentCost;
      segmentCost = undefined;
      continue;
    }
    const tokens = TOKENS_RE.exec(line);
    if (tokens) {
      const s = parseAiderTokenCount(tokens[1]!);
      const w = tokens[2] ? parseAiderTokenCount(tokens[2]) : undefined;
      const h = tokens[3] ? parseAiderTokenCount(tokens[3]) : undefined;
      const r = parseAiderTokenCount(tokens[4]!);
      if (s !== undefined) { sent += s; latestSent = s; sawTokens = true; }
      if (r !== undefined) { received += r; sawTokens = true; }
      if (w !== undefined) { cacheWrite += w; sawCacheWrite = true; }
      if (h !== undefined) { cacheHit += h; sawCacheHit = true; }
    }
    const cost = COST_RE.exec(line);
    if (cost) {
      const session = Number(cost[2]);
      if (Number.isFinite(session)) { segmentCost = session; sawCost = true; }
    }
  }
  if (segmentCost !== undefined) costTotal += segmentCost;
  if (!sawTokens && !sawCost) return null;
  return compactUsage({
    inputTokens: sawTokens ? sent : undefined,
    outputTokens: sawTokens ? received : undefined,
    cacheWriteTokens: sawCacheWrite ? cacheWrite : undefined,
    cacheReadTokens: sawCacheHit ? cacheHit : undefined,
    costUsd: sawCost ? Math.round(costTotal * 1e6) / 1e6 : undefined,
    // aider prints the cost it computed (litellm price data); exact to its print precision.
    costSource: sawCost ? "cli_reported" : undefined,
    contextUsedTokens: latestSent,
    observedAt: now().toISOString(),
    source: AIDER_USAGE_SOURCE,
    approximate: true,
  });
}
