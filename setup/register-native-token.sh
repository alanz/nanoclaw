#!/usr/bin/env bash
set -euo pipefail

# Register a Claude subscription OAuth token for the native credential proxy —
# writes CLAUDE_CODE_OAUTH_TOKEN to .env instead of the OneCLI vault.
#
# Same PTY capture flow as register-claude-token.sh; only the storage step
# differs. Use this when ONECLI_URL is not set and you're using the built-in
# credential proxy.

command -v claude >/dev/null 2>&1 || {
  echo "Claude Code CLI not found — installing it now (needed for subscription sign-in)…"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! bash "$SCRIPT_DIR/install-claude.sh"; then
    echo >&2
    echo "Couldn't install the Claude Code CLI automatically." >&2
    echo "Install it manually with" >&2
    echo "  curl -fsSL https://claude.ai/install.sh | bash" >&2
    echo "and re-run setup." >&2
    exit 1
  fi
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
}

command -v script >/dev/null \
  || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

cat <<'EOF'
A browser window will open for you to sign in with your Claude account.
When you finish, we'll save the token to .env automatically.

Press Enter to continue, or edit the command first.

EOF

cmd="claude setup-token"
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  read -r -e -i "$cmd" -p "$ " cmd </dev/tty
else
  echo "$ $cmd"
  read -r -p "Press Enter to run, Ctrl-C to abort. " _ </dev/tty
fi

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "$cmd" "$tmpfile"
else
  # shellcheck disable=SC2086
  script -q "$tmpfile" $cmd
fi

token=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpfile" \
        | tr -d '\n\r' \
        | perl -ne 'print "$1\n" while /(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g' \
        | tail -1 || true)

if [ -z "$token" ]; then
  keep=$(mktemp -t claude-setup-token-log.XXXXXX)
  cp "$tmpfile" "$keep"
  echo >&2
  echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
  exit 1
fi

echo
echo "Got token: ${token:0:16}…${token: -4}"
echo "Saving to .env as CLAUDE_CODE_OAUTH_TOKEN…"

ENV_FILE="${ENV_FILE:-.env}"
if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  # Update existing line (BSD-safe: write to temp then move)
  tmp_env=$(mktemp)
  sed "s/^CLAUDE_CODE_OAUTH_TOKEN=.*/CLAUDE_CODE_OAUTH_TOKEN=${token}/" "$ENV_FILE" > "$tmp_env"
  mv "$tmp_env" "$ENV_FILE"
else
  # Ensure file ends with newline before appending
  [ -s "$ENV_FILE" ] && [ "$(tail -c1 "$ENV_FILE" | wc -c)" -gt 0 ] \
    && echo "" >> "$ENV_FILE" || true
  echo "CLAUDE_CODE_OAUTH_TOKEN=${token}" >> "$ENV_FILE"
fi

echo "Done."
