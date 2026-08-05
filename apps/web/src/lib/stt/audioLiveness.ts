// Lane W (v0.7.8): mid-session STT liveness watchdog + per-channel
// silence hint. Session-scoped zustand store tracking, per channel key
// ("mic"/"system" — dual-capture osspeech's two channel-tagged lanes; or
// "default" — every whisper-family engine, which has no channel signal
// of its own), whether real speech-level audio keeps landing with no STT
// result to show for it, whether the stats/PCM pipeline has gone
// entirely quiet (a wedged transport), and whether one dual-capture
// channel has stayed silent long enough to be worth telling the user
// about. Modelled directly on latencyStats.ts's own tiny `create()` store
// shape — no persistence, reset per session (resetLiveness(), wired
// alongside resetLagStats() in useMeeting.ts's start()).
//
// Advisory only (STTEvents.onNotice's own contract): this module only
// ever SURFACES a verdict — it MUST NOT stop or restart anything.

import { create } from "zustand";
import type { STTEngineKind } from "@jargonslayer/core/types";
import { elapsedActiveMs, useApp } from "../store";

export type AudioChannel = "mic" | "system" | "default";

const CHANNEL_KEYS: readonly AudioChannel[] = ["mic", "system", "default"];

// Pre-tag fix round (Fix C, sustained-audio predicate): FALLBACK ONLY —
// used when a producer's stats line carries no `windowLoudMs` (an
// older/foreign helper build). The real predicate below is duration-based
// (WINDOW_LOUD_MS_MIN); this single-sample-max floor is what it degrades
// to when that duration signal isn't available. Measured quiet-room PEAK
// is 0.027 (docs/design-explorations/dual-capture-2026-08.md:41 — NOT the
// 0.022 figure a prior revision of this comment cited, which was actually
// the AEC-leakage probe, a different measurement). The old AUDIO_FLOOR
// (0.03) sat only ~11% above that floor — one loud keystroke/cough could
// clear it — so this fallback is raised to 0.06, roughly double the
// measured quiet-room peak.
export const AUDIO_FLOOR = 0.06;
// Pre-tag fix round (Fix C): the shared per-sample "loud enough to look
// like speech, not noise-floor hiss" threshold — MUST mirror
// PeakMeter.speechSampleFloor (audiocap-helper's own Swift constant, 0.05)
// exactly. Both producers (TranscribeConsumer's Swift fold and
// wsTransport.ts's own PCM fold) count samples above this SAME value into
// their windowLoudMs, so the WINDOW_LOUD_MS_MIN comparison below means the
// same thing regardless of which one emitted it. Not read directly by
// this file (the fold happens upstream, in each producer) — recorded here
// as the wire contract's documented other half.
export const SPEECH_SAMPLE_FLOOR = 0.05;
// Pre-tag fix round (Fix C): a window counts as "audio-present" once at
// least this many milliseconds of its ~5s span were louder than
// SPEECH_SAMPLE_FLOOR — a DURATION requirement, unlike a single-sample max
// (windowPeak/AUDIO_FLOOR above): one keystroke or cough sets a window's
// max but contributes at most a few ms of loud time, so it alone can never
// clear this floor across a legitimate Q&A lull.
export const WINDOW_LOUD_MS_MIN = 1000;
// Watchdog verdict: this many audio-present windows (~5s emission
// cadence each, see osSpeechTransport.ts's stats lane / wsTransport.ts's
// own PCM-fold cadence) with zero STT results landing is roughly 60s of
// audible speech going nowhere.
export const WATCHDOG_MIN_AUDIO_WINDOWS = 12;
// Watchdog verdict's wall-clock floor — lane-H precedent (queue.ts's own
// FAILURE_DEAD_WALL_CLOCK_MS): a bare window count alone can be satisfied
// fast by a short loud burst; this also requires real elapsed time.
export const WATCHDOG_WALL_FLOOR_MS = 90_000;
// statsStale verdict: this long with literally zero stats/PCM activity
// (regardless of level) while armed+listening+unpaused means the
// transport itself has wedged, not merely gone quiet.
export const STATS_STALE_MS = 45_000;
// silentChannel hint (dual-capture osspeech only): this much session
// ACTIVE time (pause-excluded — see store.ts's elapsedActiveMs) with one
// channel never once crossing AUDIO_FLOOR while the other has.
export const SILENT_CHANNEL_HINT_MS = 10 * 60_000;
// Toast re-arm interval for a persistent warning verdict — copies
// wsTransport.ts's own FLAP_RENOTICE_INTERVAL_MS re-arming pattern.
export const RENOTICE_INTERVAL_MS = 5 * 60_000;

