#!/usr/bin/env bash
set -e

# ==============================================================================
# Svorrent macOS .app & .dmg Builder
# Creates a lightweight native launcher that opens Svorrent in the default browser.
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/dist-app"
APP_BUNDLE="$BUILD_DIR/Svorrent.app"
DMG_STAGING="$BUILD_DIR/dmg-staging"
DMG_OUTPUT="$BUILD_DIR/Svorrent.dmg"

echo "==> Building Android USB tethering helper..."
NATIVE_DIR="$BUILD_DIR/native"
mkdir -p "$NATIVE_DIR"
CXX="${SVORRENT_CXX:-/Library/Developer/CommandLineTools/usr/bin/clang++}"
CC="${SVORRENT_CC:-/Library/Developer/CommandLineTools/usr/bin/clang}"
SDK="${SVORRENT_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
OTOOL="${SVORRENT_OTOOL:-/Library/Developer/CommandLineTools/usr/bin/otool}"
INSTALL_NAME_TOOL="${SVORRENT_INSTALL_NAME_TOOL:-/Library/Developer/CommandLineTools/usr/bin/install_name_tool}"
if [ ! -x "$CXX" ] || [ ! -x "$CC" ] || [ ! -d "$SDK" ] || [ ! -x "$OTOOL" ] || [ ! -x "$INSTALL_NAME_TOOL" ]; then
    echo "A macOS C++ toolchain and SDK are required to build Android USB support." >&2
    exit 1
fi
"$CXX" -isysroot "$SDK" -mmacosx-version-min=26.0 -O2 -std=c++17 -Wall -Wextra \
    "$ROOT_DIR/backend/tether/svorrent-tetherd.cc" \
    -L"$ROOT_DIR/backend/bin" -ltetherkit \
    -o "$NATIVE_DIR/svorrent-tetherd"
TETHER_LIBRARY="$("$OTOOL" -L "$NATIVE_DIR/svorrent-tetherd" | awk '/libtetherkit\.0\.dylib/{print $1; exit}')"
if [ -z "$TETHER_LIBRARY" ]; then
    echo "The native helper did not link against TetherKit." >&2
    exit 1
fi
"$INSTALL_NAME_TOOL" -change "$TETHER_LIBRARY" \
    '@executable_path/libtetherkit.0.dylib' "$NATIVE_DIR/svorrent-tetherd"
codesign --force --sign - "$NATIVE_DIR/svorrent-tetherd"
cp -a "$ROOT_DIR/backend/bin"/libtetherkit*.dylib "$ROOT_DIR/backend/bin"/libusb-*.dylib "$NATIVE_DIR/"
for library in "$NATIVE_DIR/libtetherkit.0.1.5.dylib" "$NATIVE_DIR/libusb-1.0.0.dylib"; do
    test -f "$library"
    xattr -d com.apple.quarantine "$library" 2>/dev/null || true
done
"$NATIVE_DIR/svorrent-tetherd" --list >/dev/null

echo "==> 1. Building React frontend..."
cd "$ROOT_DIR/frontend"
npm run build

echo "==> 2. Preparing staging directories..."
rm -rf "$APP_BUNDLE" "$DMG_STAGING" "$DMG_OUTPUT"
mkdir -p "$BUILD_DIR"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources/app/backend"
mkdir -p "$APP_BUNDLE/Contents/Resources/app/frontend/dist"
mkdir -p "$DMG_STAGING"

echo "==> 3. Generating macOS AppIcon.icns..."
ICON_TMP="$(mktemp -d "${TMPDIR:-/tmp}/svorrent-icon.XXXXXX")"
mkdir -p "$ICON_TMP/Svorrent.iconset"
SRC_PNG="$ICON_TMP/favicon.png"
if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w 1024 -h 1024 "$ROOT_DIR/frontend/public/favicon.svg" -o "$SRC_PNG"
elif qlmanage -t -s 1024 -o "$ICON_TMP" "$ROOT_DIR/frontend/public/favicon.svg" >/dev/null 2>&1 &&
     [ -s "$ICON_TMP/favicon.svg.png" ]; then
    mv "$ICON_TMP/favicon.svg.png" "$SRC_PNG"
else
    echo "SVG icon rendering requires librsvg or macOS Quick Look." >&2
    exit 1
fi

sips -z 16 16     "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_16x16.png" >/dev/null
sips -z 32 32     "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_32x32.png" >/dev/null
sips -z 64 64     "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_128x128.png" >/dev/null
sips -z 256 256   "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_256x256.png" >/dev/null
sips -z 512 512   "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SRC_PNG" --out "$ICON_TMP/Svorrent.iconset/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICON_TMP/Svorrent.iconset" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
rm -rf "$ICON_TMP"

