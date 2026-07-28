// @vitest-environment jsdom
//
// export.ts — iOS share-sheet path (downloadBlob/downloadFile). IS_IOS
// is a module-scope import-time const, so this needs its own file/
// vi.mock — mirrors connectors/__tests__/ankiConnect.ios.test.ts's own
// split for the identical constraint (export.test.ts covers the
// ambient/web anchor-download path, unaffected by this file).

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

const mockShowToast = vi.fn();
const storeState = { showToast: (toast: unknown) => mockShowToast(toast) };
vi.mock("@/lib/store", () => {
  const useApp = {} as { getState: () => typeof storeState };
  useApp.getState = () => storeState;
  return { useApp };
});

import { downloadBlob, downloadFile } from "../export";

/** Stubs navigator.share/canShare for one test — jsdom ships neither
 *  (see this file's own probe), so both are plain configurable-value
 *  properties, not overrides of a real implementation. */
function stubShare(impl: (data: ShareData) => Promise<void>) {
  Object.defineProperty(navigator, "share", { value: vi.fn(impl), configurable: true, writable: true });
  Object.defineProperty(navigator, "canShare", { value: vi.fn(() => true), configurable: true, writable: true });
}

describe("downloadBlob (iOS build) — share-sheet path", () => {
  afterEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "canShare");
  });

  it("hands the blob to navigator.share as a File with the right name/type, and never clicks an anchor", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
    let sharedFile: File | undefined;
    stubShare(async (data) => {
      sharedFile = data.files?.[0];
    });

    await downloadBlob("report.md", new Blob(["hello"], { type: "text/markdown" }));

    expect(sharedFile).toBeInstanceOf(File);
    expect(sharedFile?.name).toBe("report.md");
    expect(sharedFile?.type).toBe("text/markdown");
    expect(clickSpy).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  // WKWebView + navigator.share: dismissing the share sheet rejects
  // with AbortError — a cancel, not a failure (export.ts's own doc
  // comment on downloadBlob).
  it("swallows an AbortError rejection (user dismissed the share sheet) — resolves, no toast", async () => {
    stubShare(async () => {
      throw new DOMException("cancelled", "AbortError");
    });

    await expect(downloadBlob("report.md", new Blob(["hello"]))).resolves.toBeUndefined();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("on a NotAllowedError rejection, resolves without throwing and shows a retry-hint toast", async () => {
    stubShare(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });

    await expect(downloadBlob("report.md", new Blob(["hello"]))).resolves.toBeUndefined();
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    const toast = mockShowToast.mock.calls[0][0] as { message: string; action: { label: string } };
    expect(toast.message).toContain("重试");
    expect(toast.action.label).toBe("重试");
  });

  it("downloadFile delegates to the same share path (one save path)", async () => {
    let sharedFile: File | undefined;
    stubShare(async (data) => {
      sharedFile = data.files?.[0];
    });

    await downloadFile("notes.json", "{}", "application/json");

    expect(sharedFile?.name).toBe("notes.json");
    expect(sharedFile?.type).toBe("application/json");
  });
});
