#!/usr/bin/env bash
# S13 (docs/design-explorations/s13-ios-blueprint.md §3 Lane E / §4 risk 2)
# — idempotent iOS toolchain bootstrap. Safe to re-run: every step is a
# presence-check first, act only if missing.
#
# This machine's DEFAULT `cargo` is Homebrew's (no iOS cross targets, can't
# build aarch64-apple-ios). The rustup-managed toolchain under ~/.cargo/bin
# has the iOS targets, but is intentionally NOT put on PATH by default —
# root package.json's dev:ios/build:ios-app scripts prepend ~/.cargo/bin
# explicitly instead. This script NEVER sources ~/.cargo/env into a shell
# profile and never runs `rustup default`: the owner wants Homebrew's cargo
# to stay the default `cargo` on PATH for every other project.
set -euo pipefail

CARGO_BIN="$HOME/.cargo/bin"

echo "[ios-setup] checking rustup..."
if [ -x "$CARGO_BIN/rustup" ]; then
  echo "[ios-setup] rustup already installed at $CARGO_BIN/rustup — skipping install"
else
  echo "[ios-setup] rustup not found — installing via the official rustup.rs script"
  echo "[ios-setup]   using --no-modify-path: this will NOT touch ~/.zshrc, ~/.zprofile, or"
  echo "[ios-setup]   ~/.bash_profile, so Homebrew's cargo stays the default \`cargo\` on PATH"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
fi

echo "[ios-setup] ensuring iOS cross-compile targets are installed..."
"$CARGO_BIN/rustup" target add aarch64-apple-ios aarch64-apple-ios-sim

echo "[ios-setup] checking CocoaPods (required by \`tauri ios init\`)..."
if command -v pod >/dev/null 2>&1; then
  echo "[ios-setup] CocoaPods present: $(pod --version)"
else
  echo "[ios-setup] CocoaPods not found. Install it yourself (not auto-installed by this script):"
  echo "[ios-setup]   brew install cocoapods"
fi

echo "[ios-setup] checking Xcode / iOS SDK..."
if command -v xcodebuild >/dev/null 2>&1 && xcodebuild -version >/dev/null 2>&1; then
  xcodebuild -version
  sdk_version="$(xcrun --show-sdk-version --sdk iphoneos 2>/dev/null || echo unavailable)"
  echo "[ios-setup] iphoneos SDK: $sdk_version"
else
  echo "[ios-setup] Xcode not found (or no active developer dir). Install Xcode from the App"
  echo "[ios-setup]   Store / developer.apple.com, then: sudo xcode-select -s /Applications/Xcode.app"
fi

echo "[ios-setup] done."
