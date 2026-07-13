import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decideMicPermissionAction,
  openPermissionPage,
  queryMicPermission,
} from "../micPermission";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decideMicPermissionAction", () => {
  it("granted -> start (already usable, skip the grant tab)", () => {
    expect(decideMicPermissionAction("granted")).toBe("start");
  });

  it("prompt -> open-grant-page (the side panel can't resolve this itself)", () => {
    expect(decideMicPermissionAction("prompt")).toBe("open-grant-page");
  });

  it("denied -> denied-guidance (re-asking won't produce a fresh prompt)", () => {
    expect(decideMicPermissionAction("denied")).toBe("denied-guidance");
  });

  it("unknown -> start (optimistic try-then-catch fallback)", () => {
    expect(decideMicPermissionAction("unknown")).toBe("start");
  });
});

describe("queryMicPermission", () => {
  it("returns the real permission state when the Permissions API is present", async () => {
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn(async () => ({ state: "granted" })) },
    });
    expect(await queryMicPermission()).toBe("granted");
  });

  it("passes {name: 'microphone'} to permissions.query", async () => {
    const query = vi.fn(async () => ({ state: "prompt" }));
    vi.stubGlobal("navigator", { permissions: { query } });

    await queryMicPermission();

    expect(query).toHaveBeenCalledWith({ name: "microphone" });
  });

  it("returns 'unknown' when navigator.permissions is absent", async () => {
    vi.stubGlobal("navigator", {});
    expect(await queryMicPermission()).toBe("unknown");
  });

  it("returns 'unknown' when navigator itself is absent", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await queryMicPermission()).toBe("unknown");
  });

  it("returns 'unknown' when the query call rejects (best-effort only)", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => {
          throw new Error("no such permission descriptor");
        }),
      },
    });
    expect(await queryMicPermission()).toBe("unknown");
  });
});

describe("openPermissionPage", () => {
  function mockChromeTabs(): { create: ReturnType<typeof vi.fn>; getURL: ReturnType<typeof vi.fn> } {
    const getURL = vi.fn((path: string) => `chrome-extension://fake-extension-id/${path}`);
    const create = vi.fn(async (props: { url: string }) => ({ id: 1, url: props.url }));
    vi.stubGlobal("chrome", {
      runtime: { getURL },
      tabs: { create },
    });
    return { create, getURL };
  }

  it("resolves the permission.html path via chrome.runtime.getURL", async () => {
    const { getURL } = mockChromeTabs();
    await openPermissionPage();
    expect(getURL).toHaveBeenCalledWith("src/permission/permission.html");
  });

  it("opens the resolved URL in a new tab via chrome.tabs.create", async () => {
    const { create } = mockChromeTabs();
    await openPermissionPage();
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://fake-extension-id/src/permission/permission.html",
    });
  });

  it("returns the created tab", async () => {
    mockChromeTabs();
    const tab = await openPermissionPage();
    expect(tab).toEqual({ id: 1, url: "chrome-extension://fake-extension-id/src/permission/permission.html" });
  });
});
