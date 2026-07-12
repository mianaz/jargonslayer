// v0.4 S2 — llmTransport.ts's two independent concerns: the ON/OFF
// feature flag (useClientTransport/setClientTransportOverride) and the
// Transport registration point (setTransport/getTransport/
// resetTransport) S3's Tauri shell will use to inject tauri-plugin-
// http's fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTransport,
  resetTransport,
  setClientTransportOverride,
  setTransport,
  useClientTransport,
} from "../llmTransport";

afterEach(() => {
  setClientTransportOverride(null);
  resetTransport();
  vi.unstubAllGlobals();
});

describe("useClientTransport — build-time default", () => {
  it("is false by default (NEXT_PUBLIC_LLM_TRANSPORT unset in the test env) — S2 ships with the client path OFF", () => {
    expect(useClientTransport()).toBe(false);
  });
});

describe("useClientTransport — programmatic test override", () => {
  it("setClientTransportOverride(true) turns the flag on regardless of the build-time env var", () => {
    setClientTransportOverride(true);
    expect(useClientTransport()).toBe(true);
  });

  it("setClientTransportOverride(false) turns the flag off", () => {
    setClientTransportOverride(false);
    expect(useClientTransport()).toBe(false);
  });

  it("setClientTransportOverride(null) restores the build-time default", () => {
    setClientTransportOverride(true);
    expect(useClientTransport()).toBe(true);
    setClientTransportOverride(null);
    expect(useClientTransport()).toBe(false);
  });
});

describe("Transport registration point — default delegates to global fetch", () => {
  it("getTransport()'s default implementation calls whatever `fetch` currently resolves to (picks up vi.stubGlobal changes made AFTER module load)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);

    await getTransport()("https://example.com", { method: "GET" });

    expect(mockFetch).toHaveBeenCalledWith("https://example.com", { method: "GET" });
  });
});

describe("setTransport — S3's registration point", () => {
  it("redirects every subsequent getTransport() call to the injected Transport instead of global fetch", async () => {
    const realFetch = vi.fn().mockResolvedValue(new Response("real"));
    vi.stubGlobal("fetch", realFetch);

    const injected = vi.fn().mockResolvedValue(new Response("injected"));
    setTransport(injected);

    const res = await getTransport()("https://example.com/v1/messages", { method: "POST" });

    expect(injected).toHaveBeenCalledTimes(1);
    expect(realFetch).not.toHaveBeenCalled();
    expect(await res.text()).toBe("injected");
  });

  it("resetTransport() restores the global-fetch default", async () => {
    setTransport(vi.fn().mockResolvedValue(new Response("injected")));
    resetTransport();

    const realFetch = vi.fn().mockResolvedValue(new Response("real"));
    vi.stubGlobal("fetch", realFetch);

    await getTransport()("https://example.com", {});

    expect(realFetch).toHaveBeenCalledTimes(1);
  });
});
