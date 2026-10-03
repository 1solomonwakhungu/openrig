// Shared helpers for native transcript readers (feature 5): turn a CLI's tool
// inputs and results into short, readable transcript text.

/** Tool inputs and results are summarized, never dumped whole. */
export const TRANSCRIPT_PREVIEW_CHARS = 300;

/** A string as is, anything else as JSON, cut to `max` characters. */
export function transcriptPreview(value: unknown, max = TRANSCRIPT_PREVIEW_CHARS): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** "name(input preview)" for a tool call. */
export function toolCallText(name: string, input: unknown): string {
  return `${name}(${input === undefined ? "" : transcriptPreview(input)})`;
}

/** ISO time from an ISO string or epoch milliseconds; undefined otherwise. */
export function transcriptTime(value: unknown): string | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
