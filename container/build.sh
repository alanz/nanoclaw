#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Apple Container (>=0.11.0) archives the entire build context before applying
# .dockerignore rules, causing "unable to write data to the archive" on large
# node_modules directories. Work around by temporarily moving it out.
NM_DIR="$SCRIPT_DIR/agent-runner/node_modules"
NM_STASH="/tmp/nanoclaw-build-nm-stash-$$"
if [ -d "$NM_DIR" ]; then
  mv "$NM_DIR" "$NM_STASH"
  trap 'mv "$NM_STASH" "$NM_DIR" 2>/dev/null; exit' EXIT INT TERM
fi

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

if [ -d "$NM_STASH" ]; then
  mv "$NM_STASH" "$NM_DIR"
  trap - EXIT INT TERM
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
