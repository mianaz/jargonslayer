// lib/proxyUrl.ts is the ONE validator applied to the desktop proxy
// field from BOTH directions — SettingsDialog's live input and
// history/autoExport.ts's backup-restore boundary (the F5 fix hoisted
// it out of the dialog precisely so a hand-edited backup can't smuggle
// a malformed proxy past validation). Security-adjacent and previously
// untested.
import { describe, expect, it } from "vitest";
import { isValidProxyUrl, normalizeProxyUrl } from "../proxyUrl";

describe("normalizeProxyUrl", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeProxyUrl("  http://proxy:7890  ")).toBe("http://proxy:7890");
  });

  it("converts full-width ：／．～ to their ASCII forms", () => {
    expect(normalizeProxyUrl("http：／／proxy．local：7890")).toBe(
      "http://proxy.local:7890",
    );
    expect(normalizeProxyUrl("http://host/～user")).toBe("http://host/~user");
  });

  it("leaves an already-clean value unchanged", () => {
    expect(normalizeProxyUrl("socks5://127.0.0.1:7891")).toBe(
      "socks5://127.0.0.1:7891",
    );
  });
});

describe("isValidProxyUrl", () => {
  it("allows empty — the field's own default means follow the system proxy", () => {
    expect(isValidProxyUrl("")).toBe(true);
  });

  it("accepts each scheme in the allowlist with a host", () => {
    expect(isValidProxyUrl("http://proxy:7890")).toBe(true);
    expect(isValidProxyUrl("https://proxy:7890")).toBe(true);
    expect(isValidProxyUrl("socks5://127.0.0.1:7891")).toBe(true);
    expect(isValidProxyUrl("socks5h://proxy.local:1080")).toBe(true);
  });

  it("accepts an uppercase scheme (URL normalizes the protocol)", () => {
    expect(isValidProxyUrl("HTTP://proxy:7890")).toBe(true);
  });

  it("DELIBERATELY allows userinfo — the one legitimate home for basic-auth proxy credentials", () => {
    expect(isValidProxyUrl("http://user:pass@proxy:7890")).toBe(true);
    expect(isValidProxyUrl("socks5://user:pass@proxy:1080")).toBe(true);
  });

  it("rejects schemes outside the allowlist", () => {
    expect(isValidProxyUrl("ftp://proxy:21")).toBe(false);
    expect(isValidProxyUrl("socks4://proxy:1080")).toBe(false);
    expect(isValidProxyUrl("file:///etc/hosts")).toBe(false);
  });

  it("rejects a scheme-only value with no host rather than handing tauri-plugin-http a hostless config", () => {
    expect(isValidProxyUrl("socks5://")).toBe(false);
    expect(isValidProxyUrl("http://")).toBe(false);
  });

  it("rejects unparseable values and embedded whitespace", () => {
    expect(isValidProxyUrl("not a url")).toBe(false);
    expect(isValidProxyUrl("http://pro xy:7890")).toBe(false);
    expect(isValidProxyUrl("proxy:7890")).toBe(false); // no scheme → 'proxy:' isn't allowlisted
  });

  it("rejects query strings and fragments", () => {
    expect(isValidProxyUrl("http://proxy:7890?mode=global")).toBe(false);
    expect(isValidProxyUrl("http://proxy:7890#top")).toBe(false);
  });

  it("normalize + validate accepts the full-width form a zh IME produces, raw input alone does not", () => {
    const raw = "http：／／proxy：7890";
    expect(isValidProxyUrl(raw)).toBe(false);
    expect(isValidProxyUrl(normalizeProxyUrl(raw))).toBe(true);
  });
});
