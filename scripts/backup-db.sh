#!/bin/bash
# Safe online backup of messages.db using SQLite's built-in backup API.
# Runs hourly via launchd (macOS) or systemd timer (Linux); keeps 7 days of rolling snapshots.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$PROJECT_ROOT/store/messages.db"
DEST_DIR="${NANOCLAW_BACKUP_DIR:-$HOME/nanoclaw-backups}"
DEST="$DEST_DIR/messages-$(date +%Y%m%d-%H%M%S).db"

mkdir -p "$DEST_DIR"

sqlite3 "$SOURCE" ".backup '$DEST'"

# Delete backups older than 7 days
find "$DEST_DIR" -name "messages-*.db" -mtime +7 -delete

echo "Backup complete: $DEST"
