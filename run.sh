#!/usr/bin/env bash
# Serve the project locally and open the game. Usage: ./run.sh [port]
# The server listens on all interfaces, so a phone on the same Wi-Fi can open the printed LAN address.
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"

echo "Another World"
echo "  this computer : http://localhost:$PORT/"
for ip in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
  echo "  phone (Wi-Fi) : http://$ip:$PORT/"
done
echo "(Ctrl+C to stop)"

(sleep 1; xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 || true) &
exec python3 -m http.server "$PORT" --bind 0.0.0.0
