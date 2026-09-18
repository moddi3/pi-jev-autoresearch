#!/bin/bash
# Upstream correctness gate for the smoke workdir: fixed input/output goldens.
set -u
node --experimental-strip-types .auto/check-transform.mjs