// Sentinel cadence (armLiveness's own timer) — see evaluateSentinel's
// doc comment for why only statsStale needs an independent tick at all.
const SENTINEL_INTERVAL_MS = 15_000;

// Engines this watchdog ever arms for — osspeech (single- and
// dual-capture both) plus every whisper-family engine riding
// wsTransport.ts's local sidecar (whisper/tabaudio/appaudio).
// Deliberately excludes webSpeech (its own supervisor already owns this
// exact "audio but no results" concern — see webSpeech.ts's
// WATCHDOG_TICK_MS — arming this too would double-warn) and every cloud
// engine (soniox/deepgram/elevenlabs/tabaudio-cloud — a cloud round-
// trip's own latency isn't this watchdog's business, and there is no
// local pipeline to wedge).
const LIVENESS_ENGINES = new Set<STTEngineKind>(["osspeech", "whisper", "tabaudio", "appaudio"]);

interface ChannelLivenessState {
  lastAudioAt: number | null;
  audioWindowsSinceResult: number;
  lastResultAt: number;
  lastStatsAt: number;
  everAudio: boolean;
}

export interface AudioLivenessVerdicts {
  /** Verdict 1 (warning) — the channels currently satisfying it. */
  watchdogChannels: AudioChannel[];
  /** Verdict 2 (warning) — global. */
  statsStale: boolean;
  /** Verdict 3 (info, dual-capture osspeech only) — the channels
   *  currently satisfying it. */
  silentChannels: AudioChannel[];
}

export interface AudioLivenessState {
  armed: boolean;
  channels: Record<AudioChannel, ChannelLivenessState>;
  verdicts: AudioLivenessVerdicts;
}

// lastResultAt/lastStatsAt seed to the arm timestamp (never null) — a
// channel that has NEVER seen a result/stats line still needs a
// well-defined "how long has it been" baseline, and the honest answer
// for a just-armed session is "since it started", not "forever", which a
// null would otherwise force every formula below to special-case.
function freshChannelState(now: number): ChannelLivenessState {
  return { lastAudioAt: null, audioWindowsSinceResult: 0, lastResultAt: now, lastStatsAt: now, everAudio: false };
}

function freshChannels(now: number): Record<AudioChannel, ChannelLivenessState> {
  return { mic: freshChannelState(now), system: freshChannelState(now), default: freshChannelState(now) };
}

const EMPTY_VERDICTS: AudioLivenessVerdicts = { watchdogChannels: [], statsStale: false, silentChannels: [] };

export const useAudioLiveness = create<AudioLivenessState>(() => ({
  armed: false,
  channels: freshChannels(Date.now()),
  verdicts: EMPTY_VERDICTS,
}));

/** Pre-tag fix round (Fix E): plain value equality for the two small
 *  verdict arrays — order-sensitive is fine (both derive from the same
 *  fixed CHANNEL_KEYS iteration order every call), so this is simpler
 *  than a set comparison and just as correct here. */
