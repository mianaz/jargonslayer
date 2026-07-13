import { describe, expect, it } from "vitest";
import {
  VAD_ATTACK_MS,
  VAD_FLOOR_INIT_DB,
  VAD_MIN_DB,
  VAD_NOISE_MARGIN_DB,
  VAD_RELEASE_MS,
  VAD_SAMPLE_MS,
  VadCore,
} from "../vadCore";

const T0 = 1_000_000;
const LOUD_DB = VAD_FLOOR_INIT_DB + VAD_NOISE_MARGIN_DB + 20; // well above margin
const QUIET_DB = VAD_FLOOR_INIT_DB; // at the initial floor itself

describe("VadCore — margin classification", () => {
  it("starts not-speaking with lastSpeechAt = -Infinity (max gap)", () => {
    const vad = new VadCore();
    expect(vad.state.speaking).toBe(false);
    expect(vad.state.lastSpeechAt).toBe(-Infinity);
  });

  it("a single loud sample exactly at floor+margin does not yet count as speech (debounce)", () => {
    const vad = new VadCore();
    const out = vad.sample(VAD_FLOOR_INIT_DB + VAD_NOISE_MARGIN_DB, T0);
    // Classifies as loud (>=), but attack debounce hasn't elapsed.
    expect(out.speaking).toBe(false);
  });

  it("a sample below the margin never promotes to speaking regardless of duration", () => {
    const vad = new VadCore();
    let now = T0;
    for (let i = 0; i < 20; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(VAD_FLOOR_INIT_DB + VAD_NOISE_MARGIN_DB - 1, now);
      expect(out.speaking).toBe(false);
    }
  });
});

describe("VadCore — attack debounce", () => {
  it("requires VAD_ATTACK_MS of continuous loud samples before speaking flips true", () => {
    const vad = new VadCore();
    let now = T0;
    // Feed loud samples every VAD_SAMPLE_MS; speaking should stay
    // false until the accumulated loud run reaches VAD_ATTACK_MS.
    let flippedAt: number | null = null;
    for (let i = 0; i < 10; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(LOUD_DB, now);
      if (out.speaking && flippedAt === null) flippedAt = now;
    }
    expect(flippedAt).not.toBeNull();
    expect(flippedAt! - T0).toBeGreaterThanOrEqual(VAD_ATTACK_MS);
    // And it flips at the FIRST sample crossing the threshold, not late.
    expect(flippedAt! - T0).toBeLessThanOrEqual(VAD_ATTACK_MS + VAD_SAMPLE_MS);
  });

  it("a brief loud blip under the attack threshold does not flip speaking, and does not advance lastSpeechAt", () => {
    const vad = new VadCore();
    // Two loud samples ~2*VAD_SAMPLE_MS apart (< VAD_ATTACK_MS), then quiet.
    vad.sample(LOUD_DB, T0);
    const mid = vad.sample(LOUD_DB, T0 + VAD_SAMPLE_MS);
    expect(mid.speaking).toBe(false);
    expect(mid.lastSpeechAt).toBe(-Infinity); // never promoted -> never counted

    const after = vad.sample(QUIET_DB, T0 + VAD_SAMPLE_MS * 2);
    expect(after.speaking).toBe(false);
    expect(after.lastSpeechAt).toBe(-Infinity);
  });

  it("lastSpeechAt advances on every loud sample once speaking is true", () => {
    const vad = new VadCore();
    let now = T0;
    for (let i = 0; i < 4; i += 1) {
      now += VAD_ATTACK_MS; // guarantee promotion well within one step
      vad.sample(LOUD_DB, now);
    }
    expect(vad.state.speaking).toBe(true);
    const promotedAt = now;
    now += 500;
    const out = vad.sample(LOUD_DB, now);
    expect(out.lastSpeechAt).toBe(now);
    expect(out.lastSpeechAt).toBeGreaterThan(promotedAt);
  });

  it("a non-continuous loud run (interrupted by a quiet sample) resets the attack timer", () => {
    const vad = new VadCore();
    vad.sample(LOUD_DB, T0);
    vad.sample(LOUD_DB, T0 + VAD_ATTACK_MS - 10); // almost there
    vad.sample(QUIET_DB, T0 + VAD_ATTACK_MS - 5); // interrupts the run
    const out = vad.sample(LOUD_DB, T0 + VAD_ATTACK_MS + 5);
    // Only ~10ms of continuous loud since the interruption — not enough.
    expect(out.speaking).toBe(false);
  });
});

