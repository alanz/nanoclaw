#!/bin/bash
# Install or refresh the host watchdog LaunchDaemon (see scripts/host-watchdog.sh).
# Run with sudo. Copies the script to a root-owned path so the root daemon never
# executes anything from the user-writable checkout.
#
#   sudo bash scripts/install-host-watchdog.sh            # install / refresh
#   sudo bash scripts/install-host-watchdog.sh --uninstall

set -euo pipefail

LABEL=com.nanoclaw.v2.host-watchdog
LIBEXEC=/usr/local/libexec/nanoclaw
PLIST=/Library/LaunchDaemons/$LABEL.plist
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $(id -u) -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0 $*" >&2
  exit 1
fi

launchctl bootout "system/$LABEL" 2>/dev/null || true

if [[ ${1:-} == --uninstall ]]; then
  rm -f "$PLIST" "$LIBEXEC/host-watchdog.sh"
  echo "Removed $LABEL (logs and samples left in /Library/Logs/NanoClaw)"
  exit 0
fi

install -d -o root -g wheel -m 755 "$LIBEXEC" /Library/Logs/NanoClaw
install -o root -g wheel -m 755 "$PROJECT_ROOT/scripts/host-watchdog.sh" "$LIBEXEC/host-watchdog.sh"
install -o root -g wheel -m 644 "$PROJECT_ROOT/launchd/$LABEL.plist" "$PLIST"
launchctl bootstrap system "$PLIST"
echo "Installed $LABEL — log: /Library/Logs/NanoClaw/host-watchdog.log, samples: /Library/Logs/NanoClaw/memory-samples.tsv"
