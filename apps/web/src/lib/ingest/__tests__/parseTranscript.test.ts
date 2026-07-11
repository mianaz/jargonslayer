import { describe, expect, it } from "vitest";
import { parseTranscript, ParseTranscriptError } from "../parseTranscript";

describe("parseTranscript — format detection", () => {
  it("uses the .srt filename extension over content sniffing", () => {
    const raw = "just some text\nno timestamps here";
    const result = parseTranscript(raw, "meeting.srt");
    expect(result.format).toBe("srt");
  });

  it("uses the .vtt filename extension over content sniffing", () => {
    const raw = "just some text";
    const result = parseTranscript(raw, "meeting.vtt");
    expect(result.format).toBe("vtt");
  });

  it("sniffs vtt from a leading WEBVTT header when there's no filename", () => {
    const raw = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello there";
    const result = parseTranscript(raw);
    expect(result.format).toBe("vtt");
  });

  it("sniffs srt from an HH:MM:SS,mmm --> HH:MM:SS,mmm cue line when there's no filename", () => {
    const raw = "1\n00:00:01,000 --> 00:00:02,000\nHello there";
    const result = parseTranscript(raw);
    expect(result.format).toBe("srt");
  });

  it("falls back to plain when nothing matches", () => {
    const raw = "Alice: hello\nBob: hi there";
    const result = parseTranscript(raw);
    expect(result.format).toBe("plain");
  });
});

describe("parseTranscript — SRT", () => {
  it("parses the happy path: index lines, comma ms, NAME: speakers, tag stripping, multi-line cues joined", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:04,500",
      "Alice: We need to <b>circle back</b> on this.",
      "",
      "2",
      "00:00:05,200 --> 00:00:08,000",
      "Bob: Sounds good,",
      "let's do that tomorrow.",
      "",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.format).toBe("srt");
    expect(result.warnings).toEqual([]);
    expect(result.segments).toEqual([
      {
        speaker: "Alice",
        text: "We need to circle back on this.",
        startMs: 1000,
        endMs: 4500,
      },
      {
        speaker: "Bob",
        text: "Sounds good, let's do that tomorrow.",
        startMs: 5200,
        endMs: 8000,
      },
    ]);
  });

  it("tolerates missing index lines", () => {
    const raw = [
      "00:00:01,000 --> 00:00:02,000",
      "Alice: hello",
      "",
      "00:00:03,000 --> 00:00:04,000",
      "Bob: hi. there",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({
      speaker: "Alice",
      text: "hello",
      startMs: 1000,
      endMs: 2000,
    });
  });

  it("accepts the dot-ms variant alongside comma", () => {
    const raw = ["1", "00:00:01.250 --> 00:00:02.750", "hello"].join("\n");
    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments[0].startMs).toBe(1250);
    expect(result.segments[0].endMs).toBe(2750);
  });

  it("strips a leading dialogue dash", () => {
    const raw = ["1", "00:00:01,000 --> 00:00:02,000", "- hello there"].join("\n");
    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments[0].text).toBe("hello there");
  });

  it("strips <i>/<font color=...> style tags", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      '<font color="#ffffff"><i>emphasized text</i></font>',
    ].join("\n");
    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments[0].text).toBe("emphasized text");
  });
});

describe("parseTranscript — VTT", () => {
  it("parses the happy path: <v Speaker>, hours-optional timestamps, NOTE/STYLE skipped, cue identifiers, cue settings ignored", () => {
    const raw = [
      "WEBVTT",
      "",
      "NOTE this is a comment block",
      "should be fully skipped",
      "",
      "STYLE",
      "::cue { color: white; }",
      "",
      "cue-1",
      "00:01.000 --> 00:04.500 align:middle position:50%",
      "<v Alice>We need to circle back on this.</v>",
      "",
      "00:00:05.200 --> 00:00:08.000",
      "<v.loud Bob>Sounds good.</v>",
      "",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.vtt");
    expect(result.format).toBe("vtt");
    expect(result.warnings).toEqual([]);
    expect(result.segments).toEqual([
      {
        speaker: "Alice",
        text: "We need to circle back on this.",
        startMs: 1000,
        endMs: 4500,
      },
      {
        speaker: "Bob",
        text: "Sounds good.",
        startMs: 5200,
        endMs: 8000,
      },
    ]);
  });

  it("supports hours-optional timestamps (MM:SS.mmm with no HH:)", () => {
    const raw = ["WEBVTT", "", "00:01.000 --> 00:02.000", "hello"].join("\n");
    const result = parseTranscript(raw, "meeting.vtt");
    expect(result.segments[0]).toEqual({ text: "hello", startMs: 1000, endMs: 2000 });
  });

  it("falls back to NAME: prefix extraction when there's no <v> tag", () => {
    const raw = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Alice: hello from a plain cue",
    ].join("\n");
    const result = parseTranscript(raw, "meeting.vtt");
    expect(result.segments[0].speaker).toBe("Alice");
    expect(result.segments[0].text).toBe("hello from a plain cue");
  });

  it("joins multi-line cue text", () => {
    const raw = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "line one",
      "line two",
    ].join("\n");
    const result = parseTranscript(raw, "meeting.vtt");
    expect(result.segments[0].text).toBe("line one line two");
  });
});

