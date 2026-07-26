#!/usr/bin/env bash
# App Store IPA build (TestFlight round, 2026-07-25). Two stages because
# `tauri ios build --export-method app-store-connect` can ARCHIVE with
# our manual signing (pbxproj release: Manual + Apple Distribution +
# "JargonSlayer AppStore" profile) but its own export step generates an
# ExportOptions without the provisioningProfiles mapping manual signing
# requires — so its exit code is EXPECTED to be nonzero and we export
# ourselves from the produced xcarchive with the repo's plist.
#
# PATH prefix: Homebrew's rust (no iOS targets) shadows rustup on this
# machine — E0463 without it. Prereqs (one-time, already done):
# Apple Distribution cert valid in keychain (incl. WWDR G3 intermediate)
# + "JargonSlayer AppStore" profile installed in
# ~/Library/MobileDevice/Provisioning Profiles/.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/apps/desktop/src-tauri/gen/apple/build"

node "$ROOT/scripts/check-ios-plist.mjs" || exit 1
rm -rf "$BUILD"
(cd "$ROOT/apps/desktop" && PATH="$HOME/.cargo/bin:$PATH" npm run tauri -- ios build --export-method app-store-connect)

ARCHIVE="$BUILD/jargonslayer_iOS.xcarchive"
if [ ! -d "$ARCHIVE" ]; then
  echo "build-ios-ipa: no xcarchive produced — the failure above is REAL (not the expected export-step one)" >&2
  exit 1
fi

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$BUILD/export" \
  -exportOptionsPlist "$ROOT/apps/desktop/src-tauri/ExportOptions.appstore.plist" || exit 1

echo "build-ios-ipa: OK -> $BUILD/export/JargonSlayer.ipa"
