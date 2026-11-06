#!/usr/bin/env bash
set -e

# ==============================================================================
# Svorrent Windows .exe Installer & Portable Package Builder
# Produces:
#  1. Svorrent-Setup.exe (Nullsoft NSIS Modern Installer with LZMA compression)
#  2. Svorrent-Windows-x64-Portable.zip (Standalone portable distribution)
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$ROOT_DIR/scripts"
BUILD_DIR="$ROOT_DIR/dist-win"
STAGING_DIR="$BUILD_DIR/staging"
CACHE_DIR="$SCRIPTS_DIR/cache"

mkdir -p "$CACHE_DIR"

echo "==> 1. Building React frontend..."
cd "$ROOT_DIR/frontend"
npm run build

echo "==> 2. Preparing staging directories..."
rm -rf "$BUILD_DIR"
mkdir -p "$STAGING_DIR/backend"
mkdir -p "$STAGING_DIR/frontend/dist"

PYTHON_BIN="python3"
if [ -x "/usr/bin/python3" ] && /usr/bin/python3 -c "import PIL" 2>/dev/null; then
    PYTHON_BIN="/usr/bin/python3"
fi

if "$PYTHON_BIN" -c "import PIL" 2>/dev/null; then
    "$PYTHON_BIN" - << EOF
import subprocess
from PIL import Image

subprocess.run(["qlmanage", "-t", "-s", "1024", "-o", "/tmp", "$ROOT_DIR/frontend/public/favicon.svg"], capture_output=True)
img = Image.open("/tmp/favicon.svg.png").convert("RGBA")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save("$BUILD_DIR/svorrent.ico", format="ICO", sizes=sizes)
img.save("$STAGING_DIR/svorrent.ico", format="ICO", sizes=sizes)
print("Generated svorrent.ico with sizes:", sizes)
EOF
else
    cp "$ROOT_DIR/frontend/public/favicon.ico" "$BUILD_DIR/svorrent.ico"
    cp "$ROOT_DIR/frontend/public/favicon.ico" "$STAGING_DIR/svorrent.ico"
    echo "Using existing favicon.ico as svorrent.ico"
fi

echo "==> 4. Ensuring Windows x64 native binary for node-datachannel..."
WIN_NODE_DATACHANNEL="$CACHE_DIR/node_datachannel_win32_x64.node"
if [ ! -f "$WIN_NODE_DATACHANNEL" ]; then
    echo "Downloading node-datachannel win32-x64 prebuild..."
    curl -s -L "https://github.com/murat-dogan/node-datachannel/releases/download/v0.32.3/node-datachannel-v0.32.3-napi-v8-win32-x64.tar.gz" -o "/tmp/node_datachannel_win.tar.gz"
    tar -xzf "/tmp/node_datachannel_win.tar.gz" -C "/tmp"
    mv "/tmp/build/Release/node_datachannel.node" "$WIN_NODE_DATACHANNEL"
    rm -rf "/tmp/build" "/tmp/node_datachannel_win.tar.gz"
fi

echo "==> 4b. Bundling standalone Windows node.exe runtime..."
WIN_NODE_EXE="$CACHE_DIR/node-v22.12.0-win-x64.exe"
if [ ! -f "$WIN_NODE_EXE" ]; then
    echo "Downloading official standalone Node.js win-x64 binary (v22.12.0)..."
    curl -s -L "https://nodejs.org/dist/v22.12.0/win-x64/node.exe" -o "$WIN_NODE_EXE"
fi
cp "$WIN_NODE_EXE" "$STAGING_DIR/node.exe"

echo "==> 5. Compiling Windows Win32 native launcher (Svorrent.exe)..."
cp "$SCRIPTS_DIR/manifest.xml" "$BUILD_DIR/manifest.xml"
cp "$SCRIPTS_DIR/launcher.rc" "$BUILD_DIR/launcher.rc"

cd "$BUILD_DIR"
x86_64-w64-mingw32-windres launcher.rc -O coff -o launcher.res
x86_64-w64-mingw32-gcc "$SCRIPTS_DIR/launcher.c" launcher.res -o "$STAGING_DIR/Svorrent.exe" -mwindows -O2 -lws2_32 -lshell32
rm -f launcher.res launcher.rc manifest.xml

echo "==> 6. Copying application assets into staging..."
cp -R "$ROOT_DIR/frontend/dist"/* "$STAGING_DIR/frontend/dist/"
cp -R "$ROOT_DIR/backend/server.js" "$STAGING_DIR/backend/"
cp -R "$ROOT_DIR/backend/package.json" "$STAGING_DIR/backend/"
cp -R "$ROOT_DIR/backend/lib" "$STAGING_DIR/backend/"
cp -R "$ROOT_DIR/backend/node_modules" "$STAGING_DIR/backend/"

echo "==> 7. Pruning heavy city databases..."
rm -f "$STAGING_DIR/backend/node_modules/geoip-lite/data/geoip-city"*

echo "==> 8. Injecting Windows x64 native bindings..."
mkdir -p "$STAGING_DIR/backend/node_modules/node-datachannel/build/Release"
cp "$WIN_NODE_DATACHANNEL" "$STAGING_DIR/backend/node_modules/node-datachannel/build/Release/node_datachannel.node"

echo "==> 9. Compiling NSIS Windows Installer (Svorrent-Setup.exe)..."
cp "$SCRIPTS_DIR/installer.nsi" "$BUILD_DIR/installer.nsi"
cd "$BUILD_DIR"
APP_VERSION="$(node -p "require('$ROOT_DIR/backend/package.json').version")"
makensis "/DSVORRENT_VERSION=$APP_VERSION" installer.nsi
rm -f "$BUILD_DIR/installer.nsi"

echo "==> 10. Generating Portable Windows ZIP (Svorrent-Windows-x64-Portable.zip)..."
cd "$STAGING_DIR"
zip -q -r -9 "$BUILD_DIR/Svorrent-Windows-x64-Portable.zip" .

echo ""
echo "=============================================================================="
echo "Svorrent Windows build complete:"
ls -lh "$BUILD_DIR/Svorrent-Setup.exe" "$BUILD_DIR/Svorrent-Windows-x64-Portable.zip"
echo "=============================================================================="
