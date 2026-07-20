// @vitest-environment jsdom
//
// openExternalWith's web branch calls `window.open` — this file needs a
// real `window` to spy on, unlike the rest of the suite (vitest.config.
// ts's default `environment: "node"`). Mirrors lib/theme/__tests__/
// apply.test.ts's own docblock-override precedent.

import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternal, openExternalWith } from "../openExternal";
import type { OpenExternalFn } from "../../desktop/tauriApi";

describe("openExternalWith — pure core (explicit isTauri + injected opener)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Tauri (desktop or iOS): resolves the opener factory and calls it with the url, never touches window.open", async () => {
    const open = vi.fn<OpenExternalFn>().mockResolvedValue(undefined);
    const openerFactory = vi.fn().mockResolvedValue(open);
    const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await openExternalWith("https://openrouter.ai/keys", true, openerFactory);

    expect(openerFactory).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://openrouter.ai/keys");
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it("web: calls window.open(url, \"_blank\", \"noopener\"), never touches the opener factory", async () => {
    const openerFactory = vi.fn();
    const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await openExternalWith("https://openrouter.ai/keys", false, openerFactory);

    expect(windowOpenSpy).toHaveBeenCalledWith("https://openrouter.ai/keys", "_blank", "noopener");
    expect(openerFactory).not.toHaveBeenCalled();
  });

  it("propagates a rejection from the opener factory rather than swallowing it", async () => {
    const openerFactory = vi.fn().mockRejectedValue(new Error("opener unavailable"));

    await expect(openExternalWith("https://openrouter.ai/keys", true, openerFactory)).rejects.toThrow(
      "opener unavailable",
    );
  });

  it("propagates a rejection from the resolved open() call itself", async () => {
    const open = vi.fn<OpenExternalFn>().mockRejectedValue(new Error("denied by capability scope"));
    const openerFactory = vi.fn().mockResolvedValue(open);

    await expect(openExternalWith("https://evil.example/", true, openerFactory)).rejects.toThrow(
      "denied by capability scope",
    );
  });
});

describe("openExternal — real IS_TAURI/getOpener wrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Ambient test env is a web build (IS_TAURI false — neither
  // NEXT_PUBLIC_DESKTOP nor NEXT_PUBLIC_IOS is set, see platform/ios.ts)
  // — same documented limitation as store.test.ts's migrateSettings
  // describe block: only the web branch is exercisable through the real
  // IS_TAURI const here, the Tauri branch is already fully covered above
  // via openExternalWith's explicit boolean.
  it("in the ambient (web) test env, falls back to window.open", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await openExternal("https://openrouter.ai/keys");

    expect(windowOpenSpy).toHaveBeenCalledWith("https://openrouter.ai/keys", "_blank", "noopener");
  });
});
