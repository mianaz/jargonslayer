import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { probeSidecar } from "../sidecarHealth";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------
// probeSidecar — 3s-timeout GET /health probe, mirrors
// fetchSidecarHealth/agentHealth's "never throws" contract
// ---------------------------------------------------------------

describe("probeSidecar", () => {
  it("returns up:true with model + diarize from a 200 /health response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        model: "small",
        diarization_ready: true,
        diarization_error: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeSidecar(makeSettings());

    expect(result).toEqual({ up: true, model: "small", diarize: true });
  });

  it("reports diarize:false (not just omitted) when diarization_ready is false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          model: "small",
          diarization_ready: false,
          diarization_error: "未配置 HF Token",
        }),
      ),
    );

    const result = await probeSidecar(makeSettings());

    expect(result).toEqual({ up: true, model: "small", diarize: false });
  });

  it("returns up:false (never throws) when the sidecar is unreachable (fetch rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const result = await probeSidecar(makeSettings());

    expect(result).toEqual({ up: false });
  });

  it("returns up:false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500)));

    const result = await probeSidecar(makeSettings());

    expect(result).toEqual({ up: false });
  });

  it("returns up:false (never throws) on a timeout/abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new DOMException("aborted", "AbortError"))),
    );

    const result = await probeSidecar(makeSettings());

    expect(result).toEqual({ up: false });
  });

  it("returns up:false on malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));

    const result = await probeSidecar(makeSettings());

    expect(result).toEqual({ up: false });
  });

  it("derives the http job-API base from whisperUrl (ws://…:8765 -> http://…:8766), same as upload.ts's httpBaseFromWs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, model: "small", diarization_ready: false }));
    vi.stubGlobal("fetch", fetchMock);

    await probeSidecar(makeSettings({ whisperUrl: "ws://192.168.1.5:8765" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.5:8766/health",
      expect.anything(),
    );
  });
});
