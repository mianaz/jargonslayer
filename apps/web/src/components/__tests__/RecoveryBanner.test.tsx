// @vitest-environment jsdom
//
// RecoveryBanner — crash/refresh recovery (v0.5 closeout). createRoot/act
// pattern, real zustand store (mirrors AiStatusPanel.test.tsx); the
// lib/history/liveDraft module's loadDraft/clearDraft are mocked
// (AnkiConnectSection.test.tsx's own connector-mock precedent) so this
// never touches real IndexedDB — but deriveDraftId etc. are re-exported
// from the REAL module via vi.importActual (importAudio.test.ts's own
// precedent) so the banner's visibility derivation is tested against
// the actual formula, not a re-implemented copy of it.
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
vi.mock("@/lib/history/liveDraft", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/history/liveDraft")>("@/lib/history/liveDraft");
  return {
    ...actual,
    loadDraft: (...args: unknown[]) => loadDraftMock(...args),
    clearDraft: (...args: unknown[]) => clearDraftMock(...args),
  };
});

import RecoveryBanner from "../RecoveryBanner";
import * as liveDraft from "@/lib/history/liveDraft";

// Captured at module-eval time (before any test overrides it) so
// afterEach can restore the real store action — see CardsPanel.test.tsx's
// own REAL_UPDATE_CARD/REAL_UPDATE_TERM doc comment for the rationale.
const REAL_RESTORE_LIVE_DRAFT = useApp.getState().restoreLiveDraft;

function makeDraft(
  segmentOverrides: MeetingSession["segments"] = [
    { id: "s1", index: 0, startedAt: 1000, endedAt: 1500, text: "hi", engine: "webspeech" },
    { id: "s2", index: 1, startedAt: 1500, endedAt: 2000, text: "there", engine: "webspeech" },
  ],
  draftId = "gen1:1000",
) {
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
  return { draftId, snapshot, savedAt: Date.now(), startedAt };
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
      // Deterministic "no meeting yet" identity for THIS tab, regardless
      // of what a previous test in this file left behind — see
      // deriveDraftId's own doc for why (0, null) can never collide with
      // a real draft's id.
      meetingGen: 0,
      startedAt: null,
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

  function restoreBtn(): HTMLButtonElement {
    return container!.querySelector<HTMLButtonElement>('[data-testid="recovery-banner-restore"]')!;
  }

  function discardBtn(): HTMLButtonElement {
    return container!.querySelector<HTMLButtonElement>('[data-testid="recovery-banner-discard"]')!;
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
    expect(restoreBtn()).not.toBeNull();
    expect(discardBtn()).not.toBeNull();
  });

  it("恢复到历史记录 re-checks the draft, calls restoreLiveDraft with the fresh snapshot + draftId, then hides the banner on success", async () => {
    const draft = makeDraft();
    loadDraftMock.mockResolvedValue(draft);
    const restoreSpy = vi.fn().mockResolvedValue(true);
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    await act(async () => {
      restoreBtn().click();
    });
    await flush();

    expect(restoreSpy).toHaveBeenCalledWith(draft.snapshot, draft.draftId);
    expect(banner()).toBeNull();
  });

  it("恢复到历史记录 keeps the banner visible when restoreLiveDraft reports failure (H1 fix: don't dismiss over a failed save)", async () => {
    const draft = makeDraft();
    loadDraftMock.mockResolvedValue(draft);
    const restoreSpy = vi.fn().mockResolvedValue(false);
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    await act(async () => {
      restoreBtn().click();
    });
    await flush();

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(banner()).not.toBeNull();
    // Not stuck busy — the user can retry.
    expect(restoreBtn().disabled).toBe(false);
  });

  it("丢弃 re-checks the draft, clears it by draftId, and hides the banner, without ever calling restoreLiveDraft", async () => {
    const draft = makeDraft();
    loadDraftMock.mockResolvedValue(draft);
    const restoreSpy = vi.fn().mockResolvedValue(true);
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    await act(async () => {
      discardBtn().click();
    });
    await flush();

    expect(clearDraftMock).toHaveBeenCalledWith(draft.draftId);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("re-checks the draftId before acting: if the draft was already resolved elsewhere between render and click, 恢复 hides the (now-moot) banner instead of restoring/duplicating", async () => {
    const draft = makeDraft();
    // The FIRST loadDraft (hydrate-time load) resolves the draft; the
    // SECOND loadDraft (handleRestore's own re-check) resolves null —
    // as if some other path (e.g. the meeting ended normally and
    // cleared its own draft) already resolved it in the meantime.
    loadDraftMock.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    const restoreSpy = vi.fn().mockResolvedValue(true);
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    await act(async () => {
      restoreBtn().click();
    });
    await flush();

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("double-click on 恢复到历史记录 only materializes ONCE (double-click guard, Sol adversarial-review fix)", async () => {
    const draft = makeDraft();
    loadDraftMock.mockResolvedValue(draft);
    let resolveRestore: (v: boolean) => void = () => {};
    const restoreSpy = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRestore = resolve;
        }),
    );
    useApp.setState({ restoreLiveDraft: restoreSpy });
    await renderAndHydrate();

    const btn = restoreBtn();
    await act(async () => {
      btn.click();
      btn.click(); // fired in the same tick, before any state/DOM update
      await Promise.resolve();
    });

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreBtn().disabled).toBe(true);

    await act(async () => {
      resolveRestore(true);
    });
    await flush();

    expect(banner()).toBeNull();
  });

  it("STAYS VISIBLE once a new meeting starts (H3 fix, Sol adversarial review — replaces the old one-way hide latch): the loaded draft belongs to a DIFFERENT (older) meeting than the one now live", async () => {
    loadDraftMock.mockResolvedValue(makeDraft());
    await renderAndHydrate();
    expect(banner()).not.toBeNull();

    await act(async () => {
      useApp.setState({ status: "listening", meetingGen: 2, startedAt: 5000 });
    });

    expect(banner()).not.toBeNull();
    expect(clearDraftMock).not.toHaveBeenCalled();
    // Still actionable — restore/discard are still wired and clickable
    // while the new meeting runs.
    expect(restoreBtn().disabled).toBe(false);
    expect(discardBtn().disabled).toBe(false);

    // Stays visible even if status later returns to idle (e.g. the new
    // meeting ends) — visibility is re-derived from live state, not a
    // one-way latch that could get stuck either way.
    await act(async () => {
      useApp.setState({ status: "idle" });
    });
    expect(banner()).not.toBeNull();
  });

  it("hides once the SAME draft is what the resolved load turns out to be (draftId matches THIS tab's own current meeting) — not a foreign draft, nothing to recover", async () => {
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
    useApp.setState({ status: "listening", meetingGen: 3, startedAt: 9000 });

    await act(async () => {
      // Resolves with a draft carrying the EXACT id THIS meeting's own
      // writes would use — i.e. it's this meeting's own in-flight
      // draft, not an orphaned one from a previous crash.
      resolveLoad(makeDraft(undefined, liveDraft.deriveDraftId(3, 9000)));
    });
    await flush();

    expect(banner()).toBeNull();
  });
});