echo "==> 4. Writing Info.plist..."
APP_VERSION="$(node -p "require('$ROOT_DIR/backend/package.json').version" 2>/dev/null || echo "1.0.5")"
SOURCE_COMMIT="${SVORRENT_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)}"
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    echo "A full source commit SHA is required for update checks." >&2
    exit 1
fi
cat << EOF > "$APP_BUNDLE/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Svorrent</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.sovopr.svorrent</string>
    <key>CFBundleName</key>
    <string>Svorrent</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${APP_VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

echo "==> 5. Compiling Native macOS Cocoa Launcher..."
"$CC" -isysroot "$SDK" -O2 -fobjc-arc -framework Cocoa \
    "$ROOT_DIR/scripts/launcher_mac.m" -o "$APP_BUNDLE/Contents/MacOS/Svorrent"
chmod +x "$APP_BUNDLE/Contents/MacOS/Svorrent"

echo "==> 6. Copying application assets..."
cp -R "$ROOT_DIR/frontend/dist"/* "$APP_BUNDLE/Contents/Resources/app/frontend/dist/"
cp -R "$ROOT_DIR/backend/server.js" "$APP_BUNDLE/Contents/Resources/app/backend/"
cp -R "$ROOT_DIR/backend/package.json" "$APP_BUNDLE/Contents/Resources/app/backend/"
printf '{"commit":"%s"}\n' "$SOURCE_COMMIT" > "$APP_BUNDLE/Contents/Resources/app/backend/build-info.json"
cp -R "$ROOT_DIR/backend/lib" "$APP_BUNDLE/Contents/Resources/app/backend/"
cp -R "$ROOT_DIR/backend/bin" "$APP_BUNDLE/Contents/Resources/app/backend/"
cp -f "$NATIVE_DIR/svorrent-tetherd" "$APP_BUNDLE/Contents/Resources/app/backend/bin/"
cp -a "$NATIVE_DIR"/libtetherkit*.dylib "$NATIVE_DIR"/libusb-*.dylib \
    "$APP_BUNDLE/Contents/Resources/app/backend/bin/"
cp -R "$ROOT_DIR/backend/scripts" "$APP_BUNDLE/Contents/Resources/app/backend/"
cp -R "$ROOT_DIR/backend/tether/licenses" "$APP_BUNDLE/Contents/Resources/app/backend/"
cp -R "$ROOT_DIR/backend/node_modules" "$APP_BUNDLE/Contents/Resources/app/backend/"

# Prune heavy unused databases (strip 104MB city-level GeoIP data; keep country data)
echo "==> 7. Pruning heavy offline city databases..."
rm -f "$APP_BUNDLE/Contents/Resources/app/backend/node_modules/geoip-lite/data/geoip-city"*

# Finder metadata copied from a developer checkout can make the app fail to
# copy out of the mounted DMG (Finder error -36). It is not application data.
find "$APP_BUNDLE" -type f \( -name '.DS_Store' -o -name '._*' \) -delete

# The bare Mach-O signature produced by clang does not seal Info.plist or the
# app's resources. Gatekeeper reports that downloaded bundle as "damaged".
# Sign embedded Mach-O code first, then seal the complete app bundle.
SIGN_IDENTITY="${SVORRENT_CODESIGN_IDENTITY:--}"
SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != '-' ]; then
    SIGN_ARGS+=(--options runtime --timestamp)
fi
while IFS= read -r -d '' code_file; do
    if file -b "$code_file" | grep -q 'Mach-O'; then
        codesign "${SIGN_ARGS[@]}" "$code_file"
    fi
done < <(find "$APP_BUNDLE/Contents/Resources/app/backend" -type f \
    \( -name '*.dylib' -o -name '*.node' -o -name '*.so' \) -print0)
codesign "${SIGN_ARGS[@]}" "$APP_BUNDLE/Contents/Resources/app/backend/bin/svorrent-tetherd"
codesign "${SIGN_ARGS[@]}" "$APP_BUNDLE"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

echo "==> 8. Creating DMG Staging with Applications shortcut..."
cp -R "$APP_BUNDLE" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

echo "==> 9. Generating lightweight compressed DMG installer (BitTorrent Web profile)..."
hdiutil create -volname "Svorrent" -srcfolder "$DMG_STAGING" -ov -fs HFS+ -format UDBZ "$DMG_OUTPUT"

rm -rf "$DMG_STAGING"

echo "==> Svorrent DMG created successfully:"
ls -lh "$DMG_OUTPUT"
