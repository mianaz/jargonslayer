// Global zustand store — the bus between STT (worker A), detection
// (worker B) and all UI panels. Owned by the lead; workers read/write
// through the actions below and never import each other's modules.

import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  newId,
  type DetectResponse,
  type DetectionSource,
  type ExpressionCard,
  type InterimState,
  type MeetingSession,
  type MeetingStatus,
  type SessionMeta,
  type Settings,
  type SummaryResult,
  type TermCard,
  type TranscriptSegment,
} from "@jargonslayer/core/types";
import { mergeDetections } from "@jargonslayer/core/detect/dedupe";
import type { DetectMode } from "./detect/scheduler";
import type { OnDeviceMode } from "./stt/onDeviceSpeech";
import * as storage from "./history/storage";
import * as glossary from "./history/glossary";
import * as learnset from "./learn/store";
import { filterSuppressed } from "./learn/suppress";
import { schedule, type SrsGrade } from "@jargonslayer/core/learn/srs";
import * as autoExporter from "./history/autoExport";
import type { CustomEntry } from "@jargonslayer/core/types";
import type { LearnKind, LearnRecord } from "@jargonslayer/core/learn/types";
import { activateTheme } from "./theme/apply";
import { writeDisplayMirror } from "./theme/displayStorage";
import { getBuiltinTheme } from "./theme/themes";
import { isRemotelyKilled, SUBSCRIPTION_DIRECT_BUILT } from "./agent/localHost";
import { PREVIEW_TIER } from "./deployTier";
import { IS_DESKTOP } from "./platform/desktop";
import { diagLog } from "./diag/log";
import { resolveSessionElapsedBasis, type PauseInterval } from "./segmentElapsed";

// Debounced persistence for post-stop mutations (late detections,
// transcript edits) — one timer, latest state wins.
let postStopSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** `scheduledGen`/`currentGen` guard against a meeting-boundary race:
 * if the user starts a new meeting (bumping meetingGen) before this
 * debounce fires, the save would otherwise persist the WRONG (new,
 * current) live state under the OLD meeting's mutation. Skip silently
 * when the gen has moved on. Exported (like the pure helpers below)
 * so the debounce-vs-gen-bump race is directly unit-testable without
 * driving the zustand store or mocking IndexedDB. */
export function scheduleSessionSave(
  save: () => Promise<unknown>,
  scheduledGen: number,
  currentGen: () => number,
): void {
  if (postStopSaveTimer) clearTimeout(postStopSaveTimer);
  postStopSaveTimer = setTimeout(() => {
    postStopSaveTimer = null;
    if (currentGen() !== scheduledGen) return;
    void save();
  }, 1500);
}

export interface LookupRequest {
  text: string; // selected text
  contextText: string; // surrounding segment text, for disambiguation
  x: number; // viewport coords for the popover
  y: number;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

// `ref` (diagnostics, e.g. "JS-K3F9" — see lib/diag/log.ts): optional,
// additive field on the existing object variant — every pre-existing
// `{message, action}` / plain-string call site keeps compiling and
// rendering exactly as before (see Toast.tsx). Set by an error-class
// choke point (DetectionScheduler/TranslateQueue onError, STT engine
// onStatus("error")/onDiarStatus — see useMeeting.ts) alongside the
// SAME ref already attached to that error's diag ring-buffer entry, so
// a user can point a bug report at one exact log line.
export type ToastState =
  | string
  | { message: string; action?: ToastAction; ref?: string }
  | null;

// ---------------------------------------------------------------
// Realtime speaker diarization (beta) — pure helpers, exported so
// they're unit-testable independent of zustand (see store.test.ts;
// there's no pre-existing store test file to follow the pattern of,
// so the store action bodies below are kept as thin wrappers around
// these extracted pure functions, mirroring how detect/dedupe.ts's
// mergeDetections is tested directly).
// ---------------------------------------------------------------

/** Apply one `speaker_update` (already-changed-only assignments from
 * the sidecar) onto the current segment list: for each assignment,
 * find the segment by `sttSeg`, set its raw stable id (`sttSpeaker`)
 * and its DISPLAY `speaker` (alias-mapped, falling back to the stable
 * id itself when unaliased). Pure — does not touch aliases; the alias
 * map itself is only ever written by a user rename (see
 * aliasesAfterRename), never by an auto-update — that's what makes
 * "rename-wins" hold. */
export function applySpeakerUpdateToSegments(
  segments: TranscriptSegment[],
  assignments: { segId: number; speaker: string }[],
  aliases: Record<string, string>,
): TranscriptSegment[] {
  if (assignments.length === 0) return segments;
  const bySegId = new Map(assignments.map((a) => [a.segId, a.speaker]));
  return segments.map((s) => {
    const stableId = bySegId.get(s.sttSeg ?? -1);
    if (stableId === undefined) return s;
    return { ...s, sttSpeaker: stableId, speaker: aliases[stableId] ?? stableId };
  });
}

/** Existing rename behavior: every segment currently DISPLAYING
 * `from` gets its `speaker` overwritten to the cleaned `to`. Segments
 * with no `speaker` set, or a different one, are untouched. */
export function renameSpeakerInSegments(
  segments: TranscriptSegment[],
  from: string,
  to: string,
): TranscriptSegment[] {
  return segments.map((s) => (s.speaker === from ? { ...s, speaker: to } : s));
}

/** Meeting-boundary guard for realtime speaker diarization updates:
 * a `speaker_update` from a PREVIOUS meeting's engine session
 * (captured `expectedGen` at session start, see useMeeting.ts) must
 * not be applied once the store has moved on to a new meeting/session
 * context (`currentGen` bumped) — sttSeg numbering restarts per
 * engine session, so a stale update could otherwise collide with an
 * unrelated segment in the new meeting that happens to reuse the same
 * small sttSeg number. */
export function shouldApplySpeakerUpdate(
  currentGen: number,
  expectedGen: number,
): boolean {
  return currentGen === expectedGen;
}

/** Rename-wins: record `aliases[stableId] = to` for every distinct
 * stable id currently displaying as `from` (stableId = the segment's
 * `sttSpeaker ?? from` — falls back to `from` itself for
 * non-diarized/demo speakers, so the same rename behavior as before
 * realtime diarization existed still works unchanged). A later
 * `applySpeakerUpdate` for that stable id then re-resolves `speaker`
 * through this alias, so an auto-update can never clobber the rename.
 * Usually all `from`-displaying segments share one stable id (that's
 * why they display the same name); if they don't (a rare transition-
 * window edge case), every one of them gets aliased to `to`. */
export function aliasesAfterRename(
  segments: TranscriptSegment[],
  aliases: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  const next = { ...aliases };
  for (const s of segments) {
    if (s.speaker !== from) continue;
    const stableId = s.sttSpeaker ?? from;
    next[stableId] = to;
  }
  return next;
}

interface AppState {
  // settings
  settings: Settings;
  hydrated: boolean;

