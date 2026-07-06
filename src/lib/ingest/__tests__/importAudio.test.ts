import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

// ---- whisperBrowser: canned segments, no real Worker/model ----
vi.mock("../whisperBrowser", () => ({
  transcribeInBrowser: vi.fn(),
}));

// ---- ffmpegExtract (#43 phase 2b): isVideoFile stays REAL (it's pure
// and cheap — the whole point of one test below is exercising
// importAudio's actual routing decision against it), only
// extractAudioFromVideo is mocked so no real ffmpeg.wasm ever loads
// here (that module's own suite, ffmpegExtract.test.ts, covers ffmpeg
// call shape/terminate discipline directly). ----
vi.mock("../ffmpegExtract", async () => {
  const actual = await vi.importActual<typeof import("../ffmpegExtract")>("../ffmpegExtract");
  return {
    ...actual,
    extractAudioFromVideo: vi.fn(),
  };
});

// ---- detection: same shape as upload.test.ts/importText.test.ts's
// own mocks, so buildSessionFromSegments (real, imported from
// ../../stt/upload below) runs for real but never calls a live LLM. ----
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

vi.mock("../../detect/dictionary", () => ({
  scanDictionary: vi.fn(() => ({ expressions: [], terms: [] })),
}));

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

import { detectApi, translateApi, NoKeyError, RateLimitApiError } from "../../llm/client";
import * as storage from "../../history/storage";
import { transcribeInBrowser } from "../whisperBrowser";
import { extractAudioFromVideo } from "../ffmpegExtract";
import {
  importAudio,
  assertDurationWithinLimit,
  AudioTooLongError,
  AudioTooLargeError,
} from "../importAudio";
import { mapChunksToSegments } from "../whisper.worker";

const mockDetectApi = vi.mocked(detectApi);
const mockTranslateApi = vi.mocked(translateApi);
const mockTranscribeInBrowser = vi.mocked(transcribeInBrowser);
const mockExtractAudioFromVideo = vi.mocked(extractAudioFromVideo);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

// ---- fake AudioContext/OfflineAudioContext: vitest's environment is
// `node` (no real Web Audio) — the task spec explicitly calls out
// that decode/resample can't run under vitest node, so the pure
// mapChunksToSegments/assertDurationWithinLimit helpers get their own
// direct-call tests below. These globals let importAudio()'s
// orchestration run END TO END (decode -> transcribe -> build ->
// translate -> save) against a controlled fake decode result, so the
// higher-value assertions (session shape, translations, warnings)
// exercise the real function rather than a re-implementation of it. ----
const FAKE_DURATION_S = 5;

class FakeAudioBuffer {
  duration = FAKE_DURATION_S;
}

class FakeAudioContext {
  async decodeAudioData(_buf: ArrayBuffer) {
    return new FakeAudioBuffer() as unknown as AudioBuffer;
  }
  async close() {}
}

class FakeOfflineAudioContext {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  createBufferSource() {
    return {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start: vi.fn(),
    };
  }
  async startRendering() {
    return {
      getChannelData: () => new Float32Array(this.length),
    } as unknown as AudioBuffer;
  }
}

