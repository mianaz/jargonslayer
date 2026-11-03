// @vitest-environment jsdom
//
// ImportHub — the 文稿 tab's 逐句翻译 checkbox defaults to the user's SAVED
// bilingualTranscript setting. Field-test regression: the hub mounts
// (closed) before hydrate() resolves, so it used to keep DEFAULT_SETTINGS'
// value (off) until it had been opened and closed once — the first import
// after every page load started unchecked for a bilingual-on user. Same
// store/upload mock shape as ImportHub.initialTab.test.tsx.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

const storeState: {
  settings: Settings;
  loadSession: (id: string) => Promise<void>;
  showToast: (msg: string) => void;
  hydrate: () => Promise<void>;
} = {
  settings: { ...DEFAULT_SETTINGS },
  loadSession: async () => {},
  showToast: () => {},
  hydrate: async () => {},
};
vi.mock("@/lib/store", () => {
  const useApp = ((selector: (s: typeof storeState) => unknown) => selector(storeState)) as unknown as {
    (selector: (s: typeof storeState) => unknown): unknown;
    getState: () => typeof storeState;
  };
  useApp.getState = () => storeState;
  return { useApp };
});

vi.mock("@/lib/stt/upload", () => ({
  fetchSidecarHealth: async () => null,
  importAndTrack: vi.fn(),
  importUrlAndTrack: vi.fn(),
  withSidecarHint: (msg: string) => msg,
}));

import ImportHub from "../ImportHub";

function translateCheckbox(container: HTMLDivElement): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("逐句翻译"));
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error("逐句翻译 checkbox not found");
  return input;
}

describe("ImportHub — 逐句翻译 default follows the saved setting", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    storeState.settings = { ...DEFAULT_SETTINGS, bilingualTranscript: false };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
  });

  it("settings hydrating to bilingual-on while the hub is closed: the FIRST open is already checked", async () => {
    // Mounted closed with the pre-hydration default (off)...
    await act(async () => {
      root!.render(<ImportHub open={false} onClose={() => {}} />);
    });
    // ...then hydrate() lands the saved setting (on).
    storeState.settings = { ...storeState.settings, bilingualTranscript: true };
    await act(async () => {
      root!.render(<ImportHub open={false} onClose={() => {}} />);
    });
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab="text" />);
    });
    expect(translateCheckbox(container!).checked).toBe(true);
  });

  it("the user's own toggle while the hub is open is not overwritten by a re-render", async () => {
    storeState.settings = { ...storeState.settings, bilingualTranscript: true };
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab="text" />);
    });
    const box = translateCheckbox(container!);
    expect(box.checked).toBe(true);
    await act(async () => {
      box.click();
    });
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab="text" />);
    });
    expect(translateCheckbox(container!).checked).toBe(false);
  });
});
