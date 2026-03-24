#!/bin/bash
# TCP relay for the OneCLI gateway.
# Managed by launchd (com.nanoclaw.socat) with KeepAlive=true.
# start-onecli.sh writes ONECLI_GATEWAY_HOST to .env, then kicks this agent.
#
# Python sockets, socat, and Node.js/libuv all get EHOSTUNREACH on 192.168.64.x
# from launchd (Apple Container bridge network restriction). curl is unaffected.
# This relay accepts TCP connections and uses curl to forward each HTTP request.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
RELAY_PORT=10264

GATEWAY_HOST=$(grep '^ONECLI_GATEWAY_HOST=' "$ENV_FILE" 2>/dev/null | sed 's/^ONECLI_GATEWAY_HOST=//')

if [ -z "$GATEWAY_HOST" ]; then
  echo "ONECLI_GATEWAY_HOST not set in .env — OneCLI not started yet?" >&2
  exit 1
fi

echo "relay: 127.0.0.1:${RELAY_PORT} → ${GATEWAY_HOST}:10254"

# Python HTTP proxy that uses curl subprocesses for outbound requests.
# curl reaches 192.168.64.x from launchd; raw sockets do not.
exec python3 - "$GATEWAY_HOST" "$RELAY_PORT" <<'PYEOF'
import sys, socket, threading, subprocess, re, os

target_host = sys.argv[1]
listen_port = int(sys.argv[2])
target_port = 10254
target_base = f"http://{target_host}:{target_port}"

def recv_until(sock, delimiter=b"\r\n\r\n"):
    buf = b""
    while delimiter not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    return buf

def handle(client):
    try:
        raw = recv_until(client)
        if not raw:
            client.close()
            return
        # Parse request line and headers
        header_part, _, body_start = raw.partition(b"\r\n\r\n")
        lines = header_part.split(b"\r\n")
        request_line = lines[0].decode(errors="replace")
        method, path, _ = request_line.split(" ", 2)
        headers = {}
        for line in lines[1:]:
            if b":" in line:
                k, _, v = line.partition(b":")
                headers[k.strip().decode(errors="replace").lower()] = v.strip().decode(errors="replace")
        # Read body if Content-Length present
        body = body_start
        content_length = int(headers.get("content-length", 0))
        while len(body) < content_length:
            chunk = client.recv(content_length - len(body))
            if not chunk:
                break
            body += chunk
        url = f"{target_base}{path}"
        cmd = ["curl", "-si", "--max-time", "30", "-X", method, url]
        for k, v in headers.items():
            if k in ("host", "content-length", "transfer-encoding"):
                continue
            cmd += ["-H", f"{k}: {v}"]
        if body:
            cmd += ["--data-binary", "@-"]
        proc = subprocess.run(cmd, input=body, capture_output=True)
        # curl -si decodes chunked bodies; fix up headers to match
        resp = proc.stdout
        sep = resp.find(b"\r\n\r\n")
        if sep != -1:
            hdr_block = resp[:sep]
            body = resp[sep+4:]
            hdr_lines = [l for l in hdr_block.split(b"\r\n")
                         if not l.lower().startswith(b"transfer-encoding")
                         and not l.lower().startswith(b"content-length")]
            hdr_lines.append(f"Content-Length: {len(body)}".encode())
            hdr_lines.append(b"Connection: close")
            resp = b"\r\n".join(hdr_lines) + b"\r\n\r\n" + body
        client.sendall(resp)
        client.shutdown(socket.SHUT_WR)
    except Exception as e:
        print(f"handle error: {e}", flush=True)
    finally:
        try: client.close()
        except Exception: pass

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", listen_port))
server.listen(64)
print(f"listening on 127.0.0.1:{listen_port}", flush=True)
import signal
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    try:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()
    except Exception:
        break
PYEOF