describe("VadCore — release debounce", () => {
  function speakingVad(): { vad: VadCore; now: number } {
    const vad = new VadCore();
    let now = T0;
    for (let i = 0; i < 4; i += 1) {
      now += VAD_ATTACK_MS;
      vad.sample(LOUD_DB, now);
    }
    expect(vad.state.speaking).toBe(true);
    return { vad, now };
  }

  it("requires VAD_RELEASE_MS of continuous quiet before speaking flips false", () => {
    const { vad, now } = speakingVad();
    let t = now;
    let flippedAt: number | null = null;
    for (let i = 0; i < 10; i += 1) {
      t += VAD_SAMPLE_MS;
      const out = vad.sample(QUIET_DB, t);
      if (!out.speaking && flippedAt === null) flippedAt = t;
    }
    expect(flippedAt).not.toBeNull();
    expect(flippedAt! - now).toBeGreaterThanOrEqual(VAD_RELEASE_MS);
    expect(flippedAt! - now).toBeLessThanOrEqual(VAD_RELEASE_MS + VAD_SAMPLE_MS);
  });

  it("a brief quiet blip under the release threshold does not flip speaking off", () => {
    const { vad, now } = speakingVad();
    const mid = vad.sample(QUIET_DB, now + VAD_RELEASE_MS - 10);
    expect(mid.speaking).toBe(true);
    const backToLoud = vad.sample(LOUD_DB, now + VAD_RELEASE_MS - 5);
    expect(backToLoud.speaking).toBe(true);
  });

  it("lastSpeechAt freezes the instant audio goes quiet, well before the release debounce flips speaking off", () => {
    const { vad, now } = speakingVad();
    const frozenAt = vad.state.lastSpeechAt;
    expect(frozenAt).toBe(now);

    const quiet1 = vad.sample(QUIET_DB, now + 50);
    expect(quiet1.speaking).toBe(true); // still debouncing
    expect(quiet1.lastSpeechAt).toBe(frozenAt); // did NOT advance

    const quiet2 = vad.sample(QUIET_DB, now + 100);
    expect(quiet2.lastSpeechAt).toBe(frozenAt);
  });
});

describe("VadCore — adaptive noise floor", () => {
  it("does not adapt the floor while loud samples are being fed", () => {
    const vad = new VadCore();
    const initial = vad.floorDb;
    let now = T0;
    for (let i = 0; i < 50; i += 1) {
      now += VAD_SAMPLE_MS;
      vad.sample(LOUD_DB, now);
    }
    expect(vad.floorDb).toBe(initial);
  });

  it("adapts the floor toward quiet samples via EMA", () => {
    const vad = new VadCore();
    const initial = vad.floorDb;
    // Still classified "quiet" against the INITIAL floor (< floor +
    // margin) — a noisier-but-still-nobody-talking room.
    const higherQuiet = VAD_FLOOR_INIT_DB + 5;
    expect(higherQuiet).toBeLessThan(VAD_FLOOR_INIT_DB + VAD_NOISE_MARGIN_DB);
    let now = T0;
    let prev = initial;
    for (let i = 0; i < 5; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(higherQuiet, now);
      // Monotonically approaches the new quiet level from below.
      expect(vad.floorDb).toBeGreaterThan(prev);
      expect(vad.floorDb).toBeLessThan(higherQuiet);
      expect(out.speaking).toBe(false);
      prev = vad.floorDb;
    }
  });

  it("floor adaptation raises the bar for what counts as loud, given enough quiet frames", () => {
    const vad = new VadCore();
    // A step within the margin so it stays classified "quiet" (and
    // therefore keeps adapting) all the way as the floor tracks up to
    // meet it — a jump bigger than the margin would misclassify as
    // "loud" and never adapt (see the noise-margin classification
    // tests above for that boundary).
    const noisierFloor = VAD_FLOOR_INIT_DB + 6;
    let now = T0;
    for (let i = 0; i < 500; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(noisierFloor, now);
      expect(out.speaking).toBe(false);
    }
    expect(vad.floorDb).toBeGreaterThan(VAD_FLOOR_INIT_DB + 4);

    // A sample that would have been "loud" against the OLD floor is no
    // longer loud enough against the adapted one.
    now += VAD_SAMPLE_MS;
    const out = vad.sample(VAD_FLOOR_INIT_DB + VAD_NOISE_MARGIN_DB + 1, now);
    expect(out.speaking).toBe(false);
  });

  it("does not adapt the floor during the release-debounce window (still classified quiet, so it DOES adapt)", () => {
    // Sanity check on the documented semantics: floor adaptation keys
    // off the raw per-sample loud/quiet classification, not the
    // debounced `speaking` flag — so quiet samples during the release
    // hysteresis window (speaking still true) DO feed the EMA.
    const vad = new VadCore();
    let now = T0;
    for (let i = 0; i < 4; i += 1) {
      now += VAD_ATTACK_MS;
      vad.sample(LOUD_DB, now);
    }
    expect(vad.state.speaking).toBe(true);
    const before = vad.floorDb;
    // A quiet sample that differs from the current floor estimate, so
    // any EMA adaptation is observable.
    const out = vad.sample(VAD_FLOOR_INIT_DB + 3, now + 10);
    expect(out.speaking).toBe(true); // still in release debounce
    expect(vad.floorDb).not.toBe(before); // yet the floor already adapted
  });
});

