#!/usr/bin/env bash
# Upload committed source and rebuild without copying personal games, BIOS, or saves.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WSX_HOST:?Set WSX_HOST to your SSH destination (for example user@server)}"
APPDATA="${WSX_APPDATA:-/mnt/user/appdata/webstationx}"
[[ "$APPDATA" =~ ^/[a-zA-Z0-9_/-]+$ && "$APPDATA" != / ]] || { echo 'WSX_APPDATA must be an absolute path without spaces or shell characters.' >&2; exit 1; }
SSH=(ssh -o BatchMode=yes)
SCP=(scp -q)
if [[ -n "${WSX_KEY:-}" ]]; then SSH+=(-i "$WSX_KEY"); SCP+=(-i "$WSX_KEY"); fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
REMOTE="$APPDATA/releases/$STAMP"
mkdir -p work
git archive --format=tar.gz --output=work/webstationx-src.tgz HEAD
"${SSH[@]}" "$WSX_HOST" "mkdir -p '$REMOTE' '$APPDATA/Games/psx' '$APPDATA/Games/ps2' '$APPDATA/library' '$APPDATA/bios' '$APPDATA/data'"
"${SCP[@]}" work/webstationx-src.tgz "$WSX_HOST:$REMOTE/source.tgz"
"${SSH[@]}" "$WSX_HOST" "cd '$REMOTE' && tar -xzf source.tgz && docker build -t webstationx:latest . && WSX_APPDATA='$APPDATA' bash tools/unraid-run.sh"
echo "Deployed $(git rev-parse --short HEAD). Source retained at $REMOTE; game and save volumes were preserved."
