// Runs the iOS plugin's Tauri-free core suite (tauri-plugin-os-speech/
// ios/Tests/OsSpeechCoreTests — 43 XCTests as of this wiring) on a macOS
// host. Until this script, those tests ran NOWHERE: not in CI, not in any
// npm script.
//
// Why a bare `swift test --package-path .../ios` can never work on a host
// (two independent blockers, see ios/Package.swift's own host-testing
// note for the first):
//   1. SwiftPM's aggregate test bundle builds EVERY target in the
//      manifest, including the Tauri-dependent glue target
//      (Sources/tauri-plugin-os-speech) — and the Tauri package
//      unconditionally imports UIKit, so it does not compile for macOS.
//   2. The manifest's `.package(name: "Tauri", path: "../.tauri/
//      tauri-api")` names a directory that only exists after a
//      `tauri ios build` has generated it (and is gitignored) — on a
//      fresh checkout dependency RESOLUTION fails before the UIKit
//      compile error is even reachable.
//
// So this script automates the manifest's own documented manual
// workaround instead of mutating the real package in place: stage
// Sources/OsSpeechCore + Tests/OsSpeechCoreTests into a scratch SwiftPM
// package whose manifest has no Tauri dependency at all, and `swift test`
// there. The core sources are host-buildable by design — that's the whole
// point of the OsSpeechCore/glue target split (iOS-only files are
// `#if os(iOS)`-gated at file scope; @available(iOS 26/macOS 26) gates
// handle the rest, which is also why CI runs this on macos-26).
//
// macOS-only, same early-skip posture as build-audiocap.mjs: everywhere
// else the Speech/Translation system frameworks the suite imports don't
// exist, so a clear skip beats a confusing compiler error.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iosDir = join(
  root,
  "apps/desktop/src-tauri/tauri-plugin-os-speech/ios",
);

if (process.platform !== "darwin") {
  console.error(
    "test-ios-core: macOS-only (OsSpeechCore imports the Speech/Translation system frameworks). Skipping is not success — run this on a Mac or in the macos CI job.",
  );
  process.exit(1);
}

// Mirrors ios/Package.swift: same tools version, same platform floors,
// same two targets — minus the products/dependencies/glue that make the
// real manifest un-testable on a host (see header).
const manifest = `// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "OsSpeechCoreHostTests",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    targets: [
        .target(
            name: "OsSpeechCore",
            path: "Sources/OsSpeechCore"),
        .testTarget(
            name: "OsSpeechCoreTests",
            dependencies: ["OsSpeechCore"],
            path: "Tests/OsSpeechCoreTests"),
    ]
)
`;

const scratch = mkdtempSync(join(tmpdir(), "os-speech-core-tests-"));
try {
  cpSync(join(iosDir, "Sources/OsSpeechCore"), join(scratch, "Sources/OsSpeechCore"), {
    recursive: true,
  });
  cpSync(join(iosDir, "Tests/OsSpeechCoreTests"), join(scratch, "Tests/OsSpeechCoreTests"), {
    recursive: true,
  });
  writeFileSync(join(scratch, "Package.swift"), manifest);

  console.log(`test-ios-core: staged OsSpeechCore + OsSpeechCoreTests into ${scratch}`);
  execFileSync("swift", ["test", "--package-path", scratch], { stdio: "inherit" });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
