#!/bin/bash
# Build the NanoClaw WebXDC chat surface app.
# Packages webxdc-src/ into assets/nanoclaw.xdc (a zip file).
# Run via: npm run build:webxdc

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../webxdc-src"
ASSETS="$SCRIPT_DIR/../assets"
OUTPUT="$ASSETS/nanoclaw.xdc"

if ! command -v zip &>/dev/null; then
  echo "Error: 'zip' not found. Install it (e.g. brew install zip) and retry." >&2
  exit 1
fi

echo "Building NanoClaw WebXDC app..."
echo "  Source: $SRC"
echo "  Output: $OUTPUT"

# -j: junk paths (store filenames only, not directory structure)
(cd "$SRC" && zip -j "$OUTPUT" index.html manifest.toml icon.png marked.min.js)

echo "Done: $OUTPUT ($(du -sh "$OUTPUT" | cut -f1))"
