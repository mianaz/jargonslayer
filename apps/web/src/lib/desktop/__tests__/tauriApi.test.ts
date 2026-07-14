// v0.4 S3 chunk 5 — outside a desktop build (NEXT_PUBLIC_DESKTOP unset
// in the test env, same default every other build-flag test in this
// codebase relies on — see e.g. llmTransport.test.ts's own "false by
// default" case), every getter must throw SYNCHRONOUSLY before ever
// reaching its `import()` — no @tauri-apps/* package needs to exist or
// resolve for this file's own tests to pass.
import { describe, expect, it } from "vitest";

import { getAppVersion, getInvoke, getListen, getOpener, getTauriFetch } from "../tauriApi";

describe("tauriApi — outside a desktop build", () => {
  it("getInvoke throws synchronously, never returns a pending promise", () => {
    expect(() => getInvoke()).toThrow(/desktop build/);
  });

  it("getListen throws synchronously", () => {
    expect(() => getListen()).toThrow(/desktop build/);
  });

  it("getTauriFetch throws synchronously", () => {
    expect(() => getTauriFetch()).toThrow(/desktop build/);
  });

  // S10 field-fix, Chunk A
  it("getOpener throws synchronously", () => {
    expect(() => getOpener()).toThrow(/desktop build/);
  });

  it("getAppVersion throws synchronously", () => {
    expect(() => getAppVersion()).toThrow(/desktop build/);
  });
});
