#!/bin/bash
# Fixture benchmark for the live-smoke objective (ticket 12).
# SYNTHETIC BY DESIGN: scores implementation markers, not wall-clock time.
# FAST -> 50, anything else -> 100. Deterministic, no network, no timers.
set -u
TARGET="src/transform.ts"
if grep -q "FAST" "$TARGET" 2>/dev/null; then
  echo "METRIC runtime_ms=50"
else
  echo "METRIC runtime_ms=100"
fi
