#!/bin/bash
# Build the NanoClaw Todo WebXDC app.
# Packages apps/todo-app/ into assets/todo.xdc (a zip file).
# Run via: npm run build:todo-xdc

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../apps/todo-app"
ASSETS="$SCRIPT_DIR/../assets"
OUTPUT="$ASSETS/todo.xdc"

if ! command -v zip &>/dev/null; then
  echo "Error: 'zip' not found. Install it (e.g. brew install zip) and retry." >&2
  exit 1
fi

mkdir -p "$ASSETS"

echo "Building Todo WebXDC app..."
echo "  Source: $SRC"
echo "  Output: $OUTPUT"

# -j: junk paths (store filenames only, not directory structure)
(cd "$SRC" && zip -j "$OUTPUT" index.html manifest.toml)

echo "Done: $OUTPUT ($(du -sh "$OUTPUT" | cut -f1))"
