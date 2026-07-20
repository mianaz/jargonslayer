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
  type STTEngineKind,
  type SummaryResult,
  type TermCard,
  type TranscriptSegment,
} from "@jargonslayer/core/types";
import { mergeDetections } from "@jargonslayer/core/detect/dedupe";
import type { DetectMode } from "./detect/scheduler";
import type { OnDeviceMode } from "./stt/onDeviceSpeech";
import * as storage from "./history/storage";
import * as liveDraft from "./history/liveDraft";
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
import { PREVIEW_TIER, SONIOX_PREVIEW_LANE } from "./deployTier";
import { IS_DESKTOP } from "./platform/desktop";
import { IS_IOS } from "./platform/ios";
import { diagLog } from "./diag/log";
import { resolveSessionElapsedBasis, type PauseInterval } from "./segmentElapsed";
import { remapOpenRouterModelDefaults } from "./oauth/openrouterModelDefaults";

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
  // Stable per-selection id, minted once in TranscriptPanel's
  // selectionLookupRequest (background 划词 card generation, v0.5
  // closeout) — keys the background pipeline's progress state
  // (lib/tasks/selectionLookup.ts's useSelectionLookup) so the detect/
  // dictionary pipeline can run to completion independent of this
  // popover's own open/closed lifecycle. See LookupPopover.tsx's header
  // comment for the bug this fixes (closing the popover used to discard
  // an in-flight ~20s AI result).
  id: string;
  text: string; // selected text
  contextText: string; // surrounding segment text, for disambiguation
  x: number; // viewport coords for the popover
  y: number;
}