  // live meeting
  status: MeetingStatus;
  statusDetail: string | null;
  // On-device Web Speech (Chrome 139+, `processLocally` — see
  // docs/research/stt-live-engines-2026-07.md item #1 and
  // lib/stt/onDeviceSpeech.ts): which mode the ACTIVE webspeech
  // session actually reported at start (STTEvents.onEngineMode, wired
  // through useMeeting.ts). Lets StatusLine's privacy indicator show
  // the same green "音频未离开本机" posture whisper/tabaudio use instead
  // of the amber cloud warning. null = no active webspeech session has
  // reported a mode yet this meeting — every other engine never calls
  // onEngineMode, so StatusLine falls back to its existing
  // ENGINE_POSTURE map. Reset alongside the rest of the live-meeting
  // slice in beginMeeting/newMeeting.
  sttEngineMode: OnDeviceMode | null;
  startedAt: number | null;
  // Monotonically increasing generation counter — bumped whenever a
  // fresh meeting/session context begins (beginMeeting/newMeeting/
  // loadSession, i.e. anywhere segments/cards are wiped for a new
  // context). Used to silently drop stale async results (late detect
  // responses, debounced saves) that belong to a PREVIOUS meeting —
  // see the scheduler's gen capture and scheduleSessionSave above.
  meetingGen: number;
  segments: TranscriptSegment[];
  interim: InterimState | null;
  // Pause/resume/end (B2): total ms spent paused so far this meeting,
  // and the wall-clock moment the CURRENT pause began (null when not
  // paused). Both reset alongside the rest of the live-meeting slice
  // in beginMeeting/newMeeting. See elapsedActiveMs above for the pure
  // math that excludes paused time from the displayed elapsed timer.
  pausedAccumMs: number;
  pauseStartedAt: number | null;
  // Transcript-timestamp fix: every COMPLETED pause this meeting, as
  // {start, end} — pausedAccumMs above is enough for the live ticking
  // readout (elapsedActiveMs only ever needs "how much has been paused
  // so far, as of now"), but not enough to map an OLDER segment's own
  // elapsed time, which must only exclude pauses that happened BEFORE
  // it (see segmentElapsed.ts's segmentElapsedMs). Kept alongside
  // (not instead of) pausedAccumMs so elapsedActiveMs's existing
  // signature — Header.tsx's ElapsedTimer imports it directly — stays
  // untouched. Reset alongside pausedAccumMs/pauseStartedAt in
  // beginMeeting/newMeeting; one interval appended per resumeMeeting.
  pauseIntervals: PauseInterval[];
  // realtime speaker diarization (beta): stable id -> user-chosen
  // display name, written only by renameSpeaker (see rename-wins in
  // applySpeakerUpdate/aliasesAfterRename above).
  speakerAliases: Record<string, string>;
  // Live bilingual transcript (#42): segment id -> translated text,
  // written by applyTranslations (see TranslateQueue.onTranslations).
  translations: Record<string, string>;

  // detection results
  cards: ExpressionCard[];
  terms: TermCard[];
  detectBusy: boolean;
  detectMode: DetectMode;
  focusCardId: string | null; // transcript highlight → card scroll/flash

  // lookup popover (transcript selection → explanation)
  lookup: LookupRequest | null;

  // post-meeting
  summary: SummaryResult | null;
  summarizing: boolean;

  // history
  sessions: SessionMeta[];
  activeSessionId: string | null; // non-null when viewing a saved session

  // personal dictionary (global, cross-meeting)
  customEntries: CustomEntry[];
  learnset: Record<string, LearnRecord>;

  // ui
  toast: ToastState;
  focusMode: boolean; // 专注模式：折叠右栏，hover 看高亮释义

  // Sidecar status (owner ask 2026-07-11: "I cannot see in the GUI if
  // the local side got set up at all"): last known GET /health result
  // for the local Whisper sidecar, written by SettingsDialog's 转录引擎
  // status line (see lib/stt/sidecarHealth.ts's probeSidecar) so
  // StatusLine's privacy-segment tooltip can hint when the CURRENTLY
  // SELECTED engine's sidecar isn't reachable without StatusLine
  // running its own duplicate probe. Nothing here polls on its own —
  // this is just the last probe's outcome, whenever one last ran.
  // null = not probed yet this session.
  sidecarUp: boolean | null;

  // Subscription-direct (v0.2.2, experimental) kill-switch layer 3
  // race guard: true once hydrate()'s isRemotelyKilled() check has
  // resolved (success OR failure — isRemotelyKilled itself never
  // rejects, always resolving to a fail-open boolean; "resolved" here
  // just means "we've had our one chance to hear from flags.json").
  // Starts false on every fresh app load. client.ts's routing branch
  // treats "not yet settled" as "subscription-direct not currently
  // usable" (fail CLOSED for this specific startup race window only —
  // NOT the same posture as isRemotelyKilled's own fail-open contract,
  // which still governs what happens once the fetch actually settles)
  // — otherwise a detect/define call landing in the brief window
  // between hydrated:true and the remote check resolving would use
  // subscription-direct even though a same-session remote kill would
  // have disabled it, defeating the "already-shipped builds can be
  // remotely killed within one page load" guarantee. See Codex's
  // adversarial-review finding (store.ts hydrate() vs client.ts
  // shouldAttemptSubscriptionDirect) this was added to close.
  subscriptionKillCheckSettled: boolean;

  // ---- actions ----
  hydrate: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => void;