function sameChannelList(a: readonly AudioChannel[], b: readonly AudioChannel[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Re-derives all three verdicts from live channel state — the ONE place
 *  every verdict's formula lives, called after every mutation
 *  (pushAudioWindow, noteResult, resumeLiveness) AND on the sentinel's own
 *  tick, so no two call sites can ever disagree about what counts as
 *  active.
 *
 *  Fix E (pre-tag fix round): returns `prev` BY REFERENCE, not a fresh
 *  object, whenever the newly-derived verdict is scalar/array-equal to
 *  it — every armed engine recomputes this on every single interim (an
 *  every-few-hundred-ms cadence for a whole meeting), and StatusLine reads
 *  `verdicts` reactively; without this, an unchanged verdict would still
 *  re-render that component on every interim for the ENTIRE meeting. Few
 *  enough fields for a hand-rolled comparison — no library warranted. */
function computeVerdicts(
  channels: Record<AudioChannel, ChannelLivenessState>,
  now: number,
  prev: AudioLivenessVerdicts,
): AudioLivenessVerdicts {
  const { status, startedAt, pausedAccumMs, pauseStartedAt } = useApp.getState();
  const listening = status === "listening";
  const paused = status === "paused";

  const watchdogChannels = CHANNEL_KEYS.filter((key) => {
    const c = channels[key];
    return (
      c.audioWindowsSinceResult >= WATCHDOG_MIN_AUDIO_WINDOWS && now - c.lastResultAt >= WATCHDOG_WALL_FLOOR_MS
    );
  });

  const maxLastStatsAt = Math.max(...CHANNEL_KEYS.map((key) => channels[key].lastStatsAt));
  const statsStale = listening && !paused && now - maxLastStatsAt >= STATS_STALE_MS;

  // silentChannel hint: only ever meaningful for the mic/system pair —
  // "default" (every whisper-family engine, single-lane) has no "other
  // channel" to compare against, so it's never a candidate.
  const silentChannels: AudioChannel[] = [];
  const mic = channels.mic;
  const sys = channels.system;
  if (mic.everAudio !== sys.everAudio) {
    const elapsedActive = elapsedActiveMs(startedAt, now, pausedAccumMs, pauseStartedAt);
    if (elapsedActive >= SILENT_CHANNEL_HINT_MS) {
      if (!mic.everAudio) silentChannels.push("mic");
      if (!sys.everAudio) silentChannels.push("system");
    }
  }

  if (
    prev.statsStale === statsStale &&
    sameChannelList(prev.watchdogChannels, watchdogChannels) &&
    sameChannelList(prev.silentChannels, silentChannels)
  ) {
    return prev;
  }
  return { watchdogChannels, statsStale, silentChannels };
}

/** Feeds one windowed-peak sample for `channel` — osSpeech.ts's
 *  "osspeech://audio-stats" listener and wsTransport.ts's own PCM fold
 *  are the two producers (see each file's own call site). No-op while
 *  unarmed (a non-qualifying engine, or a straggler arriving after
 *  disarmLiveness() has already run).
 *
 *  Fix C (pre-tag fix round, sustained-audio predicate): `windowLoudMs`
 *  is the DURATION-based signal both producers now carry (Swift's
 *  TranscribeConsumer, wsTransport.ts's own PCM fold) — when present, it
 *  alone decides audio-presence (>= WINDOW_LOUD_MS_MIN), and `windowPeak`
 *  is ignored for that purpose (it's still recorded/returned for other
 *  callers, e.g. StatusLine's own diagnostics). `undefined` (an
 *  older/foreign producer that never sends one) falls back to the old
 *  single-sample-max predicate (windowPeak > AUDIO_FLOOR). */
export function pushAudioWindow(channel: AudioChannel, windowPeak: number, windowLoudMs?: number): void {
  const now = Date.now();
  useAudioLiveness.setState((s) => {
    if (!s.armed) return s;
    const paused = useApp.getState().status === "paused";
    const prev = s.channels[channel];
    const next: ChannelLivenessState = { ...prev, lastStatsAt: now };
    // Pause-awareness (mandatory — Swift keeps emitting stats through a
    // pause, TranscribeConsumer.swift:205-212, so unconditional counting
    // would false-fire across a pause): only the AUDIO-CROSSING bump
    // below is pause-gated. lastStatsAt above still updates
    // unconditionally — that's exactly what lets statsStale notice a
    // pipeline that's ACTUALLY wedged, distinct from one merely paused
    // by the user.
    const audioPresent = windowLoudMs !== undefined ? windowLoudMs >= WINDOW_LOUD_MS_MIN : windowPeak > AUDIO_FLOOR;
    if (!paused && audioPresent) {
      next.lastAudioAt = now;
      next.everAudio = true;
      next.audioWindowsSinceResult = prev.audioWindowsSinceResult + 1;
    }
    const channels = { ...s.channels, [channel]: next };
    return { channels, verdicts: computeVerdicts(channels, now, s.verdicts) };
  });
}

/** A final/interim STT result landed — clears the watchdog's own count
 *  for whichever channel(s) it can be attributed to. `undefined` (an
 *  unknown/channel-less result — every interim, or a final from a
 *  single-lane whisper-family engine) clears EVERY channel: conservative
 *  and false-negative-safe, since attributing a real result to the wrong
 *  channel would leave a genuinely dead one still ticking. */
export function noteResult(channel: AudioChannel | undefined): void {
  const now = Date.now();
  useAudioLiveness.setState((s) => {
    if (!s.armed) return s;
    const targets = channel === undefined ? CHANNEL_KEYS : [channel];
    const channels = { ...s.channels };
    for (const key of targets) {
      channels[key] = { ...channels[key], lastResultAt: now, audioWindowsSinceResult: 0 };
    }
    return { channels, verdicts: computeVerdicts(channels, now, s.verdicts) };
  });
}

let sentinelId: ReturnType<typeof setInterval> | null = null;

/** Arms the watchdog for a freshly-attached engine — a no-op for any
 *  engine outside LIVENESS_ENGINES (webSpeech/cloud engines, see that
 *  set's own doc comment). Resets every channel's counters (a fresh
 *  engine attach — even a mid-meeting engine switch — starts this
 *  watchdog's own clock over) and starts the ONE 15s sentinel interval
 *  that catches a total pipeline wedge (see evaluateSentinel's doc).
 *  Always disarms first — idempotent, so a re-attach never leaves two
 *  sentinels running. */
export function armLiveness(engine: STTEngineKind): void {
  disarmLiveness();
  if (!LIVENESS_ENGINES.has(engine)) return;
  const now = Date.now();
  useAudioLiveness.setState({ armed: true, channels: freshChannels(now), verdicts: EMPTY_VERDICTS });
  sentinelId = setInterval(evaluateSentinel, SENTINEL_INTERVAL_MS);
}

/** Disarms the watchdog (engine teardown/switch, or meeting end) — stops
 *  the sentinel and flips `armed` false, which also gates every
 *  push/noteResult call above into a no-op for whatever straggler
 *  arrives after this. Idempotent. */
export function disarmLiveness(): void {
  if (sentinelId !== null) {
    clearInterval(sentinelId);
    sentinelId = null;
  }
  useAudioLiveness.setState({ armed: false });
}

/** The sentinel's only job (see armLiveness's own doc): re-derive
 *  statsStale from whatever channel state already exists, on a fixed
 *  timer — a total pipeline wedge means pushAudioWindow stops being
 *  called AT ALL, so nothing would ever re-evaluate that verdict without
 *  an independent tick. Every other verdict stays fully lazy (fine,
 *  since a genuinely dead pipeline is exactly what this tick alone needs
 *  to catch — a wedge that still delivers real results/audio is, by
 *  definition, not a wedge). */
function evaluateSentinel(): void {
  useAudioLiveness.setState((s) => {
    if (!s.armed) return s;
    return { verdicts: computeVerdicts(s.channels, Date.now(), s.verdicts) };
  });
}

/** Fix A (pre-tag fix round, CRITICAL): the paused->listening transition
 *  for a SOFT-paused engine (tabaudio/appaudio — see useMeeting.ts's own
 *  resume()) keeps this SAME watchdog session alive across the pause, so
 *  its retained pre-pause state manufactures an immediate false verdict
 *  the instant the user resumes, closed by re-seeding every channel's
 *  evidence clocks to `now`, exactly like a fresh arm:
 *  - `lastStatsAt` froze at its pre-pause value the whole time paused
 *    (wsTransport's own pushPcm returns on feedPaused BEFORE ever
 *    reaching the liveness fold — see that method's own doc comment), so
 *    the free-running 15s sentinel can tick BEFORE the first post-resume
 *    fold flush (up to 5s of audio) and see a gap that looks like
 *    statsStale.
 *  - the wall-clock watchdog floor (WATCHDOG_WALL_FLOOR_MS) counts WALL-
 *    CLOCK time, not active time — a long pause pre-satisfies it the
 *    instant the retained pre-pause audioWindowsSinceResult count is
 *    still >= WATCHDOG_MIN_AUDIO_WINDOWS.
 *  Post-resume evidence only — no-op while unarmed (a teardown-resume
 *  reattaches via attachEngine's own fresh armLiveness() call instead,
 *  which already re-seeds everything; this is only reachable from the
 *  soft-resume branch, which never re-arms). */
export function resumeLiveness(): void {
  const now = Date.now();
  useAudioLiveness.setState((s) => {
    if (!s.armed) return s;
    const channels = { ...s.channels };
    for (const key of CHANNEL_KEYS) {
      channels[key] = { ...channels[key], lastStatsAt: now, lastResultAt: now, audioWindowsSinceResult: 0 };
    }
    return { channels, verdicts: computeVerdicts(channels, now, s.verdicts) };
  });
}

/** Full reset — wired alongside resetLagStats() in useMeeting.ts's
 *  start(): a fresh meeting must never show a stale watchdog/hint
 *  carried over from a previous one. */
export function resetLiveness(): void {
  disarmLiveness();
  useAudioLiveness.setState({ armed: false, channels: freshChannels(Date.now()), verdicts: EMPTY_VERDICTS });
}
