#!/usr/bin/env bash
# Activate Emscripten first. Uses the same compiled core libraries as the browser.
# PLAY_SRC=/path/to/Play- engine/play/tests/run-ee-memory-tests.sh [--quad]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="${PLAY_SRC:-/d/ps2build/Play-}"
BUILD="${PLAY_BUILD:-$SRC/build_cmake/build/wasm-ninja}"
SUITE="${CORE_TEST_SUITE:-ee-memory}"
OUT="$ROOT/work/$SUITE-tests"
mkdir -p "$OUT"
cmake --build "$BUILD" --target PlayCore > "$OUT/build.log" 2>&1 || { tail -60 "$OUT/build.log"; exit 1; }
# Keep imports identical to the actual hosted core, without constructing the full VM.
{
  sed -n '/^extern "C"/p' "$SRC/Source/ui_js/Ps2VmJs.cpp"
  echo 'static void RegisterTestFunctions() {'
  sed -n '/CWasmFunctionRegistry::RegisterFunction/p' "$SRC/Source/ui_js/Ps2VmJs.cpp"
  echo '}'
} > "$OUT/ee-test-registry.h"
EXPORTS="['_main'$(sed -n 's/.*RegisterFunction.*"\(_[^"]*\)".*/,"\1"/p' "$SRC/Source/ui_js/Ps2VmJs.cpp" | tr -d '\r\n')]"
mapfile -t LIBS < <(find "$BUILD/Source/ui_js/Source" -name '*.a')
SOURCES=("$ROOT/engine/play/tests/$SUITE-test.cpp")
if [ "$SUITE" = vu ]; then
  SOURCES=("$ROOT/engine/play/tests/vu-test.cpp")
  while IFS= read -r file; do SOURCES+=("$file"); done < <(find "$SRC/tools/VuTest" -name '*.cpp' ! -name Main.cpp)
fi
em++ -O2 --profiling-funcs -std=c++17 -pthread -msimd128 -fwasm-exceptions --bind \
  -I"$SRC/Source" -I"$SRC/deps/Framework/include" -I"$SRC/deps/CodeGen/include" -I"$OUT" -I"$SRC/tools/VuTest" -I"$SRC/Source/app_shared" \
  "${SOURCES[@]}" \
  -Wl,--start-group "${LIBS[@]}" -Wl,--end-group \
  -sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH -sENVIRONMENT=node -sSTACK_SIZE=8388608 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -o "$OUT/$SUITE-test.cjs"
node "$OUT/$SUITE-test.cjs" "$@"
