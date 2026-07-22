// D1 (preview BYOK client-direct transport) — client.ts's useDirectTransport
// decision: useClientTransport() || (PREVIEW_TIER && !!creds.apiKey).
// This file exercises the two arms that don't need PREVIEW_TIER true
// (full-tier web, desktop) under the ambient PREVIEW_TIER:false default
// (no @/lib/deployTier mock — see deployTier.ts's own NEXT_PUBLIC_
// DEPLOY_TIER default, same "ambient PREVIEW_TIER: false" convention
// other test files rely on, e.g. engineOptions.test.ts). The preview-
// tier-true half of the matrix lives in
// useDirectTransport.previewTier.test.ts, since PREVIEW_TIER is an
// import-time const no runtime override can flip within one file (same
// constraint documented across the stt/__tests__ sonioxPreviewLane
// files).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { detectApi } from "../client";
import { setClientTransportOverride } from "../llmTransport";

const mockFetch = vi.fn();

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function detectRouteFixture(): Response {
  return new Response(JSON.stringify({ expressions: [], terms: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function anthropicDirectFixture(): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ expressions: [], terms: [] }) }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  setClientTransportOverride(null);
  vi.unstubAllGlobals();
});

describe("useDirectTransport — full-tier web (ambient PREVIEW_TIER false)", () => {
  it("keyless: routes through /api/detect", async () => {
    mockFetch.mockResolvedValue(detectRouteFixture());

    await detectApi({ context: "", new_text: "hi" }, makeSettings({ apiKey: "" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/detect");
    expect(String(url)).not.toContain("api.anthropic.com");
  });

  it("WITH a configured key: STILL routes through /api/detect — full-tier behavior must not change (D1 is preview-scoped only)", async () => {
    mockFetch.mockResolvedValue(detectRouteFixture());

    await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ apiKey: "sk-ant-full-tier-byok-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/detect");
    expect(String(url)).not.toContain("api.anthropic.com");
  });
});

describe("useDirectTransport — desktop (llmTransport.ts's client-transport flag on)", () => {
  it("direct provider call regardless of tier — wins over full-tier's ambient PREVIEW_TIER:false", async () => {
    setClientTransportOverride(true);
    mockFetch.mockResolvedValue(anthropicDirectFixture());

    await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ apiKey: "sk-ant-desktop-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
  });
});
