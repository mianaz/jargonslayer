// @vitest-environment jsdom
//
// StatusLine — iOS-only coverage (iOS-cloud round, post-v0.6.0: BYOK
// cloud mic engines join IOS_ENGINE_OPTIONS, lib/stt/engineOptions.ts —
// see that file's own engineOptions.ios.test.ts for the ENGINE_OPTIONS-
// level pin). IS_IOS is a module-scope import-time const, so this needs
// its own file/vi.mock — mirrors engineOptions.ios.test.ts/
// SettingsDialog.ios.test.tsx's own split for the identical constraint
// (StatusLine.test.tsx itself needs the REAL, false value for its own
// web-build coverage and must keep working unmodified — still green
// after this round, see that file's own "engine dropdown" describe
// block).
//
// EngineDropdown (StatusLine.tsx) no longer has an IS_IOS static-chip
// early return — iOS now renders the SAME native
// <select data-testid="statusline-engine-select"> web/desktop use, just
// with the active engine's own retention text color
// (RETENTION_COPY[...].textClass) swapped in for the plain "text-fg"
// every other build gets.
//
// @/lib/desktop/osspeechCaps mock: SAME reason SettingsDialog.ios.
// test.tsx already mocks it — EngineDropdown calls useOsSpeechCaps()
// too (osspeech floor gating), and with IS_TAURI now true the REAL hook
// would call probeOsSpeechCaps() -> tauriApi.ts's getInvoke(), which
// throws SYNCHRONOUSLY outside an actual NEXT_PUBLIC_IOS=1 build (see
// that file's own header comment for the exact landmine this avoids).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true, IS_TAURI: true }));
vi.mock("@/lib/desktop/osspeechCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/osspeechCaps")>();
  return {
    ...actual,
    useOsSpeechCaps: () => null,
    preinstallOsSpeech: async () => undefined,
  };
});

import { useApp } from "../../lib/store";
import StatusLine from "../StatusLine";

describe("StatusLine — iOS build (engine picker)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "demo" } }));
    vi.unstubAllGlobals();
  });

  function renderStatusLine() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  function engineSelect(): HTMLSelectElement {
    const el = container!.querySelector('[data-testid="statusline-engine-select"]');
    if (!el) throw new Error("engine select not found");
    return el as HTMLSelectElement;
  }

  it("the static chip is gone — the select is the only engine control, with exactly the 4 iOS engine values once every BYOK key is configured", async () => {
    useApp.setState((s) => ({
      status: "idle",
      settings: {
        ...s.settings,
        engine: "osspeech",
        sonioxKey: "sk-test",
        deepgramKey: "dg-test",
        elevenLabsKey: "el-test",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(container!.querySelector('[data-testid="statusline-engine-static"]')).toBeNull();

    const select = engineSelect();
    const values = Array.from(select.querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toEqual(["osspeech", "soniox", "deepgram", "elevenlabs"]);
  });

  it("keeps the three BYOK providers visible with an unconfigured-key hint", async () => {
    useApp.setState((s) => ({
      status: "idle",
      settings: { ...s.settings, engine: "osspeech", sonioxKey: "", deepgramKey: "", elevenLabsKey: "" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const values = Array.from(engineSelect().querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toEqual(["osspeech", "soniox", "deepgram", "elevenlabs"]);
    const labelOf = (value: string) =>
      Array.from(engineSelect().querySelectorAll("option")).find((option) => option.value === value)?.textContent;
    // FINDING 12 fix: short NAME half (ENGINE_SELECT_LABEL_OVERRIDE,
    // StatusLine.tsx) — same narrow-bar constraint applies on iOS.
    expect(labelOf("soniox")).toBe("Soniox · 未配置");
    expect(labelOf("deepgram")).toBe("Deepgram · 未配置");
    expect(labelOf("elevenlabs")).toBe("ElevenLabs · 未配置");
  });

  it("select text carries the active engine's own retention color — green for local osspeech, amber for cloud-stored elevenlabs", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "osspeech" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(engineSelect().className).toContain("text-lab-green");
    expect(engineSelect().className).not.toContain("text-fg");

    await act(async () => {
      useApp.setState((s) => ({ settings: { ...s.settings, engine: "elevenlabs" } }));
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(engineSelect().className).toContain("text-warn-soft");
  });

  // iOS-cloud round fix (Sol F6): while the select shows the 选择引擎
  // placeholder (demo/import — no live capture engine named), the text
  // stays neutral — coloring it by the HIDDEN sentinel engine's
  // retention class (demo → green) would assign privacy meaning to a
  // control that names no engine.
  it("placeholder states (demo/import) render neutral text-fg, not the sentinel engine's retention color", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "demo" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(engineSelect().className).toContain("text-fg");
    expect(engineSelect().className).not.toContain("text-lab-green");
    expect(engineSelect().className).not.toContain("text-warn-soft");
  });
});
