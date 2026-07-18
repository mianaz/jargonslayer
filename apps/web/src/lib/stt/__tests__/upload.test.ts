import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

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

vi.mock("@jargonslayer/core/detect/dictionary", () => ({
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
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import {
  runDetectionPipeline,
  buildSessionFromSegments,
  fetchSidecarHealth,
  ingestUrl,
  importUrlAndTrack,
  withSidecarHint,
  SIDECAR_UNREACHABLE_HINT,
  type PlainTranscriptSegment,
} from "../upload";
import { clearDiag, getDiagEntries } from "../../diag/log";
import { resetLlmTelemetry, useLlmTelemetry } from "../../llm/telemetry";

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

  // R1 (model-blind call path fix): detectApi must be called with the
  // resolved detect-domain model, exactly like the live scheduler
  // (scheduler.ts) and LookupPopover already do — otherwise a non-
  // OpenRouter openai-compat/Anthropic-direct user silently falls to
  // the (DeepSeek-slug) server default and 404s. Pre-fix, this batch's
  // detectApi call carried no `model` field at all.
  it("forwards the resolved detect-domain model to detectApi (not the server/task default)", async () => {
    settings = makeSettings({
      provider: "openai-compat",
      baseUrl: "https://api.deepseek.com/v1",
      detectModel: "deepseek-chat",
    });
    mockDetectApi.mockResolvedValueOnce(emptyRes());

    await runDetectionPipeline([{ text: "circle back on our ARR next week" }], [], settings);

    expect(mockDetectApi).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-chat" }),
      settings,
    );
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

  // R6 field fix (Sol F5): the SAME scenario as the test immediately
  // above (a lone batch exhausting only its OWN per-batch cap, run-level
  // cap never reached) used to warn NOTHING — the batch's failure is a
  // RateLimitApiError (excluded from nonRateLimitFailures on purpose)
  // AND onRateLimitFallback never fires (the run-level cap, 5, was never
  // reached with only 2 waits spent) — a fully-degraded 1-batch import
  // completed silently. RED against the pre-fix code (no
  // rateLimitDegradedBatches tally at all): onLlmDetectFailure would
  // never have been called here.
  it("R6/F5: a lone batch degraded ONLY by its own per-batch rate-limit cap still fires onLlmDetectFailure (reusing the run-level rate-limit wording, zero batches succeeded)", async () => {
    mockDetectApi.mockRejectedValue(new RateLimitApiError());

    const onRateLimitFallback = vi.fn();
    const onLlmDetectFailure = vi.fn();
    const promise = runDetectionPipeline(
      [{ text: "one single batch, all attempts rate-limited" }],
      [],
      settings,
      undefined,
      onRateLimitFallback,
      onLlmDetectFailure,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(65_000);
    await promise;

    expect(onRateLimitFallback).not.toHaveBeenCalled();
    expect(onLlmDetectFailure).toHaveBeenCalledTimes(1);
    expect(onLlmDetectFailure).toHaveBeenCalledWith("检测请求多次被限流", false);
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

  it("finding 3 (field report): EVERY batch failing with NoKeyError fires onLlmDetectFailure ONCE with the upstream (already-zh) error message", async () => {
    mockDetectApi.mockRejectedValue(new NoKeyError("未配置 API Key"));

    const onLlmDetectFailure = vi.fn();
    // Two padded batches so this isn't just a single-batch degenerate
    // case — both fail, so both "all" and "majority" trigger the fire.
    const promise = runDetectionPipeline(
      [
        { text: "first batch, no key at all. ".repeat(40) },
        { text: "second batch, still no key. ".repeat(40) },
      ],
      [],
      settings,
      undefined,
      undefined,
      onLlmDetectFailure,
    );

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(mockScanDictionary).toHaveBeenCalledTimes(2);
    expect(onLlmDetectFailure).toHaveBeenCalledTimes(1);
    // R6/F6: `partial` (2nd arg) is false — ZERO batches succeeded via
    // the LLM this run, so the caller picks the "AI 检测未生效" template.
    expect(onLlmDetectFailure).toHaveBeenCalledWith("未配置 API Key", false);
  });

  it("a MINORITY of batches failing with NoKeyError (1 of 3) does NOT fire onLlmDetectFailure", async () => {
    mockDetectApi
      .mockResolvedValueOnce(emptyRes())
      .mockRejectedValueOnce(new NoKeyError())
      .mockResolvedValueOnce(emptyRes());

    const onLlmDetectFailure = vi.fn();
    const promise = runDetectionPipeline(
      [
        { text: "batch one, succeeds. ".repeat(40) },
        { text: "batch two, no key. ".repeat(40) },
        { text: "batch three, succeeds. ".repeat(40) },
      ],
      [],
      settings,
      undefined,
      undefined,
      onLlmDetectFailure,
    );

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(onLlmDetectFailure).not.toHaveBeenCalled();
  });

  it("a run latched by the run-level rate-limit cap does NOT ALSO fire onLlmDetectFailure (one detect warning per import, not two)", async () => {
    mockDetectApi.mockRejectedValue(new RateLimitApiError());
    const longBatches = [
      { text: "batch one text content here".repeat(60) },
      { text: "batch two text content here".repeat(60) },
      { text: "batch three text content here".repeat(60) },
    ];

    const onRateLimitFallback = vi.fn();
    const onLlmDetectFailure = vi.fn();
    const promise = runDetectionPipeline(
      longBatches,
      [],
      settings,
      undefined,
      onRateLimitFallback,
      onLlmDetectFailure,
    );

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(65_000);
    }
    await promise;

    expect(onRateLimitFallback).toHaveBeenCalledTimes(1);
    expect(onLlmDetectFailure).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------
// v0.4.5 detect-span QC (item 6, field bug follow-up): scheduler.ts's
// live path already had a span-length guard, but this import path
// (runDetectionPipeline's "llm" success branch) had NONE at all — an
// oversized/whole-sentence expression the LLM tagged despite the
// prompt-level constraint reached mergeDetections untouched. RED
// against the pre-fix code (no filterDetectSpans call in the `if
// (res)` branch at all): the oversized expression below would have
// survived into `result.cards`.
// ---------------------------------------------------------------
describe("runDetectionPipeline — detect-span QC (v0.4.5 item 6, the import-path gap)", () => {
  let settings: Settings;

  beforeEach(() => {
    settings = makeSettings();
    mockDetectApi.mockReset();
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
    clearDiag();
    resetLlmTelemetry();
  });

  const oversizedSentence =
    "The referee made a controversial offside call in the final minute of the match";

  it("drops an oversized llm-tagged expression before it reaches result.cards, keeping a short one from the same batch", async () => {
    mockDetectApi.mockResolvedValueOnce({
      expressions: [
        {
          expression: "circle back",
          category: "phrase",
          meaning: "m",
          chinese_explanation: "z",
          plain_english: "p",
          tone: "t",
          confidence: 0.9,
          source_sentence: "s",
        },
        {
          expression: oversizedSentence,
          category: "phrase",
          meaning: "m",
          chinese_explanation: "z",
          plain_english: "p",
          tone: "t",
          confidence: 0.9,
          source_sentence: oversizedSentence,
        },
      ],
      terms: [],
    });

    const result = await runDetectionPipeline(
      [{ text: "circle back on this. " + oversizedSentence }],
      [],
      settings,
    );

    expect(result.cards.map((c) => c.expression)).toEqual(["circle back"]);
  });

  it("logs a detect-ai-oversize diag entry and bumps the 'detect' QC-dropped telemetry counter on drop", async () => {
    mockDetectApi.mockResolvedValueOnce({
      expressions: [
        {
          expression: oversizedSentence,
          category: "phrase",
          meaning: "m",
          chinese_explanation: "z",
          plain_english: "p",
          tone: "t",
          confidence: 0.9,
          source_sentence: oversizedSentence,
        },
      ],
      terms: [],
    });

    await runDetectionPipeline([{ text: oversizedSentence }], [], settings);

    const entries = getDiagEntries().filter((e) => e.tag === "detect-ai-oversize");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe("dropped=1");
    expect(useLlmTelemetry.getState().detect.qcDropped).toBe(1);
  });

  it("a genuine short idiom survives untouched (no false-positive drop)", async () => {
    mockDetectApi.mockResolvedValueOnce({
      expressions: [
        {
          expression: "burning the midnight oil",
          category: "idiom",
          meaning: "m",
          chinese_explanation: "z",
          plain_english: "p",
          tone: "t",
          confidence: 0.9,
          source_sentence: "We've been burning the midnight oil.",
        },
      ],
      terms: [],
    });

    const result = await runDetectionPipeline(
      [{ text: "We've been burning the midnight oil." }],
      [],
      settings,
    );

    expect(result.cards.map((c) => c.expression)).toEqual(["burning the midnight oil"]);
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

  it("finding 3: a passed `warnings` array receives the aggregated AI-detect-failure message when both batches fail with NoKeyError", async () => {
    mockDetectApi.mockRejectedValue(new NoKeyError("未配置 API Key"));

    const warnings: string[] = [];
    await buildSessionFromSegments(
      segments,
      settings,
      { title: "会话标题", engine: "browser-whisper" },
      warnings,
    );

    expect(warnings).toEqual(["AI 检测未生效：未配置 API Key，本次仅词典检测"]);
  });

  it("finding 3: omitting the `warnings` array is a no-op — no throw even when every batch fails", async () => {
    mockDetectApi.mockRejectedValue(new NoKeyError());

    await expect(
      buildSessionFromSegments(segments, settings, {
        title: "会话标题",
        engine: "browser-whisper",
      }),
    ).resolves.toMatchObject({ title: "会话标题" });
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

// ---------------------------------------------------------------
// fetchSidecarHealth — health-parse incl. the new S5 chunk 1
// diarization_installed field (decision C/risk 5): undefined must
// never be coerced to false, whether the sidecar is unreachable or it
// simply predates S5. Mirrors ingestUrl's own direct global.fetch
// mocking above (this file's convention); sidecarHealth.test.ts covers
// the SAME field on probeSidecar's own parallel /health parse.
// ---------------------------------------------------------------

describe("fetchSidecarHealth — health-parse incl. diarization_installed (S5 chunk 3)", () => {
  let settings: Settings;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settings = makeSettings({ whisperUrl: "ws://localhost:8765" });
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it("passes diarization_installed:true through untouched", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        diarization_installed: true,
        diarization_ready: false,
        diarization_error: "未配置 HF Token",
      }),
    });

    const result = await fetchSidecarHealth(settings);

    expect(result?.diarization_installed).toBe(true);
  });

  it("passes diarization_installed:false through (not just omitted)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        diarization_installed: false,
        diarization_ready: false,
        diarization_error: null,
      }),
    });

    const result = await fetchSidecarHealth(settings);

    expect(result?.diarization_installed).toBe(false);
  });

  it("diarization_installed is undefined (never coerced) when a legacy/external sidecar omits it entirely", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, diarization_ready: true, diarization_error: null }),
    });

    const result = await fetchSidecarHealth(settings);

    expect(result?.diarization_installed).toBeUndefined();
  });

  it("returns null (never throws) when the sidecar is unreachable", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await fetchSidecarHealth(settings);

    expect(result).toBeNull();
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
    expect(SIDECAR_UNREACHABLE_HINT).toBe("，确认本地 Whisper 服务已启动且 --http-port 开启");
  });

  // R7 field fix (Sol F8, client half — wire contract with the
  // sidecar): a model-load failure means the sidecar WAS reached and
  // answered — "confirm the sidecar is started" is actively wrong
  // advice for this case. Tests the client-side decoration against the
  // pinned contract string directly (passes without the sibling's own
  // server-side change landing first, since this only exercises the
  // client half of the contract).
  it("R7: a message starting with the 模型加载失败 prefix skips the connection advice, surfacing 本地 Whisper 模型加载失败 instead", () => {
    expect(withSidecarHint("模型加载失败：磁盘空间不足")).toBe("本地 Whisper 模型加载失败：磁盘空间不足");
    expect(withSidecarHint("模型加载失败：磁盘空间不足")).not.toContain(SIDECAR_UNREACHABLE_HINT);
  });

  it("R7: an ordinary (non-model-load) message is unaffected — still gets the connection advice", () => {
    expect(withSidecarHint("上传失败（500）")).toBe(`上传失败（500）${SIDECAR_UNREACHABLE_HINT}`);
  });
});
