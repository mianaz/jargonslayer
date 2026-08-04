// @vitest-environment jsdom
//
// useOverlayA11y — Escape-to-close, focus trap Tab wrap, focus restore.
// Mirrors other component tests' createRoot/act pattern.

import { act, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useOverlayA11y } from "../a11y";

function OverlayFixture({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayProps = useOverlayA11y({ open, onClose, containerRef: ref });
  return (
    <div>
      <button type="button" data-testid="outside">Outside</button>
      <div ref={ref} data-testid="dialog" {...overlayProps}>
        <button type="button" data-testid="first">First</button>
        <button type="button" data-testid="second">Second</button>
      </div>
    </div>
  );
}

function ControlledOverlayFixture() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const overlayProps = useOverlayA11y({
    open,
    onClose: () => setOpen(false),
    containerRef: ref,
  });
  return (
    <div>
      <button type="button" data-testid="outside">Outside</button>
      <button type="button" data-testid="open" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <div ref={ref} data-testid="dialog" {...overlayProps}>
          <button type="button" data-testid="first">First</button>
        </div>
      )}
    </div>
  );
}

describe("useOverlayA11y", () => {
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

  function mount(children: ReactNode) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(children));
  }

  it("returns role=dialog and aria-modal=true", () => {
    const onClose = vi.fn();
    mount(<OverlayFixture open onClose={onClose} />);
    const dialog = container!.querySelector("[data-testid='dialog']");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("calls onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    mount(<OverlayFixture open onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the first focusable element inside the container on open", () => {
    const onClose = vi.fn();
    mount(<OverlayFixture open onClose={onClose} />);
    const first = container!.querySelector("[data-testid='first']") as HTMLButtonElement;
    expect(document.activeElement).toBe(first);
  });

  it("restores focus to the element focused before open on close", () => {
    mount(<ControlledOverlayFixture />);
    const outside = container!.querySelector("[data-testid='outside']") as HTMLButtonElement;
    const openBtn = container!.querySelector("[data-testid='open']") as HTMLButtonElement;

    act(() => {
      outside.focus();
    });
    act(() => {
      openBtn.click();
    });

    const first = container!.querySelector("[data-testid='first']") as HTMLButtonElement;
    expect(document.activeElement).toBe(first);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).toBe(outside);
  });

  it("wraps Tab from the last focusable to the first", () => {
    const onClose = vi.fn();
    mount(<OverlayFixture open onClose={onClose} />);
    const first = container!.querySelector("[data-testid='first']") as HTMLButtonElement;
    const second = container!.querySelector("[data-testid='second']") as HTMLButtonElement;

    act(() => {
      second.focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    const onClose = vi.fn();
    mount(<OverlayFixture open onClose={onClose} />);
    const first = container!.querySelector("[data-testid='first']") as HTMLButtonElement;
    const second = container!.querySelector("[data-testid='second']") as HTMLButtonElement;

    act(() => {
      first.focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(second);
  });

  // F4 fix round: `modal:false` opts a nested popover (StatusLine's own
  // AiStatusChip popover, once stacked inside its overflow popover) out
  // of aria-modal — role=dialog stays, since it's still a real dialog.
  it("modal:false omits aria-modal while still rendering role=dialog", () => {
    function NonModalFixture({
      open,
      onClose,
    }: {
      open: boolean;
      onClose: () => void;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      const overlayProps = useOverlayA11y({ open, onClose, containerRef: ref, modal: false });
      return (
        <div ref={ref} data-testid="dialog" {...overlayProps}>
          <button type="button" data-testid="first">First</button>
        </div>
      );
    }
    const onClose = vi.fn();
    mount(<NonModalFixture open onClose={onClose} />);
    const dialog = container!.querySelector("[data-testid='dialog']");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.hasAttribute("aria-modal")).toBe(false);
  });

  // F3 fix round (HIGH): before the module-level overlay stack, EVERY
  // open instance's own unconditional document Escape listener fired on
  // one keypress — a nested overlay (e.g. ImportHub opened from an
  // already-open HistoryDrawer) closed BOTH stacked dialogs at once.
  // Mutation-checked intent: reverting the `isTopOverlay` gate back to
  // "always call onClose" makes this fail (the first Escape would close
  // both outer and inner together).
  it("nested overlays: Escape closes only the top-of-stack overlay; a second Escape closes the next one down", () => {
    function NestedOverlayFixture() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      const outerRef = useRef<HTMLDivElement>(null);
      const innerRef = useRef<HTMLDivElement>(null);
      const outerProps = useOverlayA11y({
        open: outerOpen,
        onClose: () => setOuterOpen(false),
        containerRef: outerRef,
      });
      const innerProps = useOverlayA11y({
        open: innerOpen,
        onClose: () => setInnerOpen(false),
        containerRef: innerRef,
      });
      return (
        <div>
          {outerOpen && (
            <div ref={outerRef} data-testid="outer" {...outerProps}>
              <button type="button" data-testid="open-inner" onClick={() => setInnerOpen(true)}>
                Open inner
              </button>
              {innerOpen && (
                <div ref={innerRef} data-testid="inner" {...innerProps}>
                  <button type="button" data-testid="inner-btn">Inner</button>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    mount(<NestedOverlayFixture />);
    expect(container!.querySelector("[data-testid='outer']")).not.toBeNull();
    expect(container!.querySelector("[data-testid='inner']")).toBeNull();

    act(() => {
      (container!.querySelector("[data-testid='open-inner']") as HTMLButtonElement).click();
    });
    expect(container!.querySelector("[data-testid='inner']")).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // First Escape: closes only the inner (top-of-stack) overlay.
    expect(container!.querySelector("[data-testid='inner']")).toBeNull();
    expect(container!.querySelector("[data-testid='outer']")).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Second Escape: outer is now top-of-stack, closes it too.
    expect(container!.querySelector("[data-testid='outer']")).toBeNull();
  });

  // F12 fix round (LOW): a container with zero focusable descendants
  // used to let Tab fall through untouched (the wrap logic simply
  // returned early) — focus could walk straight out to the page behind
  // the overlay. Mutation-checked intent: reverting the empty-focusables
  // branch back to a bare `return` makes this fail (activeElement would
  // stay wherever it was, and no tabindex would be set).
  describe("F12: zero focusable descendants", () => {
    function EmptyOverlayFixture({
      open,
      onClose,
      presetTabIndex,
    }: {
      open: boolean;
      onClose: () => void;
      presetTabIndex?: number;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      const overlayProps = useOverlayA11y({ open, onClose, containerRef: ref });
      return (
        <div>
          <button type="button" data-testid="outside">Outside</button>
          <div ref={ref} data-testid="dialog" tabIndex={presetTabIndex} {...overlayProps}>
            <span>Nothing focusable here</span>
          </div>
        </div>
      );
    }

    it("focuses the container itself and preventDefaults Tab, setting tabindex=-1 since none was present", () => {
      const onClose = vi.fn();
      mount(<EmptyOverlayFixture open onClose={onClose} />);
      const dialog = container!.querySelector("[data-testid='dialog']") as HTMLElement;

      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      act(() => {
        document.dispatchEvent(event);
      });

      expect(document.activeElement).toBe(dialog);
      expect(dialog.getAttribute("tabindex")).toBe("-1");
      expect(event.defaultPrevented).toBe(true);
    });

    it("never clobbers a tabindex the container already carries", () => {
      const onClose = vi.fn();
      mount(<EmptyOverlayFixture open onClose={onClose} presetTabIndex={0} />);
      const dialog = container!.querySelector("[data-testid='dialog']") as HTMLElement;

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
      });

      expect(document.activeElement).toBe(dialog);
      expect(dialog.getAttribute("tabindex")).toBe("0");
    });
  });
});
