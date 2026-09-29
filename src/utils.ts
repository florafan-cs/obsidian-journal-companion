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
export function toCallout(body: string, timestamp: string, statsLine?: string): string {
  const full = statsLine ? `${statsLine}\n\n${body.trim()}` : body;
  const quoted = full
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
  return `\n\n> ${REPLY_MARKER} 💌 A letter from Claude · ${timestamp}\n${quoted}\n`;
}

// ---------------------------------------------------------------------------
// Writing stats
// ---------------------------------------------------------------------------

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;
const LATIN_WORD_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

/**
 * Counts words the way most writers expect for mixed Chinese/English text:
 * every CJK character counts as one, and every Latin word counts as one.
 */
export function countWords(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const latin = text.replace(CJK_RE, " ").match(LATIN_WORD_RE)?.length ?? 0;
  return cjk + latin;
}

/** True when CJK characters make up at least a third of the counted words. */
export function isMostlyCJK(text: string): boolean {
  const total = countWords(text);
  return total > 0 && (text.match(CJK_RE)?.length ?? 0) / total >= 1 / 3;
}

/**
 * Milliseconds of active writing between two keystrokes. Gaps longer than
 * `idleGapMs` mean the writer stepped away, so they count as zero.
 */
export function activeDelta(lastKeystroke: number | undefined, now: number, idleGapMs: number): number {
  if (lastKeystroke === undefined) return 0;
  const gap = now - lastKeystroke;
  return gap > 0 && gap <= idleGapMs ? gap : 0;
}

export interface EntryStats {
  name: string;
  /** Number of days journaled, up to and including this entry. */
  days: number;
  /** Words written across all entries up to and including this one. */
  totalWords: number;
  /** Words in this entry. */
  words: number;
  /** Active writing time for this entry, if it was tracked. */
  activeMs?: number;
  chinese: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The one-line stats header shown at the top of each letter. */
export function formatStatsLine(s: EntryStats): string {
  const minutes = s.activeMs ? Math.round(s.activeMs / 60000) : 0;
  const speed = minutes > 0 ? Math.round(s.words / minutes) : 0;

  if (s.chinese) {
    let line = `📝 ${s.name || "你"}已坚持记录 ${fmt(s.days)} 天，累计写下 ${fmt(s.totalWords)} 字｜今天 ${fmt(s.words)} 字`;
    if (minutes > 0) line += `，用时 ${minutes} 分钟，每分钟 ${speed} 字`;
    return line;
  }

  const who = s.name ? `${s.name} has` : "You've";
  let line = `📝 ${who} journaled for ${fmt(s.days)} ${s.days === 1 ? "day" : "days"}, ${fmt(s.totalWords)} words in total | Today: ${fmt(s.words)} words`;
  if (minutes > 0) line += ` in ${minutes} min (${speed} words/min)`;
  return line;
}
