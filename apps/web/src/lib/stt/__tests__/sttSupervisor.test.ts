import { describe, expect, it } from "vitest";
import {
  ROTATE_PAUSE_MS,
  SESSION_ROTATE_HARD_MS,
  SESSION_ROTATE_SOFT_MS,
  STALL_ABSOLUTE_MS,
  STALL_BACKOFF_MS,
  STALL_SILENCE_MS_LEGACY,
  STALL_SPEECH_MS,
  STALL_STEER_AFTER,
  type SupervisorAction,
  type SupervisorInput,
  decideAction,
} from "../sttSupervisor";

const T0 = 10_000_000;

/** Baseline "everything healthy, do nothing" input — each test
 *  overrides only the fields relevant to the branch under test. */
function baseInput(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    now: T0,
    sessionStartedAt: T0,
    lastEventAt: T0,
    vadAvailable: true,
    vadSpeaking: true,
    lastSpeechAt: T0,
    hasPendingInterim: false,
    realFinalSinceSoft: false,
    consecutiveSpeechStalls: 0,
    lastRecoverAt: -Infinity,
    ...overrides,
  };
}

describe("decideAction — table-driven policy coverage", () => {
  const cases: { name: string; input: SupervisorInput; expected: SupervisorAction }[] = [
    {
      name: "fresh, healthy session: none",
      input: baseInput(),
      expected: { type: "none" },
    },
    {
      name: "age >= HARD: rotate, unconditionally",
      input: baseInput({
        now: T0 + SESSION_ROTATE_HARD_MS,
        // Would otherwise not rotate/recover/steer at all.
        vadSpeaking: false,
        hasPendingInterim: true,
      }),
      expected: { type: "rotate" },
    },
    {
      name: "age >= HARD wins even mid-stall-backoff",
      input: baseInput({
        now: T0 + SESSION_ROTATE_HARD_MS,
        lastEventAt: T0,
        consecutiveSpeechStalls: STALL_STEER_AFTER,
        lastRecoverAt: T0 + SESSION_ROTATE_HARD_MS - 1, // backoff not elapsed
      }),
      expected: { type: "rotate" },
    },
    {
      name: "age >= SOFT and a real final landed since SOFT: rotate",
      input: baseInput({
        now: T0 + SESSION_ROTATE_SOFT_MS,
        realFinalSinceSoft: true,
        hasPendingInterim: true, // would otherwise block the gap-based rotate
      }),
      expected: { type: "rotate" },
    },
    {
      name: "age < SOFT: realFinalSinceSoft is ignored (can't happen before SOFT, but policy shouldn't rotate anyway)",
      input: baseInput({
        now: T0 + SESSION_ROTATE_SOFT_MS - 1,
        lastEventAt: T0 + SESSION_ROTATE_SOFT_MS - 1, // events still flowing
        realFinalSinceSoft: true,
      }),
      expected: { type: "none" },
    },
    {
      name: "age >= SOFT, VAD available, no pending interim, gap >= ROTATE_PAUSE_MS: rotate into the pause",
      input: baseInput({
        now: T0 + SESSION_ROTATE_SOFT_MS,
        lastSpeechAt: T0 + SESSION_ROTATE_SOFT_MS - ROTATE_PAUSE_MS,
        hasPendingInterim: false,
      }),
      expected: { type: "rotate" },
    },
    {
      name: "age >= SOFT, gap just under ROTATE_PAUSE_MS: not yet a real pause, no rotate",
      input: baseInput({
        now: T0 + SESSION_ROTATE_SOFT_MS,
        lastSpeechAt: T0 + SESSION_ROTATE_SOFT_MS - (ROTATE_PAUSE_MS - 1),
        hasPendingInterim: false,
        vadSpeaking: false,
      }),
      expected: { type: "none" },
    },
    {
      name: "age >= SOFT, gap long enough but STILL mid-utterance (pending interim): no rotate",
      input: baseInput({
        now: T0 + SESSION_ROTATE_SOFT_MS,
        lastSpeechAt: T0 - 10_000,
        hasPendingInterim: true,
        vadSpeaking: false,
      }),
      expected: { type: "none" },
    },
    {
      name: "age >= SOFT but VAD unavailable: gap-based rotate never fires (gap is Infinity but the branch requires vadAvailable)",
      input: baseInput({
        now: T0 + SESSION_ROTATE_SOFT_MS,
        lastEventAt: T0 + SESSION_ROTATE_SOFT_MS, // events still flowing — isolates the rotate check from the legacy stall branch
        vadAvailable: false,
        hasPendingInterim: false,
      }),
      expected: { type: "none" },
    },
    {
      name: "VAD speaking, idle >= STALL_SPEECH_MS, first stall: recover",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS,
        lastEventAt: T0,
        vadSpeaking: true,
        consecutiveSpeechStalls: 0,
      }),
      expected: { type: "recover" },
    },
    {
      name: "VAD speaking, idle just under STALL_SPEECH_MS: none",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS - 1,
        lastEventAt: T0,
        vadSpeaking: true,
      }),
      expected: { type: "none" },
    },
    {
      name: "VAD speaking, idle stalled, consecutiveSpeechStalls one below STEER_AFTER: recover",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS,
        lastEventAt: T0,
        vadSpeaking: true,
        consecutiveSpeechStalls: STALL_STEER_AFTER - 1,
      }),
      expected: { type: "recover" },
    },
    {
      name: "VAD speaking, idle stalled, consecutiveSpeechStalls >= STEER_AFTER, backoff elapsed: steer",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS,
        lastEventAt: T0,
        vadSpeaking: true,
        consecutiveSpeechStalls: STALL_STEER_AFTER,
        lastRecoverAt: T0 + STALL_SPEECH_MS - STALL_BACKOFF_MS,
      }),
      expected: { type: "steer" },
    },
    {
      name: "VAD speaking, idle stalled, consecutiveSpeechStalls >= STEER_AFTER, backoff NOT elapsed: none (suppressed, not recover)",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS,
        lastEventAt: T0,
        vadSpeaking: true,
        consecutiveSpeechStalls: STALL_STEER_AFTER,
        lastRecoverAt: T0 + STALL_SPEECH_MS - STALL_BACKOFF_MS + 1,
      }),
      expected: { type: "none" },
    },
    {
      name: "VAD says silence: never recover no matter how idle, below the absolute failsafe",
      input: baseInput({
        now: T0 + STALL_ABSOLUTE_MS - 1,
        sessionStartedAt: T0 + STALL_ABSOLUTE_MS - 1, // fresh session — isolates from the rotation-age checks
        lastEventAt: T0,
        vadSpeaking: false,
        consecutiveSpeechStalls: 5,
      }),
      expected: { type: "none" },
    },
    {
      name: "VAD says silence but idle >= STALL_ABSOLUTE_MS: failsafe recover",
      input: baseInput({
        now: T0 + STALL_ABSOLUTE_MS,
        sessionStartedAt: T0 + STALL_ABSOLUTE_MS, // fresh session — isolates from the rotation-age checks
        lastEventAt: T0,
        vadSpeaking: false,
      }),
      expected: { type: "recover" },
    },
    {
      name: "VAD unavailable, pending interim, idle >= STALL_SPEECH_MS (short legacy limit): recover",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS,
        lastEventAt: T0,
        vadAvailable: false,
        hasPendingInterim: true,
      }),
      expected: { type: "recover" },
    },
    {
      name: "VAD unavailable, pending interim, idle just under STALL_SPEECH_MS: none",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS - 1,
        lastEventAt: T0,
        vadAvailable: false,
        hasPendingInterim: true,
      }),
      expected: { type: "none" },
    },
    {
      name: "VAD unavailable, no pending interim, idle >= STALL_SPEECH_MS but < legacy silence limit: none",
      input: baseInput({
        now: T0 + STALL_SPEECH_MS,
        lastEventAt: T0,
        vadAvailable: false,
        hasPendingInterim: false,
      }),
      expected: { type: "none" },
    },
    {
      name: "VAD unavailable, no pending interim, idle >= STALL_SILENCE_MS_LEGACY: recover",
      input: baseInput({
        now: T0 + STALL_SILENCE_MS_LEGACY,
        lastEventAt: T0,
        vadAvailable: false,
        hasPendingInterim: false,
      }),
      expected: { type: "recover" },
    },
    {
      name: "VAD unavailable, idle >= STALL_ABSOLUTE_MS still just resolves via the legacy branch (recover)",
      input: baseInput({
        now: T0 + STALL_ABSOLUTE_MS,
        sessionStartedAt: T0 + STALL_ABSOLUTE_MS, // fresh session — isolates from the rotation-age checks
        lastEventAt: T0,
        vadAvailable: false,
        hasPendingInterim: false,
      }),
      expected: { type: "recover" },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(decideAction(input)).toEqual(expected);
    });
  }
});

describe("decideAction — constant sanity (documents the accepted design's values)", () => {
  it("matches the accepted design doc's constants", () => {
    expect(SESSION_ROTATE_SOFT_MS).toBe(35_000);
    expect(SESSION_ROTATE_HARD_MS).toBe(55_000);
    expect(ROTATE_PAUSE_MS).toBe(700);
    expect(STALL_SPEECH_MS).toBe(7_000);
    expect(STALL_SILENCE_MS_LEGACY).toBe(30_000);
    expect(STALL_ABSOLUTE_MS).toBe(75_000);
    expect(STALL_STEER_AFTER).toBe(2);
    expect(STALL_BACKOFF_MS).toBe(30_000);
  });
});
