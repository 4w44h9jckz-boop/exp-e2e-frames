#!/usr/bin/env bash
# Experiment 15's proving keys: phase 1 is the Privacy & Scaling Explorations perpetual powers of
# tau after 80 contributions (2^17 for kernel, import and batch8; 2^18 for round4), phase 2 one
# contribution made here from 64 random bytes that are never printed or stored. Writes
# build/<circuit>.zkey and build/<circuit>.vkey.json, and appends each contribution's hash to
# build/contributions.txt. Run from the repository root:
#
#   bash experiments/15-x10-out-and-back/setup-keys.sh <ptau dir> [circuit ...]
#
# The ptau files come from
#   https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau
#     sha256 f807e065fde53f72f4bf4d57140fab85b26daa6cc95bdfec7cce93622b3a367c
#   https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_18.ptau
#     sha256 9693220206afab749e3d88d4ab5fdf5d36120ea102e7e587ccea0e7a5208e711
set -euo pipefail
PTAU=${1:?ptau dir}
shift
B=experiments/15-x10-out-and-back/build
if [ $# -eq 0 ]; then CIRCUITS=(kernel import batch8 round4); else CIRCUITS=("$@"); fi
for c in "${CIRCUITS[@]}"; do
  case "$c" in round4) P=$PTAU/ppot_0080_18.ptau ;; *) P=$PTAU/ppot_0080_17.ptau ;; esac
  npx snarkjs groth16 setup "$B/$c.r1cs" "$P" "$B/${c}_0.zkey" >/dev/null
  npx snarkjs zkey contribute "$B/${c}_0.zkey" "$B/$c.zkey" -n="experiment 15 $c" -e="$(head -c 64 /dev/urandom | base64 -w0)" \
    | grep -i -A4 "contribution hash" | sed "s/^/$c: /" >> "$B/contributions.txt"
  rm "$B/${c}_0.zkey"
  npx snarkjs zkey export verificationkey "$B/$c.zkey" "$B/$c.vkey.json" >/dev/null
  npx snarkjs zkey verify "$B/$c.r1cs" "$P" "$B/$c.zkey" | tail -1
  sha256sum "$B/$c.zkey" "$B/$c.r1cs" "$B/${c}_js/$c.wasm"
done