  setStatus: (status: MeetingStatus, detail?: string | null) => void;
  setSttEngineMode: (mode: OnDeviceMode | null) => void;
  beginMeeting: () => void; // clears live state, stamps startedAt
  // Pause/resume (B2): pauseMeeting stamps pauseStartedAt and flips to
  // "paused"; resumeMeeting folds (now - pauseStartedAt) into
  // pausedAccumMs, clears pauseStartedAt, and flips back to
  // "listening". Both are thin — useMeeting.ts's pause()/resume() own
  // tearing down/reattaching the actual engine around these calls.
  pauseMeeting: () => void;
  resumeMeeting: () => void;
  addFinal: (
    text: string,
    opts?: { speaker?: string; startedAt?: number; sttSeg?: number },
  ) => TranscriptSegment;
  setInterim: (interim: InterimState | null) => void;
  // realtime speaker diarization (beta): back-labels already-sent
  // segments by sttSeg. Works while status === "listening" (a plain
  // set() — no status gating). See applySpeakerUpdateToSegments.
  // `expectedGen` is the meetingGen captured when the engine session
  // that produced this update was started (useMeeting.ts) — a late
  // update from a PREVIOUS meeting's engine is silently dropped if
  // the store has since moved to a new gen (meeting-boundary guard;
  // sttSeg numbering restarts per engine session, so a stale update
  // could otherwise collide with an unrelated segment in the new
  // meeting that happens to reuse the same small sttSeg number).
  // Post-stop diarization linger: the sidecar's own final pass can
  // still deliver one of these after the session was already saved
  // (up to POST_STOP_LINGER_MS later — see wsTransport.ts) — same
  // top-up re-save as applyTranslations/applyDetection below, so the
  // labels this update carries aren't lost from history.
  applySpeakerUpdate: (
    assignments: { segId: number; speaker: string }[],
    speakers: string[],
    expectedGen: number,
  ) => void;
  // Live bilingual transcript (#42): merges a translated-segment batch
  // from TranslateQueue.onTranslations. `gen` is the meetingGen
  // captured at that batch's dispatch time — a payload whose gen no
  // longer matches the current one belongs to a PREVIOUS meeting and
  // is silently dropped (same guard style as applyDetection/
  // applySpeakerUpdate above).
  applyTranslations: (map: Record<string, string>, gen: number) => void;
  // Drop one segment's translation (e.g. after a text edit — the old
  // translation no longer matches the corrected English).
  invalidateTranslation: (segmentId: string) => void;

  applyDetection: (
    res: DetectResponse,
    source: DetectionSource,
    meta?: { batchWindowStart?: number },
  ) => void;
  setDetectBusy: (busy: boolean) => void;
  setDetectMode: (mode: DetectMode) => void;
  setFocusCard: (id: string | null) => void;
  setLookup: (req: LookupRequest | null) => void;

  setSummary: (s: SummaryResult | null) => void;
  setSummarizing: (v: boolean) => void;

  // transcript editing (stopped/imported sessions)
  renameSpeaker: (from: string, to: string) => void;
  updateSegmentText: (segmentId: string, text: string) => void;

  saveCurrentSession: () => Promise<string | null>;
  loadSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  newMeeting: () => void;

  addCustomEntry: (entry: CustomEntry) => Promise<void>;
  updateCustomEntry: (entry: CustomEntry) => Promise<void>;
  removeCustomEntry: (id: string) => Promise<void>;

  markKnown: (
    kind: LearnKind,
    surface: string,
    mode?: "vote" | "suppress",
  ) => Promise<void>;
  unsuppressLearnRecord: (key: string) => Promise<void>;
  // SRS review grade (#48 step 2): lazily enrolls on the first grade
  // (same posture as markKnown's first vote), then runs SM-2-lite
  // (learn/srs.ts's schedule) to compute the next dueAt/ease/etc.
  gradeReview: (kind: LearnKind, surface: string, grade: SrsGrade) => Promise<void>;

  showToast: (toast: Exclude<ToastState, null>) => void;
  clearToast: () => void;
  setFocusMode: (v: boolean) => void;
  setSidecarUp: (up: boolean | null) => void;
}

/** S9/D7 platform engine coercion — desktop never shows tabaudio
 *  (Tauri's WKWebView has no getDisplayMedia tab-share picker to fail
 *  into; the appaudio CoreAudio-tap card takes its slot instead, see
 *  Header.tsx/SettingsDialog.tsx/TutorialOverlay.tsx's own IS_DESKTOP
 *  swaps), and web never shows appaudio (Tauri-only, D6). A stored
 *  engine from the OTHER platform — e.g. a full-tier backup exported on
 *  desktop and restored on a web build, or vice versa (SettingsDialog's
 *  全量备份/恢复, #57) — must not resurrect a picker entry this platform
 *  no longer offers, so it's coerced to this platform's own equivalent
 *  instead of surviving as an orphaned value nothing can select again.
 *  Pure so it's unit-testable without depending on the IS_DESKTOP
 *  build-time env const (tests pass `isDesktop` directly; migrateSettings
 *  below is the only real caller, feeding it the actual IS_DESKTOP) —
 *  mirrors applyTierDefaults' own shape immediately below. */
export function applyPlatformEngineDefaults(settings: Settings, isDesktop: boolean): Settings {
  if (isDesktop && settings.engine === "tabaudio") {
    return { ...settings, engine: "appaudio" };
  }
  if (!isDesktop && settings.engine === "appaudio") {
    return { ...settings, engine: "tabaudio" };
  }
  return settings;
}

/** Preview tier (#61) engine defaults — pure so it's unit-testable
 *  without depending on the PREVIEW_TIER build-time env const (tests
 *  pass `isPreview` directly; migrateSettings below is the only real
 *  caller, feeding it the actual PREVIEW_TIER). Two independent
 *  coercions, both no-ops when `isPreview` is false (full tier
 *  unaffected):
 *   1. A saved engine of "whisper"/"tabaudio" (sidecar-only, greyed in
 *      preview — see Header.tsx's ENGINE_OPTIONS) OR "soniox" (BYOK
 *      cloud, same preview lock via ENGINE_OPTIONS' byokOnly — v0.4 S4
 *      blueprint decision E) is coerced to "webspeech" so a returning
 *      preview user's start button still does real transcription
 *      instead of silently trying a disabled engine. "appaudio" joins
 *      this list too (S9/D7) — structurally, not because it's ever
 *      actually reachable here: appaudio is desktop-only, and the
 *      preview tier is a hosted WEB build, so applyPlatformEngineDefaults
 *      above would already have coerced any stored "appaudio" away to
 *      "tabaudio" before this function ever sees it on a real preview
 *      build (migrateSettings runs both, platform first) — same
 *      "extend the engine-legality function even though this exact
 *      build can't reach it" posture soniox's own listing here already
 *      set as precedent.
 *   2. True first run only — `hadSavedEngine` is false — is coerced
 *      from the default "demo" to "webspeech" so the start button does
 *      real transcription out of the box, without a trip to Settings.
 *      `demo` stays reachable via the ≡ menu at any time (see
 *      useMeeting.ts's startDemo, which persists engine:"demo" itself)
 *      — this coercion only fires when there was NO saved engine key
 *      at all, never when a returning user's own saved value happens
 *      to equal "demo" (e.g. they last quit mid-demo). */
export function applyTierDefaults(
  settings: Settings,
  isPreview: boolean,
  hadSavedEngine: boolean,
): Settings {
  if (!isPreview) return settings;
  if (
    settings.engine === "whisper" ||
    settings.engine === "tabaudio" ||
    settings.engine === "appaudio" ||
    settings.engine === "soniox"
  ) {
    return { ...settings, engine: "webspeech" };
  }
  if (!hadSavedEngine && settings.engine === "demo") {
    return { ...settings, engine: "webspeech" };
  }
  return settings;
}

/** Returns both the filtered lists AND whatever was removed (Codex/
 *  #48 s1 review item 1): markKnown's 撤销 undo needs to put a
 *  suppressed live card back, not just revert the learn-set record —
 *  without this, undo silently discarded the card/term the first
 *  suppression removed. */
function removeLiveLearnKey(
  cards: ExpressionCard[],
  terms: TermCard[],
  key: string,
): {
  cards: ExpressionCard[];
  terms: TermCard[];
  removedCards: ExpressionCard[];
  removedTerms: TermCard[];
} {
  const removedCards = cards.filter(
    (card) => learnset.learnKey("expression", card.expression) === key,
  );
  const removedTerms = terms.filter((term) => learnset.learnKey("term", term.term) === key);
  return {
    cards: cards.filter(
      (card) => learnset.learnKey("expression", card.expression) !== key,
    ),
    terms: terms.filter((term) => learnset.learnKey("term", term.term) !== key),
    removedCards,
    removedTerms,
  };
}

/** After hydrate() merges the persisted learn-set with whatever the
 *  zustand store already has (see hydrate() below — action-wins merge,
 *  #48 s1 review item 2), re-run suppression over whatever cards/terms
 *  are currently live: a suppressed-term detection landing in the
 *  hydrate window would have been filtered against the still-empty
 *  starting learnset (applyDetection's filterSuppressed reads
 *  get().learnset synchronously) and become a live card that must not
 *  survive hydration finishing. Pure so it's unit-testable without
 *  driving hydrate() end-to-end. */
export function filterSuppressedLiveCards(
  cards: ExpressionCard[],
  terms: TermCard[],
  records: Record<string, LearnRecord>,
): { cards: ExpressionCard[]; terms: TermCard[] } {
  return {
    cards: cards.filter(
      (card) => !records[learnset.learnKey("expression", card.expression)]?.suppressed,
    ),
    terms: terms.filter((term) => !records[learnset.learnKey("term", term.term)]?.suppressed),
  };
}

// ---------------------------------------------------------------
// Per-learnKey mutation serialization (Codex/#48 s1 review item 5):
// two near-simultaneous markKnown/gradeReview calls for the SAME
// learnKey (e.g. a double-tap on 太简单) must not both read the same
// stale record and both compute the same "next" value — each must see
// the effect of the one immediately before it. Every mutation here is
// already async (awaits IndexedDB via learn/store.ts), so a simple
// per-key promise chain is enough to serialize without a real lock:
// queue this call behind whatever's currently running for the same
// key, so by the time its body actually executes, the previous call's
// `set()` has already landed and reads see fresh state.
// ---------------------------------------------------------------
const learnKeyQueues = new Map<string, Promise<unknown>>();

function withLearnKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = learnKeyQueues.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Track the queue with a rejection-swallowing tail so one failed
  // mutation never permanently wedges the queue for that key — the
  // real result (including any rejection) still flows to THIS call's
  // own returned promise via `run` above.
  learnKeyQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Fold persisted settings over defaults, migrating legacy field
 *  shapes. #54: pre-v0.2.2 settings had dictionaryOnly (force
 *  offline) instead of aiDetect (opt into the LLM upgrade layer) —
 *  a user who chose offline-only stays offline-only. The legacy key
 *  is stripped so it doesn't get re-persisted forever. */
