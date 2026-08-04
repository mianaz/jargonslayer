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
});
