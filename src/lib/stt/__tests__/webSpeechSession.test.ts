import { describe, expect, it } from "vitest";
import {
  FLUSH_AFTER_MS,
  FLUSH_HOLDBACK_CHARS,
  FLUSH_MAX_CHARS,
  FLUSH_MIN_CHARS,
  FLUSH_MIN_EMIT_CHARS,
  UtteranceAssembler,
  findFlushCut,
} from "../webSpeechSession";

const T0 = 1_000_000;

function words(n: number, w = "word"): string {
  return Array.from({ length: n }, () => w).join(" ");
}

describe("findFlushCut", () => {
  it("returns 0 when the text is too short to flush safely", () => {
    expect(findFlushCut("short interim")).toBe(0);
    expect(
      findFlushCut("x".repeat(FLUSH_HOLDBACK_CHARS + FLUSH_MIN_EMIT_CHARS - 1)),
    ).toBe(0);
  });

  it("prefers the last sentence-ending punctuation outside the holdback", () => {
    const head = `${words(8)}. ${words(6)}`; // '.' well past MIN_EMIT
    const text = `${head} ${words(20)}`;
    const cut = findFlushCut(text);
    const dotIndex = head.indexOf(".");
    expect(cut).toBe(dotIndex + 1);
    expect(text.slice(0, cut).endsWith(".")).toBe(true);
  });

  it("falls back to the last word gap when there is no punctuation", () => {
    const text = words(60);
    const cut = findFlushCut(text);
    expect(cut).toBeGreaterThanOrEqual(FLUSH_MIN_EMIT_CHARS);
    expect(cut).toBeLessThanOrEqual(text.length - FLUSH_HOLDBACK_CHARS);
    expect(text[cut]).toBe(" "); // cut lands ON a gap, prefix excludes it
  });

  it("hard-cuts pathological no-space text at the holdback limit", () => {
    const text = "x".repeat(300);
    expect(findFlushCut(text)).toBe(300 - FLUSH_HOLDBACK_CHARS);
  });

  it("supports CJK sentence enders", () => {
    const head = `${"字".repeat(FLUSH_MIN_EMIT_CHARS + 5)}。`;
    const text = head + "字".repeat(200);
    expect(findFlushCut(text)).toBe(head.length);
  });
});

