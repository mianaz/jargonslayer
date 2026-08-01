import { describe, expect, it } from "vitest";
import { buildObsidianClipboardUrl } from "../obsidian";

describe("buildObsidianClipboardUrl", () => {
  it("uses the official new-note clipboard action and encodes the title", () => {
    const url = buildObsidianClipboardUrl("Weekly sync / 周会");
    expect(url).toBe("obsidian://new?name=Weekly+sync+%2F+%E5%91%A8%E4%BC%9A&clipboard=");
  });
});
