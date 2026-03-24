#!/bin/bash
# Start OneCLI using Apple Container (postgres + onecli app).
# Container IPs are on the 192.168.64.x bridge network.
# ONECLI_URL in .env is updated with the real container IP on each start.
#
# Usage: ./start-onecli.sh [start|stop|status|logs]

set -euo pipefail

RUNTIME="${CONTAINER_RUNTIME:-container}"
PG_CONTAINER="onecli-postgres"
APP_CONTAINER="onecli-app"
DATA_DIR="${HOME}/.local/share/onecli"
ONECLI_ENV="${DATA_DIR}/onecli.env"
ENV_FILE="$(dirname "$0")/.env"
RELAY_PID_FILE="${DATA_DIR}/relay.pid"
# Local relay port: Node.js (NanoClaw) can't reach 192.168.64.x bridge IPs
# directly due to a libuv/macOS interaction. socat relays localhost → container.
RELAY_PORT=10264

usage() {
  echo "Usage: $0 [start|stop|status|logs]"
  exit 1
}

# Get the bridge IP for a running container by name
get_container_ip() {
  "$RUNTIME" ls --format json 2>/dev/null | python3 -c "
import sys, json
name = '$1'
for c in json.load(sys.stdin):
    if c.get('configuration', {}).get('id') == name:
        nets = c.get('networks', [])
        if nets:
            print(nets[0]['ipv4Address'].split('/')[0])
            break
"
}

is_running() {
  "$RUNTIME" ls --format json 2>/dev/null | python3 -c "
import sys, json
name = '$1'
cs = [c for c in json.load(sys.stdin)
      if c.get('status') == 'running' and c.get('configuration', {}).get('id') == name]
sys.exit(0 if cs else 1)
" 2>/dev/null
}

cmd="${1:-start}"

case "$cmd" in
  stop)
    echo "Stopping OneCLI..."
    "$RUNTIME" stop "$APP_CONTAINER" 2>/dev/null && echo "  stopped $APP_CONTAINER" || true
    "$RUNTIME" stop "$PG_CONTAINER"  2>/dev/null && echo "  stopped $PG_CONTAINER"  || true
    if [ -f "$RELAY_PID_FILE" ]; then
      kill "$(cat "$RELAY_PID_FILE")" 2>/dev/null && echo "  stopped socat relay" || true
      rm -f "$RELAY_PID_FILE"
    fi
    tailscale serve --https=8444 off 2>/dev/null && echo "  removed Tailscale Serve :8444" || true
    exit 0
    ;;
  status)
    "$RUNTIME" ls --format json 2>/dev/null | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    name = c.get('configuration', {}).get('id', '')
    if 'onecli' in name:
        nets = c.get('networks', [])
        ip = nets[0]['ipv4Address'].split('/')[0] if nets else 'no-ip'
        print(f\"{c['status']:10} {name:30} {ip}\")
" || echo "No OneCLI containers running"
    exit 0
    ;;
  logs)
    "$RUNTIME" logs -f "$APP_CONTAINER"
    exit 0
    ;;
  start) ;;
  *) usage ;;
esac

# --- start ---

if ! "$RUNTIME" system status &>/dev/null; then
  echo "Starting container runtime..."
  "$RUNTIME" system start
fi

mkdir -p "$DATA_DIR"

# Generate encryption keys on first run
if [ ! -f "$ONECLI_ENV" ]; then
  echo "Generating OneCLI secrets (first run)..."
  # base64(32 random bytes) = key that decodes to exactly 32 bytes, as OneCLI expects
  printf 'SECRET_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" > "$ONECLI_ENV"
  printf 'NEXTAUTH_SECRET=%s\n'       "$(openssl rand -base64 32)" >> "$ONECLI_ENV"
  echo "  Saved to $ONECLI_ENV"
fi

# Read generated secrets (use sed not cut — base64 values contain '=' padding)
SECRET_ENCRYPTION_KEY=$(grep '^SECRET_ENCRYPTION_KEY=' "$ONECLI_ENV" | sed 's/^SECRET_ENCRYPTION_KEY=//')
NEXTAUTH_SECRET=$(grep '^NEXTAUTH_SECRET=' "$ONECLI_ENV" | sed 's/^NEXTAUTH_SECRET=//')

# Start postgres (no volume mount — Apple Container bind mounts block chmod/chown;
# container VM disk is persistent as long as the container is not removed)
if is_running "$PG_CONTAINER"; then
  echo "postgres already running"
else
  echo "Starting postgres..."
  "$RUNTIME" run -d \
    --name "$PG_CONTAINER" \
    -e POSTGRES_USER=onecli \
    -e POSTGRES_PASSWORD=onecli \
    -e POSTGRES_DB=onecli \
    postgres:17-alpine
fi

