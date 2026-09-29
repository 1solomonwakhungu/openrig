// Wrap-tolerant pane patterns. OpenRig panes are 80x24, so a TUI wraps its
// own text (at word boundaries) and draws dialog boxes whose borders land
// between the words of a phrase. panePhrase("Do you trust this?") matches the
// phrase with any run of whitespace, line breaks, or box-drawing borders
// between its words.

/** Whitespace, box-drawing characters (U+2500-U+257F), and ASCII pipes. */
const GAP = "[\\s\\u2500-\\u257f|]+";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The source of a wrap-tolerant pattern for `text` (words split on spaces). */
export function panePhraseSource(text: string): string {
  return text.trim().split(/\s+/).map(escapeRegExp).join(GAP);
}

/** A wrap-tolerant RegExp for `text`. Pass "i" for case-insensitive matching. */
export function panePhrase(text: string, flags = ""): RegExp {
  return new RegExp(panePhraseSource(text), flags);
}

/** A wrap-tolerant RegExp matching any of `texts`. */
export function anyPanePhrase(texts: readonly string[], flags = ""): RegExp {
  return new RegExp(texts.map(panePhraseSource).join("|"), flags);
}