export function migrateSettings(saved: Partial<Settings> | null | undefined): Settings {
  const legacy = (saved ?? {}) as Partial<Settings> & { dictionaryOnly?: boolean };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...legacy };
  if (legacy.aiDetect === undefined && typeof legacy.dictionaryOnly === "boolean") {
    settings.aiDetect = !legacy.dictionaryOnly;
  }
  delete (settings as { dictionaryOnly?: boolean }).dictionaryOnly;
  // S9/D7 platform coercion runs FIRST — see applyPlatformEngineDefaults'
  // own doc for why (an engine value must be legal for THIS platform
  // before preview-tier legality is even meaningful to ask about).
  const platformSettings = applyPlatformEngineDefaults(settings, IS_DESKTOP);
  // Preview tier (#61) — see applyTierDefaults' own doc for the two
  // coercions and why "first run" is `saved`'s own engine key, not the
  // post-fold value (a returning user's persisted engine:"demo", from
  // running the ≡ menu's 演示, must NOT be re-coerced).
  return applyTierDefaults(platformSettings, PREVIEW_TIER, !!saved && "engine" in saved);
}

// ---------------------------------------------------------------
// Pause/resume elapsed-time math (B2) — pure, unit-tested independent
// of zustand, same posture as the realtime-diarization helpers above.
// ---------------------------------------------------------------

/** Live meeting elapsed time EXCLUDING paused spans. `pausedAccumMs`
 *  is the running total of every PREVIOUS pause's duration (folded in
 *  by resumeMeeting on each resume — see below); while a pause is
 *  CURRENTLY in progress (`pauseStartedAt` non-null), the readout
 *  freezes at the instant pauseMeeting() fired instead of ticking
 *  forward with `now` — the ongoing pause's own duration only gets
 *  folded into pausedAccumMs at the NEXT resumeMeeting(). `startedAt:
 *  null` (no meeting yet) is 0. Pure epoch-ms subtraction throughout —
 *  no Date/timezone-aware math at all, so this is inherently
 *  DST-agnostic (see the unit tests). Exported so Header.tsx's
 *  ElapsedTimer renders the exact same math the store itself uses to
 *  fold a pause on resume. */
export function elapsedActiveMs(
  startedAt: number | null,
  now: number,
  pausedAccumMs: number,
  pauseStartedAt: number | null,
): number {
  if (startedAt === null) return 0;
  const upTo = pauseStartedAt ?? now;
  return Math.max(0, upTo - startedAt - pausedAccumMs);
}

/** Pause bookkeeping for a PERSISTED/exported session snapshot
 *  (saveCurrentSession / currentSessionSnapshot below — codex v2
 *  review finding F5): `pauseIntervals` only ever gets a completed
 *  {start,end} entry appended by resumeMeeting() above — ending a
 *  meeting WHILE paused (doStop() flips straight "paused" -> "stopped"
 *  with no intervening resumeMeeting()), or exporting/copying mid-
 *  pause (SummaryPanel's currentSessionSnapshot() call sites aren't
 *  gated on status), snapshots the live array with the CURRENT pause
 *  still open — its seconds would then read as active time forever in
 *  that snapshot. Returns a NEW array with the open interval closed at
 *  `snapshotAt` (a no-op passthrough when `pauseStartedAt` is null —
 *  the common case). Snapshot-local only: NEVER mutates live state or
 *  clears `pauseStartedAt` — a non-terminal snapshot taken mid-pause
 *  (e.g. an export) must not disturb a LATER resumeMeeting() in the
 *  SAME meeting, which still needs the real, still-open
 *  `pauseStartedAt` to compute its own fold correctly. */