# Wait for postgres to get a bridge IP and accept connections
echo -n "Waiting for postgres"
POSTGRES_IP=""
for i in $(seq 1 30); do
  POSTGRES_IP=$(get_container_ip "$PG_CONTAINER")
  if [ -n "$POSTGRES_IP" ]; then
    # Check if postgres is actually ready
    if "$RUNTIME" exec "$PG_CONTAINER" pg_isready -U onecli -q 2>/dev/null; then
      echo " ready at $POSTGRES_IP"
      break
    fi
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo " TIMEOUT"
    echo "ERROR: postgres did not start. Check: $RUNTIME logs $PG_CONTAINER"
    exit 1
  fi
done

# Start OneCLI app, pointing at postgres via its bridge IP
if is_running "$APP_CONTAINER"; then
  echo "onecli-app already running"
else
  echo "Starting OneCLI app (connecting to postgres at $POSTGRES_IP)..."
  "$RUNTIME" run -d \
    --name "$APP_CONTAINER" \
    -e "DATABASE_URL=postgresql://onecli:onecli@${POSTGRES_IP}:5432/onecli" \
    -e "SECRET_ENCRYPTION_KEY=${SECRET_ENCRYPTION_KEY}" \
    -e "NEXTAUTH_SECRET=${NEXTAUTH_SECRET}" \
    ghcr.io/onecli/onecli:latest
fi

# Wait for OneCLI to get a bridge IP and serve HTTP
echo -n "Waiting for OneCLI app"
ONECLI_IP=""
for i in $(seq 1 60); do
  ONECLI_IP=$(get_container_ip "$APP_CONTAINER")
  if [ -n "$ONECLI_IP" ]; then
    if curl -sf "http://${ONECLI_IP}:10254" -o /dev/null 2>/dev/null; then
      echo " ready at $ONECLI_IP"
      break
    fi
  fi
  echo -n "."
  sleep 2
  if [ "$i" -eq 60 ]; then
    echo " TIMEOUT"
    echo "ERROR: OneCLI did not start. Check: $RUNTIME logs $APP_CONTAINER"
    exit 1
  fi
done

# Start socat relay: NanoClaw's Node.js process can't reach 192.168.64.x bridge
# IPs directly (libuv/macOS bridge network issue). socat relays localhost → container.
if [ -f "$RELAY_PID_FILE" ]; then
  kill "$(cat "$RELAY_PID_FILE")" 2>/dev/null || true
  rm -f "$RELAY_PID_FILE"
fi
socat TCP-LISTEN:${RELAY_PORT},bind=127.0.0.1,fork,reuseaddr \
  TCP:${ONECLI_IP}:10254 &
echo $! > "$RELAY_PID_FILE"
echo "socat relay started: 127.0.0.1:${RELAY_PORT} → ${ONECLI_IP}:10254 (pid $(cat "$RELAY_PID_FILE"))"

# Update ONECLI_URL (relay for Node.js) and ONECLI_GATEWAY_HOST (real container IP
# for injecting into agent containers, which CAN reach the bridge network directly).
if [ -f "$ENV_FILE" ]; then
  if grep -q '^ONECLI_URL=' "$ENV_FILE"; then
    sed -i '' "s|^ONECLI_URL=.*|ONECLI_URL=http://127.0.0.1:${RELAY_PORT}|" "$ENV_FILE"
  else
    echo "ONECLI_URL=http://127.0.0.1:${RELAY_PORT}" >> "$ENV_FILE"
  fi
  if grep -q '^ONECLI_GATEWAY_HOST=' "$ENV_FILE"; then
    sed -i '' "s|^ONECLI_GATEWAY_HOST=.*|ONECLI_GATEWAY_HOST=${ONECLI_IP}|" "$ENV_FILE"
  else
    echo "ONECLI_GATEWAY_HOST=${ONECLI_IP}" >> "$ENV_FILE"
  fi
  echo "Updated .env: ONECLI_URL=http://127.0.0.1:${RELAY_PORT}, ONECLI_GATEWAY_HOST=${ONECLI_IP}"
fi

# Add (or update) Tailscale Serve entry for the OneCLI dashboard
# Uses port 8444 alongside the existing NanoClaw web UI on 8443
if command -v tailscale &>/dev/null; then
  tailscale serve --https=8444 --bg "http://${ONECLI_IP}:10254" 2>/dev/null && \
    echo "Tailscale Serve: https://$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','?').rstrip('.'))" 2>/dev/null):8444 → OneCLI dashboard"
fi

echo ""
echo "OneCLI is running:"
echo "  Container:  http://${ONECLI_IP}:10254"
echo "  Local relay:http://127.0.0.1:${RELAY_PORT} (NanoClaw connects here)"
echo "  Tailscale:  https://$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','?').rstrip('.'))" 2>/dev/null):8444"
echo "  Gateway:    http://${ONECLI_IP}:10255"
echo ""
echo "Next: open the dashboard, create an API key, then:"
echo "  ~/.local/bin/onecli auth login --api-key <oc_...>"
echo "  ~/.local/bin/onecli secrets create --name Anthropic --type anthropic --value <sk-ant-...> --host-pattern '*.anthropic.com'"
