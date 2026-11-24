#!/usr/bin/env bash
# Experiment 19 (X14), the local chain (Amendment 3): ethrex at the test network's commit with
# EIP-8288 patched in. Clones ethrex into work/ethrex at the pin (or reuses that clone), applies
# ethrex-8288.patch, and builds the binary in release mode. The patch is off unless the node runs
# with X14_EIP8288=written or extended; local.ts sets it, with the prover and the programs. ethrex
# is MIT or Apache-2.0; the patch is a diff against it.
# Run from the repository root.
set -euo pipefail
D=experiments/19-x14-hash-based-stealth-addresses-under-8288
PIN=$(python3 -c "import json;print(json.load(open(\"$D/pins.json\"))[\"ethrex\"][\"commit\"])")
E=work/ethrex
[ -d "$E/.git" ] || git clone https://github.com/lambdaclass/ethrex "$E"
git -C "$E" checkout -q "$PIN"
if git -C "$E" apply --check "$PWD/$D/ethrex-8288.patch" 2>/dev/null; then
  git -C "$E" apply "$PWD/$D/ethrex-8288.patch"
elif ! git -C "$E" apply --reverse --check "$PWD/$D/ethrex-8288.patch" 2>/dev/null; then
  echo "work/ethrex has changes the patch does not account for" >&2; exit 1
fi
( cd "$E" && cargo build --release --bin ethrex )
echo "ethrex $(git -C "$E" rev-parse --short HEAD) + ethrex-8288.patch $(sha256sum "$D/ethrex-8288.patch" | cut -c1-12)"
