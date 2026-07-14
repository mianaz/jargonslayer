// @vitest-environment jsdom
//
// OnboardingByokStep — S10 field-fix item #3. Mocks @/lib/store (only
// the updateSettings action this component reads) plus the two
// worker-A modules this component imports by the pinned contract path
// (connectOpenRouterDesktop, openExternal — lib/oauth/openrouterDesktop.ts
// / lib/platform/openExternal.ts landed mid-sprint from worker A's
// concurrent wave-1 pass). Mirrors DesktopWizard.render.test.tsx's own
// createRoot/act pattern.
//
// Note for whoever reads this early in the sprint: until those two
// files exist on disk, Vite fails to resolve them (static or dynamic
// import) regardless of vi.mock's factory — mocking only works once
// SOME file is present at that path. If this suite is ever red with a
// "Failed to resolve import" error, that's the reason, not a logic
// bug; onboardingSettings.test.ts (dependency-free) and
// DesktopOnboardingSteps.test.tsx (mocks this component instead of its
// transitive imports) stay green independent of that.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const { updateSettings, connectOpenRouterDesktop, cancelOpenRouterConnect, openExternal } = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  connectOpenRouterDesktop: vi.fn(),
  cancelOpenRouterConnect: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  useApp: (selector: (s: { updateSettings: typeof updateSettings }) => unknown) =>
    selector({ updateSettings }),
}));
vi.mock("@/lib/oauth/openrouterDesktop", () => ({ connectOpenRouterDesktop, cancelOpenRouterConnect }));
vi.mock("@/lib/platform/openExternal", () => ({ openExternal }));

import OnboardingByokStep from "../OnboardingByokStep";