describe("parseTranscript — plain text", () => {
  it("splits on newlines, drops empties, extracts NAME: prefixes when present", () => {
    const raw = "Alice: first line\n\nBob: second line\nno speaker line here";
    const result = parseTranscript(raw);
    expect(result.format).toBe("plain");
    expect(result.segments).toEqual([
      { speaker: "Alice", text: "first line" },
      { speaker: "Bob", text: "second line" },
      { text: "no speaker line here" },
    ]);
  });

  it("carries no timestamps", () => {
    const raw = "just one line of text";
    const result = parseTranscript(raw);
    expect(result.segments[0].startMs).toBeUndefined();
    expect(result.segments[0].endMs).toBeUndefined();
  });

  it("extracts a full-width-colon speaker prefix (hand-typed Chinese notes: 张三：…)", () => {
    const res = parseTranscript("张三：Let's touch base tomorrow morning.");
    expect(res.format).toBe("plain");
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0].speaker).toBe("张三");
    expect(res.segments[0].text).toBe("Let's touch base tomorrow morning.");
  });
});

describe("parseTranscript — merge rule", () => {
  it("merges consecutive same-speaker cues that don't yet end a sentence", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "Alice: We need to",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "Alice: circle back on this",
      "",
      "3",
      "00:00:03,000 --> 00:00:04,000",
      "Alice: tomorrow morning.",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({
      speaker: "Alice",
      text: "We need to circle back on this tomorrow morning.",
      startMs: 1000,
      endMs: 4000,
    });
  });

  it("stops merging once a sentence-ending punctuation mark is seen", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "Alice: First sentence.",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "Alice: Second sentence continues",
      "",
      "3",
      "00:00:03,000 --> 00:00:04,000",
      "Alice: and finishes here.",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].text).toBe("First sentence.");
    expect(result.segments[1].text).toBe("Second sentence continues and finishes here.");
  });

  it("a speaker change breaks the merge even without terminal punctuation", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "Alice: We need to",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "Bob: circle back on this",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({
      speaker: "Alice",
      text: "We need to",
      startMs: 1000,
      endMs: 2000,
    });
    expect(result.segments[1]).toEqual({
      speaker: "Bob",
      text: "circle back on this",
      startMs: 2000,
      endMs: 3000,
    });
  });

  it("respects the 400-char combined-length cap even when the speaker matches and the sentence is unfinished", () => {
    const first = "a".repeat(390);
    const second = "b".repeat(20);
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      `Alice: ${first}`,
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      `Alice: ${second}`,
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    // combined length (390 + 1 + 20 = 411) exceeds 400 -> not merged.
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].text).toBe(first);
    expect(result.segments[1].text).toBe(second);
  });

  it("merges when the combined length stays under the 400-char cap", () => {
    const first = "a".repeat(100);
    const second = "b".repeat(100);
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      `Alice: ${first}`,
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      `Alice: ${second}`,
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe(`${first} ${second}`);
  });
});

describe("parseTranscript — warnings for skipped garbage", () => {
  it("counts unparseable SRT blocks into a zh warning and keeps the parseable ones", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "good cue.",
      "",
      "this block has no timestamp line at all",
      "just garbage",
      "",
      "3",
      "00:00:05,000 --> 00:00:06,000",
      "another good cue.",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.srt");
    expect(result.segments).toHaveLength(2);
    expect(result.warnings).toEqual(["跳过 1 个无法解析的字幕块"]);
  });

  it("counts unparseable VTT blocks into a zh warning", () => {
    const raw = [
      "WEBVTT",
      "",
      "this is not a valid cue block",
      "no timestamp here either",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "a valid cue",
    ].join("\n");

    const result = parseTranscript(raw, "meeting.vtt");
    expect(result.segments).toHaveLength(1);
    expect(result.warnings).toEqual(["跳过 1 个无法解析的字幕块"]);
  });
});

describe("parseTranscript — caps", () => {
  it("throws a typed error when raw input exceeds 200,000 chars", () => {
    const raw = "a".repeat(200_001);
    expect(() => parseTranscript(raw)).toThrow(ParseTranscriptError);
  });

  it("does not throw at exactly 200,000 chars (boundary)", () => {
    const raw = "a".repeat(200_000);
    expect(() => parseTranscript(raw)).not.toThrow();
  });

  it("throws a typed error when merged segments exceed 2000", () => {
    // Each line ends in a period so the merge pass never coalesces
    // them — 2001 distinct plain-text lines land as 2001 segments.
    const raw = Array.from({ length: 2001 }, (_, i) => `Line number ${i}.`).join("\n");
    expect(() => parseTranscript(raw)).toThrow(ParseTranscriptError);
  });

  it("does not throw at exactly 2000 segments (boundary)", () => {
    const raw = Array.from({ length: 2000 }, (_, i) => `Line number ${i}.`).join("\n");
    expect(() => parseTranscript(raw)).not.toThrow();
  });
});
