"use client";

// Wiring hook: connects the STT engine layer to the app store and
// the detection scheduler. Owns the lifecycle of both per meeting.

import { useCallback, useEffect, useRef } from "react";
import { useApp } from "../lib/store";
import { createEngine } from "../lib/stt";
import { DetectionScheduler } from "../lib/detect/scheduler";
import type { STTEngine, STTEvents } from "../lib/types";

export interface UseMeetingResult {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  startDemo: () => Promise<void>;
}

export function useMeeting(): UseMeetingResult {
  const engineRef = useRef<STTEngine | null>(null);
  const schedulerRef = useRef<DetectionScheduler | null>(null);

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
      onDetection: (res, src) => useApp.getState().applyDetection(res, src),
      onBusyChange: (b) => useApp.getState().setDetectBusy(b),
      onModeChange: (m) => useApp.getState().setDetectMode(m),
      onError: (msg) => useApp.getState().showToast(msg),
    });
    schedulerRef.current = scheduler;

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
        useApp.getState().setInterim({ text, speaker });
      },
      onFinal: (text, opts) => {
        const seg = useApp.getState().addFinal(text, opts);
        useApp.getState().setInterim(null);
        scheduler.pushSegment(seg);
      },
      onSpeakerUpdate: (assignments, speakers) => {
        useApp.getState().applySpeakerUpdate(assignments, speakers, sessionGen);
      },
      onDiarStatus: (state, detail) => {
        void detail; // shown in the sidecar's own logs; UI copy is fixed per spec
        useApp
          .getState()
          .showToast(
            state === "unavailable"
              ? "实时说话人分离不可用，已回退到纯转录"
              : "实时说话人分离出错，已停止本场自动标注",
          );
      },
      onStatus: (status, detail) => {
        if (status === "connecting") {
          useApp.getState().setStatus("connecting", detail);
        } else if (status === "listening") {
          useApp.getState().setStatus("listening");
        } else if (status === "error") {
          useApp.getState().showToast(detail ?? "转录引擎错误");
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
    };
  }, []);

  return { start, stop, startDemo };
}
