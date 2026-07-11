// Choke-point integration test (spec item 7): DetectionScheduler and
// TranslateQueue onError -> useMeeting.ts's logAndToastError -> a diag
// ring-buffer entry AND a ref-carrying toast payload sharing the exact
// same ref. This repo has no hook-render test harness (useMeeting()
// itself can't practically be driven without one — see
// hooks/__tests__'s existing coverage, all pure-function-level), so
// this test wires the SAME real classes useMeeting.ts wires, through
// the SAME exported helper it calls, and drives a real failure path
// (mocked at the llm/client module boundary, same convention as
// scheduler.test.ts/queue.test.ts) — end to end short of the React
// hook wrapper itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "@jargonslayer/core/types";

vi.mock("../../lib/llm/client", () => ({
  detectApi: vi.fn(),
  translateApi: vi.fn(),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后重试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
}));

import { detectApi, NoKeyError, translateApi } from "../../lib/llm/client";
import { DetectionScheduler } from "../../lib/detect/scheduler";
import { TranslateQueue } from "../../lib/translate/queue";
import { clearDiag, getDiagEntries } from "../../lib/diag/log";
import { logAndToastError } from "../useMeeting";

const mockDetectApi = vi.mocked(detectApi);
const mockTranslateApi = vi.mocked(translateApi);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

let segIndex = 0;
function makeSegment(text: string): TranscriptSegment {
  segIndex++;
  return {
    id: `seg-${segIndex}`,
    index: segIndex,
    startedAt: Date.now(),
    endedAt: Date.now(),
    text,
    engine: "demo",
  };
}

describe("useMeeting.ts diagnostics wiring — logAndToastError", () => {
  beforeEach(() => {
    clearDiag();
  });

  it("logs an 'error' diag entry and returns a toast payload sharing the SAME ref", () => {
    const toast = logAndToastError("some-tag", "出错了", "detail text");

    expect(toast.message).toBe("出错了");
    expect(toast.ref).toMatch(/^JS-/);

    const entries = getDiagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "error",
      tag: "some-tag",
      message: "出错了",
      detail: "detail text",
      ref: toast.ref,
    });
  });

  it("detail is optional", () => {
    const toast = logAndToastError("some-tag", "出错了");
    expect(getDiagEntries()[0].detail).toBeUndefined();
    expect(toast.ref).toBeDefined();
  });
});

describe("useMeeting.ts diagnostics wiring — DetectionScheduler choke point", () => {
  let settings: Settings;
  let scheduler: DetectionScheduler;
  let toasts: { message: string; ref?: string }[];

  beforeEach(() => {
    vi.useFakeTimers();
    clearDiag();
    segIndex = 0;
    settings = makeSettings();
    mockDetectApi.mockReset();
    toasts = [];
    // Mirrors useMeeting.ts's own onError wiring exactly:
    // `onError: (msg) => useApp.getState().showToast(logAndToastError(...))`
    scheduler = new DetectionScheduler({
      getSettings: () => settings,
      getMeetingGen: () => 0,
      onDetection: vi.fn(),
      onBusyChange: vi.fn(),
      onModeChange: vi.fn(),
      onError: (msg) => toasts.push(logAndToastError("detect-scheduler", msg)),
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("a detectApi failure (NoKeyError) produces a diag entry AND a ref-carrying toast with the SAME ref", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError());

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);

    expect(toasts).toHaveLength(1);
    expect(toasts[0].ref).toMatch(/^JS-/);

    const entries = getDiagEntries().filter((e) => e.tag === "detect-scheduler");
    expect(entries).toHaveLength(1);
    expect(entries[0].ref).toBe(toasts[0].ref);
    expect(entries[0].level).toBe("error");
  });
});

describe("useMeeting.ts diagnostics wiring — TranslateQueue choke point", () => {
  let settings: Settings;
  let queue: TranslateQueue;
  let toasts: { message: string; ref?: string }[];

  beforeEach(() => {
    vi.useFakeTimers();
    clearDiag();
    segIndex = 0;
    settings = makeSettings({ bilingualTranscript: true });
    mockTranslateApi.mockReset();
    toasts = [];
    queue = new TranslateQueue({
      getSettings: () => settings,
      getMeetingGen: () => 0,
      onTranslations: vi.fn(),
      onError: (msg) => toasts.push(logAndToastError("translate-queue", msg)),
    });
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
  });

  it("a translateApi failure (NoKeyError) produces a diag entry AND a ref-carrying toast with the SAME ref", async () => {
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());

    queue.pushSegment(makeSegment("hello world"));
    await vi.advanceTimersByTimeAsync(1500); // DEBOUNCE_MS

    expect(toasts).toHaveLength(1);
    expect(toasts[0].ref).toMatch(/^JS-/);

    const entries = getDiagEntries().filter((e) => e.tag === "translate-queue");
    expect(entries).toHaveLength(1);
    expect(entries[0].ref).toBe(toasts[0].ref);
  });
});
