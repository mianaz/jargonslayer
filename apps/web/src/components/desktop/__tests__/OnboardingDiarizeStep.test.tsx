// @vitest-environment jsdom
//
// OnboardingDiarizeStep — S10 field-fix item #3. Mocks @/lib/store
// (only the updateSettings action this component reads) plus
// @/lib/platform/openExternal (worker A, S10 Chunk A — landed mid-sprint
// from worker A's concurrent wave-1 pass). See OnboardingByokStep.test.tsx's
// own header comment for the resolution-order note (only relevant if
// this file is ever read/run before openExternal.ts exists on disk).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const { updateSettings, openExternal } = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  useApp: (selector: (s: { updateSettings: typeof updateSettings }) => unknown) =>
    selector({ updateSettings }),
}));
vi.mock("@/lib/platform/openExternal", () => ({ openExternal }));

import OnboardingDiarizeStep from "../OnboardingDiarizeStep";

// See OnboardingByokStep.test.tsx's own comment on this same helper —
// bypasses React's wrapped input-value setter to simulate real typing.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OnboardingDiarizeStep", () => {
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
      root!.render(<OnboardingDiarizeStep onNext={onNext} />);
    });
  }

  it("跳过 is the prominent (bg-act) affordance and calls onNext without touching Settings", async () => {
    const onNext = vi.fn();
    await mount(onNext);

    const skipBtn = container!.querySelector('[data-testid="btn-onboarding-diarize-skip"]') as HTMLButtonElement;
    expect(skipBtn.className).toContain("bg-act");

    await act(async () => {
      skipBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("保存并继续 is disabled until a token is entered; saving writes settings.hfToken and advances", async () => {
    const onNext = vi.fn();
    await mount(onNext);

    const saveBtn = container!.querySelector('[data-testid="btn-onboarding-save-token"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    const input = container!.querySelector('[data-testid="input-onboarding-hf-token"]') as HTMLInputElement;
    await act(async () => {
      typeInto(input, "hf_abc123");
    });
    expect(saveBtn.disabled).toBe(false);

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateSettings).toHaveBeenCalledWith({ hfToken: "hf_abc123" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("the HF token page and both pyannote model-terms links route through openExternal, never a plain <a>", async () => {
    await mount(() => {});

    const links = container!.querySelector('[data-testid="onboarding-diarize-links"]')!;
    expect(links.querySelectorAll("a").length).toBe(0);
    const buttons = Array.from(links.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);

    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openExternal).toHaveBeenCalledWith("https://huggingface.co/settings/tokens");

    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openExternal).toHaveBeenCalledWith("https://huggingface.co/pyannote/segmentation-3.0");

    await act(async () => {
      buttons[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openExternal).toHaveBeenCalledWith("https://huggingface.co/pyannote/speaker-diarization-3.1");
  });
});