export function pauseIntervalsForSnapshot(
  pauseIntervals: PauseInterval[],
  pauseStartedAt: number | null,
  snapshotAt: number,
): PauseInterval[] {
  if (pauseStartedAt === null) return pauseIntervals;
  return [...pauseIntervals, { start: pauseStartedAt, end: snapshotAt }];
}

export const useApp = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  status: "idle",
  statusDetail: null,
  sttEngineMode: null,
  startedAt: null,
  meetingGen: 0,
  segments: [],
  interim: null,
  pausedAccumMs: 0,
  pauseStartedAt: null,
  pauseIntervals: [],
  speakerAliases: {},
  translations: {},

  cards: [],
  terms: [],
  detectBusy: false,
  detectMode: "llm",
  focusCardId: null,
  lookup: null,

  summary: null,
  summarizing: false,

  sessions: [],
  activeSessionId: null,

  customEntries: [],
  learnset: {},

  toast: null,
  focusMode: false,
  sidecarUp: null,

  subscriptionKillCheckSettled: false,

  hydrate: async () => {
    const [saved, metas, entries] = await Promise.all([
      storage.loadSettings(),
      storage.listSessions(),
      glossary.loadCustomEntries(),
      learnset.loadLearnset(),
    ]);
    const learned = await learnset.refreshStaleSuppressedLearnset();
    const settings = migrateSettings(saved);
    // Hydration atomicity (Codex/#48 s1 review item 2a): the UI is
    // interactive (zustand store already exists) before this async
    // hydrate() resolves — a markKnown/gradeReview/addCustomEntry that
    // fires during that window already wrote straight into
    // get().learnset via its own `set()`. Clobbering learnset with the
    // freshly-loaded `learned` map here would silently discard that
    // write. Action-wins merge: `learned` first, then whatever's
    // already live in the store — see learn/store.ts's loadLearnset
    // for the matching module-cache-side reconciliation (an upsert
    // racing the disk read must win there too, or this merge would
    // just be re-importing a stale value under a different name).
    const mergedLearnset = { ...learned, ...get().learnset };
    set({
      settings,
      sessions: metas,
      customEntries: entries,
      learnset: mergedLearnset,
      hydrated: true,
    });
    // Item 2b: re-run suppression over whatever cards/terms are live
    // right now — a suppressed-term detection landing in the same
    // window would have been filtered against the starting (empty)
    // learnset and slipped through as a live card. Only touches
    // cards/terms when something actually needs dropping.
    const cleaned = filterSuppressedLiveCards(get().cards, get().terms, mergedLearnset);
    if (cleaned.cards.length !== get().cards.length || cleaned.terms.length !== get().terms.length) {
      set({ cards: cleaned.cards, terms: cleaned.terms });
    }
    // The FOUC inline script (layout.tsx) already applied best-effort
    // theme/data-fs from its localStorage mirror before this resolved
    // — this re-applies from the authoritative IndexedDB-backed
    // Settings once hydration finishes, correcting any mismatch (e.g.
    // first load ever, a stale/absent mirror, or a value set on a
    // different browser) and mirroring it forward for next time.
    writeDisplayMirror({ themeId: settings.themeId, fontSize: settings.fontSize });
    const theme = getBuiltinTheme(settings.themeId);
    if (theme) activateTheme(theme.id, theme.tokens, theme.scheme);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.fs = settings.fontSize;
    }
    // Ask the browser not to evict IndexedDB under storage pressure
    // (Safari's 7-day eviction, Chrome quota GC). Best-effort.
    try {
      if (typeof navigator !== "undefined" && navigator.storage?.persist) {
        void navigator.storage.persist();
      }
    } catch {
      // non-fatal
    }

    // Subscription-direct (v0.2.2, experimental) kill-switch layer 3:
    // an emergency remote hide for already-shipped builds — see
    // agent/localHost.ts's isRemotelyKilled for the fail-open contract
    // (fetch failure/timeout/404/malformed = allowed; only an explicit
    // {"subscriptionDirect": false} response disables it). Fire-and-
    // forget, AFTER the synchronous `set` above already marked
    // hydrated: true — this must never delay app startup waiting on a
    // network fetch. If killed and the user's own settings currently
    // have it on, force it back off (persisting the flip so it stays
    // off across reloads) and drop the toggle back into Settings'
    // default posture; SUBSCRIPTION_DIRECT_BUILT is always false when
    // NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT is unset (kill switch
    // layer 2), so this fetch never fires in a build that didn't set
    // the flag — see localHost.ts's SUBSCRIPTION_DIRECT_BUILT doc for
    // the runtime-vs-build-time-elimination distinction.
    //
    // subscriptionKillCheckSettled: when there's actually a remote
    // check in flight (the if-branch below), it stays false until that
    // .then() fires — closing the startup race window client.ts's
    // routing branch checks (see the AppState field's own doc for the
    // full rationale). When there's NO check to wait for (this whole
    // if-branch is skipped — either the build doesn't have the
    // feature, or the user's own toggle is off), there's no race to
    // guard against, so it's set true immediately in the else branch —
    // otherwise a build/user-config that never even attempts
    // subscription-direct would be stuck permanently "unsettled" and
    // that flag would end up meaning nothing.
    if (SUBSCRIPTION_DIRECT_BUILT && settings.subscriptionDirect) {
      void isRemotelyKilled()
        .then((killed) => {
          if (killed) get().updateSettings({ subscriptionDirect: false });
        })
        .finally(() => set({ subscriptionKillCheckSettled: true }));
    } else {
      set({ subscriptionKillCheckSettled: true });
    }
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void storage.saveSettings(settings);
    // Display settings (v0.2.1): live-apply a theme change immediately
    // (rather than waiting for a reload) and mirror themeId/fontSize
    // to localStorage so the FOUC script can read them synchronously
    // on the next load — see lib/theme/displayStorage.ts. Only fires
    // when this patch actually touches one of the two mirrored fields,
    // so every other settings save (API key, engine, …) stays a no-op
    // here.
    if ("themeId" in patch || "fontSize" in patch) {
      writeDisplayMirror({ themeId: settings.themeId, fontSize: settings.fontSize });
    }
    if ("themeId" in patch) {
      const theme = getBuiltinTheme(settings.themeId);
      if (theme) activateTheme(theme.id, theme.tokens, theme.scheme);
    }
    if ("fontSize" in patch && typeof document !== "undefined") {
      document.documentElement.dataset.fs = settings.fontSize;
    }
  },

  setStatus: (status, detail = null) =>
    set({ status, statusDetail: detail ?? null }),
  setSttEngineMode: (sttEngineMode) => set({ sttEngineMode }),

  beginMeeting: () =>
    set((state) => ({
      status: "connecting",
      statusDetail: null,
      sttEngineMode: null,
      startedAt: Date.now(),
      meetingGen: state.meetingGen + 1,
      segments: [],
      interim: null,
      pausedAccumMs: 0,
      pauseStartedAt: null,
      pauseIntervals: [],
      speakerAliases: {},
      translations: {},
      cards: [],
      terms: [],
      summary: null,
      focusCardId: null,
      lookup: null,
      activeSessionId: null,
    })),

  // Pause/resume/end (B2). See elapsedActiveMs above for the paired
  // pure math these two actions' state feeds.
  pauseMeeting: () => set({ status: "paused", pauseStartedAt: Date.now() }),

  resumeMeeting: () =>
    set((state) => {
      const now = Date.now();
      const pausedAccumMs = state.pausedAccumMs + (now - (state.pauseStartedAt ?? now));
      // Transcript-timestamp fix: record the completed interval too
      // (see the AppState field's own doc) — skipped when
      // pauseStartedAt was already null (the defensive tolerance this
      // action has always had), same as pausedAccumMs staying
      // unchanged in that case.
      const pauseIntervals =
        state.pauseStartedAt !== null
          ? [...state.pauseIntervals, { start: state.pauseStartedAt, end: now }]
          : state.pauseIntervals;
      return {
        status: "listening",
        pausedAccumMs,
        pauseStartedAt: null,
        pauseIntervals,
      };
    }),

  addFinal: (text, opts) => {
    const { segments, settings } = get();
    const now = Date.now();
    const seg: TranscriptSegment = {
      id: newId(),
      index: segments.length,
      startedAt: opts?.startedAt ?? now,
      endedAt: now,
      speaker: opts?.speaker,
      text: text.trim(),
      engine: settings.engine,
      sttSeg: opts?.sttSeg,
    };
    set({ segments: [...segments, seg] });
    // Personal glossary matches ride on the segment funnel so every
    // engine and every detect mode benefits; counted exactly once
    // per occurrence here (other sources never bump custom cards).
    if (settings.autoDetect) {
      const hits = glossary.scanCustomEntries(seg.text);
      if (hits.expressions.length > 0 || hits.terms.length > 0) {
        get().applyDetection(hits, "custom");
      }
    }
    return seg;
  },

  setInterim: (interim) => set({ interim }),

  applySpeakerUpdate: (assignments, _speakers, expectedGen) => {
    // `_speakers` (the sidecar's full active-speaker list) isn't
    // needed to update segments — display names are derived per-
    // segment via aliases — but kept in the signature per the wire
    // contract / STTEvents.onSpeakerUpdate shape for callers that may
    // want it later (e.g. an active-speakers indicator).
    // Meeting-boundary guard: drop updates from a previous gen (see
    // AppState.applySpeakerUpdate doc comment above / shouldApplySpeakerUpdate).
    if (!shouldApplySpeakerUpdate(get().meetingGen, expectedGen)) return;
    set({
      segments: applySpeakerUpdateToSegments(
        get().segments,
        assignments,
        get().speakerAliases,
      ),
    });
    // Post-stop diarization linger (see AppState.applySpeakerUpdate's
    // own doc above): the sidecar's final pass can resolve after the
    // session was already saved on stop — same top-up re-save as
    // applyTranslations/applyDetection/renameSpeaker/updateSegmentText.
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  applyTranslations: (map, gen) => {
    // Meeting-boundary guard, same shape as applySpeakerUpdate above.
    if (gen !== get().meetingGen) return;
    set({ translations: { ...get().translations, ...map } });
    // Same top-up as applyDetection above: a batch dispatched just
    // before stop resolves after the session was saved — without a
    // re-save those tail translations exist on screen but not in
    // history.
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  invalidateTranslation: (segmentId) => {
    const rest = { ...get().translations };
    delete rest[segmentId];
    set({ translations: rest });
  },

  applyDetection: (res, source, meta) => {
    res = filterSuppressed(res, source, get().learnset);
    const { cards, terms, settings } = get();
    const merged = mergeDetections(
      cards,
      terms,
      res,
      source,
      settings.minConfidence,
      Date.now(),
      meta?.batchWindowStart !== undefined
        ? { llmCountSuppressSince: meta.batchWindowStart }
        : undefined,
    );
    set({ cards: merged.cards, terms: merged.terms });
    // The final flush on stop resolves asynchronously (up to ~8s
    // later). If results land after the session was already saved,
    // top up the saved copy so history isn't missing tail cards.
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  setDetectBusy: (detectBusy) => set({ detectBusy }),
  setDetectMode: (detectMode) => set({ detectMode }),
  setFocusCard: (focusCardId) => set({ focusCardId }),
  setLookup: (lookup) => set({ lookup }),

  setSummary: (summary) => set({ summary }),
  setSummarizing: (summarizing) => set({ summarizing }),

  renameSpeaker: (from, to) => {
    const cleaned = to.trim();
    if (!cleaned || from === cleaned) return;
    const { segments } = get();
    // Rename-wins: record the alias BEFORE overwriting `speaker` below
    // (aliasesAfterRename reads segments' current `speaker`/`sttSpeaker`
    // to find each affected stable id) — a later applySpeakerUpdate for
    // that stable id then re-resolves through this alias, so it can
    // never clobber the rename.
    const speakerAliases = aliasesAfterRename(segments, get().speakerAliases, from, cleaned);
    set({
      segments: renameSpeakerInSegments(segments, from, cleaned),
      speakerAliases,
    });
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  updateSegmentText: (segmentId, text) => {
    // Committed-mutation tripwire (fix #A5): this action only exists
    // for a STOPPED session's transcript-correction UI (TranscriptPanel
    // gates the edit affordance itself on status==="stopped") — no
    // live path (webSpeech/whisperSocket/tabaudio/demo, or a future
    // engine) may ever mutate already-committed text. Refuse the write
    // and log rather than silently accepting a call that shouldn't be
    // possible; PRIVACY: segment id + status only, never the text.
    const status = get().status;
    if (status !== "stopped") {
      diagLog(
        "warn",
        "stt-committed-mutation",
        "refused to mutate committed transcript text outside a stopped session",
        `segmentId=${segmentId} status=${status}`,
      );
      return;
    }
    const cleaned = text.trim();
    if (!cleaned) return;
    set({
      segments: get().segments.map((s) =>
        s.id === segmentId ? { ...s, text: cleaned } : s,
      ),
    });
    // The old translation was for the pre-edit English text — stale
    // now, so drop it (useMeeting.ts re-enqueues it for a fresh
    // translation while the meeting is still live and the toggle is on).
    get().invalidateTranslation(segmentId);
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  saveCurrentSession: async () => {
    const s = get();
    if (s.segments.length === 0) return null;
    const startedAt = s.startedAt ?? s.segments[0].startedAt;
    const d = new Date(startedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const session: MeetingSession = {
      id: s.activeSessionId ?? newId(),
      title: `会议 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate(),
      )} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      startedAt,
      endedAt: s.segments[s.segments.length - 1].endedAt,
      engine: s.settings.engine,
      segments: s.segments,
      cards: s.cards,
      terms: s.terms,
      summary: s.summary ?? undefined,
      speakerAliases:
        Object.keys(s.speakerAliases).length > 0 ? s.speakerAliases : undefined,
      translations:
        Object.keys(s.translations).length > 0 ? s.translations : undefined,
      // Transcript-timestamp fix: always persisted (even []) — unlike
      // speakerAliases/translations above, emptiness here is NOT
      // interchangeable with absence: presence (even []) means "this
      // meeting's pause bookkeeping is known and complete", while
      // absence means "unknown/legacy" (see MeetingSession's own doc
      // and resolveSessionElapsedBasis in segmentElapsed.ts). Snapshot-
      // closes a still-open pause (F5: End-from-paused) — see
      // pauseIntervalsForSnapshot's own doc above.
      pauseIntervals: pauseIntervalsForSnapshot(s.pauseIntervals, s.pauseStartedAt, Date.now()),
    };
    await storage.saveSession(session);
    const metas = await storage.listSessions();
    set({ sessions: metas, activeSessionId: session.id });
    // Agent-native output layer (both no-op unless configured).
    const { autoExport, exportFrontmatter, webhookUrl } = s.settings;
    if (autoExport) {
      void autoExporter.exportSessionToFolder(session, {
        frontmatter: exportFrontmatter,
      });
    }
    if (webhookUrl) {
      void autoExporter.postWebhook(session, webhookUrl);
    }
    return session.id;
  },

  loadSession: async (id) => {
    const session = await storage.getSession(id);
    if (!session) {
      get().showToast("会话不存在或已删除");
      return;
    }
    // #48 s1 review item 12b: a saved session's cards/terms are
    // deliberately NOT re-filtered against the CURRENT learn-set here
    // — history is an immutable archive of what a meeting actually
    // showed at the time, not a live view that should retroactively
    // hide cards for terms suppressed LATER. Only live detection
    // (applyDetection's filterSuppressed) and the hydrate-window
    // cleanup (filterSuppressedLiveCards, see hydrate() above) ever
    // drop a card for being suppressed.
    // Transcript-timestamp fix: resolves the elapsed-time basis (zero
    // point + completed pauses) this session should render with —
    // see resolveSessionElapsedBasis's own doc for the legacy-session
    // (no persisted pauseIntervals) fallback.
    const { startedAt, pauseIntervals } = resolveSessionElapsedBasis(session);
    set((state) => ({
      status: "stopped",
      statusDetail: null,
      startedAt,
      meetingGen: state.meetingGen + 1,
      segments: session.segments,
      interim: null,
      // A loaded/stopped session has no LIVE pause in progress and no
      // further live pause bookkeeping to accumulate — reset both so
      // neither carries over from whatever meeting the store was
      // previously in (pauseIntervals above already carries this
      // session's own history).
      pausedAccumMs: 0,
      pauseStartedAt: null,
      pauseIntervals,
      speakerAliases: session.speakerAliases ?? {},
      translations: session.translations ?? {},
      cards: session.cards,
      terms: session.terms,
      summary: session.summary ?? null,
      activeSessionId: session.id,
      focusCardId: null,
      lookup: null,
    }));
  },

  deleteSession: async (id) => {
    await storage.deleteSession(id);
    const metas = await storage.listSessions();
    const patch: Partial<AppState> = { sessions: metas };
    if (get().activeSessionId === id) {
      patch.activeSessionId = null;
    }
    set(patch);
  },

  addCustomEntry: async (entry) => {
    const list = await glossary.upsertCustomEntry(entry);
    set({ customEntries: [...list] });
    // Lazy SRS enrollment (#48 step 2): a glossary save is itself a
    // familiarity signal, so it auto-enrolls (dueAt=now) — but only
    // the FIRST time this learnKey appears; never resets an already-
    // enrolled record's schedule (a later edit of the same entry goes
    // through updateCustomEntry, which does not re-enroll).
    const key = learnset.learnKey(entry.kind, entry.headword);
    if (!get().learnset[key]) {
      const record = learnset.makeInitialLearnRecord(entry.kind, entry.headword, Date.now());
      try {
        const map = await learnset.upsertLearnRecord(record);
        set({ learnset: { ...map } });
      } catch (err) {
        // #48 s1 review item 3: the glossary entry itself already
        // saved above — only the SRS auto-enrollment failed to
        // persist. Surface it rather than silently pretending it
        // succeeded (learn/store.ts stays pure of UI and just throws).
        console.warn("[store] addCustomEntry SRS enrollment persist failed", err);
        get().showToast("学习记录保存失败");
      }
    }
  },

  updateCustomEntry: async (entry) => {
    const list = await glossary.upsertCustomEntry({
      ...entry,
      updatedAt: Date.now(),
    });
    set({ customEntries: [...list] });
  },

  removeCustomEntry: async (id) => {
    const list = await glossary.deleteCustomEntry(id);
    set({ customEntries: [...list] });
  },

  markKnown: (kind, surface, mode = "vote") => {
    const key = learnset.learnKey(kind, surface);
    // #48 s1 review item 5: serialize concurrent mutations to the SAME
    // learnKey — two rapid 太简单 taps must not both read the same
    // stale familiarity and both compute the same "next" value.
    return withLearnKeyLock(key, async () => {
      // Freshest-record read: with the per-key queue above, any
      // earlier call for this same key has already fully finished
      // (including its own `set()`) before this one starts, so
      // get().learnset[key] is never a stale snapshot from a call
      // that raced ahead of this one. The one case where the zustand
      // copy could otherwise drift from learn/store.ts's own module
      // cache — a persist failure (#48 s1 review item 3) — is
      // reconciled back onto zustand in the catch block below, so this
      // read stays the single source of truth in every case.
      const previous = get().learnset[key];
      const now = Date.now();
      const base = previous ?? learnset.makeInitialLearnRecord(kind, surface, now);
      const familiarity =
        mode === "suppress"
          ? learnset.KNOWN_SUPPRESS_FAMILIARITY
          : Math.min(
              learnset.KNOWN_SUPPRESS_FAMILIARITY,
              base.familiarity + learnset.KNOWN_VOTE_INCREMENT,
            );
      // #48 s1 review item 12a: a card with prior familiarity >= 0.5
      // (i.e. it already survived one 认识 vote) suppresses on a
      // SINGLE further tap by design — two votes total, never two
      // more from wherever familiarity happened to be. A mis-tap is
      // recoverable via the 撤销 undo in the toast below, so this
      // stays a one-way ratchet rather than needing a confirmation.
      const suppressed =
        mode === "suppress" ||
        familiarity >= learnset.KNOWN_SUPPRESS_FAMILIARITY;
      const next: LearnRecord = {
        ...base,
        surface,
        familiarity,
        suppressed,
        suppressedAt: suppressed ? now : base.suppressedAt,
        updatedAt: now,
      };

      let map: Record<string, LearnRecord>;
      try {
        map = await learnset.upsertLearnRecord(next);
      } catch (err) {
        // #48 s1 review item 3: a persist failure must never show the
        // usual success toast — learn/store.ts stays pure of UI and
        // just throws/rejects; this is the one place that turns it
        // into a visible error.
        console.warn("[store] markKnown persist failed", err);
        // Reconcile zustand back onto the module cache even on
        // failure — persist() always assigns `cache = next` before it
        // can throw (see learn/store.ts), so cache may already be
        // ahead of the zustand copy at this point; without this, a
        // later read of get().learnset[key] would be stale relative
        // to what upsertLearnRecord/removeLearnRecord will use next.
        set({ learnset: { ...learnset.getCachedLearnset() } });
        get().showToast("本次标记保存失败");
        return;
      }
      set({ learnset: { ...map } });

      if (suppressed) {
        // #48 s1 review item 1: capture what removeLiveLearnKey
        // actually removed so 撤销 can put the card/term BACK, not
        // just revert the learn-set record (previously the card was
        // simply discarded — undo only fixed the badge, not the UI).
        const removedFromLive = removeLiveLearnKey(get().cards, get().terms, key);
        set({ cards: removedFromLive.cards, terms: removedFromLive.terms });
        get().showToast({
          message: "已记为熟悉，将减少提示",
          action: {
            label: "撤销",
            run: () => {
              void (async () => {
                try {
                  const restored = previous
                    ? await learnset.upsertLearnRecord(previous)
                    : await learnset.removeLearnRecord(key);
                  set({
                    learnset: { ...restored },
                    cards: [...get().cards, ...removedFromLive.removedCards],
                    terms: [...get().terms, ...removedFromLive.removedTerms],
                  });
                } catch (err) {
                  console.warn("[store] markKnown undo persist failed", err);
                  get().showToast("撤销失败，请重试");
                }
              })();
            },
          },
        });
      } else {
        get().showToast("熟悉度 +1");
      }
    });
  },

  unsuppressLearnRecord: async (key) => {
    const record = get().learnset[key];
    if (!record) return;
    const next: LearnRecord = {
      ...record,
      suppressed: false,
      dueAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      const map = await learnset.upsertLearnRecord(next);
      set({ learnset: { ...map } });
    } catch (err) {
      console.warn("[store] unsuppressLearnRecord persist failed", err);
      get().showToast("恢复提示保存失败");
    }
  },

  gradeReview: (kind, surface, grade) => {
    const key = learnset.learnKey(kind, surface);
    // Same per-key serialization as markKnown above — a double-tapped
    // grade button must not race itself either (#48 s1 review item 5).
    return withLearnKeyLock(key, async () => {
      const now = Date.now();
      // Lazy enrollment: grading a recent-meeting card that has no
      // learn-set record yet (composeReviewQueue's "recent, not
      // enrolled" bucket) starts it fresh right here. Freshest-record
      // read — see markKnown's own comment above (per-key queue +
      // catch-block reconciliation keeps get().learnset current).
      const base = get().learnset[key] ?? learnset.makeInitialLearnRecord(kind, surface, now);
      const next = schedule(base, grade, now);

      let map: Record<string, LearnRecord>;
      try {
        map = await learnset.upsertLearnRecord(next);
      } catch (err) {
        console.warn("[store] gradeReview persist failed", err);
        set({ learnset: { ...learnset.getCachedLearnset() } });
        get().showToast("本次评分保存失败");
        return;
      }
      set({ learnset: { ...map } });

      // Auto-suppression (interval >= 30d AND familiarity >= 0.85 on a
      // 认识 grade) behaves like a markKnown suppression for any card
      // still live in the current meeting — never surface it again.
      if (next.suppressed && !base.suppressed) {
        const removedFromLive = removeLiveLearnKey(get().cards, get().terms, key);
        set({ cards: removedFromLive.cards, terms: removedFromLive.terms });
      }
    });
  },

  newMeeting: () =>
    set((state) => ({
      status: "idle",
      statusDetail: null,
      sttEngineMode: null,
      startedAt: null,
      meetingGen: state.meetingGen + 1,
      segments: [],
      interim: null,
      pausedAccumMs: 0,
      pauseStartedAt: null,
      pauseIntervals: [],
      speakerAliases: {},
      translations: {},
      cards: [],
      terms: [],
      summary: null,
      summarizing: false,
      focusCardId: null,
      lookup: null,
      activeSessionId: null,
    })),

  showToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),
  setFocusMode: (focusMode) => set({ focusMode }),
  setSidecarUp: (sidecarUp) => set({ sidecarUp }),
}));

/** Meta helper kept here so UI code doesn't rebuild it. */
export function currentSessionSnapshot(): MeetingSession | null {
  const s = useApp.getState();
  if (s.segments.length === 0) return null;
  return {
    id: s.activeSessionId ?? "unsaved",
    title: "当前会议",
    startedAt: s.startedAt ?? s.segments[0].startedAt,
    endedAt: s.segments[s.segments.length - 1].endedAt,
    engine: s.settings.engine,
    segments: s.segments,
    cards: s.cards,
    terms: s.terms,
    summary: s.summary ?? undefined,
    speakerAliases:
      Object.keys(s.speakerAliases).length > 0 ? s.speakerAliases : undefined,
    translations:
      Object.keys(s.translations).length > 0 ? s.translations : undefined,
    // Transcript-timestamp fix: same "always present" posture as
    // saveCurrentSession — see that field's own comment above. Also
    // snapshot-closes a still-open pause the same way (F5) — this
    // snapshot can be taken mid-pause too (e.g. SummaryPanel's export
    // row shows whenever segments exist, regardless of status).
    pauseIntervals: pauseIntervalsForSnapshot(s.pauseIntervals, s.pauseStartedAt, Date.now()),
  };
}
