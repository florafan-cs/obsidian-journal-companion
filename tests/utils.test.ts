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

import { moodSection, parseMoodJson, scoreBar, toMood } from "../src/utils";

describe("mood parsing", () => {
  it("reads plain JSON and JSON wrapped in prose or code fences", () => {
    const want = { mood: 4, energy: 2, emotions: ["期待", "疲惫"] };
    expect(parseMoodJson('{"mood":4,"energy":2,"emotions":["期待","疲惫"]}')).toEqual(want);
    expect(parseMoodJson('Here you go:\n```json\n{"mood": 4, "energy": 2, "emotions": ["期待", "疲惫"]}\n```')).toEqual(want);
  });

  it("rejects out-of-range or malformed scores", () => {
    expect(parseMoodJson('{"mood": 6, "energy": 3}')).toBeNull();
    expect(parseMoodJson('{"mood": 2.5, "energy": 3}')).toBeNull();
    expect(parseMoodJson("no json here")).toBeNull();
    expect(parseMoodJson("{not: json}")).toBeNull();
  });

  it("accepts frontmatter values, including numbers stored as strings", () => {
    expect(toMood({ mood: "3", energy: 5 })).toEqual({ mood: 3, energy: 5, emotions: [] });
    expect(toMood({ mood: 3 })).toBeNull();
  });

  it("keeps at most three feelings", () => {
    expect(toMood({ mood: 3, energy: 3, emotions: ["a", "b", "c", "d"] })?.emotions).toEqual(["a", "b", "c"]);
  });
});

describe("moodSection", () => {
  const rows = [
    { label: "9/22", day: "Mon 9/22", mood: 4, energy: 3, emotions: ["满足"] },
    { label: "9/23", day: "Tue 9/23", mood: 2, energy: 2, emotions: ["焦虑", "疲惫"] },
  ];

  it("draws a chart with energy bars and a mood line", () => {
    const md = moodSection(rows, true);
    expect(md).toContain('x-axis ["9/22", "9/23"]');
    expect(md).toContain("bar [3, 2]");
    expect(md).toContain("line [4, 2]");
  });

  it("includes averages and a readable per-day table", () => {
    const md = moodSection(rows, true);
    expect(md).toContain("心情 😐 3 / 5");
    expect(md).toContain("| Tue 9/23 | 😕 ▇▇░░░ 2 | ⚡ ▇▇░░░ 2 | 焦虑、疲惫 |");
  });

  it("uses English labels for English journals and is empty with no data", () => {
    expect(moodSection(rows, false)).toContain("**Average**: Mood");
    expect(moodSection([], false)).toBe("");
  });

  it("draws score bars", () => {
    expect(scoreBar(1)).toBe("▇░░░░");
    expect(scoreBar(5)).toBe("▇▇▇▇▇");
  });
});

import { isInside, monthFolderTarget } from "../src/utils";

describe("folders", () => {
  it("matches files inside a folder at any depth, and nothing else", () => {
    expect(isInside("Journal/2026-09-22 Tue..md", "Journal")).toBe(true);
    expect(isInside("Journal/2026-09 9月/2026-09-22 Tue..md", "Journal")).toBe(true);
    expect(isInside("Journal/Summaries/Memory.md", "Journal/Summaries")).toBe(true);
    expect(isInside("Journals/2026-09-22.md", "Journal")).toBe(false);
    expect(isInside("Journal", "Journal")).toBe(false);
  });

  it("treats an empty folder as the vault root", () => {
    expect(isInside("2026-09-22.md", "")).toBe(true);
  });

  it("builds the month folder path, tolerating stray slashes", () => {
    expect(monthFolderTarget("Journal", "2026-09 9月", "2026-09-22 Tue..md")).toBe("Journal/2026-09 9月/2026-09-22 Tue..md");
    expect(monthFolderTarget("Journal/", "/2026/09/", "x.md")).toBe("Journal/2026/09/x.md");
    expect(monthFolderTarget("", "2026-09", "x.md")).toBe("2026-09/x.md");
  });
});

import { addAnswerSlots, arrangePhotos, calendarMarkdown, extractQuestions, hasAnswers, parseChoice, parseLink } from "../src/utils";

