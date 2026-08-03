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

  describe("mic — iOS: osspeech default; a BYOK cloud pick with its OWN matching key is respected (iOS-cloud round)", () => {
    it("fresh default / non-cloud engine -> osspeech", () => {
      expect(deriveEngineForMode("mic", IOS, settings({ engine: "demo" }))).toBe("osspeech");
      expect(
        deriveEngineForMode("mic", IOS, settings({ engine: "whisper", sonioxKey: "sk-x" })),
      ).toBe("osspeech");
    });

    it.each([
      ["soniox", { sonioxKey: "sk-x" }],
      ["deepgram", { deepgramKey: "dg-x" }],
      ["elevenlabs", { elevenLabsKey: "el-x" }],
    ] as const)("engine already %s with its own key -> respected", (engine, keys) => {
      expect(deriveEngineForMode("mic", IOS, settings({ engine, ...keys }))).toBe(engine);
    });

    it("cloud pick with NO key (or only a MISMATCHED key) -> osspeech, the zero-config default", () => {
      expect(deriveEngineForMode("mic", IOS, settings({ engine: "soniox" }))).toBe("osspeech");
      expect(
        deriveEngineForMode("mic", IOS, settings({ engine: "elevenlabs", sonioxKey: "sk-x" })),
      ).toBe("osspeech");
    });
  });

  // v0.7.4 field bug: desktop osspeech USED TO BE the CoreAudio
  // system-OUTPUT tap only — the audiocap helper had no mic branch
  // (main.swift runTranscribe) — so the old osspeech-if-floor
  // derivation here ran the output tap under a 麦克风 label and
  // captured all-zero audio. Desktop mic was whisper regardless of the
  // osspeech floor; a keyed cloud pick was respected, same rule as the
  // web branch below.
  //
  // Dual capture v1 (docs/design-explorations/dual-capture-2026-08.md)
  // amends this SURGICALLY: osspeech now has a real AEC mic producer,
  // so a mic-tile click RETAINS osspeech when it's ALREADY the current
  // engine (same "deliberate pick survives a mic-tile click" posture
  // whisper/soniox/deepgram already get below) — every other
  // engine/mode combination (fresh/demo default, a DIFFERENT prior
  // engine, floor state) stays byte-identical to the pre-dual-capture
  // rule.
  describe("mic — desktop: whisper by default — osspeech RETAINED only when already the current engine (dual capture v1); keyed cloud pick respected", () => {
    it("fresh/demo default -> whisper, regardless of the osspeech floor", async () => {
      await setOsSpeechFloor(true);
      expect(deriveEngineForMode("mic", DESKTOP, settings())).toBe("whisper");
    });

    it("engine ALREADY osspeech -> RETAINED (dual capture v1: osspeech now has a real mic branch)", async () => {
      await setOsSpeechFloor(true);
      expect(deriveEngineForMode("mic", DESKTOP, settings({ engine: "osspeech" }))).toBe(
        "osspeech",
      );
    });

    it("engine ALREADY osspeech, floor NOT (yet) met -> still retained here (deriveEngineForMode never re-probes; the sanitize pass/option gate is what actually locks a below-floor pick, not this branch)", async () => {
      await setOsSpeechFloor(false);
      expect(deriveEngineForMode("mic", DESKTOP, settings({ engine: "osspeech" }))).toBe(
        "osspeech",
      );
    });

    it("floor NOT met, fresh default -> whisper", async () => {
      await setOsSpeechFloor(false);
      expect(deriveEngineForMode("mic", DESKTOP, settings())).toBe("whisper");
    });

    it("keyed cloud pick respected; keyless cloud pick resets to whisper", async () => {
      await setOsSpeechFloor(true);
      expect(
        deriveEngineForMode("mic", DESKTOP, settings({ engine: "soniox", sonioxKey: "sk-x" })),
      ).toBe("soniox");
      expect(deriveEngineForMode("mic", DESKTOP, settings({ engine: "soniox" }))).toBe("whisper");
    });
  });

  // Dual capture v1: 麦克风+系统 is osspeech-exclusive — no fallback
  // engine exists for it (unlike "system-audio", which degrades to
  // appaudio below the osspeech floor).
  describe("dual — osspeech-exclusive: desktop always osspeech; unreachable off-desktop degrades sanely", () => {
    it("desktop -> osspeech, regardless of the current engine or the floor", async () => {
      await setOsSpeechFloor(true);
      expect(deriveEngineForMode("dual", DESKTOP, settings())).toBe("osspeech");
      expect(deriveEngineForMode("dual", DESKTOP, settings({ engine: "whisper" }))).toBe(
        "osspeech",
      );
      await setOsSpeechFloor(false);
      expect(deriveEngineForMode("dual", DESKTOP, settings({ engine: "whisper" }))).toBe(
        "osspeech",
      );
    });

    it("unreachable via the real tile set (isModeLegalForPlatform pins desktop-only) — never crashes, degrades sanely", () => {
      expect(deriveEngineForMode("dual", IOS, settings())).toBe("osspeech");
      expect(deriveEngineForMode("dual", WEB, settings())).toBe("webspeech");
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

    it("sidecar-family pick is STICKY: tabaudio + mic flip -> whisper (same recognizer, mic lane), never webspeech", () => {
      expect(deriveEngineForMode("mic", WEB, settings({ engine: "tabaudio" }))).toBe("whisper");
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

    it("engine already elevenlabs AND an elevenlabs key exists -> respected (iOS-cloud round drive-by fix: this trio member was omitted from the v0.6 chain, so a keyed pick got clobbered to webspeech)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "elevenlabs", elevenLabsKey: "el-x" })),
      ).toBe("elevenlabs");
    });

    it("engine already elevenlabs with NO matching key -> reset to webspeech (same matching-key rule as soniox/deepgram)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "elevenlabs", deepgramKey: "dg-x" })),
      ).toBe("webspeech");
    });

    it("engine already webspeech + a key exists -> stays webspeech (not a whisper/soniox/deepgram choice to respect)", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "webspeech", sonioxKey: "sk-x" })),
      ).toBe("webspeech");
    });

    // REVERSED (Miana 2026-08-01, recognizer stickiness): tabaudio is
    // the same sidecar recognizer as whisper, so a mic flip keeps it
    // local (-> whisper) instead of resetting to webspeech — the key's
    // presence is irrelevant either way. A non-sidecar, non-cloud value
    // (demo) still resets to webspeech below.
    it("engine tabaudio + a key exists -> whisper (sidecar family sticks), never webspeech", () => {
      expect(
        deriveEngineForMode("mic", WEB, settings({ engine: "tabaudio", sonioxKey: "sk-x" })),
      ).toBe("whisper");
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

    // Recognizer stickiness (Miana 2026-08-01): the sidecar family is
    // ONE recognizer across sources — a deliberate 本地模型 pick
    // survives a source flip as appaudio instead of being silently
    // swapped to the Apple recognizer.
    it("sidecar-family pick is STICKY: whisper/tabaudio + system-audio flip -> appaudio even with the floor met", async () => {
      await setOsSpeechFloor(true);
      expect(deriveEngineForMode("system-audio", DESKTOP, settings({ engine: "whisper" }))).toBe(
        "appaudio",
      );
      expect(deriveEngineForMode("system-audio", DESKTOP, settings({ engine: "appaudio" }))).toBe(
        "appaudio",
      );
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

    it("sidecar-family pick is STICKY: whisper + tab flip -> tabaudio even with a provider key present (key presence is a default, not an override)", () => {
      expect(
        deriveEngineForMode(
          "tab",
          WEB,
          settings({ engine: "whisper", tabAudioCloudProvider: "soniox", sonioxKey: "sk-x" }),
        ),
      ).toBe("tabaudio");
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
