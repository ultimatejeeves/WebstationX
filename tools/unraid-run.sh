#!/usr/bin/env bash
# Run on Unraid after building webstationx:latest. Keep the previous container for rollback.
set -euo pipefail
APPDATA="${WSX_APPDATA:-/mnt/user/appdata/webstationx}"
PORT="${WSX_PORT:-8090}"
mkdir -p "$APPDATA/Games/psx" "$APPDATA/Games/ps2" "$APPDATA/library" "$APPDATA/bios" "$APPDATA/data"
docker network inspect wsxnet >/dev/null 2>&1 || docker network create wsxnet >/dev/null
if docker container inspect webstationx-previous >/dev/null 2>&1; then
  echo 'A previous rollback container already exists. Resolve it before redeploying.' >&2
  exit 1
fi
had_previous=0
if docker container inspect webstationx >/dev/null 2>&1; then
  docker stop webstationx >/dev/null
  docker rename webstationx webstationx-previous
  had_previous=1
fi
rollback() {
  docker rm -f webstationx >/dev/null 2>&1 || true
  if [[ "$had_previous" == 1 ]]; then
    docker rename webstationx-previous webstationx
    docker start webstationx >/dev/null
  fi
  echo 'Deployment failed; the previous container was restored when available.' >&2
}
trap rollback ERR
ENV_ARGS=(-e WSX_PORT=8090 -e WSX_TRUST_PROXY="${WSX_TRUST_PROXY:-1}")
if [[ -n "${WSX_ICE_SERVERS:-}" ]]; then ENV_ARGS+=(-e "WSX_ICE_SERVERS=$WSX_ICE_SERVERS"); fi
docker run -d --name webstationx --network wsxnet \
  --user "${WSX_UID:-0}:${WSX_GID:-0}" \
  --security-opt no-new-privileges:true --cap-drop ALL \
  -p "${PORT}:8090" "${ENV_ARGS[@]}" \
  -v "$APPDATA/Games:/app/Games" \
  -v "$APPDATA/library:/app/library:ro" \
  -v "$APPDATA/bios:/app/bios:ro" \
  -v "$APPDATA/data:/app/data" \
  --restart unless-stopped \
  -l net.unraid.docker.managed=dockerman \
  -l net.unraid.docker.webui='http://[IP]:[PORT:8090]' \
  webstationx:latest >/dev/null
for attempt in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' webstationx)
  if [[ "$status" == healthy ]]; then
    trap - ERR
    if [[ "$had_previous" == 1 ]]; then docker rm webstationx-previous >/dev/null; fi
    echo "WebStationX is healthy on port $PORT."
    exit 0
  fi
  sleep 2
done
false