// lib/llm/client.ts already imports `useApp` FROM this file (its own
// header comment) — a static import here of anything that reaches
// detectApi (lib/tasks/selectionLookup.ts -> llm/client.ts) would close
// a real cycle back into store.ts. A dynamic import resolves after this
// module has already finished its own top-level evaluation, so there's
// no cycle in practice; mirrors lib/desktop/bootstrap.ts's/lib/oauth/
// openrouterDesktop.ts's own `await import("../store")` idiom for
// exactly this class of problem, just applied in the opposite
// direction (keeping llm/client.ts's own sizeable graph — provider
// clients, subscription-direct, telemetry — out of THIS file's static
// graph instead). runSelectionLookup itself never throws (see that
// module's own doc), so this fire-and-forget is safe.
async function triggerSelectionLookup(req: LookupRequest, settings: Settings): Promise<void> {
  const { runSelectionLookup } = await import("./tasks/selectionLookup");
  void runSelectionLookup(req, settings);
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
 * "rename-wins" hold.
 *
 * v0.5 Wave-1 Feature 1 / §5 A2 (manual-assignment guard, REWRITTEN
 * from a rev-1 draft that skipped locked segments wholesale): the
 * sidecar sends CHANGED-ONLY assignments (whisper_server.py:1126-1148)
 * — a locked segment may never appear in another update again, so
 * dropping it wholesale would permanently discard its raw stable id.
 * A locked segment's `sttSpeaker` therefore still updates; only its
 * manually-assigned DISPLAY `speaker` is protected. Unlock (跟随识别,
 * see unlockSegmentSpeaker below) clears the lock and recomputes
 * `speaker` from the alias map. */
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
    if (s.speakerLocked) return { ...s, sttSpeaker: stableId };
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

// ---------------------------------------------------------------
// v0.5 Wave-1 Feature 1 (owner amendment — unbounded roster, default
// unassigned, multi-select, retroactive-following, live latch; docs/
// design-explorations/v05-wave1-blueprint.md §1 Feature 1 + §5 A2) —
// pure helpers for the manual speaker roster + per-segment assignment,
// same "thin store action wraps an extracted pure function" pattern as
// the realtime-diarization helpers immediately above.
// ---------------------------------------------------------------

/** Soft cap (§5 A1: "cap 200 enforced in store", not merely a UI
 *  decoration) — a roster this large is almost certainly a stuck/
 *  runaway auto-number loop rather than a real meeting's speaker list. */
export const SPEAKER_ROSTER_CAP = 200;

/** Add a name to the roster, or auto-number "说话人 N" (smallest N not
 *  already taken) when `name` is omitted/blank. Trims a provided name;
 *  a name already present (or a full roster) is a no-op on the roster
 *  itself, but the resolved name is still returned so a caller can
 *  still use it (e.g. re-selecting an existing entry by name). Pure. */
export function addSpeakerToRosterList(
  roster: string[],
  name?: string,
): { roster: string[]; name: string } {
  const trimmed = name?.trim();
  const resolved =
    trimmed ||
    (() => {
      let n = 1;
      while (roster.includes(`说话人 ${n}`)) n++;
      return `说话人 ${n}`;
    })();
  if (roster.includes(resolved) || roster.length >= SPEAKER_ROSTER_CAP) {
    return { roster, name: resolved };
  }
  return { roster: [...roster, resolved], name: resolved };
}

/** Rename a roster entry in place. Refuses (returns null — caller
 *  no-ops) a blank result or a collision with a DIFFERENT existing
 *  entry, so the roster never ends up with two entries sharing one
 *  display name. Pure — segment/alias rewrite is the caller's job (the
 *  store action delegates to the existing renameSpeaker path). */
export function renameRosterSpeakerList(
  roster: string[],
  from: string,
  to: string,
): string[] | null {
  const cleaned = to.trim();
  if (!cleaned || from === cleaned || roster.includes(cleaned)) return null;
  return roster.map((r) => (r === from ? cleaned : r));
}

/** Bulk per-segment assignment (single assign = a one-element
 *  `segmentIds` array) — sets `speaker` + `speakerLocked:true` on every
 *  matching segment, manual-wins semantics matching the A2 guard above. */
export function assignSpeakerToSegments(
  segments: TranscriptSegment[],
  segmentIds: string[],
  name: string,
): TranscriptSegment[] {
  const ids = new Set(segmentIds);
  return segments.map((s) =>
    ids.has(s.id) ? { ...s, speaker: name, speakerLocked: true } : s,
  );
}

/** Retroactive "this and everything after" (应用到本句及之后): assigns
 *  `segmentId` AND every segment arriving after it (array/arrival
 *  order — TranscriptSegment.index is exactly this order). An unknown
 *  `segmentId` is a no-op (same array returned). */
export function assignSpeakerFollowingInSegments(
  segments: TranscriptSegment[],
  segmentId: string,
  name: string,
): TranscriptSegment[] {
  const idx = segments.findIndex((s) => s.id === segmentId);
  if (idx === -1) return segments;
  return segments.map((s, i) => (i >= idx ? { ...s, speaker: name, speakerLocked: true } : s));
}

/** 跟随识别 unlock: clears `speakerLocked` on one segment and recomputes
 *  its DISPLAY `speaker` from `aliases[sttSpeaker] ?? sttSpeaker` — the
 *  same resolution applySpeakerUpdateToSegments uses — falling back to
 *  whatever `speaker` already held when the segment has no `sttSpeaker`
 *  at all (never diarized; nothing to "follow" back to). An unknown
 *  `segmentId` is a no-op. */
export function unlockSpeakerInSegments(
  segments: TranscriptSegment[],
  segmentId: string,
  aliases: Record<string, string>,
): TranscriptSegment[] {
  return segments.map((s) => {
    if (s.id !== segmentId) return s;
    const speaker = s.sttSpeaker !== undefined ? aliases[s.sttSpeaker] ?? s.sttSpeaker : s.speaker;
    return { ...s, speakerLocked: false, speaker };
  });
}

/** Legacy-session roster fallback (§5 A2: "legacy loaded sessions
 *  derive roster from unique segment.speaker values"): a session saved
 *  before the roster feature existed has no `speakerRoster` at all —
 *  reconstruct one from whatever distinct display names its segments
 *  already carry, in first-seen order, so a loaded old session still
 *  gets a working roster instead of starting from an empty one despite
 *  having named speakers on screen already. */
export function deriveRosterFromSegments(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>();
  for (const s of segments) {
    if (s.speaker) seen.add(s.speaker);
  }
  return [...seen];
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
  // the same green "音频在本地处理" posture whisper/tabaudio use instead
  // of the amber cloud warning. null = no active webspeech session has
  // reported a mode yet this meeting — every other engine never calls
  // onEngineMode, so StatusLine falls back to ENGINE_OPTIONS's own
  // posture field (lib/stt/engineOptions.ts). Reset alongside the rest
  // of the live-meeting slice in beginMeeting/newMeeting.
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
  // v0.5 Wave-1 Feature 1 (manual speaker roster, owner amendment): this
  // meeting's manually-managed speaker names — starts empty (no
  // pre-seeded speakers), grows via addSpeakerToRoster, reset in
  // beginMeeting/loadSession/newMeeting, persisted ALWAYS (even []) in
  // saveCurrentSession (see MeetingSession.speakerRoster's own doc for
  // why "always", unlike speakerAliases/translations below).
  speakerRoster: string[];
  // Live latch (F1): while set, addFinal stamps this roster name onto
  // every NEW finalized segment that arrives with no speaker of its own
  // (see addFinal below) — until switched (setActiveSpeaker) or cleared
  // (null). NOT persisted in Settings and NOT part of a saved
  // MeetingSession (a live-only ergonomic aid, same posture as `interim`
  // below); reset in beginMeeting/loadSession/newMeeting.
  activeSpeaker: string | null;
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
  // v0.5 Wave-1 Feature 2 (AI transcript correction, batch/review-gated
  // — docs/design-explorations/v05-wave1-blueprint.md §1 Feature 2 + §5
  // A5): true while the batch correction call is in flight. Review
  // state itself (proposed changes, per-row accept/ignore) lives in the
  // CorrectionReview component, not here — this flag only gates the
  // trigger button/spinner. Reset on begin/load/new (a stale busy flag
  // from a previous meeting/session must never survive into a new one).
  correctionBusy: boolean;

  // history
  sessions: SessionMeta[];
  activeSessionId: string | null; // non-null when viewing a saved session

  // personal dictionary (global, cross-meeting)
  customEntries: CustomEntry[];
  learnset: Record<string, LearnRecord>;

  // ui
  toast: ToastState;
  focusMode: boolean; // 专注模式：折叠右栏，hover 看高亮释义
  // Floating caption (S14): desktop-only "shrink the main window into a
  // caption strip" mode — page.tsx swaps its ENTIRE layout for
  // FloatingCaption while this is true (see that component + lib/
  // captionWindow.ts's own docs). Web's own floating caption is a
  // Document Picture-in-Picture window instead (lib/captionWindow.ts),
  // which never touches this flag — it doesn't change THIS window's
  // layout at all. Non-persisted, same posture as focusMode above (an
  // ergonomic session toggle, not a Settings field).
  captionMode: boolean;

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
  // `opts.persist` (S14.1 field fix, default true): useMeeting.ts's
  // startDemo passes `{ persist: false }` when setting engine:"demo" —
  // a live demo session is entirely in-memory (settings.engine is read
  // live by attachEngine/addFinal for the duration of that one tab
  // session) and never needs to survive a reload, so writing it to
  // storage only risks stranding a returning user on a start button
  // that silently replays the demo (see applyTierDefaults' own doc for
  // the exact field report this closes). Every other call site omits
  // `opts` and persists exactly as before.
  updateSettings: (patch: Partial<Settings>, opts?: { persist?: boolean }) => void;

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
  // v0.5 Wave-1 Feature 1 (manual speaker roster + per-segment
  // assignment — see the pure helpers above this interface for the
  // exact semantics each wraps). Available whenever a session exists
  // (stopped/paused/listening) — a USER action, not an engine mutation,
  // so unlike updateSegmentText/updateCard/updateTerm below these are
  // NOT gated to status==="stopped" (doc §1 F1's own "UX shape"); each
  // still triggers the same post-stop re-save top-up as every other
  // post-stop-reachable mutation in this file when the meeting has
  // already ended.
  addSpeakerToRoster: (name?: string) => string; // returns the resolved (trimmed/auto-numbered) name
  renameRosterSpeaker: (from: string, to: string) => void;
  assignSegmentsSpeaker: (segmentIds: string[], name: string) => void;
  assignSpeakerFollowing: (segmentId: string, name: string) => void;
  setActiveSpeaker: (name: string | null) => void;
  unlockSegmentSpeaker: (segmentId: string) => void;
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
  // v0.5 Wave-1 Feature 2 (AI transcript correction) — see the
  // `correctionBusy` field's own doc above.
  setCorrectionBusy: (v: boolean) => void;

  // transcript editing (stopped/imported sessions)
  renameSpeaker: (from: string, to: string) => void;
  // Finding 3 fix (pre-merge review): returns true when the mutation
  // was actually applied, false when the stopped-only tripwire (or a
  // blank/whitespace-only text) refused it — see the implementation's
  // own doc. CorrectionReview.tsx is the one caller that acts on this;
  // every other caller may ignore the return value unchanged.
  updateSegmentText: (segmentId: string, text: string) => boolean;
  // v0.5 Wave-1 Feature 7 (inline card edit, docs/design-explorations/
  // v05-wave1-blueprint.md §1 Feature 7): patches editable fields by id
  // — expression/meaning/chinese_explanation/plain_english for a card,
  // term/gloss_en/gloss_zh for a term. Same committed-mutation tripwire
  // as updateSegmentText above (status==="stopped" only, fix #A5's
  // posture extended to cards/terms) + post-stop re-save.
  updateCard: (
    id: string,
    patch: Partial<
      Pick<ExpressionCard, "expression" | "meaning" | "chinese_explanation" | "plain_english">
    >,
  ) => void;
  updateTerm: (id: string, patch: Partial<Pick<TermCard, "term" | "gloss_en" | "gloss_zh">>) => void;

  // H1 fix (Sol adversarial review): null now ALSO covers "the
  // underlying storage.saveSession write failed" (previously null only
  // ever meant "no segments to save") — this action shows its own
  // 保存失败 toast and skips clearing the live draft on that path, so no
  // caller needs to branch on WHY it came back null; every existing
  // caller (useMeeting.ts's doStop/runStopFlow, SummaryPanel.tsx) may
  // still treat a non-null id as "saved" and null as "nothing to do".
  saveCurrentSession: () => Promise<string | null>;
  loadSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  // Crash/refresh recovery (v0.5 closeout — lib/history/liveDraft.ts's
  // own header comment has the full write policy/multi-tab caveat).
  // Materializes a RecoveryBanner-recovered draft snapshot via the SAME
  // storage.saveSession/listSessions pair saveCurrentSession uses below,
  // so the session appears in 历史 exactly like any normally-ended
  // meeting — deliberately NOT routed through the live segments/cards
  // slice (unlike saveCurrentSession), since the draft may belong to a
  // different meeting than whatever is (or isn't) currently live in this
  // tab (see RecoveryBanner's "new meeting keeps the draft" contract).
  // `draftId` is the SAME id RecoveryBanner loaded this snapshot under
  // (liveDraft.ts's deriveDraftId) — passed straight through to
  // liveDraft.clearDraft's compare-and-delete on success. H1 fix:
  // returns whether the underlying save actually landed — RecoveryBanner
  // only dismisses itself on true; on false the draft (and banner) stay
  // put and this shows its own 恢复失败 toast.
  restoreLiveDraft: (snapshot: MeetingSession, draftId: string) => Promise<boolean>;
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
  setCaptionMode: (v: boolean) => void;
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
 *
 *  S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
 *  item #1): desktop ALSO coerces a persisted "webspeech" to "whisper"
 *  (the local sidecar mic engine) — Tauri's WKWebView has no
 *  SpeechRecognition API at all, so webspeech has never once worked on
 *  desktop (unlike tabaudio, which at least had a picker-shaped reason
 *  to exist there before S9). Wave 2 drops webspeech from the desktop
 *  ENGINE_OPTIONS picker entirely (mirroring this same file's own
 *  tabaudio precedent) — this coercion lands FIRST so a returning
 *  desktop user who last quit on webspeech is never stranded on an
 *  engine the picker no longer even offers. Deliberately NOT appaudio:
 *  webspeech is a MIC engine (like whisper), appaudio is SYSTEM audio —
 *  substituting the wrong capture source would be a worse landing than
 *  the dead engine itself.
 *
 *  Pure so it's unit-testable without depending on the IS_DESKTOP
 *  build-time env const (tests pass `isDesktop` directly; migrateSettings
 *  below is the only real caller, feeding it the actual IS_DESKTOP) —
 *  mirrors applyTierDefaults' own shape immediately below.
 *
 *  S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md):
 *  web also coerces a stored "osspeech" to "tabaudio" — osspeech is
 *  Tauri-only (desktop's macOS SpeechAnalyzer helper has no web
 *  equivalent), the identical D6 rationale appaudio's own web-side
 *  coercion already documents above. No OS-version coercion here either
 *  (Q8): the macOS-26 floor is an engineOptions.ts option-gate + a
 *  start_os_speech runtime re-check, not a platform swap.
 *
 *  S13 (docs/design-explorations/s13-ios-blueprint.md, §6): iOS v1's
 *  ENGINE_OPTIONS is osspeech-only (engineOptions.ts) — a persisted
 *  engine from any OTHER platform (a full-tier backup restored on an
 *  iOS device, or a device that was on an earlier build before this
 *  engine existed) is coerced to osspeech, the one iOS default, rather
 *  than surviving as an orphaned picker value. Checked FIRST and returns
 *  early: isDesktop is always false on an iOS build (D4 — IS_DESKTOP
 *  means exactly "macOS desktop shell"), so without this early return
 *  a stored "appaudio"/"osspeech" would otherwise fall into the `
 *  !isDesktop` web-coercion branches below and land on tabaudio, an
 *  engine iOS never offers either. No reverse (iOS -> other platform)
 *  coercion is needed: osspeech already exists on desktop, and web's own
 *  osspeech->tabaudio coercion above already covers a stored osspeech
 *  landing on a web build.
 *
 *  v0.5 Wave-1 Feature 4 (docs/design-explorations/v05-wave1-blueprint.
 *  md §1 Feature 4 + §5 A4): desktop ALSO coerces a persisted
 *  "tabaudio-cloud" to "appaudio" — same D7 rationale as "tabaudio"
 *  itself immediately below (WKWebView has no tab-share picker to fail
 *  into, cloud backend or not) — tabaudio-cloud is web-only for v0.5
 *  (desktop already has sidecar+appaudio). No web/iOS coercion needed:
 *  tabaudio-cloud is legal on web as-is, and iOS's own isIos branch
 *  above already sweeps every non-osspeech/demo value (including this
 *  one) to osspeech before this line is ever reached. */
export function applyPlatformEngineDefaults(settings: Settings, isDesktop: boolean, isIos = false): Settings {
  if (isIos) {
    if (settings.engine === "osspeech" || settings.engine === "demo") return settings;
    return { ...settings, engine: "osspeech" };
  }
  if (isDesktop && settings.engine === "tabaudio") {
    return { ...settings, engine: "appaudio" };
  }
  if (isDesktop && settings.engine === "tabaudio-cloud") {
    return { ...settings, engine: "appaudio" };
  }
  if (isDesktop && settings.engine === "webspeech") {
    return { ...settings, engine: "whisper" };
  }
  if (!isDesktop && settings.engine === "appaudio") {
    return { ...settings, engine: "tabaudio" };
  }
  if (!isDesktop && settings.engine === "osspeech") {
    return { ...settings, engine: "tabaudio" };
  }
  return settings;
}

/** Preview tier (#61) engine defaults — pure so it's unit-testable
 *  without depending on the PREVIEW_TIER build-time env const (tests
 *  pass `isPreview` directly; migrateSettings below is the only real
 *  caller, feeding it the actual PREVIEW_TIER). Two independent
 *  coercion groups, both no-ops when `isPreview` is false (full tier
 *  unaffected):
 *   1. A saved engine of "whisper"/"tabaudio" (sidecar-only, greyed in
 *      preview — see Header.tsx's ENGINE_OPTIONS) OR "soniox"/"deepgram"
 *      (BYOK cloud, same preview lock via ENGINE_OPTIONS' byokOnly —
 *      v0.4 S4 blueprint decision E / v0.4.7 Lane D) OR "tabaudio-cloud"
 *      (v0.5 Wave-1 F4 + §5 A4: byokOnly, web-only, genuinely reachable
 *      on a hosted preview build) is coerced to "webspeech" so a
 *      returning preview user's start button still does real
 *      transcription instead of silently trying a disabled engine.
 *      "appaudio" joins structurally, not because it's reachable:
 *      desktop-only, so applyPlatformEngineDefaults above already
 *      coerced any stored "appaudio" away before this function sees it
 *      on a real preview build (migrateSettings runs both, platform
 *      first) — same "extend the engine-legality function even though
 *      this exact build can't reach it" posture soniox's listing set as
 *      precedent. "osspeech" (S11) joins for the IDENTICAL
 *      structural-only reason.
 *   2. "demo" (S14.1 field fix — real owner report on the hosted
 *      preview): UNCONDITIONALLY coerced now, regardless of
 *      `_hadSavedEngine`. It used to coerce only on a true first run,
 *      on the theory that a returning user's persisted engine:"demo"
 *      meant "they last quit mid-demo". In the field that theory broke:
 *      ≡ 演示 persisted engine:"demo" the moment it ran, and nothing
 *      ever coerced it back — a returning preview user's 开始监听
 *      silently replayed the demo forever after. Fixed at the root in
 *      useMeeting.ts's startDemo (S14.1): it no longer persists
 *      engine:"demo" at all — this coercion only ever fires on a STALE
 *      pre-fix value or a hand-edited settings blob, safe to always
 *      redirect. `_hadSavedEngine` is kept in the signature
 *      (migrateSettings still feeds it; other call sites pass it) but
 *      is no longer read here.
 *
 *  Soniox preview lane (hosted trial, SONIOX_PREVIEW_LANE — deployTier.
 *  ts): a THIRD, independent exception on top of the two groups above —
 *  "soniox" is carved OUT of group 1's coercion (survives instead of
 *  falling to webspeech) when `sonioxPreviewLane` is true, since a
 *  preview user can now actually run it on a server-minted key (see
 *  stt/soniox.ts's SonioxEngine.start). "tabaudio-cloud" joins the SAME
 *  carve-out, UNCONDITIONALLY on the stored tabAudioCloudProvider —
 *  tabAudioCloud.ts's own start() always forces the identical
 *  minted-Soniox path on this lane (effectiveProvider), regardless of
 *  whether the persisted provider is "soniox" or a stale "deepgram" (no
 *  trial exists for Deepgram — see that file's own INVARIANT comment),
 *  so a persisted "deepgram" pick must not be re-coerced away here
 *  either; the RUNTIME override, not this coercion, is what makes a
 *  stale deepgram pick harmless. "tabaudio" (the local-sidecar engine,
 *  no cloud/mint path at all) is NOT part of this carve-out and keeps
 *  coercing exactly as before. Every OTHER byokOnly/sidecarOnly engine
 *  in group 1 (deepgram included) also keeps coercing exactly as
 *  before — the lane is a two-engine carve-out for the ONE lane-funded
 *  mechanism, not a blanket preview unlock. Defaults to the real
 *  build-time const so every existing call site (this function has
 *  two: migrateSettings below, and engineOptions.ts's
 *  deriveEngineForMode) keeps compiling and behaving unchanged without
 *  passing a 4th argument; tests drive it explicitly instead (see
 *  store.test.ts) since the pure-function contract is otherwise
 *  identical to isPreview/_hadSavedEngine above. */
export function applyTierDefaults(
  settings: Settings,
  isPreview: boolean,
  _hadSavedEngine: boolean,
  sonioxPreviewLane: boolean = SONIOX_PREVIEW_LANE,
): Settings {
  if (!isPreview) return settings;
  if (sonioxPreviewLane && (settings.engine === "soniox" || settings.engine === "tabaudio-cloud")) {
    return settings;
  }
  if (
    settings.engine === "whisper" ||
    settings.engine === "tabaudio" ||
    settings.engine === "tabaudio-cloud" ||
    settings.engine === "appaudio" ||
    settings.engine === "osspeech" ||
    settings.engine === "soniox" ||
    settings.engine === "deepgram" ||
    settings.engine === "demo"
  ) {
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

/** Field-test fix (v0.4.4, real user report): an existing user who
 *  connected OpenRouter BEFORE this fix shipped (or restored a pre-fix
 *  full backup, #57) has baseUrl=openrouter.ai persisted alongside a
 *  bare Anthropic-flavored detectModel/summaryModel — every detect/
 *  summary call 400s ("... is not a valid model ID") until they
 *  happen to retype the model field by hand. One-shot at hydrate,
 *  idempotent (an already-remapped or deliberately-custom slash-
 *  shaped model is a no-op on every later hydrate too — see
 *  remapOpenRouterModelDefaults' own doc comment for the exact
 *  heuristic). Gated on the baseUrl host so this NEVER touches an
 *  Anthropic-direct/DeepSeek-direct/Ollama/etc user's own models —
 *  exact same hostname check resolveLlmConfig's own isOpenRouter uses
 *  server-side, kept independent here rather than shared (that one's
 *  Node-only, reads a server env var, and lives in a completely
 *  different module). Pure so it's unit-testable without touching the
 *  real store, same posture as applyPlatformEngineDefaults/
 *  applyTierDefaults immediately above.
 *
 *  R2 ripple fix (v0.4.4): ALSO requires provider === "openai-compat"
 *  — a request only ever reaches OpenRouter when the provider is
 *  openai-compat (baseUrl is never even read for the anthropic
 *  provider — see taskHeaders/resolveTaskCreds). Before DEFAULT_
 *  SETTINGS.baseUrl became the OpenRouter URL (R2), a legacy/partial
 *  persisted blob that OMITTED baseUrl entirely safely folded in the
 *  old "" default (not OpenRouter) regardless of its own `provider`;
 *  after R2 it would instead silently inherit the new OpenRouter
 *  default baseUrl and get an explicitly-`provider:"anthropic"` user's
 *  perfectly-fine Claude models incorrectly remapped to DeepSeek slugs
 *  — exactly the "NEVER touches an Anthropic-direct... user" promise
 *  this function's own doc above already made. The provider check
 *  closes that gap without changing the hostname check's own behavior
 *  for any already-openai-compat settings object. */
export function applyOpenRouterModelDefaults(settings: Settings): Settings {
  if (settings.provider !== "openai-compat") return settings;
  let isOpenRouter = false;
  try {
    isOpenRouter = new URL(settings.baseUrl).hostname === "openrouter.ai";
  } catch {
    isOpenRouter = false;
  }
  if (!isOpenRouter) return settings;
  const patch = remapOpenRouterModelDefaults(settings);
  return Object.keys(patch).length > 0 ? { ...settings, ...patch } : settings;
}

/** v0.5 Wave-1 Feature 5 / §5 A3 — the three shells this repo builds
 *  for, named (rather than two booleans) because modeForPersistedEngine
 *  below has one genuinely three-way branch (osspeech). */
export type ModePlatform = "web" | "desktop" | "ios";

const VALID_MODES = new Set<Settings["mode"]>(["system-audio", "tab", "mic", "import", "url"]);

/** §5 A3: "persisted mode strings runtime-validated" — an untrusted/
 *  garbage/future-unknown value is treated as absent (triggers
 *  back-derivation below) rather than blindly trusted, unlike `engine`
 *  elsewhere in this file (no picker ever writes a bad `mode` string,
 *  but a hand-edited/cross-version IndexedDB blob could). */
function isValidMode(x: unknown): x is Settings["mode"] {
  return typeof x === "string" && VALID_MODES.has(x as Settings["mode"]);
}

/** §5 A3 (BLOCKER) — total, platform-aware back-derivation of `mode`
 *  from a persisted `engine`, for every returning user who saved
 *  settings before `mode` existed (or whose saved `mode` didn't
 *  validate — see isValidMode above). Exported for tests: this is the
 *  exact mapping the migration matrix pins.
 *
 *  `rawEngine` is the UNCOERCED value straight off the saved blob (may
 *  be undefined — a fresh install has none) — checked FIRST and only
 *  for "import"/"browser-whisper", because neither
 *  applyPlatformEngineDefaults nor applyTierDefaults has (or ever will
 *  have) a branch that produces those two values, so a raw import-
 *  origin engine would otherwise never be visible to this mapper once
 *  `legalEngine` has settled on some other, unrelated coerced value.
 *  `legalEngine` is the FULLY coerced (platform + tier) engine — every
 *  other branch reads it, since by then it's guaranteed legal for
 *  `platform`.
 *
 *  Mapping (§5 A3, verbatim): import/browser-whisper(raw)->import;
 *  tabaudio/tabaudio-cloud->tab; webspeech/whisper/soniox/deepgram->mic;
 *  appaudio->system-audio(desktop); osspeech->mic on iOS/system-audio on
 *  desktop; demo->platform's legal default capture mode; unknown-
 *  >platform default; NEVER url. */
export function modeForPersistedEngine(
  rawEngine: STTEngineKind | undefined,
  legalEngine: STTEngineKind,
  platform: ModePlatform,
): Settings["mode"] {
  if (rawEngine === "import" || rawEngine === "browser-whisper") return "import";
  switch (legalEngine) {
    case "tabaudio":
    case "tabaudio-cloud":
      return "tab";
    case "webspeech":
    case "whisper":
    case "soniox":
    case "deepgram":
      return "mic";
    case "appaudio":
      return "system-audio";
    case "osspeech":
      // osspeech spans both platforms with a different mode meaning on
      // each: iOS's only engine (mic-only v1) vs desktop's system-audio
      // CoreAudio-tap pairing (see appaudio's own branch above).
      return platform === "desktop" ? "system-audio" : "mic";
    case "demo":
    default:
      // demo (scripted preview, not a real capture mode) and any
      // unrecognized future value both fall back to "mic" — the one
      // mode legal on every platform (web/desktop/iOS all support mic
      // capture; system-audio/tab don't) — never "url".
      return "mic";
  }
}

/** Finding 4 fix (pre-merge review): isValidMode above only proves a
 *  persisted `mode` STRING is one of the 5 enum values — not that it's
 *  legal on THIS platform. A web backup's mode:"tab" restored on
 *  desktop (or "system-audio" restored on web/iOS) is syntactically
 *  valid but names a capture intent this platform can never satisfy.
 *  "mic" is legal everywhere (DEFAULT_SETTINGS' own comment); "import"/
 *  "url" are the import-family modes and are ALWAYS fine to keep —
 *  they're never tied to a capture engine's platform restrictions in
 *  the first place (same modes modeForPersistedEngine above NEVER
 *  derives except "import", but a persisted "url" surviving here is
 *  still legitimate: A3's own "locked is FINE to keep" ruling). */
export function isModeLegalForPlatform(mode: Settings["mode"], platform: ModePlatform): boolean {
  if (mode === "tab") return platform === "web";
  if (mode === "system-audio") return platform === "desktop";
  return true;
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
  const platformSettings = applyPlatformEngineDefaults(settings, IS_DESKTOP, IS_IOS);
  // Preview tier (#61) — see applyTierDefaults' own doc for the two
  // coercions and why "first run" is `saved`'s own engine key, not the
  // post-fold value (a returning user's persisted engine:"demo", from
  // running the ≡ menu's 演示, must NOT be re-coerced).
  const tierSettings = applyTierDefaults(platformSettings, PREVIEW_TIER, !!saved && "engine" in saved);
  // OpenRouter model remap runs LAST — unrelated to either coercion
  // above (detectModel/summaryModel vs. engine), order is arbitrary
  // either way, but this needs the fully-folded `baseUrl` (from
  // `legacy`/DEFAULT_SETTINGS above) to decide.
  const openRouterSettings = applyOpenRouterModelDefaults(tierSettings);
  // v0.5 Wave-1 Feature 5 / §5 A3: mode back-derivation. `hadSavedMode`
  // reads the RAW saved object, before the defaults fold above — mirrors
  // `hadSavedEngine`'s own "engine" in saved check for applyTierDefaults.
  // Runs LAST (after platform/tier coercion) so it derives `mode` from a
  // legal `engine`, per A3's own ordering requirement.
  //
  // Finding 4 fix (pre-merge review): hadSavedMode (isValidMode) alone
  // used to be the whole gate — kept unchanged as the FIRST half of
  // this check (a persisted mode must still be a syntactically real
  // value to even consider keeping) — now ALSO requires the value be
  // legal on THIS platform (isModeLegalForPlatform); when it isn't, a
  // platform-illegal-but-syntactically-valid persisted mode falls
  // through to the exact same back-derivation the no-saved-mode path
  // below already uses, rather than surviving hydration as a stale,
  // unavailable intent.
  const platform: ModePlatform = IS_IOS ? "ios" : IS_DESKTOP ? "desktop" : "web";
  if (isValidMode(legacy.mode) && isModeLegalForPlatform(legacy.mode, platform)) {
    return openRouterSettings;
  }
  return {
    ...openRouterSettings,
    mode: modeForPersistedEngine(legacy.engine, openRouterSettings.engine, platform),
  };
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
  speakerRoster: [],
  activeSpeaker: null,
  translations: {},

  cards: [],
  terms: [],
  detectBusy: false,
  detectMode: "llm",
  focusCardId: null,
  lookup: null,

  summary: null,
  summarizing: false,
  correctionBusy: false,

  sessions: [],
  activeSessionId: null,

  customEntries: [],
  learnset: {},

  toast: null,
  focusMode: false,
  captionMode: false,
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
    // Storage-durability request (navigator.storage.persist, asking the
    // browser not to evict IndexedDB under pressure — Safari's 7-day
    // eviction, Chrome quota GC) used to fire here at boot; moved to
    // useMeeting.ts's start() (first meeting start of a page load) —
    // Firefox actually prompts for this permission, and a prompt at
    // boot, before the user has done anything, is hostile. See that
    // call site's own comment.

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

  updateSettings: (patch, opts) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (opts?.persist !== false) {
      void storage.saveSettings(settings);
    }
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
      speakerRoster: [],
      activeSpeaker: null,
      translations: {},
      cards: [],
      terms: [],
      summary: null,
      correctionBusy: false,
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
    const { segments, settings, activeSpeaker } = get();
    const now = Date.now();
    // v0.5 Wave-1 Feature 1 (live latch): applies ONLY to a final that
    // arrives with no speaker of its own (demo/deepgram/soniox can
    // report one directly at finalize time; wsTransport's realtime
    // diarization only ever back-labels via a LATER speaker_update, so
    // its finals always arrive speaker-less here) — stamps the latched
    // roster name and marks it manually locked, same "manual wins"
    // semantics as a per-segment assignment (see applySpeakerUpdateToSegments'
    // A2 guard above).
    const latched = opts?.speaker === undefined && activeSpeaker !== null;
    const seg: TranscriptSegment = {
      id: newId(),
      index: segments.length,
      startedAt: opts?.startedAt ?? now,
      endedAt: now,
      speaker: opts?.speaker ?? (activeSpeaker ?? undefined),
      speakerLocked: latched ? true : undefined,
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

  // v0.5 Wave-1 Feature 1 (manual speaker roster + per-segment
  // assignment) — thin wrappers around the pure helpers defined above
  // this store, per this file's own established pattern. None of these
  // are gated to status==="stopped" (see AppState's own doc); each
  // schedules the same post-stop re-save top-up as applySpeakerUpdate
  // above whenever the meeting has already ended.
  addSpeakerToRoster: (name) => {
    const { roster, name: resolved } = addSpeakerToRosterList(get().speakerRoster, name);
    set({ speakerRoster: roster });
    // speakerRoster is ALWAYS persisted (see saveCurrentSession's own
    // doc) — a bare add with no segment assignment yet must still
    // survive a stopped session's re-save, same top-up as every other
    // mutation in this file.
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
    return resolved;
  },

  renameRosterSpeaker: (from, to) => {
    const next = renameRosterSpeakerList(get().speakerRoster, from, to);
    if (next === null) return;
    set({ speakerRoster: next });
    // Delegate the segment/alias rewrite to the existing rename-all
    // path (renameSpeaker below) — guarded once, above, so the roster
    // and the segments/aliases it labels never end up split-brain.
    get().renameSpeaker(from, to);
  },

  assignSegmentsSpeaker: (segmentIds, name) => {
    const cleaned = name.trim();
    if (!cleaned || segmentIds.length === 0) return;
    set({ segments: assignSpeakerToSegments(get().segments, segmentIds, cleaned) });
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  assignSpeakerFollowing: (segmentId, name) => {
    const cleaned = name.trim();
    if (!cleaned) return;
    set({ segments: assignSpeakerFollowingInSegments(get().segments, segmentId, cleaned) });
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  setActiveSpeaker: (activeSpeaker) => set({ activeSpeaker }),

  unlockSegmentSpeaker: (segmentId) => {
    set({
      segments: unlockSpeakerInSegments(get().segments, segmentId, get().speakerAliases),
    });
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
  // Background 划词 card generation (v0.5 closeout): setLookup is the
  // single trigger for the selection-lookup pipeline — every UI call
  // site (TranscriptPanel's mouse + touch paths) just calls this, so
  // the pipeline can never be duplicated or forgotten at some future
  // third call site. Fire-and-forget: from here on the pipeline owns
  // its own progress/task-registry/toast lifecycle independent of
  // whatever this popover does next (close/reselect/navigate away) —
  // see lib/tasks/selectionLookup.ts's own header.
  setLookup: (lookup) => {
    set({ lookup });
    if (lookup) void triggerSelectionLookup(lookup, get().settings);
  },

  setSummary: (summary) => set({ summary }),
  setSummarizing: (summarizing) => set({ summarizing }),
  setCorrectionBusy: (correctionBusy) => set({ correctionBusy }),

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
    //
    // Finding 3 fix (pre-merge review): returns a boolean (true =
    // mutation applied) instead of void — CorrectionReview.tsx's own
    // acceptance gate checks session/gen/text but NOT status, so a
    // refused write here used to be silently indistinguishable from a
    // successful one from that caller's point of view (the review row
    // still got marked accepted + queued for retranslation). Callers
    // that don't need the outcome (TranscriptPanel's inline edit) are
    // unaffected — ignoring a non-void return is always legal.
    const status = get().status;
    if (status !== "stopped") {
      diagLog(
        "warn",
        "stt-committed-mutation",
        "refused to mutate committed transcript text outside a stopped session",
        `segmentId=${segmentId} status=${status}`,
      );
      return false;
    }
    const cleaned = text.trim();
    if (!cleaned) return false;
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
    return true;
  },

  // v0.5 Wave-1 Feature 7 (inline card edit) — same committed-mutation
  // tripwire as updateSegmentText above (status==="stopped" only) + the
  // same post-stop re-save.
  updateCard: (id, patch) => {
    const status = get().status;
    if (status !== "stopped") {
      diagLog(
        "warn",
        "stt-committed-mutation",
        "refused to mutate a committed card outside a stopped session",
        `cardId=${id} status=${status}`,
      );
      return;
    }
    set({ cards: get().cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    if (get().status === "stopped" && get().segments.length > 0) {
      scheduleSessionSave(
        () => get().saveCurrentSession(),
        get().meetingGen,
        () => get().meetingGen,
      );
    }
  },

  updateTerm: (id, patch) => {
    const status = get().status;
    if (status !== "stopped") {
      diagLog(
        "warn",
        "stt-committed-mutation",
        "refused to mutate a committed term outside a stopped session",
        `termId=${id} status=${status}`,
      );
      return;
    }
    set({ terms: get().terms.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
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
      // v0.5 Wave-1 Feature 1: always persisted (even []) — same
      // "presence, even empty, marks known-complete bookkeeping vs.
      // legacy-absent" posture as pauseIntervals below, NOT
      // speakerAliases/translations' omit-when-empty convention above:
      // loadSession must tell "this session's roster really is empty"
      // apart from "this session predates the roster feature entirely"
      // (only the latter derives a roster from segments' own speaker
      // values — see loadSession below).
      speakerRoster: s.speakerRoster,
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
    // H1 fix (Sol adversarial review): storage.saveSession now reports
    // whether the write actually landed — a failed local save must
    // neither clear the only recovery copy (the live draft) nor claim
    // success. On failure: show the failure toast and stop, leaving the
    // draft/activeSessionId/sessions list exactly as they were (a later
    // post-stop top-up re-save — see scheduleSessionSave's call sites
    // below — gets another chance).
    const saved = await storage.saveSession(session);
    if (!saved) {
      get().showToast("保存失败，会议草稿已保留");
      return null;
    }
    const metas = await storage.listSessions();
    set({ sessions: metas, activeSessionId: session.id });
    // Crash/refresh recovery (v0.5 closeout): a meeting that ends
    // normally (this is the ONLY function that ever reaches "stopped"
    // persistence — every call site is gated on status==="stopped", see
    // useMeeting.ts's doStop/runStopFlow and this file's own post-stop
    // top-up re-saves) must never leave a stale liveDraft behind ONCE
    // it's actually safely persisted elsewhere (the `saved` check just
    // above). `draftId` (H3 fix) is THIS meeting's own identity —
    // liveDraft.clearDraft's compare-and-delete no-ops when nothing was
    // ever drafted under it (e.g. a short meeting the periodic interval
    // never got to write) OR when the disk now holds a DIFFERENT
    // (newer) meeting's still-unresolved draft. Awaited, like the
    // storage.* calls just above — this is local IndexedDB bookkeeping,
    // not one of the optional external integrations below that
    // deliberately fire-and-forget.
    const draftId = liveDraft.deriveDraftId(s.meetingGen, startedAt);
    await liveDraft.clearDraft(draftId);
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
    // v0.5 F9 / blueprint §5 A8 (F0b, lead-owned): AnkiConnect delivery
    // rides the SAME post-save hook as the webhook — a stopped session
    // re-saves many times (late diarization/translations/edits), and
    // deliverSessionNotes' ledger is what makes those repeats
    // duplicate-free, so firing on every save is deliberate, not waste.
    // Dynamic import keeps the connector (and idb ledger) entirely off
    // the hot path for the overwhelmingly common disabled case. iOS is
    // rejected inside ankiInvoke itself; fail-soft like postWebhook.
    const ankiCfg = s.settings.ankiConnect;
    if (ankiCfg?.enabled) {
      void import("./history/connectors/ankiConnect").then(
        ({ deliverSessionNotes, ankiLedger }) =>
          deliverSessionNotes(session, ankiCfg, ankiLedger),
      );
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
      // v0.5 Wave-1 Feature 1 / §5 A2: a session saved by the new code
      // always carries `speakerRoster` (even []) — only a session saved
      // BEFORE this feature existed lacks the key entirely, and only
      // THAT case derives a roster from the segments' own distinct
      // speaker values (see deriveRosterFromSegments above).
      speakerRoster: session.speakerRoster ?? deriveRosterFromSegments(session.segments),
      // A loaded/stopped session has no live latch to carry over, and
      // no correction batch in flight.
      activeSpeaker: null,
      correctionBusy: false,
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

  // Crash/refresh recovery (v0.5 closeout) — see this action's own
  // AppState doc comment above for why this bypasses the live
  // segments/cards slice entirely: `snapshot` is whatever RecoveryBanner
  // loaded from IndexedDB, not necessarily anything related to this
  // tab's current live meeting (or lack thereof).
  restoreLiveDraft: async (snapshot, draftId) => {
    // H4 fix (Sol adversarial review): currentSessionSnapshot()'s own
    // `id` is "unsaved" for every live-draft snapshot (activeSessionId
    // is always null while a meeting is draftable — see that
    // function's own doc comment), so reusing it here would let a
    // SECOND crash recovery overwrite the FIRST recovered session
    // (storage.saveSession keys by id). Always mint a fresh identity
    // for the materialized session rather than ever trusting the
    // incoming one.
    const session: MeetingSession = { ...snapshot, id: newId() };
    // H1 fix: same "don't clear the only copy / don't claim success on
    // a failed write" posture as saveCurrentSession above.
    const saved = await storage.saveSession(session);
    if (!saved) {
      get().showToast("恢复失败，请重试");
      return false;
    }
    const metas = await storage.listSessions();
    set({ sessions: metas });
    await liveDraft.clearDraft(draftId);
    get().showToast("已恢复，可在历史记录中查看");
    return true;
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
      speakerRoster: [],
      activeSpeaker: null,
      translations: {},
      cards: [],
      terms: [],
      summary: null,
      summarizing: false,
      correctionBusy: false,
      focusCardId: null,
      lookup: null,
      activeSessionId: null,
    })),

  showToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),
  setFocusMode: (focusMode) => set({ focusMode }),
  setCaptionMode: (captionMode) => set({ captionMode }),
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
    // v0.5 Wave-1 Feature 1: always present, mirroring saveCurrentSession's
    // own posture (see that call site's comment for why).
    speakerRoster: s.speakerRoster,
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
