#!/usr/bin/env bash
# Builds the Play! tree as it is (uncommitted work included, no patches re-applied) into a trial core
# directory for the bench: engine/play/build-dev.sh <name> [--install]
#   -> work/cores-trial/<name>/{Play.js,Play.wasm}   (serve with CORE_DIR=work/cores-trial/<name>)
#   --install also copies it to public/cores/play and updates src/emu/ps2/core-version.ts
# PLAY_SRC (default D:/ps2build/Play-) and EMSDK (default D:/ps2build/emsdk) pick the tree and toolchain.
set -euo pipefail
NAME="${1:?name}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${PLAY_SRC:-/d/ps2build/Play-}"
EMSDK_DIR="${EMSDK:-/d/ps2build/emsdk}"
export PATH="$PATH:/c/Users/$USERNAME/AppData/Roaming/Python/Python314/Scripts"
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
cd "$SRC"
LOG="$ROOT/work/cores-trial/$NAME-build.log"
mkdir -p "$(dirname "$LOG")"
if ! cmake --build --preset wasm-ninja-release --target Play > "$LOG" 2>&1; then
  tail -80 "$LOG"
  exit 1
fi
grep -E "error|warning: unused|FAILED|Linking|ninja: no work|^\[[0-9]+/[0-9]+\] Linking" "$LOG" | grep -v "Wno-" | tail -40 || true
BUILT="$SRC/build_cmake/build/wasm-ninja/Source/ui_js"
[ "$BUILT/Play.wasm" -nt "$SRC/Source/ui_js/Main.cpp" ] || echo "note: Play.wasm is older than Main.cpp (build may have failed)"
grep -q 'case 9:Module\[d.handler\]' "$BUILT/Play.js" || { echo "Emscripten worker message layout changed" >&2; exit 1; }
OUT="$ROOT/work/cores-trial/$NAME"
mkdir -p "$OUT"
cp "$BUILT/Play.js" "$BUILT/Play.wasm" "$OUT/"
VERSION=$(cat "$OUT/Play.js" "$OUT/Play.wasm" | sha1sum | cut -c1-12)
echo "core $VERSION -> $OUT"
if [ "${2:-}" = "--install" ]; then
  cp "$OUT/Play.js" "$OUT/Play.wasm" "$ROOT/public/cores/play/"
  printf "// Written by engine/play/build.sh: cache-busts the PS2 core (public/cores/play).\nexport const PS2_CORE_VERSION = '%s';\n" "$VERSION" > "$ROOT/src/emu/ps2/core-version.ts"
  echo "installed in public/cores/play"
fi
