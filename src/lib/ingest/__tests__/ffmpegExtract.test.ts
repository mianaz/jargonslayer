import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- @ffmpeg/ffmpeg + @ffmpeg/util: entirely mocked, never fetches
// the real ~31MB core wasm in tests. Both modules are only reached via
// the dynamic `await import(...)` inside extractAudioFromVideo, but
// vi.mock intercepts a specifier's dynamic import exactly like a
// static one — these hoisted mocks are what let the "size cap throws
// before any ffmpeg import" test assert the constructor/fetchFile were
// never invoked. ----
const mockOn = vi.fn();
const mockLoad = vi.fn(async () => true);
const mockWriteFile = vi.fn(async () => true);
const mockExec = vi.fn(async () => 0);
const mockReadFile = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
const mockTerminate = vi.fn();
const mockFFmpegCtor = vi.fn(function FFmpegMock(this: unknown) {
  Object.assign(this as object, {
    on: mockOn,
    load: mockLoad,
    writeFile: mockWriteFile,
    exec: mockExec,
    readFile: mockReadFile,
    terminate: mockTerminate,
  });
});

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: mockFFmpegCtor,
}));

const mockToBlobURL = vi.fn(async (url: string) => `blob:${url}`);
const mockFetchFile = vi.fn(async () => new Uint8Array([9, 9, 9]));

vi.mock("@ffmpeg/util", () => ({
  toBlobURL: mockToBlobURL,
  fetchFile: mockFetchFile,
}));

import {
  isVideoFile,
  extractAudioFromVideo,
  VideoTooLargeError,
  VideoExtractError,
} from "../ffmpegExtract";

function fakeVideoFile(overrides: Partial<{ name: string; type: string; size: number }> = {}): File {
  const size = overrides.size ?? 1024;
  return {
    name: overrides.name ?? "clip.mp4",
    type: overrides.type ?? "video/mp4",
    size,
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as File;
}

describe("isVideoFile", () => {
  it("matches every spec'd video extension case-insensitively, regardless of MIME", () => {
    for (const ext of ["mp4", "webm", "mov", "mkv", "m4v"]) {
      expect(isVideoFile({ name: `clip.${ext}`, type: "" })).toBe(true);
      expect(isVideoFile({ name: `clip.${ext.toUpperCase()}`, type: "" })).toBe(true);
    }
  });

  it("matches any video/* MIME type regardless of extension", () => {
    expect(isVideoFile({ name: "clip.bin", type: "video/mp4" })).toBe(true);
    expect(isVideoFile({ name: "clip", type: "video/quicktime" })).toBe(true);
  });

  it("returns false for audio files (extension and MIME)", () => {
    expect(isVideoFile({ name: "meeting.wav", type: "audio/wav" })).toBe(false);
    expect(isVideoFile({ name: "meeting.mp3", type: "audio/mpeg" })).toBe(false);
    expect(isVideoFile({ name: "meeting.m4a", type: "" })).toBe(false);
    expect(isVideoFile({ name: "meeting.flac", type: "" })).toBe(false);
  });

  it("returns false for a file with no matching extension and a non-video MIME", () => {
    expect(isVideoFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isVideoFile({ name: "noextension", type: "" })).toBe(false);
  });
});

describe("extractAudioFromVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(true);
    mockWriteFile.mockResolvedValue(true);
    mockExec.mockResolvedValue(0);
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws VideoTooLargeError for a file over 400MB WITHOUT ever importing @ffmpeg/ffmpeg", async () => {
    const file = fakeVideoFile({ size: 400 * 1024 * 1024 + 1 });

    await expect(extractAudioFromVideo(file)).rejects.toThrow(VideoTooLargeError);
    await expect(extractAudioFromVideo(file)).rejects.toThrow(
      "视频过大（超过 400 MB），请先在本地提取音频后再导入",
    );

    // The size guard runs before the dynamic import — the mocked
    // FFmpeg constructor (and therefore the module) is never reached.
    expect(mockFFmpegCtor).not.toHaveBeenCalled();
    expect(mockFetchFile).not.toHaveBeenCalled();
  });

  it("does not throw at exactly the 400MB boundary", async () => {
    const file = fakeVideoFile({ size: 400 * 1024 * 1024 });
    await expect(extractAudioFromVideo(file)).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it("calls exec with the exact extraction args, and terminate() on success", async () => {
    const file = fakeVideoFile();
    const result = await extractAudioFromVideo(file);

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith([
      "-i",
      "input",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      "out.wav",
    ]);
    expect(mockWriteFile).toHaveBeenCalledWith("input", expect.any(Uint8Array));
    expect(mockTerminate).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it("forwards ffmpeg's 0-1 progress ratio to onProgress", async () => {
    mockOn.mockImplementation((event: string, cb: (info: { progress: number }) => void) => {
      if (event === "progress") {
        cb({ progress: 0.42 });
      }
    });
    const onProgress = vi.fn();

    await extractAudioFromVideo(fakeVideoFile(), onProgress);

    expect(onProgress).toHaveBeenCalledWith(0.42);
  });

  it("throws VideoExtractError AND still calls terminate() when exec returns a non-zero exit code", async () => {
    mockExec.mockResolvedValue(1);

    await expect(extractAudioFromVideo(fakeVideoFile())).rejects.toThrow(VideoExtractError);
    expect(mockTerminate).toHaveBeenCalledTimes(1);
  });

  it("throws VideoExtractError AND still calls terminate() when exec itself throws", async () => {
    mockExec.mockRejectedValue(new Error("ffmpeg internal failure"));

    await expect(extractAudioFromVideo(fakeVideoFile())).rejects.toThrow(VideoExtractError);
    await expect(extractAudioFromVideo(fakeVideoFile())).rejects.toThrow(
      "无法从该视频提取音频，请转成 mp4/webm 后重试",
    );
    expect(mockTerminate).toHaveBeenCalled();
  });

  it("calls terminate() even when ffmpeg.load() itself throws", async () => {
    mockLoad.mockRejectedValue(new Error("core fetch failed"));

    // load() failures are wrapped into the zh-ready VideoExtractError
    // (CDN unreachable / class-worker construction failed — the
    // user-visible remedy is the same as an extraction failure).
    await expect(extractAudioFromVideo(fakeVideoFile())).rejects.toThrow(
      "无法从该视频提取音频",
    );
    expect(mockTerminate).toHaveBeenCalledTimes(1);
  });
});
