#!/usr/bin/env bash
# Deploy WebStationX to an Unraid (or any Docker) host over SSH.
#
#   tools/deploy-unraid.sh                 # uses user@your-server and ~/.ssh/id_webstationx
#   WSX_HOST=user@your-server WSX_KEY=~/.ssh/id_ed25519 tools/deploy-unraid.sh
#
# Steps: upload the source tree (tracked + untracked, minus ignored files), sync library/ and
# bios/ into the appdata share, build the image on the host, and (re)create the container.
# Player data in appdata/webstationx/data is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${WSX_HOST:-user@your-server}"
KEY="${WSX_KEY:-$HOME/.ssh/id_webstationx}"
APPDATA="${WSX_APPDATA:-/mnt/user/appdata/webstationx}"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
SCP=(scp -q -i "$KEY")

echo "== Packaging source"
mkdir -p work
git ls-files -co --exclude-standard | grep -v '^library/\|^\.claude/' > work/deploy-files.txt
tar -czf work/webstationx-src.tgz -T work/deploy-files.txt

echo "== Uploading to $HOST:$APPDATA"
"${SSH[@]}" "mkdir -p $APPDATA/src $APPDATA/library $APPDATA/bios $APPDATA/data && rm -rf $APPDATA/src/*"
"${SCP[@]}" work/webstationx-src.tgz "$HOST:$APPDATA/src/"
"${SSH[@]}" "cd $APPDATA/src && tar -xzf webstationx-src.tgz && rm webstationx-src.tgz"
"${SCP[@]}" -r library/. "$HOST:$APPDATA/library/"
"${SCP[@]}" bios/*.BIN bios/*.bin "$HOST:$APPDATA/bios/" 2>/dev/null || true

echo "== Building image on host"
"${SSH[@]}" "cd $APPDATA/src && docker build -t webstationx:latest ."

echo "== Recreating container"
"${SCP[@]}" tools/unraid-run.sh "$HOST:$APPDATA/run.sh"
"${SSH[@]}" "chmod +x $APPDATA/run.sh && WSX_APPDATA=$APPDATA $APPDATA/run.sh"

echo "== Done. Health:"
"${SSH[@]}" "sleep 3; docker ps --filter name=webstationx --format '{{.Names}} {{.Status}} {{.Ports}}'; wget -qO- http://127.0.0.1:8090/api/session; echo"
