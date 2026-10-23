#!/usr/bin/env bash
set -euo pipefail

# Build an unsigned iOS app bundle for Sideloadly to sign with the user's Apple ID.
# Run from apps/mobile after dependencies and CocoaPods are installed.
DERIVED_DATA="${RUNNER_TEMP:-/tmp}/feyfeeds-ios-derived"
IPA_DIR="${RUNNER_TEMP:-/tmp}/feyfeeds-ipa"
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/Folo.app"

xcodebuild \
  -workspace ios/Folo.xcworkspace \
  -scheme Folo \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  build

test -d "$APP_PATH"
rm -rf "$IPA_DIR"
mkdir -p "$IPA_DIR/Payload"
ditto "$APP_PATH" "$IPA_DIR/Payload/Folo.app"
rm -f build.ipa
(cd "$IPA_DIR" && /usr/bin/zip -qry "$GITHUB_WORKSPACE/apps/mobile/build.ipa" Payload)
test -s build.ipa
