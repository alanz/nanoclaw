#!/bin/bash
# Hourly backup: SQLite dump + groups rsync to local dir, then borg to BorgBase.
# Runs via launchd (macOS) or systemd timer (Linux).

set -euo pipefail

# Ensure Homebrew binaries (sqlite3, rsync, borg) are available when run via launchd
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load BORG_PASSPHRASE and other config from .env
# shellcheck source=/dev/null
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a; source "$PROJECT_ROOT/.env"; set +a
fi
SOURCE="$PROJECT_ROOT/store/messages.db"
DEST_DIR="${NANOCLAW_BACKUP_DIR:-$HOME/nanoclaw-backups}"
DEST="$DEST_DIR/messages-$(date +%Y%m%d-%H%M%S).db"

mkdir -p "$DEST_DIR"

sqlite3 "$SOURCE" ".backup '$DEST'"

# Delete backups older than 7 days
find "$DEST_DIR" -name "messages-*.db" -mtime +7 -delete

echo "Backup complete: $DEST"

# Back up embeddings.db via SQLite API (safe against WAL races, 1.2 GB file)
EMBEDDINGS_SRC="$PROJECT_ROOT/store/main/embeddings.db"
EMBEDDINGS_DEST="$DEST_DIR/embeddings.db"
if [[ -f "$EMBEDDINGS_SRC" ]]; then
  sqlite3 "$EMBEDDINGS_SRC" ".backup '$EMBEDDINGS_DEST'"
  echo "Embeddings backup complete: $EMBEDDINGS_DEST"
else
  echo "WARNING: embeddings.db not found at expected path: $EMBEDDINGS_SRC" >&2
  echo "WARNING: embeddings.db may have moved or been deleted — update backup-db.sh if intentional" >&2
fi

# Back up groups/ (plain files — rsync mirror is sufficient)
GROUPS_SRC="$PROJECT_ROOT/groups/"
GROUPS_DEST="$DEST_DIR/groups/"
rsync -a --delete "$GROUPS_SRC" "$GROUPS_DEST"
echo "Groups backup complete: $GROUPS_DEST"

# Save list of .env variable names (no values) for reconstruction reference
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  grep -v '^\s*#' "$PROJECT_ROOT/.env" | grep '=' | cut -d= -f1 > "$DEST_DIR/env-vars.txt"
  echo "Env var list saved: $DEST_DIR/env-vars.txt"
fi

# Back up ~/.config/nanoclaw (mount allowlist, etc.)
CONFIG_SRC="$HOME/.config/nanoclaw/"
CONFIG_DEST="$DEST_DIR/config-nanoclaw/"
rsync -a --delete "$CONFIG_SRC" "$CONFIG_DEST"
echo "Config backup complete: $CONFIG_DEST"

# Back up ~/.claude (settings, memory, plans, tasks, todos, plugins, credentials)
# Excludes ephemeral/regeneratable dirs to keep the archive small
CLAUDE_SRC="$HOME/.claude/"
CLAUDE_DEST="$DEST_DIR/claude/"
rsync -a --delete \
  --exclude="cache/" \
  --exclude="debug/" \
  --exclude="file-history/" \
  --exclude="paste-cache/" \
  --exclude="session-env/" \
  --exclude="shell-snapshots/" \
  --exclude="sessions/" \
  --exclude="backups/" \
  --exclude="history.jsonl" \
  --exclude="mcp-needs-auth-cache.json" \
  --exclude="stats-cache.json" \
  "$CLAUDE_SRC" "$CLAUDE_DEST"
echo "Claude backup complete: $CLAUDE_DEST"

# Ship local backup dir to BorgBase via borg
BORG_REPO="ssh://o5eh77xl@o5eh77xl.repo.borgbase.com/./repo"
export BORG_PASSPHRASE
borg create \
  --compression lz4 \
  "$BORG_REPO::nanoclaw-{now:%Y%m%d-%H%M%S}" \
  "$DEST_DIR"
echo "Borg backup complete"
