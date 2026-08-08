// First test under scripts/ — the directory was outside the root vitest
// projects glob entirely until the root config grew its inline "scripts"
// project, so even a test written here would never have run. check-versions
// .mjs is the exemplar because it's pure-logic release tooling with a shipped
// failure in its history (a DMG stamped 1.0.0 while every other surface said
// 0.6.0): these tests pin the extraction regexes and the exact-vs-startsWith
// site rules the release train leans on.
import { describe, expect, it } from "vitest";
import {
  collectVersionErrors,
  extractCargoPackageVersion,
  extractPlistVersion,
  extractProjectYmlVersion,
} from "../check-versions.mjs";

describe("extractCargoPackageVersion", () => {
  it("reads the [package] section's version from a realistic Cargo.toml", () => {
    const toml = [
      "[package]",
      'name = "jargonslayer"',
      'version = "0.7.8"',
      'authors = ["Miana Zeng"]',
      "",
      "[dependencies]",
      'tauri = { version = "2.11.3" }',
    ].join("\n");
    expect(extractCargoPackageVersion(toml)).toBe("0.7.8");
  });

  it("still finds [package] when it is not the first section", () => {
    const toml = [
      "# release notes template",
      "[profile.release]",
      "lto = true",
      "",
      "[package]",
      'name = "x"',
      'edition = "2021"',
      'version = "1.2.3"',
    ].join("\n");
    expect(extractCargoPackageVersion(toml)).toBe("1.2.3");
  });

  it("ignores an inline dependency version on a non-line-start position", () => {
    // The regex requires `version =` at line start (m-flag ^): an inline
    // `pkg = { version = "9.9.9" }` between [package] and its version line
    // must not win.
    const toml = [
      "[package]",
      '# pinned: tauri = { version = "9.9.9" }',
      'version = "0.7.8"',
    ].join("\n");
    expect(extractCargoPackageVersion(toml)).toBe("0.7.8");
  });

  it("returns undefined when there is no [package] section", () => {
    expect(extractCargoPackageVersion('[workspace]\nmembers = []\n')).toBeUndefined();
  });
});

describe("extractProjectYmlVersion", () => {
  it("reads quoted and unquoted values", () => {
    const yml = [
      "settings:",
      '  CFBundleShortVersionString: "0.7.8"',
      "  CFBundleVersion: 0.7.8.1",
    ].join("\n");
    expect(extractProjectYmlVersion(yml, "CFBundleShortVersionString")).toBe("0.7.8");
    expect(extractProjectYmlVersion(yml, "CFBundleVersion")).toBe("0.7.8.1");
  });

  it("returns undefined for a missing key", () => {
    expect(extractProjectYmlVersion("settings: {}", "CFBundleVersion")).toBeUndefined();
  });
});

describe("extractPlistVersion", () => {
  it("reads the string that follows the key, across whitespace and newlines", () => {
    const plist = [
      "<dict>",
      "  <key>CFBundleShortVersionString</key>",
      "  <string>0.7.8</string>",
      "  <key>CFBundleVersion</key><string>0.7.8.2</string>",
      "</dict>",
    ].join("\n");
    expect(extractPlistVersion(plist, "CFBundleShortVersionString")).toBe("0.7.8");
    expect(extractPlistVersion(plist, "CFBundleVersion")).toBe("0.7.8.2");
  });

  it("returns undefined for a missing key", () => {
    expect(extractPlistVersion("<dict></dict>", "CFBundleVersion")).toBeUndefined();
  });
});

describe("collectVersionErrors", () => {
  const source = "0.7.8";

  it("returns no errors when every site agrees", () => {
    expect(
      collectVersionErrors(source, {
        exact: { "a/package.json": "0.7.8" },
        shortVersionSites: { "project.yml (short)": "0.7.8" },
        buildVersionSites: { "Info.plist (build)": "0.7.8" },
      }),
    ).toEqual([]);
  });

  it("flags an exact-site drift with both versions named", () => {
    const errors = collectVersionErrors(source, {
      exact: { "apps/web/package.json": "0.7.7" },
    });
    expect(errors).toEqual([
      'apps/web/package.json: "0.7.7" !== Cargo.toml "0.7.8"',
    ]);
  });

  it("build-number sites may carry a trailing .N (re-upload convention) but must start with the source", () => {
    expect(
      collectVersionErrors(source, {
        buildVersionSites: { "Info.plist (build)": "0.7.8.3" },
      }),
    ).toEqual([]);
    expect(
      collectVersionErrors(source, {
        buildVersionSites: { "Info.plist (build)": "0.7.9" },
      }),
    ).toEqual(['Info.plist (build): "0.7.9" does not start with Cargo.toml "0.7.8"']);
  });

  it("short-version sites require an exact match — the startsWith leniency is build-number-only", () => {
    const errors = collectVersionErrors(source, {
      shortVersionSites: { "project.yml (short)": "0.7.8.1" },
    });
    expect(errors).toEqual(['project.yml (short): "0.7.8.1" !== Cargo.toml "0.7.8"']);
  });

  it("a site whose value could not be extracted is a loud 'not found', never a silent pass", () => {
    const errors = collectVersionErrors(source, {
      shortVersionSites: { "project.yml (short)": undefined },
      buildVersionSites: { "Info.plist (build)": undefined },
    });
    expect(errors).toEqual([
      "project.yml (short): not found",
      "Info.plist (build): not found",
    ]);
  });

  it("collects every drifted site in one pass rather than stopping at the first", () => {
    const errors = collectVersionErrors(source, {
      exact: { a: "0.7.7", b: "0.7.8", c: "0.9.0" },
    });
    expect(errors).toHaveLength(2);
  });
});
