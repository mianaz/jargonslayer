// @vitest-environment jsdom
//
// RecoveryBanner — crash/refresh recovery (v0.5 closeout). createRoot/act
// pattern, real zustand store (mirrors AiStatusPanel.test.tsx); the
// lib/history/liveDraft module is mocked (AnkiConnectSection.test.tsx's
// own connector-mock precedent) so this never touches real IndexedDB.
// restoreLiveDraft is spied via a setState override + REAL-action
// restore in afterEach (CardsPanel.test.tsx's updateCard/updateTerm
// precedent) rather than mocking the whole store module.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS, type MeetingSession } from "@jargonslayer/core/types";

const loadDraftMock = vi.fn();
const clearDraftMock = vi.fn();
vi.mock("@/lib/history/liveDraft", () => ({
  loadDraft: (...args: unknown[]) => loadDraftMock(...args),
  clearDraft: (...args: unknown[]) => clearDraftMock(...args),
}));

import RecoveryBanner from "../RecoveryBanner";

// Captured at module-eval time (before any test overrides it) so
// afterEach can restore the real store action — see CardsPanel.test.tsx's
// own REAL_UPDATE_CARD/REAL_UPDATE_TERM doc comment for the rationale.
const REAL_RESTORE_LIVE_DRAFT = useApp.getState().restoreLiveDraft;

function makeDraft(segmentOverrides: MeetingSession["segments"] = [
  { id: "s1", index: 0, startedAt: 1000, endedAt: 1500, text: "hi", engine: "webspeech" },
  { id: "s2", index: 1, startedAt: 1500, endedAt: 2000, text: "there", engine: "webspeech" },
]) {
  const startedAt = new Date(2026, 6, 1, 9, 30).getTime(); // 2026-07-01 09:30
  const snapshot: MeetingSession = {
    id: "draft-1",
    title: "当前会议",
    startedAt,
    endedAt: startedAt + 60_000,
    engine: "webspeech",
    segments: segmentOverrides,
    cards: [],
    terms: [],
  };
  return { snapshot, savedAt: Date.now(), startedAt };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RecoveryBanner", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    useApp.setState({
      hydrated: false,
      status: "idle",
      settings: { ...DEFAULT_SETTINGS },
      toast: null,
    });
    loadDraftMock.mockReset();
    clearDraftMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    useApp.setState({ restoreLiveDraft: REAL_RESTORE_LIVE_DRAFT });
    vi.clearAllMocks();
  });

  function render() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  async function renderAndHydrate() {
    render();
    await act(async () => {
      root!.render(<RecoveryBanner />);
    });
    await act(async () => {
      useApp.setState({ hydrated: true });
    });
    await flush();
  }

  function banner(): Element | null {
    return container!.querySelector('[data-testid="recovery-banner"]');
  }

  it("renders nothing before hydrate() settles, even if a draft would resolve", async () => {
    loadDraftMock.mockResolvedValue(makeDraft());
    render();
    await act(async () => {
      root!.render(<RecoveryBanner />);
    });

    expect(loadDraftMock).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("renders nothing when no draft exists", async () => {
    loadDraftMock.mockResolvedValue(null);
    await renderAndHydrate();

    expect(banner()).toBeNull();
  });

  it("renders nothing when the draft's transcript is empty", async () => {
    loadDraftMock.mockResolvedValue(makeDraft([]));
    await renderAndHydrate();

    expect(banner()).toBeNull();
  });

  it("renders the banner (date/time + segment count + both actions) when a non-empty draft exists", async () => {
    loadDraftMock.mockResolvedValue(makeDraft());
    await renderAndHydrate();

    const el = banner();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("2026-07-01 09:30");
    expect(el!.textContent).toContain("2 段");
    expect(el!.textContent).toContain("可能因页面刷新或崩溃中断");
    expect(container!.querySelector('[data-testid="recovery-banner-restore"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="recovery-banner-discard"]')).not.toBeNull();
  });

  it("恢复到历史记录 calls restoreLiveDraft with the draft's snapshot, then hides the banner", async () => {
    const draft = makeDraft();
    loadDraftMock.mockResolvedValue(draft);
    const restoreSpy = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="recovery-banner-restore"]')!
        .click();
    });

    expect(restoreSpy).toHaveBeenCalledWith(draft.snapshot);
    expect(banner()).toBeNull();
  });

  it("丢弃 clears the draft and hides the banner, without ever calling restoreLiveDraft", async () => {
    loadDraftMock.mockResolvedValue(makeDraft());
    const restoreSpy = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="recovery-banner-discard"]')!
        .click();
    });

    expect(clearDraftMock).toHaveBeenCalledTimes(1);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("hides (one-way) once a new meeting starts (status leaves idle) while the banner is up, WITHOUT clearing the draft", async () => {
    loadDraftMock.mockResolvedValue(makeDraft());
    await renderAndHydrate();
    expect(banner()).not.toBeNull();

    await act(async () => {
      useApp.setState({ status: "connecting" });
    });

    expect(banner()).toBeNull();
    expect(clearDraftMock).not.toHaveBeenCalled();

    // Stays hidden even if status later returns to idle (e.g. a
    // 0-segment run ending) — a one-way latch, not a live re-derivation
    // that could flash stale info back up.
    await act(async () => {
      useApp.setState({ status: "idle" });
    });
    expect(banner()).toBeNull();
  });

  it("never shows the banner if a meeting already started before loadDraft's async resolution lands (boot race guard)", async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    loadDraftMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    render();
    await act(async () => {
      root!.render(<RecoveryBanner />);
    });
    await act(async () => {
      useApp.setState({ hydrated: true });
    });

    // A meeting starts before the still-pending loadDraft() resolves.
    useApp.setState({ status: "listening" });

    await act(async () => {
      resolveLoad(makeDraft());
    });
    await flush();

    expect(banner()).toBeNull();
  });
});