describe("VadCore — non-finite sample defense (2026-07 VAD-supervisor review, finding #1)", () => {
  it("a single -Infinity sample does not poison the floor to non-finite", () => {
    const vad = new VadCore();
    const out = vad.sample(-Infinity, T0);
    expect(Number.isFinite(vad.floorDb)).toBe(true);
    expect(out.speaking).toBe(false);
  });

  it("sustained digital silence (-Infinity every frame) never promotes to speaking, and the floor stays finite throughout", () => {
    const vad = new VadCore();
    let now = T0;
    for (let i = 0; i < 200; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(-Infinity, now);
      expect(out.speaking).toBe(false);
      expect(Number.isFinite(vad.floorDb)).toBe(true);
    }
    // The regression this guards against: once the floor itself goes
    // -Infinity, `db >= floor + margin` is true for ANY finite db (even
    // a genuinely quiet one), and quiet frames stop being able to
    // adapt the floor back down — permanent false "speech". Confirm
    // the floor actually settled near VAD_MIN_DB (not just "some
    // finite number"), i.e. the clamp did its job every single frame.
    expect(vad.floorDb).toBeLessThan(VAD_FLOOR_INIT_DB);
    expect(vad.floorDb).toBeGreaterThanOrEqual(VAD_MIN_DB);
  });

  it("NaN samples are treated the same as -Infinity (also clamped, never poison the floor)", () => {
    const vad = new VadCore();
    let now = T0;
    for (let i = 0; i < 50; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(NaN, now);
      expect(out.speaking).toBe(false);
      expect(Number.isFinite(vad.floorDb)).toBe(true);
    }
  });

  it("recovery: real loud audio after a run of digital silence still correctly promotes to speaking (the floor was never poisoned into misreading everything as loud)", () => {
    const vad = new VadCore();
    let now = T0;
    // A long run of true digital silence first — if this had poisoned
    // the floor to -Infinity, `speaking` would already have flipped
    // true right here (any finite sample, loud or not, would clear
    // -Infinity + margin), well before any genuinely loud audio.
    for (let i = 0; i < 100; i += 1) {
      now += VAD_SAMPLE_MS;
      vad.sample(-Infinity, now);
    }
    expect(vad.state.speaking).toBe(false);

    // Now genuinely loud audio arrives — must still take a full
    // VAD_ATTACK_MS to promote, exactly like the attack-debounce
    // tests above with a clean floor.
    let flippedAt: number | null = null;
    for (let i = 0; i < 10; i += 1) {
      now += VAD_SAMPLE_MS;
      const out = vad.sample(LOUD_DB, now);
      if (out.speaking && flippedAt === null) flippedAt = now;
    }
    expect(flippedAt).not.toBeNull();
    expect(vad.state.speaking).toBe(true);
  });
});
