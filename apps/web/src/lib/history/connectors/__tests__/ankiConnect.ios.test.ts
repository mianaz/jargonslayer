// ankiConnect.ts — iOS-branch coverage. IS_IOS is a module-scope
// import-time const, so this needs its own file/vi.mock — mirrors
// osSpeechTransport.ios.test.ts's own split for the identical
// constraint (see ankiConnect.test.ts for the ambient/web branch).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

import { AnkiIosUnsupportedError, ankiInvoke, testAndAuthorize } from "../ankiConnect";

describe("ankiConnect (iOS build) — never dispatched", () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ankiInvoke rejects with AnkiIosUnsupportedError before ever attempting a network call", async () => {
    await expect(ankiInvoke(8765, "version")).rejects.toBeInstanceOf(AnkiIosUnsupportedError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("testAndAuthorize resolves ios-unsupported without ever attempting a network call", async () => {
    const status = await testAndAuthorize(8765);
    expect(status).toEqual({ kind: "ios-unsupported", label: "iOS 不支持 AnkiConnect" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
