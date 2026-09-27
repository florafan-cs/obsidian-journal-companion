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