describe("importAudio", () => {
  beforeEach(() => {
    memStore.clear();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
    (globalThis as { window?: unknown }).window = globalThis;
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
    (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext =
      FakeOfflineAudioContext;

    mockDetectApi.mockReset();
    mockDetectApi.mockResolvedValue({ expressions: [], terms: [] });
    mockTranslateApi.mockReset();
    mockTranslateApi.mockResolvedValue({ translations: [] });
    mockTranscribeInBrowser.mockReset();
    mockTranscribeInBrowser.mockResolvedValue([
      { start: 0, end: 2, text: "circle back on this" },
      { start: 2, end: 4, text: "let's move the needle" },
    ]);
    mockExtractAudioFromVideo.mockReset();
    mockExtractAudioFromVideo.mockResolvedValue(new ArrayBuffer(8));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function fakeFile(name = "meeting.wav", size = 8): File {
    return {
      name,
      // Real Files always carry a (possibly empty) .type — isVideoFile
      // (now called at the top of importAudio) reads it unconditionally.
      type: "",
      size,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as File;
  }

  // #43 phase 2b: a video File — MIME + extension both signal "video"
  // so isVideoFile's routing branch fires deterministically regardless
  // of which check it happens to short-circuit on.
  function fakeVideoFile(name = "meeting.mp4"): File {
    return {
      name,
      type: "video/mp4",
      size: 1024,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as File;
  }

  it("builds a session with engine 'browser-whisper', the 导入 <filename> title, and the transcribed segment count", async () => {
    const { sessionId } = await importAudio({
      file: fakeFile("meeting.wav"),
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    const session = await storage.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.engine).toBe("browser-whisper");
    expect(session!.title).toBe("导入 meeting.wav");
    expect(session!.segments).toHaveLength(2);
    expect(session!.segments[0].text).toBe("circle back on this");
    expect(session!.segments[0].engine).toBe("browser-whisper");
  });

  it("routes a video file through extractAudioFromVideo (with a 提取音频 progress phase) then the normal pipeline, title still 导入 <filename>", async () => {
    mockExtractAudioFromVideo.mockImplementation(async (_file, onProgress) => {
      onProgress?.(0.5);
      onProgress?.(1);
      return new ArrayBuffer(8);
    });
    const onProgress = vi.fn();

    const { sessionId } = await importAudio({
      file: fakeVideoFile("clip.mp4"),
      translate: false,
      settings: makeSettings(),
      onProgress,
    });

    expect(mockExtractAudioFromVideo).toHaveBeenCalledTimes(1);
    const [fileArg] = mockExtractAudioFromVideo.mock.calls[0];
    expect(fileArg.name).toBe("clip.mp4");

    const phases = onProgress.mock.calls.map((c) => c[1]);
    expect(phases).toContain("提取音频");
    expect(phases).not.toContain("读取音频"); // video path skips the audio-only phase label

    const session = await storage.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.title).toBe("导入 clip.mp4");
    expect(session!.engine).toBe("browser-whisper");
    expect(session!.segments).toHaveLength(2);
  });

  it("an audio file bypasses extraction entirely — extractAudioFromVideo is never called", async () => {
    await importAudio({
      file: fakeFile("meeting.wav"),
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    expect(mockExtractAudioFromVideo).not.toHaveBeenCalled();
  });

  it("throws AudioTooLargeError for a native audio file over 200MB WITHOUT ever calling decodeAudioData/transcribeInBrowser", async () => {
    const file = fakeFile("huge.wav", 200 * 1024 * 1024 + 1);

    await expect(
      importAudio({ file, translate: false, settings: makeSettings(), onProgress: vi.fn() }),
    ).rejects.toThrow(AudioTooLargeError);
    await expect(
      importAudio({ file, translate: false, settings: makeSettings(), onProgress: vi.fn() }),
    ).rejects.toThrow("音频过大（超过 200 MB），请改用本地 Whisper sidecar 转录");

    expect(mockTranscribeInBrowser).not.toHaveBeenCalled();
  });

  it("a native audio file exactly at the 200MB boundary is NOT rejected", async () => {
    const file = fakeFile("boundary.wav", 200 * 1024 * 1024);

    await expect(
      importAudio({ file, translate: false, settings: makeSettings(), onProgress: vi.fn() }),
    ).resolves.toMatchObject({ warnings: [] });
  });

  it("translate:false skips translateApi and leaves session.translations undefined", async () => {
    const { sessionId } = await importAudio({
      file: fakeFile(),
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    expect(mockTranslateApi).not.toHaveBeenCalled();
    const session = await storage.getSession(sessionId);
    expect(session!.translations).toBeUndefined();
  });

  it("translate:true attaches session.translations keyed by segment id", async () => {
    mockTranslateApi.mockImplementation(async (body) => ({
      translations: body.segments.map((s) => ({ id: s.id, text: `翻译:${s.text}` })),
    }));

    const { sessionId } = await importAudio({
      file: fakeFile(),
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    const session = await storage.getSession(sessionId);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    expect(session!.translations).toBeDefined();
    for (const seg of session!.segments) {
      expect(session!.translations![seg.id]).toBe(`翻译:${seg.text}`);
    }
  });

  it("NoKeyError during translate surfaces a zh warning and keeps the session (translate skipped, not failed)", async () => {
    mockTranslateApi.mockRejectedValue(new NoKeyError());

    const { warnings, sessionId } = await importAudio({
      file: fakeFile(),
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    expect(warnings).toEqual(["未配置 API Key，已跳过中文对照"]);
    const session = await storage.getSession(sessionId);
    expect(session).not.toBeNull();
  });

  it("a persistent RateLimitApiError during translate stops translating and surfaces the run-level zh warning", async () => {
    mockTranslateApi.mockRejectedValue(new RateLimitApiError());
    // 14 segments -> 3 translate batches of 6/6/2 (TRANSLATE_BATCH_SIZE
    // =6), same shape as importText.test.ts's run-level-exhaustion
    // case — a single batch alone can't exhaust the run-level cap
    // (only its own per-batch cap), so this needs several batches.
    mockTranscribeInBrowser.mockResolvedValue(
      Array.from({ length: 14 }, (_, i) => ({ start: i, end: i + 1, text: `line ${i}` })),
    );
    vi.useFakeTimers();
    const promise = importAudio({
      file: fakeFile(),
      translate: true,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(65_000);
    }
    const { warnings } = await promise;
    vi.useRealTimers();

    expect(warnings).toEqual(["翻译请求多次被限流，已停止翻译剩余内容"]);
  });

  it("calls onProgress through the 读取音频/下载模型/转录/构建会话 phases", async () => {
    mockTranscribeInBrowser.mockImplementation(async (_audio, _modelId, onProgress) => {
      onProgress?.({ phase: "download", ratio: 0.5 });
      onProgress?.({ phase: "transcribe", ratio: 1 });
      return [{ start: 0, end: 1, text: "hi" }];
    });

    const onProgress = vi.fn();
    await importAudio({
      file: fakeFile(),
      translate: false,
      settings: makeSettings(),
      onProgress,
    });

    const phases = onProgress.mock.calls.map((c) => c[1]);
    expect(phases).toContain("读取音频");
    expect(phases).toContain("下载模型");
    expect(phases).toContain("转录");
    expect(phases).toContain("构建会话");
  });

  it("passes the decoded Float32Array and the default model id to transcribeInBrowser", async () => {
    await importAudio({
      file: fakeFile(),
      translate: false,
      settings: makeSettings(),
      onProgress: vi.fn(),
    });

    expect(mockTranscribeInBrowser).toHaveBeenCalledTimes(1);
    const [audioArg, modelIdArg] = mockTranscribeInBrowser.mock.calls[0];
    expect(audioArg).toBeInstanceOf(Float32Array);
    expect(modelIdArg).toBe("onnx-community/whisper-base");
  });
});

// ---------------------------------------------------------------
// Pure helpers — exercised directly since decode/resample itself
// can't run under vitest's node environment (no real AudioContext).
// ---------------------------------------------------------------

describe("assertDurationWithinLimit", () => {
  it("does not throw at or under the 45-minute boundary", () => {
    expect(() => assertDurationWithinLimit(45 * 60)).not.toThrow();
    expect(() => assertDurationWithinLimit(0)).not.toThrow();
  });

  it("throws AudioTooLongError just over the 45-minute boundary", () => {
    expect(() => assertDurationWithinLimit(45 * 60 + 1)).toThrow(AudioTooLongError);
    expect(() => assertDurationWithinLimit(45 * 60 + 1)).toThrow(
      "音频过长（超过 45 分钟），请分段后再导入",
    );
  });
});

describe("mapChunksToSegments", () => {
  it("maps {text, timestamp:[start,end]} chunks to {start,end,text}", () => {
    const result = mapChunksToSegments([
      { text: " hello there", timestamp: [0, 1.5] },
      { text: " general kenobi", timestamp: [1.5, 3] },
    ]);

    expect(result).toEqual([
      { start: 0, end: 1.5, text: "hello there" },
      { start: 1.5, end: 3, text: "general kenobi" },
    ]);
  });

  it("drops a chunk whose start timestamp is null or undefined", () => {
    const result = mapChunksToSegments([
      { text: "kept", timestamp: [0, 1] },
      { text: "dropped (null start)", timestamp: [null, 2] },
      { text: "dropped (undefined start)", timestamp: [undefined, 3] },
    ]);

    expect(result).toEqual([{ start: 0, end: 1, text: "kept" }]);
  });

  it("falls back end to start when end is null/undefined (unclosed trailing chunk)", () => {
    const result = mapChunksToSegments([{ text: "trailing", timestamp: [9, null] }]);
    expect(result).toEqual([{ start: 9, end: 9, text: "trailing" }]);
  });
});
