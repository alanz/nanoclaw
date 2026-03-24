#!/bin/bash
# Runs the socat relay for the OneCLI gateway.
# Managed by launchd (com.nanoclaw.socat) with KeepAlive=true.
# start-onecli.sh writes ONECLI_GATEWAY_HOST to .env, then kicks this agent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
RELAY_PORT=10264

GATEWAY_HOST=$(grep '^ONECLI_GATEWAY_HOST=' "$ENV_FILE" 2>/dev/null | sed 's/^ONECLI_GATEWAY_HOST=//')

if [ -z "$GATEWAY_HOST" ]; then
  echo "ONECLI_GATEWAY_HOST not set in .env — OneCLI not started yet?" >&2
  exit 1
fi

echo "socat relay: 127.0.0.1:${RELAY_PORT} → ${GATEWAY_HOST}:10254"
exec /opt/homebrew/bin/socat \
  TCP-LISTEN:${RELAY_PORT},bind=127.0.0.1,fork,reuseaddr \
  TCP:${GATEWAY_HOST}:10254
