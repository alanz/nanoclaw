#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

NM_DIR="$SCRIPT_DIR/agent-runner/node_modules"
NM_STASH="/tmp/nanoclaw-build-nm-stash-$$"

cleanup() {
  [ -d "$NM_STASH" ] && mv "$NM_STASH" "$NM_DIR" 2>/dev/null
  [ "$CONTAINER_RUNTIME" = "container" ] && container builder stop
}
trap cleanup EXIT

if [ "$CONTAINER_RUNTIME" = "container" ]; then
    container builder status 2>/dev/null | grep -q "running" || container builder start
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Apple Container (>=0.11.0) archives the entire build context before applying
# .dockerignore rules, causing "unable to write data to the archive" on large
# node_modules directories. Work around by temporarily moving it out.
if [ -d "$NM_DIR" ]; then
  mv "$NM_DIR" "$NM_STASH"
fi

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
