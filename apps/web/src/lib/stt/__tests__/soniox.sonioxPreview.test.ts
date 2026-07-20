// SonioxEngine — hosted Soniox preview trial (SONIOX_PREVIEW_LANE): the
// mintPreviewToken construction path added to SonioxEngine.start.
// PREVIEW_TIER/SONIOX_PREVIEW_LANE are both import-time consts
// (deployTier.ts) — same "needs its own vi.mock'd file" constraint as
// engineOptions.sonioxPreviewLane.test.ts (see that file's own header)
// — soniox.test.ts's own ambient env (both false) stays untouched for
// its existing non-preview coverage. SonioxTransport is module-mocked
// exactly like soniox.test.ts's own sonioxTransportCtor capture, so the
// `mintToken` callback SonioxEngine.start constructs can be pulled
// straight off the captured constructor args and exercised directly —
// the same "transport-level, following sonioxTransport.test.ts's own
// mintToken precedent" seam the task spec points at, one level up.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: true }));

const sonioxTransportCtor = vi.fn();
vi.mock("../sonioxTransport", () => ({
  SonioxTransport: class {
    constructor(...args: unknown[]) {
      sonioxTransportCtor(...args);
    }
    attachStream() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));

import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";
import { getPreviewSessionSeconds, SonioxEngine } from "../soniox";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";

function noopEvents(): STTEvents {
  return { onInterim: () => {}, onFinal: () => {}, onStatus: () => {} } as unknown as STTEvents;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Drives SonioxEngine.start() to completion and returns the mintToken
 *  callback (if any) the (mocked) SonioxTransport constructor was
 *  called with — mirrors soniox.test.ts's own gumCalls[0].resolve(...)
 *  drive pattern. */
async function startAndCaptureMintToken(
  sonioxKey: string,
): Promise<((key: string) => Promise<string>) | undefined> {
  const { gumCalls } = installFakeMediaDevices();
  const engine = new SonioxEngine();
  const settings = { ...DEFAULT_SETTINGS, engine: "soniox" as const, sonioxKey };
  const startP = engine.start(noopEvents(), settings);
  gumCalls[0].resolve(new FakeMediaStream());
  await startP;

  const ctorArgs = sonioxTransportCtor.mock.calls[0][0] as {
    mintToken?: (key: string) => Promise<string>;
  };
  return ctorArgs.mintToken;
}

afterEach(() => {
  uninstallFakeMediaDevices();
  sonioxTransportCtor.mockClear();
  vi.unstubAllGlobals();
});

describe("SonioxEngine.start() — preview lane mint wiring", () => {
  it("constructs SonioxTransport with a mintToken callback when the lane is on and no BYOK key is set", async () => {
    const mintToken = await startAndCaptureMintToken("");
    expect(typeof mintToken).toBe("function");
  });

  it("never sets mintToken when a BYOK sonioxKey is already present, even with the lane on (a deliberate BYOK choice always wins)", async () => {
    const mintToken = await startAndCaptureMintToken("sk-own-key");
    expect(mintToken).toBeUndefined();
  });

  it("the mint callback POSTs withBase('/api/soniox/token') and resolves to json.api_key on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ api_key: "minted-key-abc", expires_at: null }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const mintToken = await startAndCaptureMintToken("");
    await expect(mintToken!("")).resolves.toBe("minted-key-abc");
    expect(fetchMock).toHaveBeenCalledWith("/api/soniox/token", expect.objectContaining({ method: "POST" }));
  });

  // v0.5 closeout: session_seconds caching (getPreviewSessionSeconds) —
  // useMeeting.ts's session-start notice quotes this instead of a
  // hardcoded 600s.
  it("caches session_seconds from a successful mint, readable via getPreviewSessionSeconds()", async () => {
    expect(getPreviewSessionSeconds()).toBeNull();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ api_key: "minted-key-abc", expires_at: null, session_seconds: 480 }, 200),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mintToken = await startAndCaptureMintToken("");
    await mintToken!("");

    expect(getPreviewSessionSeconds()).toBe(480);
  });

  it("a response with no session_seconds field leaves an already-cached value untouched", async () => {
    // Self-contained (doesn't rely on the previous test's own cache
    // side effect running first): primes the cache to 480, THEN mints
    // again with a response that omits session_seconds entirely (e.g.
    // an older deploy) — the omission must not blank it back to null.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ api_key: "minted-key-abc", expires_at: null, session_seconds: 480 }, 200)),
    );
    await (await startAndCaptureMintToken(""))!("");
    expect(getPreviewSessionSeconds()).toBe(480);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ api_key: "minted-key-abc", expires_at: null }, 200)));
    await (await startAndCaptureMintToken(""))!("");

    expect(getPreviewSessionSeconds()).toBe(480);
  });

  it("a 429 preview_budget response rejects with the server's own zh error string (contains 额度)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: "预览版 Soniox 体验额度已达上限，请改用浏览器识别或自备密钥", code: "preview_budget" },
        429,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mintToken = await startAndCaptureMintToken("");
    await expect(mintToken!("")).rejects.toThrow(/额度/);
  });

  it("a 404 no_key response rejects with the server's own zh error string (deploy has no server key)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "此部署未启用 Soniox 预览体验", code: "no_key" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mintToken = await startAndCaptureMintToken("");
    await expect(mintToken!("")).rejects.toThrow("此部署未启用 Soniox 预览体验");
  });

  it("a non-OK response with no parseable JSON body falls back to the generic zh unavailable message", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const mintToken = await startAndCaptureMintToken("");
    await expect(mintToken!("")).rejects.toThrow("Soniox 预览体验暂不可用");
  });

  it("a network failure (fetch itself rejects) falls back to the generic zh unavailable message", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const mintToken = await startAndCaptureMintToken("");
    await expect(mintToken!("")).rejects.toThrow("Soniox 预览体验暂不可用");
  });
});