// React tracks an <input>'s value via a wrapped native setter to
// distinguish real user input from a plain `el.value = x` assignment
// (which it would otherwise dedupe away) — bypassing THAT wrapper via
// the native prototype setter is the standard way to simulate typing
// without @testing-library/user-event (not in this repo's test stack).
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OnboardingByokStep", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(onNext: () => void) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OnboardingByokStep onNext={onNext} />);
    });
  }

  it("跳过 calls onNext without touching Settings", async () => {
    const onNext = vi.fn();
    await mount(onNext);

    await act(async () => {
      container!.querySelector('[data-testid="btn-onboarding-byok-skip"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("保存并继续 is disabled until a key is entered; pasting + saving writes the EXACT web-callback settings shape and advances", async () => {
    const onNext = vi.fn();
    await mount(onNext);

    const saveBtn = container!.querySelector('[data-testid="btn-onboarding-save-key"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    const input = container!.querySelector('[data-testid="input-onboarding-byok-key"]') as HTMLInputElement;
    await act(async () => {
      typeInto(input, "sk-or-abc123");
    });
    expect(saveBtn.disabled).toBe(false);

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateSettings).toHaveBeenCalledWith({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-abc123",
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("使用 OpenRouter 登录 -> ok:true advances without writing Settings itself (connectOpenRouterDesktop already did)", async () => {
    connectOpenRouterDesktop.mockResolvedValue({ ok: true });
    const onNext = vi.fn();
    await mount(onNext);

    await act(async () => {
      container!.querySelector('[data-testid="btn-onboarding-oauth"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(connectOpenRouterDesktop).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("使用 OpenRouter 登录 -> ok:false shows a one-line zh hint and an openExternal(openrouter.ai/keys) link, does not advance", async () => {
    connectOpenRouterDesktop.mockResolvedValue({ ok: false, reason: "timeout" });
    const onNext = vi.fn();
    await mount(onNext);

    await act(async () => {
      container!.querySelector('[data-testid="btn-onboarding-oauth"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const hint = container!.querySelector('[data-testid="onboarding-oauth-hint"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("连接超时");
    expect(onNext).not.toHaveBeenCalled();

    await act(async () => {
      container!.querySelector('[data-testid="btn-onboarding-openrouter-keys"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(openExternal).toHaveBeenCalledWith("https://openrouter.ai/keys");
  });

  it("a late OAuth resolution after 跳过 already advanced (unmounted this step) does not fire onNext a second time", async () => {
    let resolveConnect!: (v: { ok: true }) => void;
    connectOpenRouterDesktop.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );
    const onNext = vi.fn();
    await mount(onNext);

    await act(async () => {
      container!.querySelector('[data-testid="btn-onboarding-oauth"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    // Bail via skip while the OAuth attempt is still in flight.
    await act(async () => {
      container!.querySelector('[data-testid="btn-onboarding-byok-skip"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onNext).toHaveBeenCalledTimes(1);

    // Now unmount (the sequencer would have swapped this step out) and
    // let the stale promise resolve — must be a no-op, not a 2nd onNext.
    await act(async () => {
      root!.unmount();
    });
    root = null;
    await act(async () => {
      resolveConnect({ ok: true });
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  // F4 (HIGH, adversarial review): cancelledRef above only stops THIS
  // component reacting to a stale OAuth resolution — it does nothing
  // to stop connectOpenRouterDesktop's own promise from running to
  // completion (and, pre-F3, writing settings) after the user has
  // already moved on via paste-save or skip. cancelOpenRouterConnect
  // (F3's export) must be called at every one of those exit points so
  // the underlying attempt itself is told to stop.
  describe("cancelOpenRouterConnect wiring (F4)", () => {
    it("跳过 calls cancelOpenRouterConnect() before onNext", async () => {
      const order: string[] = [];
      cancelOpenRouterConnect.mockImplementation(() => order.push("cancel"));
      const onNext = vi.fn(() => order.push("onNext"));
      await mount(onNext);

      await act(async () => {
        container!.querySelector('[data-testid="btn-onboarding-byok-skip"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      expect(cancelOpenRouterConnect).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["cancel", "onNext"]);
    });

    it("保存并继续 calls cancelOpenRouterConnect() before writing settings", async () => {
      const order: string[] = [];
      cancelOpenRouterConnect.mockImplementation(() => order.push("cancel"));
      updateSettings.mockImplementation(() => order.push("updateSettings"));
      const onNext = vi.fn();
      await mount(onNext);

      const input = container!.querySelector('[data-testid="input-onboarding-byok-key"]') as HTMLInputElement;
      await act(async () => {
        typeInto(input, "sk-or-abc123");
      });
      await act(async () => {
        container!.querySelector('[data-testid="btn-onboarding-save-key"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      expect(cancelOpenRouterConnect).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["cancel", "updateSettings"]);
    });

    it("unmounting calls cancelOpenRouterConnect(), aborting whatever OAuth attempt is still in flight", async () => {
      connectOpenRouterDesktop.mockReturnValue(new Promise(() => {})); // never resolves in this test
      const onNext = vi.fn();
      await mount(onNext);

      await act(async () => {
        container!.querySelector('[data-testid="btn-onboarding-oauth"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      await act(async () => {
        root!.unmount();
      });
      root = null;

      expect(cancelOpenRouterConnect).toHaveBeenCalledTimes(1);
    });

    it("pasting and saving while an OAuth attempt is in flight cancels it — the pasted key is the ONE settings write, never clobbered by the cancelled attempt", async () => {
      let resolveConnect!: (v: { ok: false; reason: "cancelled" }) => void;
      connectOpenRouterDesktop.mockReturnValue(
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
      );
      // Mirrors F3's real, independently-tested contract
      // (openrouterDesktop.test.ts's own "cancelOpenRouterConnect"
      // describe block): calling cancelOpenRouterConnect() settles the
      // in-flight attempt's OWN promise as {ok:false,
      // reason:"cancelled"} — simulated here since connectOpenRouterDesktop
      // itself is mocked at this component layer.
      cancelOpenRouterConnect.mockImplementation(() => resolveConnect({ ok: false, reason: "cancelled" }));

      const onNext = vi.fn();
      await mount(onNext);

      await act(async () => {
        container!.querySelector('[data-testid="btn-onboarding-oauth"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      const input = container!.querySelector('[data-testid="input-onboarding-byok-key"]') as HTMLInputElement;
      await act(async () => {
        typeInto(input, "sk-or-pasted");
      });
      await act(async () => {
        container!.querySelector('[data-testid="btn-onboarding-save-key"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      expect(cancelOpenRouterConnect).toHaveBeenCalledTimes(1);
      // The pasted key is the only write — never overwritten by the
      // now-cancelled OAuth attempt settling out from under it.
      expect(updateSettings).toHaveBeenCalledTimes(1);
      expect(updateSettings).toHaveBeenCalledWith({
        provider: "openai-compat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-pasted",
      });
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });
});