describe("UtteranceAssembler", () => {
  it("keeps short interims as interim only", () => {
    const a = new UtteranceAssembler();
    const out = a.push(
      [{ index: 0, transcript: "hello there", isFinal: false }],
      T0,
    );
    expect(out.finals).toEqual([]);
    expect(out.interim).toBe("hello there");
    expect(out.sawRealFinal).toBe(false);
    expect(a.hasPendingInterim()).toBe(true);
  });

  it("emits a real final with startedAt = first-seen time", () => {
    const a = new UtteranceAssembler();
    a.push([{ index: 0, transcript: "hel", isFinal: false }], T0);
    const out = a.push(
      [{ index: 0, transcript: "hello world", isFinal: true }],
      T0 + 2_000,
    );
    expect(out.finals).toEqual([{ text: "hello world", startedAt: T0 }]);
    expect(out.sawRealFinal).toBe(true);
    expect(a.hasPendingInterim()).toBe(false);
  });

  it("self-flushes once the interim crosses FLUSH_MAX_CHARS", () => {
    const a = new UtteranceAssembler();
    const long = words(50); // 249 chars > 200
    expect(long.length).toBeGreaterThan(FLUSH_MAX_CHARS);
    const out = a.push([{ index: 0, transcript: long, isFinal: false }], T0);
    expect(out.finals).toHaveLength(1);
    const flushed = out.finals[0].text;
    expect(flushed.length).toBeGreaterThan(0);
    expect(long.startsWith(flushed)).toBe(true);
    // remainder is displayed as interim, not lost
    expect(out.interim).toBe(long.slice(flushed.length).trim());
    expect(out.finals[0].startedAt).toBe(T0);
  });

  it("dedups the eventual real final against the flushed prefix", () => {
    const a = new UtteranceAssembler();
    const long = words(50);
    const first = a.push([{ index: 0, transcript: long, isFinal: false }], T0);
    const flushedText = first.finals[0].text;

    const fullFinal = `${long} and then it ends`;
    const out = a.push(
      [{ index: 0, transcript: fullFinal, isFinal: true }],
      T0 + 5_000,
    );
    expect(out.finals).toHaveLength(1);
    // Only the unseen suffix — no duplicated words from the flush.
    expect(out.finals[0].text).toBe(
      fullFinal.slice(flushedText.length).trim(),
    );
    expect(flushedText + " " + out.finals[0].text).toBe(
      fullFinal.replace(/\s+/g, " ").trim(),
    );
  });

  it("flushes on age once FLUSH_AFTER_MS passes with enough text", () => {
    const a = new UtteranceAssembler();
    const mid = words(25); // 124 chars: > FLUSH_MIN_CHARS, < FLUSH_MAX_CHARS
    expect(mid.length).toBeGreaterThan(FLUSH_MIN_CHARS);
    expect(mid.length).toBeLessThan(FLUSH_MAX_CHARS);

    const early = a.push([{ index: 0, transcript: mid, isFinal: false }], T0);
    expect(early.finals).toEqual([]);

    const out = a.push(
      [{ index: 0, transcript: mid, isFinal: false }],
      T0 + FLUSH_AFTER_MS,
    );
    expect(out.finals).toHaveLength(1);
  });

  it("does not age-flush short interims", () => {
    const a = new UtteranceAssembler();
    const short = "just a few words here";
    a.push([{ index: 0, transcript: short, isFinal: false }], T0);
    // A genuinely CHANGED (still short) transcript for the same
    // index, not a repeat — see the honest-interim-contract test
    // (#A4) right below for the unchanged-repeat case, which now
    // correctly returns interim:null instead of re-signaling the same
    // text.
    const stillShort = `${short} still`;
    const out = a.push(
      [{ index: 0, transcript: stillShort, isFinal: false }],
      T0 + FLUSH_AFTER_MS * 2,
    );
    expect(out.finals).toEqual([]);
    expect(out.interim).toBe(stillShort);
  });

  it("fix #A4 (honest interim contract): push() returns interim:null when the remainder is unchanged from the last push", () => {
    const a = new UtteranceAssembler();
    const short = "just a few words here";
    const first = a.push([{ index: 0, transcript: short, isFinal: false }], T0);
    expect(first.interim).toBe(short);

    // Same transcript, same index — nothing actually changed for the
    // caller to redraw.
    const second = a.push([{ index: 0, transcript: short, isFinal: false }], T0 + 100);
    expect(second.interim).toBeNull();
  });

  it("fix #A4 (honest interim contract): a retraction to nothing pending returns interim:'' (a real signal), not null", () => {
    const a = new UtteranceAssembler();
    const text = "hello there";
    const first = a.push([{ index: 0, transcript: text, isFinal: false }], T0);
    expect(first.interim).toBe(text);

    // The real final clears pendingSnapshots for index 0 — the
    // remainder goes from "hello there" to "", a genuine change the
    // caller must be told about (never conflated with "unchanged").
    const out = a.push([{ index: 0, transcript: text, isFinal: true }], T0 + 200);
    expect(out.interim).toBe("");
  });

  it("handles a final and a new non-final result in one event", () => {
    const a = new UtteranceAssembler();
    a.push([{ index: 0, transcript: "first part", isFinal: false }], T0);
    const out = a.push(
      [
        { index: 0, transcript: "first sentence done", isFinal: true },
        { index: 1, transcript: "second beg", isFinal: false },
      ],
      T0 + 1_000,
    );
    expect(out.finals.map((f) => f.text)).toEqual(["first sentence done"]);
    expect(out.interim).toBe("second beg");
    expect(out.sawRealFinal).toBe(true);
  });

  it("flushAll rescues the tail and later real finals emit nothing new", () => {
    const a = new UtteranceAssembler();
    const text = "this whole utterance was still pending when we rotated";
    a.push([{ index: 0, transcript: text, isFinal: false }], T0);

    const tail = a.flushAll(T0 + 1_000);
    expect(tail).toEqual({ text, startedAt: T0 });
    expect(a.hasPendingInterim()).toBe(false);

    // Chrome's trailing real final for the same result: fully dedup'd.
    const out = a.push([{ index: 0, transcript: text, isFinal: true }], T0 + 2_000);
    expect(out.finals).toEqual([]);
  });

  it("flushAll returns null when nothing is pending", () => {
    const a = new UtteranceAssembler();
    expect(a.flushAll(T0)).toBeNull();
    a.push([{ index: 0, transcript: "done.", isFinal: true }], T0);
    expect(a.flushAll(T0 + 100)).toBeNull();
  });

  it("reset clears offsets so a new session reuses indices safely", () => {
    const a = new UtteranceAssembler();
    const long = words(50);
    a.push([{ index: 0, transcript: long, isFinal: false }], T0);
    a.reset();
    // New session, index 0 again — no stale flushed offset must apply.
    const out = a.push(
      [{ index: 0, transcript: "fresh short text", isFinal: true }],
      T0 + 60_000,
    );
    expect(out.finals.map((f) => f.text)).toEqual(["fresh short text"]);
  });

  it("a real final resets the utterance clock for the next utterance", () => {
    const a = new UtteranceAssembler();
    a.push([{ index: 0, transcript: "one.", isFinal: true }], T0);
    const out = a.push(
      [{ index: 1, transcript: "two begins", isFinal: false }],
      T0 + 30_000,
    );
    expect(out.finals).toEqual([]);
    const fin = a.push(
      [{ index: 1, transcript: "two begins and ends", isFinal: true }],
      T0 + 31_000,
    );
    expect(fin.finals[0].startedAt).toBe(T0 + 30_000);
  });
});

