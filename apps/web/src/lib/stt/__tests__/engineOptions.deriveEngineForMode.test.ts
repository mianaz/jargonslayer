// v0.5 Wave-1 Feature 5 (mode-first UI, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 5 + §5 A3/A4) — deriveEngineForMode's
// own matrix (mode × platform × key/floor presence), mirroring
// store.test.ts's modeForPersistedEngine matrix test style. Unlike
// ENGINE_OPTIONS (module-scope IS_DESKTOP/IS_IOS, needs vi.mock +
// resetModules + a separate file per platform — see engineOptions.
// desktop.test.ts/engineOptions.ios.test.ts), deriveEngineForMode takes
// `platform` as an explicit parameter, so all three shells are covered
// from this one file with a plain function call.
//
// osspeech floor state is exercised through the SAME probe/cache
// osspeechCaps.test.ts already covers (probeOsSpeechCapabilitiesWith +
// resetOsSpeechCapsCache) — deriveEngineForMode reads the synchronous
// snapshot, never re-probes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { deriveEngineForMode, type DeriveEnginePlatform } from "../engineOptions";
import {
  probeOsSpeechCapabilitiesWith,
  resetOsSpeechCapsCache,
  type OsSpeechCapabilities,
} from "@/lib/desktop/osspeechCaps";
import type { InvokeFn } from "@/lib/desktop/tauriApi";

function fakeInvoke(handler: () => unknown): InvokeFn {
  return (async () => handler()) as InvokeFn;
}

async function setOsSpeechFloor(supported: boolean): Promise<void> {
  const caps: OsSpeechCapabilities = {
    supported,
    reason: supported ? null : "需要 macOS 26 或更高版本",
    locales: [],
    installedLocales: [],
  };
  await probeOsSpeechCapabilitiesWith(fakeInvoke(() => caps));
}

