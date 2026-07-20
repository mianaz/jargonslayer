// v0.5 Wave-1 Feature 2 (AI transcript correction, §5 A5) — postFilter
// coverage: "shared zod CorrectResponseSchema validation (reject blank/
// duplicate ids, filter to requested ids)". The schema itself
// (providerCore.ts's CorrectResponseSchema) is shape-only (mirrors
// TranslateSegmentsSchema); this is where a malformed row actually gets
// dropped WITHOUT sinking the whole batch — same "extract, don't fork"
// posture as tasks/translate.ts's own postFilter.
import { describe, expect, it } from "vitest";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import { runCorrectTask, type CorrectTaskInput } from "../correct";
import type { CorrectResponse } from "@jargonslayer/core/types";

function baseInput(overrides: Partial<CorrectTaskInput> = {}): CorrectTaskInput {
  return {
    apiKey: "key",
    model: "model",
    provider: "anthropic",
    baseUrl: "",
    segments: [
      { id: "s1", text: "scar an seek" },
      { id: "s2", text: "everything else fine" },
    ],
    context: "",
    lexicon: ["scRNA-seq"],
    ...overrides,
  };
}

function makeCall(response: CorrectResponse): ProviderCaller {
  return (async <T>(_opts: CallJsonOptions<T>): Promise<T> => response as T) as ProviderCaller;
}

describe("runCorrectTask — postFilter", () => {
  it("passes through a well-formed response unchanged", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "s1", text: "scRNA-seq" },
          { id: "s2", text: "everything else fine" },
        ],
      }),
    );
    expect(res.corrections).toEqual([
      { id: "s1", text: "scRNA-seq" },
      { id: "s2", text: "everything else fine" },
    ]);
  });

  it("drops a correction with a blank id", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "", text: "should be dropped" },
          { id: "s1", text: "scRNA-seq" },
        ],
      }),
    );
    expect(res.corrections).toEqual([{ id: "s1", text: "scRNA-seq" }]);
  });

  it("drops the SECOND occurrence of a duplicate id, keeping the first", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "s1", text: "first" },
          { id: "s1", text: "second — should be dropped" },
        ],
      }),
    );
    expect(res.corrections).toEqual([{ id: "s1", text: "first" }]);
  });

  it("drops a correction for an id that was never requested", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "s1", text: "scRNA-seq" },
          { id: "unrequested-id", text: "should be dropped" },
        ],
      }),
    );
    expect(res.corrections).toEqual([{ id: "s1", text: "scRNA-seq" }]);
  });

  it("a single malformed row never sinks the whole batch — every OTHER valid row still comes through", async () => {
    const res = await runCorrectTask(
      baseInput({
        segments: [
          { id: "s1", text: "a" },
          { id: "s2", text: "b" },
          { id: "s3", text: "c" },
        ],
      }),
      makeCall({
        corrections: [
          { id: "", text: "blank" },
          { id: "s1", text: "s1-fixed" },
          { id: "s1", text: "s1-dup" },
          { id: "extra", text: "unrequested" },
          { id: "s2", text: "s2-fixed" },
        ],
      }),
    );
    expect(res.corrections).toEqual([
      { id: "s1", text: "s1-fixed" },
      { id: "s2", text: "s2-fixed" },
    ]);
  });

  it("forwards the resolved lexicon/context/segments into the provider call's user message", async () => {
    let capturedUser = "";
    const call: ProviderCaller = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
      capturedUser = opts.user;
      return { corrections: [] } as T;
    }) as ProviderCaller;

    await runCorrectTask(
      baseInput({ context: "prior discussion of RNA sequencing", lexicon: ["scRNA-seq", "UMAP"] }),
      call,
    );

    expect(capturedUser).toContain("scRNA-seq, UMAP");
    expect(capturedUser).toContain("prior discussion of RNA sequencing");
    expect(capturedUser).toContain(JSON.stringify(baseInput().segments));
  });
});
