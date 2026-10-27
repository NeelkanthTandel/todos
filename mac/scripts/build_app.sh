#!/bin/sh
# Builds Todos.app (release) into mac/build/Todos.app, with a copy of the website (../public) inside it.
#
#   scripts/build_app.sh               build for this Mac's architecture
#   scripts/build_app.sh --universal   build for Apple Silicon and Intel (used for releases)
#
# Environment (all optional; used by the release workflow):
#   VERSION         marketing version, e.g. 1.2.0 (default: the one in Resources/Info.plist)
#   BUILD_NUMBER    CFBundleVersion (default: VERSION)
#   SIGN_IDENTITY   codesigning identity, e.g. "Developer ID Application: …" (default: "-", ad hoc)
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
APP="$ROOT/build/Todos.app"

UNIVERSAL=0
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$UNIVERSAL" = 1 ]; then
  swift build -c release --arch arm64 --arch x86_64
  BIN=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/Todos
else
  swift build -c release
  BIN=$(swift build -c release --show-bin-path)/Todos
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Todos"
strip -x "$APP/Contents/MacOS/Todos"
cp Resources/Info.plist "$APP/Contents/Info.plist"

# The web UI, exactly as the website ships it: one codebase for both.
cp -R "$ROOT/../public" "$APP/Contents/Resources/web"
find "$APP/Contents/Resources/web" -name .DS_Store -delete

if [ -n "$VERSION" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD_NUMBER:-$VERSION}" "$APP/Contents/Info.plist"
fi

# App icon
ICONSET="$ROOT/build/AppIcon.iconset"
if [ ! -f "$ROOT/build/AppIcon.icns" ] || [ scripts/make_icon.swift -nt "$ROOT/build/AppIcon.icns" ]; then
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  swift scripts/make_icon.swift "$ROOT/build/icon_1024.png"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/build/icon_1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d "$ROOT/build/icon_1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ROOT/build/AppIcon.icns"
fi
cp "$ROOT/build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# Signed with the hardened runtime, which blocks injected libraries (DYLD_INSERT_LIBRARIES). It needs no
# entitlements: the web content runs in WebKit's own processes. Ad hoc by default; a real identity also gets a
# secure timestamp, which notarization requires.
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
if [ "$SIGN_IDENTITY" = "-" ]; then
  codesign --force --options runtime --sign - "$APP"
else
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
fi
codesign --verify --strict "$APP"
echo "Built $APP ($(lipo -archs "$APP/Contents/MacOS/Todos"), $(du -sh "$APP" | cut -f1))"
