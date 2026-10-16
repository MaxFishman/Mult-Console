#!/bin/bash
#
# Mult Console — one-line installer for macOS.
#
# Downloads the latest release, installs it to /Applications, and removes the
# Gatekeeper quarantine flag so it opens with no warnings. The app is ad-hoc
# signed but not Apple-notarized, which is why this step is needed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MaxFishman/mult-console/main/install.sh | bash
#
set -euo pipefail

REPO="MaxFishman/mult-console"
APP="/Applications/Mult Console.app"

# Pick the right build for this Mac.
if [ "$(uname -m)" = "arm64" ]; then PATTERN="arm64"; else PATTERN="intel"; fi

echo "→ Finding the latest Mult Console ($PATTERN) release…"
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url" \
  | grep "$PATTERN" \
  | grep '\.dmg' \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "${URL:-}" ]; then
  echo "✗ Could not find a download URL. Check: https://github.com/$REPO/releases"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'hdiutil detach "$TMP/vol" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

echo "→ Downloading…"
curl -fL# "$URL" -o "$TMP/mc.dmg"

echo "→ Installing to /Applications…"
hdiutil attach "$TMP/mc.dmg" -nobrowse -mountpoint "$TMP/vol" >/dev/null
rm -rf "$APP"
cp -R "$TMP/vol/Mult Console.app" /Applications/
hdiutil detach "$TMP/vol" >/dev/null

echo "→ Clearing the quarantine flag…"
xattr -cr "$APP" 2>/dev/null || true

echo "✓ Installed. Opening Mult Console…"
open "$APP"
echo ""
echo "  Next: open the in-app Setup guide once to install AbletonOSC into Ableton."
