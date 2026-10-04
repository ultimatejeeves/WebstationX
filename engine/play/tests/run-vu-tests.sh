#!/usr/bin/env bash
set -euo pipefail
CORE_TEST_SUITE=vu exec "$(dirname "$0")/run-ee-memory-tests.sh" "$@"
