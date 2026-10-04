#!/usr/bin/env bash
set -euo pipefail
CORE_TEST_SUITE=spu2-state exec "$(dirname "$0")/run-ee-memory-tests.sh" "$@"
