import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

vi.mock("../../llm/client", () => ({
  detectApi: vi.fn(),
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

vi.mock("../../detect/dictionary", () => ({
  scanDictionary: vi.fn(() => ({ expressions: [], terms: [] })),
}));

// importUrlAndTrack (#43 phase 2c) touches the same
// saveSession/loadSession side effects importAndTrack's sidecar branch
// does — mocked here (neither is exercised by the rate-limit/
// buildSessionFrom* suites above, which never reach these calls) so
// the URL-import flow tests below can assert on the resulting session
// without a real IndexedDB/zustand store.
const mockSaveSession = vi.fn(async (_session: unknown) => {});
vi.mock("../../history/storage", () => ({
  saveSession: (session: unknown) => mockSaveSession(session),
}));

const mockLoadSession = vi.fn(async () => {});
vi.mock("../../store", () => ({
  useApp: {
    getState: () => ({ loadSession: mockLoadSession }),
  },
}));

import { detectApi, RateLimitApiError, NoKeyError } from "../../llm/client";
import { scanDictionary } from "../../detect/dictionary";
import {
  runDetectionPipeline,
  buildSessionFromSegments,
  ingestUrl,
  importUrlAndTrack,
  withSidecarHint,
  SIDECAR_UNREACHABLE_HINT,
  type PlainTranscriptSegment,
} from "../upload";

const mockDetectApi = vi.mocked(detectApi);
const mockScanDictionary = vi.mocked(scanDictionary);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function emptyRes() {
  return { expressions: [], terms: [] };
}

describe("runDetectionPipeline — rate-limit pacing", () => {
  let settings: Settings;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = makeSettings();
    mockDetectApi.mockReset();
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aiDetect off (#54): fully offline — zero detectApi calls, every batch goes straight to the dictionary", async () => {
    settings = makeSettings({ aiDetect: false });
    const dictRes = {
      expressions: [],
      terms: [{ term: "ARR", type: "metric" as const, gloss_en: "e", gloss_zh: "z" }],
    };
    mockScanDictionary.mockReturnValue(dictRes);

    const onProgress = vi.fn();
    const result = await runDetectionPipeline(
      [{ text: "circle back on our ARR" }],
      [],
      settings,
      onProgress,
    );

    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0].source).toBe("dictionary");
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it("a RateLimitApiError sleeps 65s then retries the same batch, succeeding without falling back to the dictionary", async () => {
    mockDetectApi.mockRejectedValueOnce(new RateLimitApiError()).mockResolvedValueOnce(emptyRes());

    const onProgress = vi.fn();
    const promise = runDetectionPipeline(
      [{ text: "circle back on this tomorrow" }],
      [],
      settings,
      onProgress,
    );

    // Let the microtask queue run so detectApi's first (rejecting)
    // call resolves and the 65s sleep gets armed.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // Still waiting just before the 65s boundary.
    await vi.advanceTimersByTimeAsync(64_999);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // Fires the retry at exactly 65s.
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it("a lone batch exhausting only its OWN per-batch wait cap (2) falls back to the dictionary for that batch, without latching the run or firing onRateLimitFallback", async () => {
    mockDetectApi.mockRejectedValue(new RateLimitApiError());

    const onRateLimitFallback = vi.fn();
    const promise = runDetectionPipeline(
      [{ text: "one single batch, all attempts rate-limited" }],
      [],
      settings,
      undefined,
      onRateLimitFallback,
    );

    // 3 attempts total: initial + 2 retries (2 waits), each gated by
    // a 65s sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockDetectApi).toHaveBeenCalledTimes(3);

    await promise;

    // Per-batch cap (2 waits) exhausted after the 3rd attempt — no 4th
    // call, and the dictionary took over for this batch. Only 2 of the
    // 5 run-level waits were spent, so the run itself is NOT latched
    // and onRateLimitFallback (a run-exhausted signal) does not fire.
    expect(mockDetectApi).toHaveBeenCalledTimes(3);
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
    expect(onRateLimitFallback).not.toHaveBeenCalled();
  });

  it("exceeding the run-level wait cap (5) latches dictionary fallback for every remaining batch, calling detectApi no further times", async () => {
    mockDetectApi.mockRejectedValue(new RateLimitApiError());

    const onRateLimitFallback = vi.fn();
    const batches = [
      { text: "batch one text content here" },
      { text: "batch two text content here" },
      { text: "batch three text content here" },
    ];
    // Force separate chunkSegmentTexts batches by exceeding
    // BATCH_CHARS(1200) is unnecessary here — feed 3 pre-split texts,
    // each under the char cap but distinct entries so the chunker's
    // greedy join keeps them together unless we make them long enough
    // to each exceed 1200 on their own. Simpler: just call the
    // pipeline 3 times conceptually via 3 long/separate texts so the
    // chunker can't merge them into a single batch.
    const longBatches = batches.map((b) => ({ text: b.text.repeat(60) }));

    const promise = runDetectionPipeline(longBatches, [], settings, undefined, onRateLimitFallback);

    // Batch 1: initial + 2 waits (uses run-waits 1,2) -> 3 attempts,
    // falls back to dictionary (per-batch cap hit), latches run-level
    // continuation is NOT yet exhausted (2/5 used).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(65_000);

    // Batch 2: initial + 2 waits (uses run-waits 3,4) -> 3 more
    // attempts, falls back to dictionary too (per-batch cap hit
    // again); run-level total so far = 4/5.
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(65_000);

    // Batch 3: initial attempt fails, 1st retry would be run-wait #5
    // (still allowed), 2nd retry would be run-wait #6 (run cap
    // exhausted) -> falls back to dictionary directly without a 3rd
    // detectApi attempt for this batch.
    await vi.advanceTimersByTimeAsync(65_000);

    await promise;

    // 3 (batch1) + 3 (batch2) + 2 (batch3: initial + 1 retry) = 8
    expect(mockDetectApi).toHaveBeenCalledTimes(8);
    expect(mockScanDictionary).toHaveBeenCalledTimes(3);
    expect(onRateLimitFallback).toHaveBeenCalledTimes(1);
  });

  it("NoKeyError falls back to the dictionary for that batch immediately, no wait, no latch", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError()).mockResolvedValueOnce(emptyRes());

    // Each text is padded past BATCH_CHARS(1200) on its own so the
    // greedy chunker can't join them into a single batch — we need
    // two distinct detectApi calls to observe the "no latch" claim.
    const promise = runDetectionPipeline(
      [
        { text: "first batch, no key configured. ".repeat(40) },
        { text: "second batch, key now present. ".repeat(40) },
      ],
      [],
      settings,
    );

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
  });

  it("a transient (non-429, non-NoKey) error is retried once after 4s — retry success keeps the LLM result, no dictionary", async () => {
    mockDetectApi
      .mockRejectedValueOnce(new Error("upstream 502"))
      .mockResolvedValueOnce(emptyRes());

    const promise = runDetectionPipeline(
      [{ text: "one batch, brief upstream blip" }],
      [],
      settings,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).not.toHaveBeenCalled();
  });

  it("a transient error failing twice falls back to the dictionary for that batch (one retry only)", async () => {
    mockDetectApi.mockRejectedValue(new Error("upstream 502, persistent"));

    const promise = runDetectionPipeline(
      [{ text: "one batch, persistent upstream failure" }],
      [],
      settings,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
  });
});

describe("buildSessionFromSegments — reuse (#43 phase 2a)", () => {
  let settings: Settings;

  beforeEach(() => {
    settings = makeSettings();
    mockDetectApi.mockReset();
    mockDetectApi.mockResolvedValue(emptyRes());
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
  });

  const segments: PlainTranscriptSegment[] = [
    { start: 0, end: 2, text: "circle back on this" },
    { start: 2, end: 4, text: "let's move the needle" },
  ];

  it("honors the passed engine/title rather than hardcoding whisper/导入 <filename>", async () => {
    const session = await buildSessionFromSegments(segments, settings, {
      title: "自定义会话标题",
      engine: "browser-whisper",
    });

    expect(session.engine).toBe("browser-whisper");
    expect(session.title).toBe("自定义会话标题");
    expect(session.segments).toHaveLength(2);
    expect(session.segments[0].engine).toBe("browser-whisper");
    expect(session.segments[0].text).toBe("circle back on this");
  });

  it("导入 <filename> title + whisper engine shape (what the sunset #22 cloud helper used to wrap) still holds via direct call", async () => {
    const session = await buildSessionFromSegments(segments, settings, {
      title: "导入 meeting.wav",
      engine: "whisper",
    });
    expect(session.engine).toBe("whisper");
    expect(session.title).toBe("导入 meeting.wav");
    expect(session.segments.map((s) => ({ text: s.text, engine: s.engine }))).toEqual([
      { text: "circle back on this", engine: "whisper" },
      { text: "let's move the needle", engine: "whisper" },
    ]);
  });
});

describe("ingestUrl — request shape (#43 phase 2c, LOCAL TIER ONLY)", () => {
  let settings: Settings;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settings = makeSettings({ whisperUrl: "ws://localhost:8765" });
    mockFetch = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ job_id: "job-123" }),
    }));
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it("POSTs JSON {url, language} to {httpBase}/ingest-url, with no diarize/hf_token when hfToken is unset", async () => {
    const { jobId } = await ingestUrl("https://example.com/watch?v=abc", settings);

    expect(jobId).toBe("job-123");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8766/ingest-url");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      url: "https://example.com/watch?v=abc",
      language: "en",
    });
  });

  it("includes diarize + hf_token when settings.hfToken is present, mirroring uploadRecording's own gating", async () => {
    settings = makeSettings({ whisperUrl: "ws://localhost:8765", hfToken: "hf_secret" });

    await ingestUrl("https://example.com/watch?v=abc", settings, false);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      url: "https://example.com/watch?v=abc",
      language: "en",
      diarize: false,
      hf_token: "hf_secret",
    });
  });

  it("uses settings.language's primary subtag only (zh-CN -> zh), same as uploadRecording", async () => {
    settings = makeSettings({ whisperUrl: "ws://localhost:8765", language: "zh-CN" });

    await ingestUrl("https://example.com/watch?v=abc", settings);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.language).toBe("zh");
  });

  it("surfaces the sidecar's zh error message on a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "未检测到 yt-dlp，请先安装（brew install yt-dlp 或 pipx install yt-dlp）" }),
    });

    await expect(ingestUrl("https://example.com/watch?v=abc", settings)).rejects.toThrow(
      "未检测到 yt-dlp，请先安装（brew install yt-dlp 或 pipx install yt-dlp）",
    );
  });

  it("falls back to a generic message when the error response has no parseable JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    await expect(ingestUrl("https://example.com/watch?v=abc", settings)).rejects.toThrow(
      "导入失败（500）",
    );
  });
});

