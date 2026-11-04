#!/usr/bin/env bash
# Experiment 20 (Q6), arm 5: how many committee statements one interval holds on this machine.
# leanVM's own aggregation at 3cbac04 (work/leanVM, `cargo build --release -p leanvm-cli`), 3 to
# 64 leanSPHINCS signatures, three measured passes after a warm-up at each size; then experiment
# 19's prover, which the local node runs once per block, cold, on 3 and 64 real committee
# signatures (bench.ts). Run from the repository root; writes results/<label>-aggregation.txt.
set -euo pipefail
LABEL=${1:?label}
D=experiments/20-q6-committee-signatures
OUT=$D/results/$LABEL-aggregation.txt
BIN=work/leanVM/target/release/leanvm
mkdir -p $D/results
{
  echo "leanVM $(git -C work/leanVM rev-parse HEAD)"
  echo "machine $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) cores, $(free -g | awk '/Mem:/ {print $2}') GiB"
  for n in 3 4 6 8 16 32 64; do
    echo "== $n"
    "$BIN" aggregate --sphincs "$n" --log-inv-rate 1 --repeat 3 2>/dev/null | grep -E "cycles|proof size|proving time|per signature|verifying"
  done
} > "$OUT"
cat "$OUT"