const WEB: DeriveEnginePlatform = { isDesktop: false, isIos: false };
const DESKTOP: DeriveEnginePlatform = { isDesktop: true, isIos: false };
const IOS: DeriveEnginePlatform = { isDesktop: false, isIos: true };

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("deriveEngineForMode", () => {
  beforeEach(() => resetOsSpeechCapsCache());
  afterEach(() => resetOsSpeechCapsCache());

  describe("import/url — engine passes through UNCHANGED (these modes open ImportHub, no live engine)", () => {
    it.each(["import", "url"] as const)("mode=%s", (mode) => {
      for (const platform of [WEB, DESKTOP, IOS]) {
        expect(deriveEngineForMode(mode, platform, settings({ engine: "whisper" }))).toBe("whisper");
        expect(deriveEngineForMode(mode, platform, settings({ engine: "soniox" }))).toBe("soniox");
      }
    });
  });

  describe("mic — iOS: osspeech unconditionally (v1's only engine)", () => {
    it("ignores settings.engine/keys entirely", () => {
      expect(deriveEngineForMode("mic", IOS, settings({ engine: "demo" }))).toBe("osspeech");
      expect(
        deriveEngineForMode("mic", IOS, settings({ engine: "whisper", sonioxKey: "sk-x" })),
      ).toBe("osspeech");
    });
  });

  describe("mic — desktop: osspeech-if-floor else whisper (never appaudio — that's system audio, not mic)", () => {
    it("floor met -> osspeech", async () => {
      await setOsSpeechFloor(true);
      expect(deriveEngineForMode("mic", DESKTOP, settings())).toBe("osspeech");
    });

    it("floor NOT met -> whisper", async () => {
      await setOsSpeechFloor(false);
      expect(deriveEngineForMode("mic", DESKTOP, settings())).toBe("whisper");
    });

    it("floor not yet resolved (null snapshot) fails OPEN to osspeech — same D6 policy isOsSpeechFloorLocked already uses", () => {
      expect(deriveEngineForMode("mic", DESKTOP, settings())).toBe("osspeech");
    });
  });

  describe("mic — web: webspeech default; whisper respected UNCONDITIONALLY (local, keyless); soniox/deepgram respected only with their OWN matching key", () => {
    it("fresh default (engine:demo, no keys) -> webspeech", () => {
      expect(deriveEngineForMode("mic", WEB, settings())).toBe("webspeech");
    });

    it("engine already whisper with NO key at all -> respected (whisper needs no key — L8 review fix)", () => {
      expect(deriveEngineForMode("mic", WEB, settings({ engine: "whisper" }))).toBe("whisper");
    });

    it("engine already whisper AND a soniox key exists -> still whisper (key irrelevant to whisper)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "whisper", sonioxKey: "sk-x" })),
      ).toBe("whisper");
    });

    it("engine already soniox but only a DEEPGRAM key exists -> reset to webspeech (matching key required)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "soniox", deepgramKey: "dg-x" })),
      ).toBe("webspeech");
    });

    it("engine already soniox AND a soniox key exists -> respected (soniox)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "soniox", sonioxKey: "sk-x" })),
      ).toBe("soniox");
    });

    it("engine already deepgram AND a deepgram key exists -> respected (deepgram)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "deepgram", deepgramKey: "dg-x" })),
      ).toBe("deepgram");
    });

    it("engine already webspeech + a key exists -> stays webspeech (not a whisper/soniox/deepgram choice to respect)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "webspeech", sonioxKey: "sk-x" })),
      ).toBe("webspeech");
    });

    it("engine is some other value (e.g. tabaudio) + a key exists -> reset to webspeech, not respected", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "tabaudio", sonioxKey: "sk-x" })),
      ).toBe("webspeech");
    });
  });

  describe("system-audio — desktop: osspeech-if-floor else appaudio", () => {
    it("floor met -> osspeech", async () => {
      await setOsSpeechFloor(true);
      expect(deriveEngineForMode("system-audio", DESKTOP, settings())).toBe("osspeech");
    });

    it("floor NOT met -> appaudio", async () => {
      await setOsSpeechFloor(false);
      expect(deriveEngineForMode("system-audio", DESKTOP, settings())).toBe("appaudio");
    });

    it("floor not yet resolved fails OPEN to osspeech", () => {
      expect(deriveEngineForMode("system-audio", DESKTOP, settings())).toBe("osspeech");
    });
  });

  describe("system-audio — unreachable via the real tile set (§3 Q2: absent, not disabled off-desktop) — never crashes, degrades sanely", () => {
    it("iOS -> osspeech", () => {
      expect(deriveEngineForMode("system-audio", IOS, settings())).toBe("osspeech");
    });

    it("web -> webspeech (a real, working mic default — not a nonsense system-audio value)", () => {
      expect(deriveEngineForMode("system-audio", WEB, settings())).toBe("webspeech");
    });
  });

  describe("tab — web: tabaudio-cloud when the MATCHING provider's BYOK key exists, else local-sidecar tabaudio", () => {
    it("provider soniox, no key -> tabaudio", () => {
      expect(
        deriveEngineForMode("tab", WEB, settings({ tabAudioCloudProvider: "soniox", sonioxKey: "" })),
      ).toBe("tabaudio");
    });

    it("provider soniox, key present -> tabaudio-cloud", () => {
      expect(
        deriveEngineForMode(
          "tab",
          WEB,
          settings({ tabAudioCloudProvider: "soniox", sonioxKey: "sk-x" }),
        ),
      ).toBe("tabaudio-cloud");
    });

    it("provider deepgram, deepgram key ABSENT (even though a soniox key exists) -> tabaudio — never silently swaps provider", () => {
      expect(
        deriveEngineForMode(
          "tab",
          WEB,
          settings({ tabAudioCloudProvider: "deepgram", deepgramKey: "", sonioxKey: "sk-x" }),
        ),
      ).toBe("tabaudio");
    });

    it("provider deepgram, deepgram key present -> tabaudio-cloud", () => {
      expect(
        deriveEngineForMode(
          "tab",
          WEB,
          settings({ tabAudioCloudProvider: "deepgram", deepgramKey: "dg-x" }),
        ),
      ).toBe("tabaudio-cloud");
    });
  });

  describe("tab — desktop: sanitized to appaudio regardless of provider/key (D7: WKWebView has no tab-share picker)", () => {
    it("proves the SANITIZE PASS runs, not just this branch's own logic — the tab branch has no desktop-awareness of its own", () => {
      expect(
        deriveEngineForMode(
          "tab",
          DESKTOP,
          settings({ tabAudioCloudProvider: "soniox", sonioxKey: "sk-x" }),
        ),
      ).toBe("appaudio");
      expect(
        deriveEngineForMode("tab", DESKTOP, settings({ tabAudioCloudProvider: "soniox", sonioxKey: "" })),
      ).toBe("appaudio");
    });
  });

  describe("tab — iOS: sanitized to osspeech — proves the sanitize pass runs (the tab branch has no iOS-awareness of its own)", () => {
    it("web-style candidate degrades to osspeech via applyPlatformEngineDefaults' isIos sweep", () => {
      expect(
        deriveEngineForMode("tab", IOS, settings({ tabAudioCloudProvider: "soniox", sonioxKey: "sk-x" })),
      ).toBe("osspeech");
    });
  });
});
