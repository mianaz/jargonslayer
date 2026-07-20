"use client";

// Wiring hook: connects the STT engine layer to the app store and
// the detection scheduler. Owns the lifecycle of both per meeting.

import { useCallback, useEffect, useRef } from "react";
import { useApp } from "../lib/store";
import { createEngine } from "../lib/stt";
import { DetectionScheduler } from "../lib/detect/scheduler";
import { TranslateQueue } from "../lib/translate/queue";
import { langPairFromSettings, resolveTranslationProvider } from "../lib/translate/providers";
import { diagLog } from "../lib/diag/log";
import { resetLagStats } from "../lib/stt/latencyStats";
import { buildMeetingLexicon } from "../lib/stt/lexicon";
import { SONIOX_PREVIEW_LANE } from "../lib/deployTier";
import { getPreviewSessionSeconds } from "../lib/stt/soniox";
import type { STTEngine, STTEvents } from "@jargonslayer/core/types";

// Live bilingual transcript (#42): how many of the most recent
// finalized segments to catch up when the toggle flips OFF->ON
// mid-meeting (see the backfill effect below).
const BILINGUAL_BACKFILL_COUNT = 5;

/** Diagnostics choke-point wiring (item 2/3): every onError-shaped
 *  callback below (DetectionScheduler, TranslateQueue, STT engine
 *  onStatus("error")/onDiarStatus's error branch) uses this SAME
 *  pattern — log an "error" diag entry (log.ts assigns it a ref) and
 *  build the matching ref-carrying toast payload, so the toast's ref
 *  and the ring-buffer entry's ref are always the exact same value.
 *  Exported (not just inlined per call site) so this exact wiring is
 *  directly unit-testable — this repo has no hook-render test harness
 *  (see hooks/__tests__'s existing coverage, all pure-function-level),
 *  so testing useMeeting() itself isn't practical; testing the wiring
 *  it actually calls is. */
export function logAndToastError(
  tag: string,
  message: string,
  detail?: string,
): { message: string; ref?: string } {
  const entry = diagLog("error", tag, message, detail);
  return { message, ref: entry.ref };
}

export interface UseMeetingResult {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  startDemo: () => Promise<void>;
}

