"use client";

// Wiring hook: connects the STT engine layer to the app store and
// the detection scheduler. Owns the lifecycle of both per meeting.

import { useCallback, useEffect, useRef } from "react";
import { useApp } from "../lib/store";
import { createEngine } from "../lib/stt";
import { DetectionScheduler } from "../lib/detect/scheduler";
import { TranslateQueue } from "../lib/translate/queue";
import { diagLog } from "../lib/diag/log";
import type { STTEngine, STTEvents } from "../lib/types";

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
  stop: () => Promise<void>;
  startDemo: () => Promise<void>;
}

export function useMeeting(): UseMeetingResult {
  const engineRef = useRef<STTEngine | null>(null);
  const schedulerRef = useRef<DetectionScheduler | null>(null);
  const translateQueueRef = useRef<TranslateQueue | null>(null);

  const start = useCallback(async () => {
    const { status } = useApp.getState();
    if (status === "listening" || status === "connecting") return;

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
    const translateQueue = new TranslateQueue({
      getSettings: () => useApp.getState().settings,
      getMeetingGen: () => useApp.getState().meetingGen,
      onTranslations: (map, gen) => useApp.getState().applyTranslations(map, gen),
      onError: (msg) => useApp.getState().showToast(logAndToastError("translate-queue", msg)),
    });
    translateQueueRef.current = translateQueue;

    const settings = useApp.getState().settings;
    const engine = createEngine(settings.engine);
    engineRef.current = engine;

    const runStopFlow = async () => {
      await engine.stop();
      scheduler.flushNow();
      const segCount = useApp.getState().segments.length;
      useApp.getState().setStatus(segCount ? "stopped" : "idle");
      // Persist whatever was transcribed — engine errors and demo
      // completion must not lose the session. Late detection results
      // are re-saved by the store's post-stop debounced save.
      if (segCount > 0) {
        await useApp.getState().saveCurrentSession();
      }
    };

    const events: STTEvents = {
      onInterim: (text, speaker) => {
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
      onStatus: (status, detail) => {
        if (status === "connecting") {
          useApp.getState().setStatus("connecting", detail);
        } else if (status === "listening") {
          useApp.getState().setStatus("listening");
        } else if (status === "error") {
          useApp.getState().showToast(logAndToastError("stt", detail ?? "转录引擎错误"));
          void runStopFlow();
        } else if (
          status === "idle" &&
          (detail === "demo_finished" || detail === "capture_ended")
        ) {
          const endToast =
            detail === "capture_ended"
              ? "共享已结束，会议已保存到历史记录"
              : "演示结束，打开右侧「纪要」标签生成会后报告试试";
          void runStopFlow().then(() => {
            useApp.getState().showToast(endToast);
          });
        }
      },
    };

    await engine.start(events, settings);
  }, []);

  const stop = useCallback(async () => {
    const engine = engineRef.current;
    const scheduler = schedulerRef.current;
    if (engine) {
      await engine.stop();
    }
    // Scheduler stays alive so late responses still land; it is
    // replaced+stopped on the next start().
    scheduler?.flushNow();
    useApp.getState().setStatus("stopped");

    if (useApp.getState().segments.length > 0) {
      await useApp.getState().saveCurrentSession();
      useApp.getState().showToast("会议已保存到历史记录");
    }
  }, []);

  const startDemo = useCallback(async () => {
    useApp.getState().updateSettings({ engine: "demo" });
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

  return { start, stop, startDemo };
}
