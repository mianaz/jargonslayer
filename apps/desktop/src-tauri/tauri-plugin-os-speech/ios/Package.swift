// swift-tools-version:5.3
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

// S13 (docs/design-explorations/s13-ios-blueprint.md, Lane B) — two
// targets, not the generator's single one: `OsSpeechCore` has NO
// dependency on `Tauri`/`SwiftRs` at all (plain Foundation/AVFoundation/
// Speech/UIKit — system frameworks only), so it (and OsSpeechCoreTests)
// can build+run on a plain macOS host — the `Tauri` package itself
// unconditionally `import UIKit`s (verified: it does not build for
// macOS at all), so a single Tauri-dependent target would make host
// testing fail before ever reaching any of this plugin's OWN pure logic,
// regardless of this package's own per-file `#if os(iOS)` gates.
// `tauri-plugin-os-speech` (same name as the product, unchanged from the
// generator, so the Cargo-side `ios_path("ios")`/Xcode integration keeps
// resolving the SAME product) is now just the thin `OsSpeechPlugin.swift`
// glue, depending on `OsSpeechCore` + `Tauri`.
//
// Host-testing note: a bare `swift test` still tries to build EVERY
// target in this manifest (including the Tauri-dependent glue target,
// which cannot compile on macOS) — that's SwiftPM CLI's own
// aggregate-PackageTests-bundle behavior, not fixable from inside this
// manifest. Verified working instead: `swift build --target
// OsSpeechCoreTests` (compiles OsSpeechCore + OsSpeechCoreTests only,
// green); to actually RUN OsSpeechCoreTests on a host, temporarily drop
// the `tauri-plugin-os-speech` target/product (keep OsSpeechCore +
// OsSpeechCoreTests only) and run `swift test` — 15/15 passed this way
// as of this port. CI/lane gates for the REAL iOS target are unaffected:
// `xcodebuild`/`swift build --triple arm64-apple-ios` build the whole
// package, including the glue target, exactly as intended there.
let package = Package(
    name: "tauri-plugin-os-speech",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    products: [
        // Products define the executables and libraries a package produces, and make them visible to other packages.
        .library(
            name: "tauri-plugin-os-speech",
            type: .static,
            targets: ["tauri-plugin-os-speech"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        // Targets are the basic building blocks of a package. A target can define a module or a test suite.
        // Targets can depend on other targets in this package, and on products in packages this package depends on.
        .target(
            name: "OsSpeechCore",
            path: "Sources/OsSpeechCore"),
        .target(
            name: "tauri-plugin-os-speech",
            dependencies: [
                "OsSpeechCore",
                .byName(name: "Tauri"),
            ],
            path: "Sources/tauri-plugin-os-speech"),
        .testTarget(
            name: "OsSpeechCoreTests",
            dependencies: ["OsSpeechCore"],
            path: "Tests/OsSpeechCoreTests"),
    ]
)
