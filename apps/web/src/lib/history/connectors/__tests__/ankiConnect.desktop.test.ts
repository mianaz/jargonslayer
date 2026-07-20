// ankiConnect.ts — desktop-branch coverage. IS_DESKTOP is a module-scope
// import-time const, so this needs its own file/vi.mock — mirrors
// engineOptions.desktop.test.ts's own split for the identical
// constraint (see ankiConnect.test.ts for the ambient/web branch).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const tauriFetch = vi.fn(async () => ({
  json: async () => ({ result: 6, error: null }),
})) as unknown as typeof fetch;

vi.mock("@/lib/desktop/tauriApi", () => ({
  getTauriFetch: () => Promise.resolve(tauriFetch),
}));

import { ankiInvoke } from "../ankiConnect";

describe("ankiInvoke (desktop build)", () => {
  let webFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (tauriFetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    webFetch = vi.fn(async () => ({ json: async () => ({ result: null, error: null }) }));
    global.fetch = webFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes through tauriApi's getTauriFetch (CORS-exempt native fetch), never the ambient browser fetch", async () => {
    const result = await ankiInvoke<number>(8765, "version");

    expect(result).toBe(6);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(tauriFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765",
      expect.objectContaining({ method: "POST" }),
    );
    expect(webFetch).not.toHaveBeenCalled();
  });
});