describe("importUrlAndTrack — poll/build/save flow (#43 phase 2c, LOCAL TIER ONLY)", () => {
  let settings: Settings;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = makeSettings({ whisperUrl: "ws://localhost:8765" });
    mockDetectApi.mockReset();
    mockDetectApi.mockResolvedValue(emptyRes());
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
    mockSaveSession.mockClear();
    mockLoadSession.mockClear();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses the SAME poll -> buildSessionFromJob -> save -> load flow as importAndTrack's sidecar branch, using the job's own display_name as the session title", async () => {
    mockFetch
      // ingestUrl's POST /ingest-url
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ job_id: "job-url-1" }),
      })
      // first poll: still running, downloading
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "job-url-1",
          status: "running",
          progress: 0.1,
          status_detail: "下载中",
          segments: [],
          error: null,
          diarized: false,
          warning: null,
          display_name: null,
        }),
      })
      // second poll: transcribing
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "job-url-1",
          status: "running",
          progress: 0.5,
          status_detail: null,
          segments: [],
          error: null,
          diarized: false,
          warning: null,
          display_name: "Me at the zoo",
        }),
      })
      // third poll: done
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "job-url-1",
          status: "done",
          progress: 1.0,
          status_detail: null,
          segments: [{ start: 0, end: 2, text: "circle back on this" }],
          error: null,
          diarized: false,
          warning: null,
          display_name: "Me at the zoo",
        }),
      });

    const onProgress = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const promise = importUrlAndTrack(
      "https://example.com/watch?v=abc",
      settings,
      { onProgress, onDone, onError },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500); // POLL_INTERVAL_MS, first -> second poll
    await vi.advanceTimersByTimeAsync(1_500); // second -> third (done) poll
    await promise;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0, "下载中");
    expect(onProgress).toHaveBeenCalledWith(0.1, "下载中");
    expect(onProgress).toHaveBeenCalledWith(0.5, "转录中");

    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    const savedSession = mockSaveSession.mock.calls[0][0] as unknown as {
      title: string;
      segments: unknown[];
    };
    // buildSessionFromJob's own title convention: `导入 ${filename}`,
    // fed the job's display_name (server-resolved title) rather than a
    // client-known File.name — the one behavioral difference from
    // importAndTrack's uploaded-file branch, which always has a
    // filename before the job even starts.
    expect(savedSession.title).toBe("导入 Me at the zoo");
    expect(savedSession.segments).toHaveLength(1);

    expect(mockLoadSession).toHaveBeenCalledTimes(1);
  });

  it("falls back to the URL itself as buildSessionFromJob's filename when the job never resolves a display_name", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ job_id: "job-url-2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "job-url-2",
          status: "done",
          progress: 1.0,
          status_detail: null,
          segments: [],
          error: null,
          diarized: false,
          warning: null,
          display_name: null,
        }),
      });

    const onDone = vi.fn();
    const onError = vi.fn();
    const promise = importUrlAndTrack("https://example.com/clip", settings, {
      onProgress: vi.fn(),
      onDone,
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(onError).not.toHaveBeenCalled();
    const savedSession = mockSaveSession.mock.calls[0][0] as unknown as { title: string };
    expect(savedSession.title).toBe("导入 https://example.com/clip");
  });

  it("reports the job's error via onError without throwing, and never calls saveSession/loadSession", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ job_id: "job-url-3" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "job-url-3",
          status: "error",
          progress: 0,
          status_detail: "下载中",
          segments: [],
          error: "下载失败：ERROR: unable to resolve host",
          diarized: false,
          warning: null,
          display_name: null,
        }),
      });

    const onError = vi.fn();
    const onDone = vi.fn();
    const promise = importUrlAndTrack("https://not-a-real-site.invalid/x", settings, {
      onProgress: vi.fn(),
      onDone,
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(onError).toHaveBeenCalledWith("下载失败：ERROR: unable to resolve host");
    expect(onDone).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it("reports ingestUrl's own rejection (e.g. missing yt-dlp) via onError, never calling pollJob", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "未检测到 yt-dlp，请先安装（brew install yt-dlp 或 pipx install yt-dlp）",
      }),
    });

    const onError = vi.fn();
    const promise = importUrlAndTrack("https://example.com/clip", settings, {
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(onError).toHaveBeenCalledWith(
      "未检测到 yt-dlp，请先安装（brew install yt-dlp 或 pipx install yt-dlp）",
    );
    // Only the ingestUrl POST — no poll GET was ever attempted.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("withSidecarHint — ImportHub sidecar-path error hint (#58 review fix 2)", () => {
  it("appends SIDECAR_UNREACHABLE_HINT to any message", () => {
    expect(withSidecarHint("上传失败（500）")).toBe(`上传失败（500）${SIDECAR_UNREACHABLE_HINT}`);
    expect(withSidecarHint("转录失败")).toBe(`转录失败${SIDECAR_UNREACHABLE_HINT}`);
  });

  it("the hint text itself is the exact pre-#58 HistoryDrawer copy", () => {
    expect(SIDECAR_UNREACHABLE_HINT).toBe("，确认 sidecar 已启动且 --http-port 开启");
  });
});