describe("UtteranceAssembler.flushStable — rotation/recovery, dup-bug regression", () => {
  it("holds back the revision-prone tail (same cut boundary as self-flush), unlike flushAll", () => {
    const a = new UtteranceAssembler();
    const long = words(20); // long enough for a safe cut to exist
    a.push([{ index: 0, transcript: long, isFinal: false }], T0);

    const out = a.flushStable(T0 + 100);
    expect(out).not.toBeNull();
    expect(long.startsWith(out!.text)).toBe(true);
    // The tail stayed pending — not the whole snapshot like flushAll.
    expect(out!.text.length).toBeLessThan(long.length);
    expect(a.hasPendingInterim()).toBe(true);
  });

  it("returns null and leaves everything pending when the unflushed text is too short to safely cut", () => {
    const a = new UtteranceAssembler();
    a.push([{ index: 0, transcript: "short interim", isFinal: false }], T0);
    const out = a.flushStable(T0 + 100);
    expect(out).toBeNull();
    expect(a.hasPendingInterim()).toBe(true);
  });

  it("returns null when nothing is pending, same as flushAll", () => {
    const a = new UtteranceAssembler();
    expect(a.flushStable(T0)).toBeNull();
    a.push([{ index: 0, transcript: "done.", isFinal: true }], T0);
    expect(a.flushStable(T0 + 100)).toBeNull();
  });

  it("a subsequent real final for the same index completes the held-back tail with no loss and no dup", () => {
    const a = new UtteranceAssembler();
    const long = words(20);
    a.push([{ index: 0, transcript: long, isFinal: false }], T0);

    const partial = a.flushStable(T0 + 100);
    expect(partial).not.toBeNull();

    // The dying session's own stop()-triggered real final: the SAME
    // (unrevised) text, exactly what a real Chrome finalization of
    // already-collected audio would report.
    const out = a.push([{ index: 0, transcript: long, isFinal: true }], T0 + 200);

    const reconstructed = [partial!.text, ...out.finals.map((f) => f.text)]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(reconstructed).toBe(long.replace(/\s+/g, " ").trim());
    expect(a.hasPendingInterim()).toBe(false);
  });

  it("regression: a real final DIVERGING from the last revision-flipped interim is never dropped, and the revision artifact never leaks into a final (the 2026-07 66-dup bug)", () => {
    const a = new UtteranceAssembler();
    // Long enough that the safe cut lands well before the revision-
    // flipped last word, mirroring Chrome rewriting the tail as more
    // context arrives (FakeSpeechRecognition.revisedTranscript).
    const stable = words(20);
    const revised = `${stable}x`; // last word mid-revision, e.g. "wordx"
    a.push([{ index: 0, transcript: stable, isFinal: false }], T0);
    a.push([{ index: 0, transcript: revised, isFinal: false }], T0 + 300);

    // Rotation/recovery fires HERE, mid-revision.
    const partial = a.flushStable(T0 + 350);
    expect(partial).not.toBeNull();
    // The corrupted "wordx" artifact must never appear in emitted text.
    expect(partial!.text).not.toContain("wordx");

    // The dying session's stop() finalizes based on ACTUAL collected
    // audio — the plain (non-revised) transcript, per MDN semantics —
    // which may be SHORTER than the revision we last rendered.
    const out = a.push([{ index: 0, transcript: stable, isFinal: true }], T0 + 400);

    const reconstructed = [partial!.text, ...out.finals.map((f) => f.text)]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(reconstructed).toBe(stable.replace(/\s+/g, " ").trim());
    expect(reconstructed).not.toContain("wordx");
  });

  it("does not clear utteranceStart — the held-back remainder is still the same ongoing utterance", () => {
    const a = new UtteranceAssembler();
    const long = words(20);
    a.push([{ index: 0, transcript: long, isFinal: false }], T0);
    a.flushStable(T0 + 100);

    const out = a.push([{ index: 0, transcript: long, isFinal: true }], T0 + 5_000);
    // startedAt reflects the utterance's TRUE origin, not the flush time.
    expect(out.finals[0].startedAt).toBe(T0);
  });

  it("2026-07 VAD-supervisor review finding #5: stops at the first earlier index that can't safely flush, never skipping ahead to flush a LATER index first", () => {
    const a = new UtteranceAssembler();
    // index 0: too short to ever safely cut (findFlushCut returns 0).
    a.push([{ index: 0, transcript: "hi", isFinal: false }], T0);
    // index 1: long enough that, taken in isolation, it WOULD have a
    // safe cut — without the fix, this used to get flushed anyway,
    // landing emission order as [idx1-prefix, idx0-final, idx1-tail]
    // instead of staying chronological.
    const long = words(20);
    a.push([{ index: 1, transcript: long, isFinal: false }], T0 + 50);

    const out = a.flushStable(T0 + 100);
    expect(out).toBeNull(); // nothing emitted — index 0 blocks index 1 too
    expect(a.hasPendingInterim()).toBe(true);

    // Index 1 never got a flushedChars offset either (confirmed via
    // flushAll: both indices' FULL original text is still there, in
    // order, nothing was partially consumed out of sequence).
    const rescued = a.flushAll(T0 + 200);
    expect(rescued?.text).toBe(`hi ${long}`);
  });
});
