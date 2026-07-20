// @vitest-environment jsdom
//
// v0.5 Wave-1 Feature 8 (named custom dictionary packs, docs/design-
// explorations/v05-wave1-blueprint.md §1 F8 + §5 A7/A9) — pack UI
// smoke test. createRoot/act pattern, real zustand store for entry
// CRUD (CardsPanel.test.tsx precedent); glossary.ts's PACK functions
// are module-mocked (packs are glossary.ts's own registry, NOT zustand
// state — see glossary.ts's A7 doc comment) so pack CRUD calls/results
// are test-controlled. Scope: tabs render, new-pack flow, delete
// confirm — CRUD correctness itself is glossary.test.ts's job.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import type { CustomPack } from "@jargonslayer/core/types";

vi.mock("@/lib/history/glossary", () => ({
  PERSONAL_PACK_ID: "personal",
  getCustomPacks: vi.fn(() => []),
  loadCustomPacks: vi.fn(async () => []),
  createCustomPack: vi.fn(async () => []),
  renameCustomPack: vi.fn(async () => []),
  setCustomPackEnabled: vi.fn(async () => []),
  deleteCustomPack: vi.fn(async () => []),
  upsertCustomPack: vi.fn(async () => []),
  isCustomPackEnabled: vi.fn(() => true),
  upsertCustomEntry: vi.fn(async (e: unknown) => [e]),
  deleteCustomEntry: vi.fn(async () => []),
  loadCustomEntries: vi.fn(async () => []),
  clearGlossary: vi.fn(async () => {}),
  scanCustomEntries: vi.fn(() => ({ expressions: [], terms: [] })),
  findEntryBySurface: vi.fn(() => null),
  getCachedEntries: vi.fn(() => []),
}));

import * as glossary from "@/lib/history/glossary";
import GlossaryPanel from "../GlossaryPanel";

function personalPack(): CustomPack {
  return { id: "personal", name: "个人词库", enabled: true, createdAt: 0 };
}

const REAL_ADD_CUSTOM_ENTRY = useApp.getState().addCustomEntry;
const REAL_UPDATE_CUSTOM_ENTRY = useApp.getState().updateCustomEntry;
const REAL_REMOVE_CUSTOM_ENTRY = useApp.getState().removeCustomEntry;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(el: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GlossaryPanel — v0.5 Wave-1 Feature 8 pack UI smoke", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function render() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  function findButton(text: string): HTMLButtonElement | null {
    return (
      Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text) ?? null
    );
  }

  beforeEach(() => {
    vi.mocked(glossary.getCustomPacks).mockReturnValue([personalPack()]);
    vi.mocked(glossary.loadCustomPacks).mockResolvedValue([personalPack()]);
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
    useApp.setState({
      customEntries: [],
      addCustomEntry: REAL_ADD_CUSTOM_ENTRY,
      updateCustomEntry: REAL_UPDATE_CUSTOM_ENTRY,
      removeCustomEntry: REAL_REMOVE_CUSTOM_ENTRY,
    });
    vi.clearAllMocks();
  });

  it("renders a tab for 全部 plus every loaded pack", async () => {
    const techPack: CustomPack = { id: "p2", name: "Tech Terms", enabled: true, createdAt: 500 };
    vi.mocked(glossary.getCustomPacks).mockReturnValue([personalPack(), techPack]);
    vi.mocked(glossary.loadCustomPacks).mockResolvedValue([personalPack(), techPack]);

    render();
    await act(async () => {
      root!.render(<GlossaryPanel />);
    });

    expect(findButton("全部")).not.toBeNull();
    expect(findButton("个人词库")).not.toBeNull();
    expect(findButton("Tech Terms")).not.toBeNull();
  });

  it("new-pack flow: typing a name and clicking 创建 calls createCustomPack and renders the new tab", async () => {
    const newPack: CustomPack = { id: "p2", name: "Tech Terms", enabled: true, createdAt: 500 };
    vi.mocked(glossary.createCustomPack).mockResolvedValue([personalPack(), newPack]);

    render();
    await act(async () => {
      root!.render(<GlossaryPanel />);
    });

    await act(async () => {
      findButton("＋新建词包")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = container!.querySelector("input[placeholder='词包名称']") as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, "Tech Terms");
    });
    await act(async () => {
      findButton("创建")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(glossary.createCustomPack).toHaveBeenCalledWith("Tech Terms");
    expect(findButton("Tech Terms")).not.toBeNull();
  });

  it("delete confirm: first click arms (no call yet), second click calls deleteCustomPack(id, true)", async () => {
    const pack: CustomPack = { id: "p2", name: "Tech Terms", enabled: true, createdAt: 500 };
    vi.mocked(glossary.getCustomPacks).mockReturnValue([personalPack(), pack]);
    vi.mocked(glossary.loadCustomPacks).mockResolvedValue([personalPack(), pack]);
    vi.mocked(glossary.deleteCustomPack).mockResolvedValue([personalPack()]);

    render();
    await act(async () => {
      root!.render(<GlossaryPanel />);
    });

    // Select the pack tab to reveal its management row.
    await act(async () => {
      findButton("Tech Terms")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(findButton("删除词包")).not.toBeNull();

    await act(async () => {
      findButton("删除词包")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(glossary.deleteCustomPack).not.toHaveBeenCalled();
    expect(findButton("确认删除?")).not.toBeNull();

    await act(async () => {
      findButton("确认删除?")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(glossary.deleteCustomPack).toHaveBeenCalledWith("p2", true);
  });

  it("personal pack's management row never shows a delete affordance", async () => {
    render();
    await act(async () => {
      root!.render(<GlossaryPanel />);
    });

    await act(async () => {
      findButton("个人词库")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(findButton("重命名")).not.toBeNull();
    expect(findButton("删除词包")).toBeNull();
  });
});
