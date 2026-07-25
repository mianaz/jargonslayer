import { describe, expect, it } from "vitest";
import { toRawGithubUrl } from "../githubUrl";

describe("toRawGithubUrl — v0.6 T3(a) GitHub blob -> raw rewrite", () => {
  it("rewrites a blob URL to its raw.githubusercontent.com equivalent", () => {
    expect(toRawGithubUrl("https://github.com/mianaz/jargonslayer-dicts/blob/main/pharma.json")).toBe(
      "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pharma.json",
    );
  });

  it("preserves a nested path under blob/<ref>/", () => {
    expect(
      toRawGithubUrl("https://github.com/mianaz/jargonslayer-dicts/blob/main/packs/dicts/pharma.json"),
    ).toBe("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/dicts/pharma.json");
  });

  it("drops a query string / line-highlight fragment (meaningless on a raw URL)", () => {
    expect(
      toRawGithubUrl("https://github.com/mianaz/jargonslayer-dicts/blob/main/pharma.json?plain=1#L10-L20"),
    ).toBe("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pharma.json");
  });

  it("passes through a URL that's already raw.githubusercontent.com unchanged", () => {
    const url = "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pharma.json";
    expect(toRawGithubUrl(url)).toBe(url);
  });

  it("passes through a non-GitHub URL unchanged", () => {
    const url = "https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@main/index.json";
    expect(toRawGithubUrl(url)).toBe(url);
  });

  it("passes through a github.com URL that isn't a /blob/ path unchanged", () => {
    const url = "https://github.com/mianaz/jargonslayer-dicts";
    expect(toRawGithubUrl(url)).toBe(url);
  });

  it("passes through a github.com issue/PR URL unchanged", () => {
    const url = "https://github.com/mianaz/jargonslayer/issues/123";
    expect(toRawGithubUrl(url)).toBe(url);
  });

  it("passes through a non-URL string unchanged (never throws)", () => {
    expect(toRawGithubUrl("not a url")).toBe("not a url");
    expect(toRawGithubUrl("")).toBe("");
  });

  it("does not rewrite a downgraded http:// blob URL (only the https form is recognized)", () => {
    const url = "http://github.com/mianaz/jargonslayer-dicts/blob/main/pharma.json";
    expect(toRawGithubUrl(url)).toBe(url);
  });
});
