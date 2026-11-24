#!/usr/bin/env bash
# Experiment 30's client: BLINDMINT, BLINDTRANSFER and BLINDPRUNE as precompiles with state
# (experiments/30-blindmint-and-blindtransfer-natively/SPEC.md). Applies ethrex-blind.patch on top
# of ethrex-8288.patch and ethrex-writes.patch in work/ethrex, builds a separate binary into
# work/ethrex-bins, then removes the patch and puts the standard binary back, so other experiments
# run on the client they were written against. ethrex is MIT or Apache-2.0; work/ is never
# committed. Run from the repository root, after scripts/ethrex-writes.sh.
set -euo pipefail
E=work/ethrex
P="$PWD/scripts/ethrex-blind.patch"
OUT=work/ethrex-bins/ethrex-8288-writes-blind
STD=work/ethrex-bins/ethrex-8288-writes
mkdir -p work/ethrex-bins
git -C "$E" apply --check "$P"
cp -p "$E/target/release/ethrex" "$STD"
git -C "$E" apply "$P"
trap 'git -C "$E" apply --reverse "$P"; cp -p "$STD" "$E/target/release/ethrex"' EXIT
( cd "$E" && cargo build --release --bin ethrex )
cp -p "$E/target/release/ethrex" "$OUT"
echo "ethrex $(git -C "$E" rev-parse --short HEAD) + ethrex-8288.patch + ethrex-writes.patch + ethrex-blind.patch $(sha256sum "$P" | cut -c1-12): $OUT $(sha256sum "$OUT" | cut -c1-12)"
