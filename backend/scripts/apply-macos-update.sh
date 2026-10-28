#!/usr/bin/env bash
set -euo pipefail

DMG="${1:?missing DMG}"
DIGEST="${2:?missing digest}"
VERSION="${3:?missing version}"
TARGET="${4:?missing installed app path}"

if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
   [[ "$TARGET" != /Applications/Svorrent.app ]]; then
    echo 'Invalid macOS update parameters' >&2
    exit 1
fi

MOUNT="$(mktemp -d "${TMPDIR:-/tmp}/svorrent-update-mount.XXXXXX")"
STAGE="$(mktemp -d /Applications/.Svorrent-update.XXXXXX)"
BACKUP="${STAGE}/Svorrent-old.app"
MOUNTED=0
SWAPPED=0

cleanup() {
    result=$?
    trap - EXIT
    if [ "$result" -ne 0 ]; then
        osascript -e 'tell application id "com.sovopr.svorrent" to quit' >/dev/null 2>&1 || true
        if [ "$SWAPPED" -eq 1 ]; then
            echo 'Update failed; restoring previous Svorrent.app' >&2
            rm -rf "$TARGET"
            if ! mv "$BACKUP" "$TARGET"; then
                echo "Could not restore app automatically; backup is at $BACKUP" >&2
                exit "$result"
            fi
        fi
    fi
    if [ "$MOUNTED" -eq 1 ]; then hdiutil detach -quiet "$MOUNT" || true; fi
    rm -rf "$MOUNT" "$STAGE"
    if [ "$result" -ne 0 ]; then
        sleep 1
        open "$TARGET" || true
    fi
    exit "$result"
}
trap cleanup EXIT

actual="$(shasum -a 256 "$DMG" | awk '{print $1}')"
if [ "sha256:${actual}" != "$DIGEST" ]; then
    echo 'Downloaded DMG checksum does not match GitHub asset digest' >&2
    exit 1
fi
hdiutil verify "$DMG" >/dev/null
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$DMG"
MOUNTED=1
SOURCE="$MOUNT/Svorrent.app"
test -d "$SOURCE"
test -f "$SOURCE/Contents/Resources/app/backend/package.json"
codesign --verify --deep --strict "$SOURCE"
ditto "$SOURCE" "$STAGE/Svorrent.app"
xattr -cr "$STAGE/Svorrent.app" 2>/dev/null || true
codesign --verify --deep --strict "$STAGE/Svorrent.app"

# The launcher owns the old backend. Wait for both to exit before replacement.
osascript -e 'tell application id "com.sovopr.svorrent" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do
    if ! lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 &&
       ! pgrep -f "$TARGET/Contents/MacOS/Svorrent" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done
if lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
    echo 'Old Svorrent backend did not stop; leaving installation untouched' >&2
    exit 1
fi

mv "$TARGET" "$BACKUP"
SWAPPED=1
mv "$STAGE/Svorrent.app" "$TARGET"
sleep 1
open "$TARGET" || open -n "$TARGET"
for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 http://localhost:3001/api/updater/status 2>/dev/null |
       grep -Fq "\"currentVersion\":\"${VERSION}\""; then
        echo "Svorrent v${VERSION} installed and running"
        rm -rf "$BACKUP"
        SWAPPED=0
        exit 0
    fi
    sleep 0.5
done
echo 'New Svorrent backend did not start with expected version' >&2
exit 1
