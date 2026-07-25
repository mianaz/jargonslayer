// @vitest-environment jsdom
//
// ImportHub — iOS-only coverage (S15 mobile-UX sprint): a full-screen
// page instead of the floating centered modal, and 链接 (yt-dlp via the
// sidecar — no Python sidecar exists on iOS at all) dropped from the
// tab list entirely rather than rendered locked. IS_IOS is a module-
// scope import-time const, so this needs its own file/vi.mock, mirroring
// ModeSelector.ios.test.tsx's own split for the identical constraint.
// @/lib/store + @/lib/stt/upload mocks mirror ImportHub.initialTab.
// test.tsx's own shape exactly — the mount effect fires
// fetchSidecarHealth regardless of platform/tab.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

const storeState = {
  settings: { ...DEFAULT_SETTINGS },
  loadSession: async (_id: string) => {},
  showToast: (_msg: string) => {},
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

describe("ImportHub — iOS full-screen page (S15)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  async function renderOpen(): Promise<void> {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} />);
    });
  }

  function pickFile(input: HTMLInputElement, file: File) {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("renders the full-screen container (not the floating centered modal)", async () => {
    await renderOpen();
    expect(container!.querySelector('[data-testid="import-hub-fullscreen"]')).not.toBeNull();
  });

  it("tab list has 文件 + 文稿 and NOT 链接", async () => {
    await renderOpen();
    const sheet = container!.querySelector('[data-testid="import-hub-fullscreen"]')!;
    const tabButtons = Array.from(sheet.querySelectorAll("button")).filter((b) =>
      ["文件", "文稿", "链接"].includes(b.textContent ?? ""),
    );
    const labels = tabButtons.map((b) => b.textContent);

    expect(labels).toContain("文件");
    expect(labels).toContain("文稿");
    expect(labels).not.toContain("链接");
  });

  // Bonus (task 3b verification): the sidecar-recommended card's own
  // disabled-state copy used to unconditionally read "需启动本地
  // Whisper" — an action the user could take on desktop, but not on iOS
  // (no Python sidecar there at all, see decideVideoRouting/
  // fetchSidecarHealth). This card only renders once a file is staged.
  it("本地 Whisper card reads 此设备不支持, not 需启动本地 Whisper (no sidecar to ever reach on iOS)", async () => {
    await renderOpen();

    const fileInput = container!.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      pickFile(fileInput, new File(["x"], "clip.mp3", { type: "audio/mpeg" }));
    });

    expect(container!.textContent).toContain("此设备不支持");
    expect(container!.textContent).not.toContain("需启动本地 Whisper");
  });
});
