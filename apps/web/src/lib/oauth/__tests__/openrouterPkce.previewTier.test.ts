// FIX 2 (byok-preview sprint) — the PREVIEW_TIER:true half of
// exchangeCodeForKey's routing decision. openrouterPkce.test.ts's
// existing "POSTs code/code_verifier/code_challenge_method to the
// same-origin proxy route" test already pins the full-tier half under
// the ambient PREVIEW_TIER:false default (no @/lib/deployTier mock —
// same convention useDirectTransport.test.ts documents), so this file
// only needs the true branch. Separate file because PREVIEW_TIER is an
// import-time const no runtime override can flip within one file (same
// constraint documented across useDirectTransport.previewTier.test.ts
// and the stt/__tests__ sonioxPreviewLane files).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true }));

import { EXCHANGE_URL, exchangeCodeForKey } from "../openrouterPkce";

describe("exchangeCodeForKey — preview tier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts DIRECTLY to EXCHANGE_URL (openrouter.ai), never the same-origin proxy route — and still returns the { key } wrapper exchangeCodeForKey's other callers expect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ key: "sk-or-v1-preview" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeCodeForKey({ code: "auth-code", codeVerifier: "verifier-value" });

    expect(result).toEqual({ key: "sk-or-v1-preview" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EXCHANGE_URL);
    expect(url).not.toBe("/api/openrouter/exchange");
    expect(JSON.parse(init.body)).toEqual({
      code: "auth-code",
      code_verifier: "verifier-value",
      code_challenge_method: "S256",
    });
  });

  it("propagates the upstream error message on a non-2xx response — parsing stays identical to the proxy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid code" }), { status: 400 })),
    );

    await expect(exchangeCodeForKey({ code: "bad-code", codeVerifier: "v" })).rejects.toThrow(
      "invalid code",
    );
  });
});
