// Exercises diagReport.ts's pure pieces (redactByKeyShape,
// buildSettingsSnapshot, buildDiagnosticReport) — none of them touch
// chrome/navigator/indexedDB, so they run under this app's plain node
// vitest environment with no mocking (see vitest.config.ts's own
// header for why this app stays DOM/chrome-mock-free). The impure
// orchestrator (copyDiagnosticReport) is intentionally left untested
// here — same "manually verified via load-unpacked + vite build"
// posture main.ts's own DOM wiring already has (vitest.config.ts).

import { beforeEach, describe, expect, it } from "vitest";

import { clearDiag, diagLog } from "../diag";
import {
  buildDiagnosticReport,
  buildSettingsSnapshot,
  DIAG_REPORT_ENTRIES,
  redactByKeyShape,
} from "../diagReport";

describe("diagReport — redactByKeyShape", () => {
  it("collapses a secret-shaped key to has<Key>/<key>Chars, never the value", () => {
    const out = redactByKeyShape({ apiKey: "sk-SENTINEL" });
    expect(out).not.toHaveProperty("apiKey");
    expect(out.hasApiKey).toBe(true);
    expect(out.apiKeyChars).toBe("sk-SENTINEL".length);
  });

  it("hasApiKey is false and apiKeyChars is 0 for an empty secret-shaped value", () => {
    const out = redactByKeyShape({ apiKey: "" });
    expect(out.hasApiKey).toBe(false);
    expect(out.apiKeyChars).toBe(0);
  });

  it("reduces a url-shaped key to its origin only — path/query dropped", () => {
    const out = redactByKeyShape({ sourceUrl: "https://example.com/manifest.json?token=SENTINEL" });
    expect(out.sourceUrl).toBe("https://example.com");
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
  });

  it("an unparseable url-shaped value collapses to the fallback marker, never the raw value", () => {
    const out = redactByKeyShape({ sourceUrl: "not a url" });
    expect(out.sourceUrl).toBe("(无法解析的地址，已隐去)");
  });

  it("passes non-secret, non-url fields through verbatim", () => {
    const out = redactByKeyShape({ packId: "core", count: 3 });
    expect(out.packId).toBe("core");
    expect(out.count).toBe(3);
  });
});

describe("diagReport — buildSettingsSnapshot", () => {
  it("redacts every installed pack source's url to its origin, keeps counts", () => {
    const snapshot = buildSettingsSnapshot(
      [
        { url: "https://example.com/manifest.json?SENTINEL=1", pack: { id: "custom-a" } },
        { url: "https://other.example.com/manifest.json", pack: { id: "custom-b" } },
      ],
      14,
    );
    expect(snapshot.builtinPackCount).toBe(14);
    expect(snapshot.installedPackCount).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("SENTINEL");
    expect(JSON.stringify(snapshot)).toContain("https://example.com");
    expect(JSON.stringify(snapshot)).toContain("custom-a");
  });

  it("an empty source list still reports zero counts, not an error", () => {
    const snapshot = buildSettingsSnapshot([], 14);
    expect(snapshot.installedPackCount).toBe(0);
    expect(snapshot.installedPacks).toEqual([]);
  });
});

describe("diagReport — buildDiagnosticReport", () => {
  beforeEach(() => clearDiag());

  it("includes the given version/UA and the settings snapshot as JSON", () => {
    const text = buildDiagnosticReport("0.6.0", "test-ua", { foo: "bar" });
    expect(text).toContain("版本: 0.6.0");
    expect(text).toContain("test-ua");
    expect(text).toContain('"foo": "bar"');
  });

  it("includes the last DIAG_REPORT_ENTRIES ring-buffer entries, most recent still present when the buffer exceeds it", () => {
    for (let i = 0; i < DIAG_REPORT_ENTRIES + 5; i++) {
      diagLog("info", "seq", `entry-${i}`);
    }
    const text = buildDiagnosticReport("0.6.0", "test-ua", {});
    expect(text).toContain(`entry-${DIAG_REPORT_ENTRIES + 4}`); // most recent
    expect(text).not.toContain("entry-0"); // dropped from the last-N window
  });

  it("reports （暂无记录） when the ring buffer is empty", () => {
    const text = buildDiagnosticReport("0.6.0", "test-ua", {});
    expect(text).toContain("（暂无记录）");
  });
});
