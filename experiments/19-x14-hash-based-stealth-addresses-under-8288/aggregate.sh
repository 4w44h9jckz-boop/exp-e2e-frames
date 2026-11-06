#!/usr/bin/env bash
# Experiment 19 (X14), arm 5, prediction 8: how many leanSPHINCS signatures one 1,000 ms interval
# holds on this machine, with leanVM's own aggregation at 3cbac04 (work/leanVM, built by
# `cargo build --release -p leanvm-cli`). Three measured passes after a warm-up at each size.
# Run from the repository root; writes results/<label>-aggregation.txt.
set -euo pipefail
LABEL=${1:?label}
D=experiments/19-x14-hash-based-stealth-addresses-under-8288
OUT=$D/results/$LABEL-aggregation.txt
BIN=work/leanVM/target/release/leanvm
{
  echo "leanVM $(git -C work/leanVM rev-parse HEAD)"
  echo "machine $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) cores, $(free -g | awk '/Mem:/ {print $2}') GiB"
  for n in 16 32 48 64 80 96 128; do
    echo "== $n"
    "$BIN" aggregate --sphincs "$n" --log-inv-rate 1 --repeat 3 2>/dev/null | grep -E "cycles|proof size|proving time|per signature|verifying"
  done
} > "$OUT"
cat "$OUT"
