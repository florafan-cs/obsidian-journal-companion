/**
 * Pure helpers with no Obsidian dependency, so they can be unit-tested in Node.
 */

/** Callout type used to mark AI replies. Also used to detect and strip them. */
export const REPLY_MARKER = "[!ai-reply]";

/** Journal filenames must start with an ISO date, e.g. "2026-09-22 Tue..md". */
export const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

export const MAX_ENTRY_CHARS = 4000;

/** Returns the YYYY-MM-DD prefix of a filename, or null if it has none. */
export function extractDate(basename: string): string | null {
  const m = basename.match(DATE_PREFIX_RE);
  return m ? m[1] : null;
}

/**
 * Removes any AI reply callouts from a note, so replies are never fed back
 * into later replies or summaries. A callout is the marker line plus every
 * directly following line that starts with ">".
 */
export function stripReplies(text: string): string {
  const out: string[] = [];
  let inReply = false;
  for (const line of text.split("\n")) {
    const quoted = line.trimStart().startsWith(">");
    if (quoted && line.includes(REPLY_MARKER)) {
      // Drop the blank lines that separated the reply from the text above it.
      while (out.length && out[out.length - 1].trim() === "") out.pop();
      inReply = true;
      continue;
    }
    if (inReply && quoted) continue;
    if (inReply) {
      // Leaving a reply: keep exactly one blank line before any later text.
      inReply = false;
      if (out.length) out.push("");
      if (line.trim() === "") continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

export function hasReply(text: string): boolean {
  return text.includes(REPLY_MARKER);
}

/** Caps very long entries so one day can't blow up the prompt size. */
export function truncate(text: string, max = MAX_ENTRY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

/** Wraps a reply in an Obsidian callout block, ready to append to a note. */
export function toCallout(body: string, timestamp: string): string {
  const quoted = body
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
  return `\n\n> ${REPLY_MARKER} 💌 A letter from Claude · ${timestamp}\n${quoted}\n`;
}