describe("arrangePhotos", () => {
  it("gathers consecutive photos into a grid and leaves text alone", () => {
    const before = "Went to the park.\n\n![[a.jpg]]\n![[b.png|300]]\n\n![[c.jpeg]]\n\nSo nice.";
    expect(arrangePhotos(before)).toBe("Went to the park.\n\n> [!photos]\n> ![[a.jpg]] ![[b.png|300]] ![[c.jpeg]]\n\nSo nice.");
  });

  it("handles several photos on one line and Markdown image syntax", () => {
    expect(arrangePhotos("![[a.jpg]] ![](img/b.webp)")).toBe("> [!photos]\n> ![[a.jpg]] ![](img/b.webp)");
  });

  it("leaves single photos, mixed lines, code and frontmatter as they are", () => {
    const text = [
      "---",
      "cover: \"[[a.jpg]]\"",
      "---",
      "![[a.jpg]]",
      "text",
      "Look ![[b.jpg]] here",
      "![[c.jpg]]",
      "```",
      "![[d.jpg]]",
      "![[e.jpg]]",
      "```",
    ].join("\n");
    expect(arrangePhotos(text)).toBe(text);
  });

  it("is idempotent and ignores non-image embeds", () => {
    const once = arrangePhotos("![[a.jpg]]\n![[b.jpg]]");
    expect(arrangePhotos(once)).toBe(once);
    expect(arrangePhotos("![[note]]\n![[other.pdf]]")).toBe("![[note]]\n![[other.pdf]]");
  });
});

describe("photo helpers", () => {
  it("parses cover links and model choices", () => {
    expect(parseLink("[[photos/cat.jpg]]")).toBe("photos/cat.jpg");
    expect(parseLink("[[cat.jpg|alias]]")).toBe("cat.jpg");
    expect(parseLink("cat.jpg")).toBe("cat.jpg");
    expect(parseLink(undefined)).toBeNull();
    expect(parseChoice('{"index": 2}', 3)).toBe(1);
    expect(parseChoice('{"index": 5}', 3)).toBeNull();
    expect(parseChoice("I like the second one", 3)).toBeNull();
  });
});

describe("calendarMarkdown", () => {
  // October 2026 starts on a Thursday and has 31 days.
  const days = new Map([[5, { link: "2026-10-05 Mon.", emoji: "🙂", cover: "Photos/park.jpg" }], [7, { link: "2026-10-07 Wed.", emoji: "😐" }]]);
  const md = calendarMarkdown(2026, 10, days, true);
  const rows = md.split("\n");

  it("starts on Monday with the right offset and covers the whole month", () => {
    expect(rows[0]).toBe("| 一 | 二 | 三 | 四 | 五 | 六 | 日 |");
    expect(rows[2]).toBe("|   |   |   | 1 | 2 | 3 | 4 |");
    expect(rows.length).toBe(2 + 5);
    expect(rows[rows.length - 1]).toContain("| 31 |");
  });

  it("links entries, shows mood and cover, and escapes pipes inside the table", () => {
    expect(md).toContain("[[2026-10-05 Mon.\\|5]] 🙂<br>![[Photos/park.jpg\\|200]]");
    expect(md).toContain("[[2026-10-07 Wed.\\|7]] 😐 |");
  });
});

describe("reflective questions", () => {
  const body = "## A note to you\nYou did great.\n## 🤔 Questions for you\n1. What are you avoiding?\n2. 你在害怕什么？\n";

  it("adds an answer line under each question, only in the 🤔 section", () => {
    const withSlots = addAnswerSlots("## Try next week\n1. Sleep earlier\n" + body);
    expect(withSlots).toContain("1. Sleep earlier\n## A note");
    expect(withSlots).toContain("1. What are you avoiding?\n   - ✍️ \n2. 你在害怕什么？\n   - ✍️ ");
  });

  it("extracts the questions section and detects answers", () => {
    const note = `# Week\n${addAnswerSlots(body)}\n---\n### Entries this week\n- [[x]]`;
    const qa = extractQuestions(note);
    expect(qa.startsWith("## 🤔 Questions for you")).toBe(true);
    expect(qa).not.toContain("Entries this week");
    expect(hasAnswers(qa)).toBe(false);
    expect(hasAnswers(qa.replace("✍️ ", "✍️ Probably the internship emails"))).toBe(true);
    expect(extractQuestions("no questions")).toBe("");
  });
});

import { feelingsInLanguage } from "../src/utils";

describe("feelingsInLanguage", () => {
  it("checks that feeling words match the journal's language", () => {
    expect(feelingsInLanguage(["沉思", "担忧"], true)).toBe(true);
    expect(feelingsInLanguage(["thoughtful", "担忧"], true)).toBe(false);
    expect(feelingsInLanguage(["hopeful", "calm"], false)).toBe(true);
    expect(feelingsInLanguage(["期待"], false)).toBe(false);
    expect(feelingsInLanguage([], true)).toBe(true);
  });
});
