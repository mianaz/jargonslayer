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

    // Replace any previous scheduler before wiring a fresh one.
    schedulerRef.current?.stop();
    const scheduler = new DetectionScheduler({
      getSettings: () => useApp.getState().settings,
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
      onStatus: (status, detail) => {
        if (status === "connecting") {
          useApp.getState().setStatus("connecting", detail);
        } else if (status === "listening") {
          useApp.getState().setStatus("listening");
        } else if (status === "error") {
          useApp.getState().showToast(detail ?? "转录引擎错误");
          void runStopFlow();
        } else if (status === "idle" && detail === "demo_finished") {
          void runStopFlow().then(() => {
            useApp
              .getState()
              .showToast("演示结束 — 打开右侧「纪要」标签生成会后报告试试");
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
