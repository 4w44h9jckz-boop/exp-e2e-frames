#!/usr/bin/env bash
# The local chain's simulated writes (docs/simulated-writes.md). Applies ethrex-writes.patch on top
# of experiment 19's ethrex-8288.patch in work/ethrex, then rebuilds the binary. ethrex is MIT or
# Apache-2.0; the patch is a diff against it, and work/ethrex is never committed.
# Run from the repository root, after experiments/19-x14-hash-based-stealth-addresses-under-8288/ethrex.sh.
set -euo pipefail
E=work/ethrex
P="$PWD/scripts/ethrex-writes.patch"
if git -C "$E" apply --check "$P" 2>/dev/null; then
  git -C "$E" apply "$P"
elif ! git -C "$E" apply --reverse --check "$P" 2>/dev/null; then
  echo "work/ethrex is not at ethrex-8288.patch's state, or has other changes" >&2; exit 1
fi
( cd "$E" && cargo build --release --bin ethrex )
echo "ethrex $(git -C "$E" rev-parse --short HEAD) + ethrex-8288.patch + ethrex-writes.patch $(sha256sum "$P" | cut -c1-12)"