export function useMeeting(): UseMeetingResult {
  const engineRef = useRef<STTEngine | null>(null);
  const schedulerRef = useRef<DetectionScheduler | null>(null);
  const translateQueueRef = useRef<TranslateQueue | null>(null);

  // Lifecycle serialization (codex review 2026-07-10, rounds 1-3):
  // start/pause/resume/stop each await an engine teardown or attach,
  // and a second lifecycle click landing INSIDE that window corrupted
  // state (double-pause restamped pauseStartedAt; End during pause's
  // await resurrected an already-saved meeting as "paused").
  // Synchronous check-and-set — a concurrent lifecycle call no-ops
  // instead of interleaving.
  //
  // EXCEPT End: a gated no-op silently DROPS the user's End exactly
  // when it must win (e.g. clicked while resume is awaiting a
  // permission prompt). End therefore never no-ops — when the gate is
  // held it records an intent flag; the intent suppresses any
  // engine-driven upward status flip (attachEngine's onStatus), blocks
  // resume's accounting fold, and the gate drains it into a real stop
  // the moment it frees.
  const lifecycleBusyRef = useRef(false);
  const pendingEndRef = useRef(false);

  // Terminal-teardown race (codex v2 review F6): the error and
  // capture_ended branches below call runStopFlow() UN-GATED (they
  // deliberately never go through withLifecycleGate — gating them
  // would deadlock: an error firing WHILE pause()/resume() itself
  // holds the gate could otherwise never resolve). That means the
  // lifecycle gate stays FREE for the whole up-to-8s drain, so if the
  // meeting was "paused" (soft) when the error/capture_ended fired,
  // Resume stays clickable the entire time: the still-alive-but-
  // dying engine's own resume() would no-op (it's mid-`stopping`), yet
  // resume() would unconditionally call resumeMeeting() anyway,
  // producing a phantom "listening" over a dead capture. Set
  // SYNCHRONOUSLY (before runStopFlow ever awaits) at the top of both
  // branches, cleared in a finally once runStopFlow settles — pause()/
  // resume() both plain-return while it's set, without touching the
  // gate itself.
  const terminalTeardownRef = useRef(false);

  // Diar "ready" one-shot toast (STT protocol v2): reset per meeting
  // (see start() below) so a hard-resume's fresh engine (which re-arms
  // diarization from scratch on the sidecar) doesn't spam a second
  // toast within the SAME meeting — a soft-paused/resumed connection
  // never re-arms at all, so this also naturally covers "don't toast
  // again on a within-meeting reconnect".
  const diarReadyToastedRef = useRef(false);

  // Preview-lane trial notice (v0.5 closeout, owner ask: "the trial's
  // limits CLEARLY noticed"): one-shot per meeting start, same reset
  // seam as diarReadyToastedRef immediately above — no existing
  // "first listening" hook point exists in this file to piggy-back on
  // (diarReadyToastedRef covers a DIFFERENT event, onDiarStatus
  // "ready"), so this is a new ref styled identically. Unlike
  // diarReadyToastedRef, this ALSO covers a teardown-RESUME: soniox/
  // tabaudio-cloud have no soft pause (see either engine's own "No
  // pause/resume" header note), so resuming from a pause reattaches a
  // FRESH engine instance that fires onStatus("listening") again — this
  // ref is only reset in start(), never in resume(), so that re-fire is
  // deliberately suppressed (one notice per MEETING, not per attach).
  const previewMintNoticeRef = useRef(false);

  // Engine-creation/wiring block (pause/resume, B3): extracted out of
  // start() so resume() can reattach a FRESH engine instance to the
  // SAME meeting (same scheduler/translateQueue, same sessionGen)
  // without re-running beginMeeting() or recreating either queue —
  // both stay alive across a pause (they read meetingGen via
  // closures, not a captured value, so they keep working unchanged
  // once the meeting resumes). Requires schedulerRef/translateQueueRef
  // to already be wired (true both from start(), which just created
  // them, and from resume(), which never tore them down).
  // Returns whether the attach SUCCEEDED — resume must not infer
  // success from global status (codex round-3: the un-awaited error
  // stop flow updates status asynchronously, so status can read
  // "paused" long after the engine already failed).
  const attachEngine = useCallback(async (sessionGen: number): Promise<boolean> => {
    const scheduler = schedulerRef.current;
    const translateQueue = translateQueueRef.current;
    if (!scheduler || !translateQueue) return false;

    const settings = useApp.getState().settings;
    const engine = createEngine(settings.engine);
    engineRef.current = engine;
    let attachFailed = false;

    const runStopFlow = async () => {
      await engine.stop();
      // Stop-drain belt (STT protocol v2): the drain final's own
      // onFinal already clears interim when one arrives, but a stop
      // with no trailing final must not leave a stale gray interim on
      // screen forever — see doStop's matching call for the full
      // rationale.
      useApp.getState().setInterim(null);
      scheduler.flushNow();
      const segCount = useApp.getState().segments.length;
      useApp.getState().setStatus(segCount ? "stopped" : "idle");
      // Persist whatever was transcribed — engine errors and demo
      // completion must not lose the session. Late detection results
      // and a lingering speaker_update (see wsTransport.ts's
      // POST_STOP_LINGER_MS) are both re-saved by the store's post-stop
      // debounced save (store.ts's applyDetection/applySpeakerUpdate).
      if (segCount > 0) {
        await useApp.getState().saveCurrentSession();
      }
    };

    const events: STTEvents = {
      onInterim: (text, speaker) => {
        // Late-partial belt (STT protocol v2 fix, codex v2 review
        // F4): a "flush" (soft pause) doesn't cancel an in-flight
        // partial transcription — its result can arrive AFTER pause
        // already cleared the interim, with no new PCM ever coming to
        // replace it, so it would otherwise stick on screen forever.
        // Only accept interim text while the meeting is actually
        // listening for one; this also belts a straggler arriving
        // after End (stop()/runStopFlow already clear interim, but a
        // late partial landing right after would otherwise repopulate
        // it one more time).
        const status = useApp.getState().status;
        if (status !== "listening" && status !== "connecting") {
          diagLog("info", "stt-lifecycle", "忽略非监听状态下到达的插字");
          return;
        }
        // Honest interim contract (fix #A4): the engine layer now
        // forwards `""` (a genuine retraction) instead of swallowing
        // it — map that to `null` here so InterimLine doesn't render
        // an empty-but-non-null interim row. Real engines other than
        // webSpeech (wsTransport/demo) only ever emit non-empty text,
        // so this is a no-op for them.
        useApp.getState().setInterim(text ? { text, speaker } : null);
      },
      onFinal: (text, opts) => {
        const seg = useApp.getState().addFinal(text, opts);
        useApp.getState().setInterim(null);
        scheduler.pushSegment(seg);
        translateQueue.pushSegment(seg);
      },
      onSpeakerUpdate: (assignments, speakers) => {
        useApp.getState().applySpeakerUpdate(assignments, speakers, sessionGen);
      },
      onDiarStatus: (state, detail) => {
        // UI copy is fixed per spec — `detail` (the sidecar's own
        // short status string) only ever reaches the diag ring buffer
        // below, never the toast text itself.
        if (state === "error") {
          useApp
            .getState()
            .showToast(logAndToastError("stt-diar", "实时说话人分离出错，已停止本场自动标注", detail));
        } else if (state === "ready") {
          // Positive ack (STT protocol v2): arming actually succeeded
          // on the sidecar. One-shot per meeting — see
          // diarReadyToastedRef's own doc comment.
          if (!diarReadyToastedRef.current) {
            diarReadyToastedRef.current = true;
            diagLog("info", "stt-diar", "实时说话人分离已开启");
            useApp.getState().showToast("实时说话人分离已开启");
          }
        } else {
          diagLog("warn", "stt-diar", "实时说话人分离不可用，已回退到纯转录", detail);
          useApp.getState().showToast("实时说话人分离不可用，已回退到纯转录");
        }
      },
      onNotice: (msg) => {
        // Advisory only (see STTEvents.onNotice's own doc comment) —
        // logged at "warn", no ref/toast-copy action: this is a steer
        // hint, not a failure to diagnose.
        diagLog("warn", "stt-notice", msg);
        useApp.getState().showToast(msg);
      },
      onEngineMode: (mode) => {
        // On-device Web Speech (see STTEvents.onEngineMode's own doc)
        // — plain store mirror, no toast/diag here (webSpeech.ts
        // already diag-logs the decision itself); StatusLine's privacy
        // indicator reads this field directly.
        useApp.getState().setSttEngineMode(mode);
      },
      onStatus: (status, detail) => {
        if (status === "connecting" || status === "listening") {
          // A pending End outranks the engine (codex round-3): once
          // the user clicked End, no engine event may flip the meeting
          // upward while the intent awaits its drain.
          if (pendingEndRef.current) return;
          // Soft-paused (STT protocol v2): a still-alive transport
          // (tabaudio) can emit its own reconnect status events (e.g.
          // a transient ws drop) while the meeting is soft-paused —
          // that must never un-pause the UI out from under the user.
          if (useApp.getState().status === "paused") {
            diagLog("warn", "stt-lifecycle", `忽略暂停期间的引擎状态变化: ${status}`);
            return;
          }
          useApp.getState().setStatus(status, status === "connecting" ? detail : undefined);
          // Preview-lane trial notice (v0.5 closeout item 3): fires
          // once per meeting start, only for a session actually riding
          // the server-minted credential — soniox OR tabaudio-cloud
          // (tabAudioCloud.ts's own effectiveProvider forces the same
          // path on this lane, so its BYOK check is the SAME
          // settings.sonioxKey, never deepgramKey) — with no BYOK
          // sonioxKey of the user's own.
          if (
            status === "listening" &&
            !previewMintNoticeRef.current &&
            SONIOX_PREVIEW_LANE &&
            !settings.sonioxKey &&
            (engine.kind === "soniox" || engine.kind === "tabaudio-cloud")
          ) {
            previewMintNoticeRef.current = true;
            const s = getPreviewSessionSeconds() ?? 600;
            useApp
              .getState()
              .showToast(
                `预览体验：本段最长 ${Math.round(s / 60)} 分钟（每日限量），音频经 Soniox 云端转写、不留存`,
              );
          }
        } else if (status === "error") {
          attachFailed = true;
          // F6: set BEFORE runStopFlow's first await — see
          // terminalTeardownRef's own doc above.
          terminalTeardownRef.current = true;
          useApp.getState().showToast(logAndToastError("stt", detail ?? "转录引擎错误"));
          void runStopFlow().finally(() => {
            terminalTeardownRef.current = false;
          });
        } else if (
          status === "idle" &&
          (detail === "demo_finished" || detail === "capture_ended")
        ) {
          // F6: same synchronous-before-await set as the error branch.
          terminalTeardownRef.current = true;
          // capture_ended toast copy is engine-kind-conditional
          // (adversarial review finding F10): an earlier S9.4 fix here
          // changed this to "音频捕获已结束" UNCONDITIONALLY, which
          // silently altered tabaudio's (and any other non-appaudio
          // engine's) WEB-build toast too, violating D7's "browser
          // behavior stays byte-identical" pin. tabaudio (and anything
          // else) keeps the ORIGINAL "共享已结束" share-picker phrasing;
          // only appaudio's own CoreAudio-tap ending gets "音频捕获已结束"
          // — "共享" reads wrong there, since a tap never opened a share
          // picker in the first place. `engine` (this attachEngine()
          // call's own instance, same closure the pause branch below
          // reads `engine?.pause` from) is what carries the kind.
          const endToast =
            detail === "capture_ended"
              ? engine.kind === "appaudio"
                ? "音频捕获已结束，会议已保存到历史记录"
                : "共享已结束，会议已保存到历史记录"
              : "演示结束，打开右侧「纪要」标签生成会后报告试试";
          void runStopFlow()
            .then(() => {
              useApp.getState().showToast(endToast);
            })
            .finally(() => {
              terminalTeardownRef.current = false;
            });
        }
      },
    };

    // v0.4.7 Lane B (glossary -> recognizer bias, docs/design-
    // explorations/stt-provider-wiring-2026-07.md §3, D8): ONE lexicon
    // snapshot, built HERE (read via existing store selectors, same
    // moment `settings` above was read) and passed explicitly into
    // engine.start() — adapters never read the store for this
    // themselves anymore (Q11's osSpeech.ts direct read migrated onto
    // this same seam). Every real engine.start() invocation goes
    // through this ONE attachEngine() call site (fresh start() AND
    // resume()'s teardown-reattach), so a mid-meeting reattach always
    // gets a freshly-built snapshot too — same "start-time one-shot"
    // semantics Q11 already had, just generalized.
    //
    // D1 extension point: bias is default-ON, unconditional, for every
    // free/local mechanism (doc D1) — a future 术语偏置 Settings toggle
    // would gate this whole build+pass step right here (e.g. `settings
    // .termBiasEnabled === false ? undefined : buildMeetingLexicon(...)`)
    // rather than inside any individual adapter.
    const lexicon = buildMeetingLexicon({
      customEntries: useApp.getState().customEntries,
      enabledPacks: settings.enabledPacks,
      learnset: useApp.getState().learnset,
    });
    await engine.start(events, settings, lexicon);
    return !attachFailed;
  }, []);

  // End body, ungated — reachable from listening AND paused; also the
  // drain target for pendingEndRef.
  const doStop = useCallback(async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    const scheduler = schedulerRef.current;
    if (engine) {
      await engine.stop();
    }
    // Stop-drain belt (STT protocol v2): the drain final's own onFinal
    // already clears interim when one arrives (WsTransport.stop() now
    // waits for the sidecar's drain ack before resolving — see
    // wsTransport.ts), but a stop with no trailing final (nothing was
    // being said, or the tail was pure silence) would otherwise leave
    // a stale gray interim on screen forever.
    useApp.getState().setInterim(null);
    // Scheduler stays alive so late responses still land; it is
    // replaced+stopped on the next start().
    scheduler?.flushNow();
    useApp.getState().setStatus("stopped");

    if (useApp.getState().segments.length > 0) {
      await useApp.getState().saveCurrentSession();
      useApp.getState().showToast("会议已保存到历史记录");
    }
  }, []);

  const withLifecycleGate = useCallback(async (fn: () => Promise<void>) => {
    if (lifecycleBusyRef.current) return;
    lifecycleBusyRef.current = true;
    try {
      await fn();
    } finally {
      lifecycleBusyRef.current = false;
      if (pendingEndRef.current) {
        pendingEndRef.current = false;
        // Re-enters the (now free) gate; a pendingEnd set during THIS
        // drain lands in the drain's own finally, so intents can't
        // starve.
        void withLifecycleGate(doStop);
      }
    }
  }, [doStop]);

  const start = useCallback(async () => withLifecycleGate(async () => {
    const { status } = useApp.getState();
    if (status === "listening" || status === "connecting") return;

    diarReadyToastedRef.current = false;
    previewMintNoticeRef.current = false;
    // S10 field-fix #6: a fresh session must never show a stale EMA
    // reading carried over from the previous one (lib/stt/latencyStats.
    // ts's own resetLagStats doc comment) — same per-session-start seam
    // as diarReadyToastedRef's reset just above. Not called from
    // resume()'s soft/teardown-resume paths below — those continue the
    // SAME session (a pause never counts as "the next" one).
    resetLagStats();
    useApp.getState().beginMeeting();
    // Captured once, right after beginMeeting() bumps meetingGen —
    // this is "this engine session's gen" for the meeting-boundary
    // guards below (late scheduler results / late speaker updates
    // from a previous meeting must not land on this one, and vice
    // versa once a NEXT meeting starts and bumps the gen again).
    const sessionGen = useApp.getState().meetingGen;

    // Replace any previous scheduler before wiring a fresh one.
    schedulerRef.current?.stop();
    const scheduler = new DetectionScheduler({
      getSettings: () => useApp.getState().settings,
      getMeetingGen: () => useApp.getState().meetingGen,
      onDetection: (res, src, meta) => useApp.getState().applyDetection(res, src, meta),
      onBusyChange: (b) => useApp.getState().setDetectBusy(b),
      onModeChange: (m) => useApp.getState().setDetectMode(m),
      onError: (msg) => useApp.getState().showToast(logAndToastError("detect-scheduler", msg)),
    });
    schedulerRef.current = scheduler;

    // Replace any previous translate queue before wiring a fresh one —
    // same lifecycle as the scheduler above.
    translateQueueRef.current?.stop();
    // v0.5 Wave-1 Feature 6 / A6 (docs/design-explorations/
    // v05-wave1-blueprint.md §1 Feature 6 + §5 A6): provider KIND is
    // decided once here (mirrors attachEngine's own settings.engine
    // snapshot just below) and, when it resolves to the on-device
    // Chrome provider, prepare() MUST fire synchronously, inside THIS
    // Start click's own user gesture, before any await — this whole
    // start() callback body still runs synchronously up to
    // attachEngine's own internal `await engine.start(...)`, so this
    // call site is well inside that window. See providers.ts's header
    // comment for the full activation contract; LlmTranslationProvider's
    // prepare() is a no-op, so this is harmless when the resolved
    // provider is (as by far most commonly) "llm".
    const provider = resolveTranslationProvider(() => useApp.getState().settings);
    provider.prepare(langPairFromSettings(useApp.getState().settings));
    const translateQueue = new TranslateQueue({
      getSettings: () => useApp.getState().settings,
      getMeetingGen: () => useApp.getState().meetingGen,
      provider,
      onTranslations: (map, gen) => useApp.getState().applyTranslations(map, gen),
      onError: (msg) => useApp.getState().showToast(logAndToastError("translate-queue", msg)),
    });
    translateQueueRef.current = translateQueue;

    await attachEngine(sessionGen);
  }), [attachEngine, withLifecycleGate]);

  // Pause (B3, soft branch added by STT protocol v2): two branches —
  // SOFT (engine.pause exists — tabaudio and appaudio) keeps the
  // engine/transport alive, so resume needs no reconnect and no
  // re-picker; TEARDOWN (everything else, unchanged from B3) stops the
  // engine outright and resume() reattaches a fresh one. Both branches
  // share the same ordering rationale (codex review 2026-07-10): flip
  // to "paused" SYNCHRONOUSLY before the awaited pause/stop call, so
  // every other lifecycle guard sees the new state first.
  const pause = useCallback(async () => withLifecycleGate(async () => {
    // F6: an un-gated error/capture_ended teardown is draining — see
    // terminalTeardownRef's own doc above. Plain-return without
    // touching the gate itself (the gate stays free for this whole
    // window by design).
    if (terminalTeardownRef.current) return;
    const { status } = useApp.getState();
    if (status !== "listening") return;
    const engine = engineRef.current;
    if (engine?.pause) {
      // Soft pause: KEEP engineRef.current — this is what distinguishes
      // it from the teardown branch below (resume() branches on the
      // very same `engineRef.current?.resume` check).
      useApp.getState().pauseMeeting();
      await engine.pause();
      useApp.getState().setInterim(null);
      return;
    }
    // Teardown pause: webspeech's stop() drains the working tail into
    // committed segments before it resolves; the interim display is
    // cleared only after that drain.
    engineRef.current = null;
    useApp.getState().pauseMeeting();
    await engine?.stop();
    useApp.getState().setInterim(null);
  }), [withLifecycleGate]);

  // Resume (B3, soft branch added by STT protocol v2): mirrors pause()'s
  // two branches. SOFT (engineRef.current?.resume exists — the SAME
  // still-alive engine from a soft pause): resume it in place, no
  // re-attach, no re-picker. TEARDOWN (everything else, unchanged from
  // B3): attachEngine() a FRESH engine instance (the paused one was
  // fully torn down), and resumeMeeting() only once capture is
  // attached, so the paused-time accounting also absorbs the
  // connection delay instead of counting it as active meeting time
  // (codex review 2026-07-10).
  const resume = useCallback(async () => withLifecycleGate(async () => {
    // F6: same plain-return as pause() above — see terminalTeardownRef's
    // own doc.
    if (terminalTeardownRef.current) return;
    const { status, meetingGen, settings } = useApp.getState();
    if (status !== "paused") return;
    let engine = engineRef.current;
    // Engine switch during a retained soft pause (codex v2 review F7):
    // pre-v2, EVERY pause was teardown, so switching engines in
    // Settings while paused was already honored (resume's
    // teardown-resume path below always attaches whatever
    // settings.engine currently says). A RETAINED soft-paused engine
    // (tabaudio) bypasses that entirely by design — it's the SAME
    // instance, never re-attached — so it silently kept ignoring a
    // mid-pause engine switch. If the live engine no longer matches
    // the currently-selected one, fully tear it down (including its
    // own stop drain) here, then fall through to the SAME
    // teardown-resume path below so the newly selected engine attaches
    // (the tab-audio picker reappearing when switching TO tabaudio is
    // expected — same as any other fresh attach). Same pendingEnd
    // guards as the paths below apply automatically once this falls
    // through — nothing extra needed here.
    if (engine && engine.kind !== settings.engine) {
      engineRef.current = null;
      await engine.stop();
      engine = null;
    }
    if (engine?.resume) {
      await engine.resume();
      // A pending End equally wins over the fold here (mirrors the
      // teardown branch's own guard below) — the gate's drain will
      // stop this SAME engine the moment this call releases. Unlike
      // the teardown branch, there is no attach-failure/stopped-or-
      // idle race to also guard against: resume() on an already-live
      // transport doesn't asynchronously fail the way attachEngine can.
      if (!pendingEndRef.current) {
        useApp.getState().resumeMeeting();
      }
      return;
    }
    const attached = await attachEngine(meetingGen);
    // Fold accounting ONLY on an explicit successful attach (codex
    // round-3: the error stop flow is un-awaited, so global status is
    // not a reliable success signal). A failed attach's own error path
    // lands the meeting on stopped/idle; the terminal-status check is
    // the belt for teardown that already completed. A pending End
    // equally wins over the flip: the gate's drain will stop the
    // just-attached engine the moment this releases.
    const after = useApp.getState().status;
    if (attached && after !== "stopped" && after !== "idle" && !pendingEndRef.current) {
      useApp.getState().resumeMeeting();
    }
  }), [attachEngine, withLifecycleGate]);

  const stop = useCallback(async () => {
    if (lifecycleBusyRef.current) {
      // Never drop an End (codex round-2 HIGH): the gate-holder's
      // finally drains this intent into a real stop.
      pendingEndRef.current = true;
      return;
    }
    await withLifecycleGate(doStop);
  }, [withLifecycleGate, doStop]);

  const startDemo = useCallback(async () => {
    // S14.1 field fix: live-only — never persisted (store.ts's
    // updateSettings `persist:false`), so a demo run can't strand a
    // returning preview user's real engine pick across a reload (see
    // store.ts's applyTierDefaults doc for the field report).
    useApp.getState().updateSettings({ engine: "demo" }, { persist: false });
    await start();
  }, [start]);

  useEffect(() => {
    return () => {
      void engineRef.current?.stop();
      schedulerRef.current?.stop();
      translateQueueRef.current?.stop();
    };
  }, []);

  // Live bilingual transcript (#42): flipping the toggle OFF->ON
  // mid-meeting shouldn't leave the just-elapsed minute untranslated —
  // catch up the most recent finalized segments that don't have one
  // yet. Gated to `listening` because the queue is only alive for a
  // live meeting (stopped sessions have no TranslateQueue to backfill
  // into; toggling the setting from a stopped session's view has no
  // live effect here).
  const bilingualTranscript = useApp((s) => s.settings.bilingualTranscript);
  const status = useApp((s) => s.status);
  const prevBilingualRef = useRef(bilingualTranscript);
  useEffect(() => {
    const wasOff = !prevBilingualRef.current;
    prevBilingualRef.current = bilingualTranscript;
    if (!(wasOff && bilingualTranscript && status === "listening")) return;

    const { segments, translations } = useApp.getState();
    const toBackfill = segments
      .filter((s) => !translations[s.id])
      .slice(-BILINGUAL_BACKFILL_COUNT);
    translateQueueRef.current?.backfill(toBackfill);
  }, [bilingualTranscript, status]);

  // Re-translate a segment whose text was hand-corrected (store's
  // updateSegmentText already dropped the stale translation entry —
  // see store.ts) while the toggle is on. Tracks last-seen text per
  // segment id so only genuine edits (not new arrivals) re-enqueue;
  // cleared per meetingGen so it doesn't accumulate ids across every
  // meeting held in one tab session.
  const segments = useApp((s) => s.segments);
  const meetingGen = useApp((s) => s.meetingGen);
  const lastTextRef = useRef<Map<string, string>>(new Map());
  const lastTextGenRef = useRef(meetingGen);
  useEffect(() => {
    if (lastTextGenRef.current !== meetingGen) {
      lastTextGenRef.current = meetingGen;
      lastTextRef.current = new Map();
    }
    const lastText = lastTextRef.current;
    const settings = useApp.getState().settings;
    for (const seg of segments) {
      const prevText = lastText.get(seg.id);
      if (prevText !== undefined && prevText !== seg.text && settings.bilingualTranscript) {
        translateQueueRef.current?.pushSegment(seg);
      }
      lastText.set(seg.id, seg.text);
    }
  }, [segments, meetingGen]);

  return { start, pause, resume, stop, startDemo };
}
