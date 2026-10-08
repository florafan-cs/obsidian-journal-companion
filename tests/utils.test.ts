import { describe, expect, it } from "vitest";
import { extractDate, hasReply, stripReplies, toCallout, truncate } from "../src/utils";

describe("extractDate", () => {
  it("reads the ISO date prefix", () => {
    expect(extractDate("2026-09-22 Tue.")).toBe("2026-09-22");
  });
  it("returns null for non-journal notes", () => {
    expect(extractDate("Reading list")).toBeNull();
  });
});

describe("toCallout / stripReplies", () => {
  const entry = "Went to Costco today.\n\nFound kiwi berries!";
  const withReply = entry + toCallout("What a fun find.\n\nEnjoy them!", "2026-09-25 08:00");

  it("marks the reply so it can be detected", () => {
    expect(hasReply(entry)).toBe(false);
    expect(hasReply(withReply)).toBe(true);
  });

  it("round-trips: stripping a reply restores the original entry", () => {
    expect(stripReplies(withReply)).toBe(entry);
  });

  it("keeps blank lines inside the reply inside the callout", () => {
    expect(withReply).toContain("> What a fun find.\n>\n> Enjoy them!");
  });

  it("keeps the user's own quotes and text written after a reply", () => {
    const text = "> a quote I like\n\nmy day" + toCallout("hi", "t") + "\nwritten later";
    expect(stripReplies(text)).toBe("> a quote I like\n\nmy day\n\nwritten later");
  });
});

describe("truncate", () => {
  it("leaves short text alone and caps long text", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdef", 3)).toBe("abc\n…(truncated)");
  });
});

import { activeDelta, countWords, formatStatsLine, isMostlyCJK } from "../src/utils";

describe("countWords", () => {
  it("counts each Chinese character and each English word once", () => {
    expect(countWords("今天去Costco买水")).toBe(6);
    expect(countWords("I love kiwi berries!")).toBe(4);
    expect(countWords("")).toBe(0);
  });
  it("treats contractions and hyphenated words as one word", () => {
    expect(countWords("don't over-think it")).toBe(3);
  });
});

describe("isMostlyCJK", () => {
  it("detects Chinese-led entries, including ones with some English", () => {
    expect(isMostlyCJK("今天在Costco买了kiwi berry")).toBe(true);
    expect(isMostlyCJK("Went to Costco and bought 水")).toBe(false);
  });
});

describe("activeDelta", () => {
  const gap = 120_000;
  it("counts short pauses between keystrokes", () => {
    expect(activeDelta(1_000, 31_000, gap)).toBe(30_000);
  });
  it("ignores the first keystroke and long breaks", () => {
    expect(activeDelta(undefined, 5_000, gap)).toBe(0);
    expect(activeDelta(0, 10 * 60_000, gap)).toBe(0);
  });
});

describe("formatStatsLine", () => {
  const base = { name: "Flora", days: 30, totalWords: 12345, words: 820 };
  it("writes a Chinese line with time and speed", () => {
    expect(formatStatsLine({ ...base, activeMs: 25 * 60_000, chinese: true })).toBe(
      "📝 Flora已坚持记录 30 天，累计写下 12,345 字｜今天 820 字，用时 25 分钟，每分钟 33 字"
    );
  });
  it("omits time and speed when writing time wasn't tracked", () => {
    expect(formatStatsLine({ ...base, chinese: false })).toBe(
      "📝 Flora has journaled for 30 days, 12,345 words in total | Today: 820 words"
    );
  });
  it("falls back to 'you' without a name", () => {
    expect(formatStatsLine({ ...base, name: "", days: 1, chinese: false })).toMatch(/^📝 You've journaled for 1 day,/);
  });
});

describe("toCallout with stats", () => {
  it("puts the stats line first and still strips cleanly", () => {
    const entry = "my day";
    const withReply = entry + toCallout("Nice!", "t", "📝 stats");
    expect(withReply).toContain("> 📝 stats\n>\n> Nice!");
    expect(stripReplies(withReply)).toBe(entry);
  });
});

import { PINNED_PLACEHOLDER, buildMemoryNote, splitMemory, stripFrontmatter } from "../src/utils";

describe("memory note", () => {
  const ai = "## People & pets\n- Mochi: the cat\n\n## Goals & projects\n- Summer internship";

  it("round-trips pinned notes and the AI part", () => {
    const note = buildMemoryNote("- I'm allergic to cats but love them anyway", ai, "2026-10-07 23:30");
    const { pinned, aiPart } = splitMemory(note);
    expect(pinned).toBe("- I'm allergic to cats but love them anyway");
    expect(aiPart).toBe(ai);
  });

  it("treats the placeholder as no pinned notes", () => {
    const note = buildMemoryNote("", ai, "t");
    expect(note).toContain(PINNED_PLACEHOLDER);
    expect(splitMemory(note).pinned).toBe("");
  });

  it("never lets the model overwrite the pinned section", () => {
    const sneaky = "## 📌 Pinned\n- model-written pin\n\n" + ai;
    const note = buildMemoryNote("- real pin", sneaky, "t");
    const { pinned, aiPart } = splitMemory(note);
    expect(pinned).toBe("- real pin");
    expect(aiPart).toBe(ai);
    expect(note).not.toContain("model-written pin");
  });

  it("keeps edits the writer makes to the AI part", () => {
    const edited = buildMemoryNote("", ai, "t").replace("the cat", "the best cat");
    expect(splitMemory(edited).aiPart).toContain("the best cat");
  });

  it("strips frontmatter", () => {
    expect(stripFrontmatter("---\na: 1\n---\nbody")).toBe("body");
    expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
  });
});
