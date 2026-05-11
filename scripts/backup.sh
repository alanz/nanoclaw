#!/bin/bash
# Hourly backup: SQLite dumps + rsync mirror to local dir, then borg to BorgBase.
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

DEST_DIR="${NANOCLAW_V2_BACKUP_DIR:-$HOME/nanoclaw-v2-backups}"
mkdir -p "$DEST_DIR"

# Back up central DB via SQLite API (safe against WAL races)
sqlite3 "$PROJECT_ROOT/data/v2.db" ".backup '$DEST_DIR/v2.db'"
echo "Central DB backup complete: $DEST_DIR/v2.db"

# Back up each agent group's memory index.db via SQLite API (large embedding DBs)
for index_db in "$PROJECT_ROOT/data/v2-memory"/*/index.db; do
  [[ -f "$index_db" ]] || continue
  ag_id="$(basename "$(dirname "$index_db")")"
  mkdir -p "$DEST_DIR/v2-memory/$ag_id"
  sqlite3 "$index_db" ".backup '$DEST_DIR/v2-memory/$ag_id/index.db'"
  echo "Memory index backup complete: $ag_id/index.db"
done

# Back up session DBs (journal_mode=DELETE; rsync is safe when containers are idle)
if [[ -d "$PROJECT_ROOT/data/v2-sessions" ]]; then
  rsync -a --delete "$PROJECT_ROOT/data/v2-sessions/" "$DEST_DIR/v2-sessions/"
  echo "Session DBs backup complete: $DEST_DIR/v2-sessions/"
fi

# Back up groups/ (plain files — rsync mirror is sufficient)
rsync -a --delete "$PROJECT_ROOT/groups/" "$DEST_DIR/groups/"
echo "Groups backup complete: $DEST_DIR/groups/"

# Save list of .env variable names (no values) for reconstruction reference
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  grep -v '^\s*#' "$PROJECT_ROOT/.env" | grep '=' | cut -d= -f1 > "$DEST_DIR/env-vars.txt"
  echo "Env var list saved: $DEST_DIR/env-vars.txt"
fi

# Back up ~/.config/nanoclaw (mount allowlist, etc.)
CONFIG_SRC="$HOME/.config/nanoclaw/"
if [[ -d "$CONFIG_SRC" ]]; then
  rsync -a --delete "$CONFIG_SRC" "$DEST_DIR/config-nanoclaw/"
  echo "Config backup complete: $DEST_DIR/config-nanoclaw/"
fi

# Back up ~/.claude (settings, memory, plans, tasks, todos, plugins, credentials)
# Excludes ephemeral/regeneratable dirs to keep the archive small
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
  "$HOME/.claude/" "$DEST_DIR/claude/"
echo "Claude backup complete: $DEST_DIR/claude/"

# Ship local backup dir to BorgBase via borg
# Uses same BorgBase repo as v1, distinguished by archive prefix nanoclaw-v2-
BORG_REPO="ssh://o5eh77xl@o5eh77xl.repo.borgbase.com/./repo"
export BORG_PASSPHRASE
borg create \
  --compression lz4 \
  "$BORG_REPO::nanoclaw-v2-{now:%Y%m%d-%H%M%S}" \
  "$DEST_DIR"
echo "Borg backup complete"
