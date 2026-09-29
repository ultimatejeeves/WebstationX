#!/bin/bash
# (Re)create the WebStationX container on the Docker host. Safe to re-run after a rebuild.
# Lives at /mnt/user/appdata/webstationx/run.sh once deployed.
set -e
APPDATA="${WSX_APPDATA:-/mnt/user/appdata/webstationx}"
PORT="${WSX_PORT:-8090}"

docker network inspect wsxnet >/dev/null 2>&1 || docker network create wsxnet >/dev/null
docker rm -f webstationx >/dev/null 2>&1 || true

docker run -d --name webstationx \
  --network wsxnet \
  -p "${PORT}:8090" \
  -e WSX_PORT=8090 \
  -e WSX_TRUST_PROXY=1 \
  ${WSX_ICE_SERVERS:+-e WSX_ICE_SERVERS="$WSX_ICE_SERVERS"} \
  -v "$APPDATA/library:/app/library" \
  -v "$APPDATA/bios:/app/bios" \
  -v "$APPDATA/data:/app/data" \
  --restart unless-stopped \
  -l net.unraid.docker.managed=dockerman \
  -l net.unraid.docker.webui="http://[IP]:[PORT:8090]" \
  -l net.unraid.docker.icon="https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/playstation.png" \
  webstationx:latest >/dev/null

echo "webstationx running on port ${PORT}"
