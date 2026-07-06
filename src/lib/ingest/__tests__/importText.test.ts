import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memStore.delete(key);
  }),
}));

vi.mock("../../llm/client", () => ({
  detectApi: vi.fn(),
  translateApi: vi.fn(),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后再试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
}));

import { detectApi, translateApi, RateLimitApiError, NoKeyError } from "../../llm/client";
import * as storage from "../../history/storage";
import { importTranscriptText } from "../importText";

const mockDetectApi = vi.mocked(detectApi);
const mockTranslateApi = vi.mocked(translateApi);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function emptyDetectRes() {
  return { expressions: [], terms: [] };
}

function emptyTranslateRes() {
  return { translations: [] };
}

describe("importTranscriptText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    memStore.clear();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
    mockDetectApi.mockReset();
    mockDetectApi.mockResolvedValue(emptyDetectRes());
    mockTranslateApi.mockReset();
    mockTranslateApi.mockResolvedValue(emptyTranslateRes());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("builds a synthetic timeline from cue timestamps (SRT), normalized so the FIRST cue lands exactly at the Date.now() base", async () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "Alice: first line.",
      "",
      "2",
      "00:00:05,000 --> 00:00:08,000",
      "Bob: second line.",
    ].join("\n");

    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const onProgress = vi.fn();
    const { sessionId } = await importTranscriptText({
      raw,
      filename: "meeting.srt",
      translate: false,
      settings: makeSettings(),
      onProgress,
    });

    const session = await storage.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.segments).toHaveLength(2);
    // First cue starts at 00:00:01 — that 1s origin is subtracted so
    // the session begins "now", with inter-cue gaps preserved.
    expect(session!.segments[0].startedAt).toBe(now);
    expect(session!.segments[0].endedAt).toBe(now + 3000);
    expect(session!.segments[1].startedAt).toBe(now + 4000);
    expect(session!.segments[1].endedAt).toBe(now + 7000);
    expect(session!.segments[0].speaker).toBe("Alice");
    expect(session!.segments[0].engine).toBe("import");
    expect(session!.engine).toBe("import");
  });

  it("a trimmed export whose first cue starts deep into the recording (00:10:00) still lands at the base — never in the future", async () => {
    const raw = [
      "1",
      "00:10:00,000 --> 00:10:03,000",
      "Late start, trimmed export.",
    ].join("\n");

    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const { sessionId } = await importTranscriptText({
      raw,
      filename: "trimmed.srt",
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    const session = await storage.getSession(sessionId);
    expect(session!.segments[0].startedAt).toBe(now);
    expect(session!.segments[0].endedAt).toBe(now + 3000);
    expect(session!.startedAt).toBe(now);
  });

  it("spaces plain-text segments (no timestamps) 4s apart from a Date.now() base", async () => {
    const raw = "first line here.\nsecond line here.\nthird line here.";
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const { sessionId } = await importTranscriptText({
      raw,
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    const session = await storage.getSession(sessionId);
    expect(session!.segments).toHaveLength(3);
    expect(session!.segments[0].startedAt).toBe(now);
    expect(session!.segments[0].endedAt).toBe(now + 4000);
    expect(session!.segments[1].startedAt).toBe(now + 4000);
    expect(session!.segments[1].endedAt).toBe(now + 8000);
    expect(session!.segments[2].startedAt).toBe(now + 8000);
    expect(session!.segments[2].endedAt).toBe(now + 12000);
  });

  it("translate=false skips translateApi entirely and leaves session.translations undefined", async () => {
    const raw = "hello there.\ngeneral kenobi.";
    await importTranscriptText({
      raw,
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    expect(mockTranslateApi).not.toHaveBeenCalled();
  });

  it("translate=true calls translateApi and stores results in session.translations keyed by segment id", async () => {
    const raw = "hello there.\ngeneral kenobi.";
    mockTranslateApi.mockImplementation(async (body) => ({
      translations: body.segments.map((s) => ({ id: s.id, text: `翻译:${s.text}` })),
    }));

    const { sessionId } = await importTranscriptText({
      raw,
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    const session = await storage.getSession(sessionId);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    expect(session!.translations).toBeDefined();
    const segIds = session!.segments.map((s) => s.id);
    for (const id of segIds) {
      expect(session!.translations![id]).toBe(`翻译:${session!.segments.find((s) => s.id === id)!.text}`);
    }
  });

  it("RateLimitApiError during translate waits 65s then retries the same batch, succeeding", async () => {
    const raw = "hello there.\ngeneral kenobi.";
    mockTranslateApi
      .mockRejectedValueOnce(new RateLimitApiError())
      .mockImplementationOnce(async (body) => ({
        translations: body.segments.map((s) => ({ id: s.id, text: `翻译:${s.text}` })),
      }));

    const promise = importTranscriptText({
      raw,
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(64_999);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const { sessionId, warnings } = await promise;
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);

    const session = await storage.getSession(sessionId);
    expect(Object.keys(session!.translations ?? {})).toHaveLength(2);
  });

  it("exceeding the translate run-level wait cap stops translating remaining batches, keeps what's done, and adds a zh warning", async () => {
    // 14 short lines -> 3 batches of 6/6/2 (TRANSLATE_BATCH_SIZE=6).
    const raw = Array.from({ length: 14 }, (_, i) => `Line number ${i}.`).join("\n");
    mockTranslateApi.mockImplementation(async () => {
      throw new RateLimitApiError();
    });

    const promise = importTranscriptText({
      raw,
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    // Drain every pending 65s wait until the promise settles (bounded
    // loop so a logic bug can't hang the test suite).
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(65_000);
    }

    const { warnings } = await promise;
    expect(warnings).toEqual(["翻译请求多次被限流，已停止翻译剩余内容"]);
  });

  it("NoKeyError during translate stops translating silently, keeps the session, and adds a zh warning", async () => {
    const raw = "hello there.\ngeneral kenobi.";
    mockTranslateApi.mockRejectedValue(new NoKeyError());

    const { sessionId, warnings } = await importTranscriptText({
      raw,
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    expect(warnings).toEqual(["未配置 API Key，已跳过中文对照"]);
    const session = await storage.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.translations ?? {}).toEqual({});
  });

  it("saves a session with cards/terms/translations populated from the detect and translate pipelines", async () => {
    mockDetectApi.mockResolvedValue({
      expressions: [
        {
          expression: "circle back",
          category: "phrase",
          meaning: "revisit later",
          chinese_explanation: "回头再聊",
          plain_english: "discuss again later",
          tone: "neutral",
          confidence: 0.9,
          source_sentence: "Let's circle back on this.",
        },
      ],
      terms: [],
    });
    mockTranslateApi.mockImplementation(async (body) => ({
      translations: body.segments.map((s) => ({ id: s.id, text: `翻译:${s.text}` })),
    }));

    const raw = "Let's circle back on this.";
    const { sessionId } = await importTranscriptText({
      raw,
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    const session = await storage.getSession(sessionId);
    expect(session!.cards).toHaveLength(1);
    expect(session!.cards[0].expression).toBe("circle back");
    expect(Object.keys(session!.translations ?? {})).toHaveLength(1);
  });

  it("title resolution: explicit title wins over filename and the date fallback", async () => {
    const { sessionId } = await importTranscriptText({
      raw: "hello.",
      filename: "meeting.srt",
      title: "自定义标题",
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });
    const session = await storage.getSession(sessionId);
    expect(session!.title).toBe("自定义标题");
  });

  it("title resolution: filename stem is used (extension stripped) when no explicit title is given", async () => {
    const { sessionId } = await importTranscriptText({
      raw: "hello.",
      filename: "weekly-standup.vtt",
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });
    const session = await storage.getSession(sessionId);
    expect(session!.title).toBe("导入 weekly-standup");
  });

  it("title resolution: falls back to a date-stamped 导入的文稿 title when neither title nor filename is given", async () => {
    const now = new Date("2026-03-15T09:30:00");
    vi.setSystemTime(now);
    const { sessionId } = await importTranscriptText({
      raw: "hello.",
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });
    const session = await storage.getSession(sessionId);
    expect(session!.title).toBe("导入的文稿 2026-03-15 09:30");
  });
});
