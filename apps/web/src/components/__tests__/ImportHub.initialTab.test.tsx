// @vitest-environment jsdom
//
// ImportHub — initialTab prop (v0.5 Wave-1 Feature 5, mode-first UI,
// docs/design-explorations/v05-wave1-blueprint.md §1 Feature 5).
// ModeSelector's 导入/链接 tiles open this SAME dialog instance (page.tsx
// owns the open-state) on a specific starting tab instead of always
// landing on 文件. Mirrors ImportHub.warningsToast.test.tsx's own mock
// shape (@/lib/store, @/lib/stt/upload — the mount effect fires
// fetchSidecarHealth regardless of which tab is active) — this suite
// only exercises WHICH tab is active on open, not the import pipeline.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

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

// Each tab body renders distinguishing markup — checked directly rather
// than via the nav buttons' own selected-state class (less brittle to a
// future styling tweak).
function activeTab(container: HTMLDivElement): "file" | "text" | "url" {
  if (container.querySelector("textarea")) return "text";
  if (container.querySelector('input[placeholder="https://..."]')) return "url";
  return "file";
}

describe("ImportHub — initialTab prop", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it("no initialTab prop: opens on 文件 (existing default, unchanged)", async () => {
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} />);
    });
    expect(activeTab(container!)).toBe("file");
  });

  it("initialTab='url': opens directly on 链接", async () => {
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab="url" />);
    });
    expect(activeTab(container!)).toBe("url");
  });

  it("initialTab='text': opens directly on 文稿", async () => {
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab="text" />);
    });
    expect(activeTab(container!)).toBe("text");
  });

  it("a later generic open (initialTab undefined again) after a tile-requested open lands back on 文件", async () => {
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab="url" />);
    });
    expect(activeTab(container!)).toBe("url");

    // Close, then reopen with initialTab cleared — mirrors page.tsx's own
    // onClose reset (setImportInitialTab(undefined)) so a later Header/
    // HistoryDrawer generic 导入 open never inherits a stale tile tab.
    await act(async () => {
      root!.render(<ImportHub open={false} onClose={() => {}} initialTab="url" />);
    });
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} initialTab={undefined} />);
    });
    expect(activeTab(container!)).toBe("file");
  });
});
