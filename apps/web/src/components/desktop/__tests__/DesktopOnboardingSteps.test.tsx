// @vitest-environment jsdom
//
// DesktopOnboardingSteps (exported from DesktopWizard.tsx) — covers
// ONLY the sequencing (byok -> diarize -> onDone), independent of each
// step's own internals (those live in OnboardingByokStep/
// OnboardingDiarizeStep, each with their own dedicated test file).
// Mocks the two sibling step components themselves (not their
// transitive connectOpenRouterDesktop/openExternal imports) — see this
// worker's own report for why that's the one boundary that resolves
// cleanly before those two worker-A modules exist on disk. Mirrors
// DesktopWizard.render.test.tsx's own createRoot/act pattern.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../OnboardingByokStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => (
    <button type="button" data-testid="stub-byok-next" onClick={onNext}>
      byok next
    </button>
  ),
}));
vi.mock("../OnboardingDiarizeStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => (
    <button type="button" data-testid="stub-diarize-next" onClick={onNext}>
      diarize next
    </button>
  ),
}));

import { DesktopOnboardingSteps } from "../DesktopWizard";

describe("DesktopOnboardingSteps — sequencing (byok -> diarize -> onDone)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function mount(onDone: () => void) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<DesktopOnboardingSteps onDone={onDone} />);
    });
  }

  it("renders inside the shared WizardFrame chrome (desktop-wizard) with the byok step first", async () => {
    await mount(() => {});
    expect(container!.querySelector('[data-testid="desktop-wizard"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="desktop-onboarding-steps"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="stub-byok-next"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="stub-diarize-next"]')).toBeNull();
    expect(container!.textContent).toContain("1 / 2");
  });

  it("byok's onNext advances to the diarize step (no onDone yet)", async () => {
    const onDone = vi.fn();
    await mount(onDone);

    await act(async () => {
      container!.querySelector('[data-testid="stub-byok-next"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.querySelector('[data-testid="stub-byok-next"]')).toBeNull();
    expect(container!.querySelector('[data-testid="stub-diarize-next"]')).not.toBeNull();
    expect(container!.textContent).toContain("2 / 2");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("diarize's onNext calls onDone", async () => {
    const onDone = vi.fn();
    await mount(onDone);

    await act(async () => {
      container!.querySelector('[data-testid="stub-byok-next"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      container!.querySelector('[data-testid="stub-diarize-next"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
