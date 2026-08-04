// swift-tools-version:5.9
// S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md) —
// jargonslayer-audiocap: the CoreAudio process-tap helper, a second
// externalBin alongside uv (D2). Built by ../../../../scripts/
// build-audiocap.mjs, staged as binaries/jargonslayer-audiocap-<triple>.
//
// Package platform floor is intentionally macOS 13.0, ONE major version
// BELOW D1's technical floor (14.2) — NOT the same value. Setting it to
// 14.2 would embed that as this binary's LC_BUILD_VERSION minos, and
// dyld refuses to even launch a binary whose minos exceeds the running
// OS (the process never reaches main() at all, let alone the
// `#available(macOS 14.2, *)` runtime guard main.swift is supposed to
// report a typed "unsupported-os" error through). D2's own "below floor
// we never spawn it" means Rust-side gating (S9.2) is the real
// belt-and-suspenders here, but keeping THIS binary launchable one
// version below the floor is what lets its own guard ever actually run
// and print something instead of just failing to launch silently.
import Foundation
import PackageDescription

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let infoPlistPath = packageDirectory.appendingPathComponent("Resources/Info.plist").path

let package = Package(
    name: "audiocap-helper",
    platforms: [.macOS("13.0")],
    targets: [
        // C11-atomics shim — see its own header comment for why this
        // exists (Swift can't call <stdatomic.h>'s macros directly, and
        // this floor predates the Synchronization framework).
        .target(
            name: "CAudioCapAtomics",
            path: "Sources/CAudioCapAtomics"
        ),
        // Pure-Swift + CoreAudio-orchestration library — everything
        // except CLI argument parsing and the top-level `#available`
        // gate, so the test target can `@testable import` it without
        // SwiftPM's executable-target-testability edge cases.
        .target(
            name: "AudioCapCore",
            dependencies: ["CAudioCapAtomics"],
            path: "Sources/AudioCapCore"
        ),
        .executableTarget(
            name: "jargonslayer-audiocap",
            dependencies: ["AudioCapCore"],
            path: "Sources/jargonslayer-audiocap",
            linkerSettings: [
                // Embeds Resources/Info.plist into a __TEXT,__info_plist
                // section of the raw Mach-O executable — the S9.1
                // deliverable's own instruction (CFBundleIdentifier +
                // NSAudioCaptureUsageDescription, D6: "in BOTH app
                // Info.plist and helper __info_plist"). No codesign here
                // (the tauri bundler signs externalBins during
                // bundling — build-audiocap.mjs's own header comment).
                // Verified end-to-end against this toolchain with a
                // throwaway package (built, then read the section back
                // with `otool -s __TEXT __info_plist` and confirmed a
                // byte-exact round trip) before relying on it here.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", infoPlistPath,
                ])
            ]
        ),
        .testTarget(
            name: "AudioCapCoreTests",
            dependencies: ["AudioCapCore"],
            path: "Tests/AudioCapCoreTests"
        ),
    ]
)
