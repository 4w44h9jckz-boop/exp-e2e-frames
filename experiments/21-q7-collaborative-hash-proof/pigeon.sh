#!/usr/bin/env bash
# Experiment 21 (Q7), plan step 2: ePrint 2026/729's authors' prover (`pigeon`, benchmark 0, circuit
# type 1: a synthetic R1CS of 2^M gates, additions and multiplications at random, srand(42)) at
# N MPI provers on this one host. One warm-up and three measured passes at each point; every pass's
# whole output is kept. Wall-clock figures are loopback figures; N = 8 oversubscribes 4 cores.
# usage: experiments/21-q7-collaborative-hash-proof/pigeon.sh <label> <path to the built pigeon>
set -euo pipefail
LABEL=${1:?label}; PIGEON=${2:?pigeon}
D=$(cd "$(dirname "$0")" && pwd)/results/$LABEL-pigeon
mkdir -p "$D"
{
  echo "repo $(git -C "$(dirname "$PIGEON")/../.." rev-parse HEAD)"
  echo "libXKCP.a $(sha256sum "$(dirname "$PIGEON")/../../lib/libXKCP.a" | cut -d' ' -f1)"
  echo "compiler $(g++ --version | head -1)"
  echo "mpi $(mpirun --version | head -1)"
  echo "machine $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) cores, $(free -g | awk '/Mem:/ {print $2}') GiB"
} > "$D/build.txt"
cd "$(dirname "$PIGEON")"
for N in 4 8; do
  for M in 15 16; do
    for pass in warmup 1 2 3; do
      extra=""; [ "$N" -gt "$(nproc)" ] && extra="--oversubscribe"
      timeout 1200 mpirun --allow-run-as-root $extra -np "$N" ./pigeon 0 "$M" 1 > "$D/N$N-M$M-$pass.txt" 2>&1 || echo "exit $?" >> "$D/N$N-M$M-$pass.txt"
      echo "N=$N M=$M $pass: $(grep -E '^Vt' "$D/N$N-M$M-$pass.txt")"
    done
  done
done
