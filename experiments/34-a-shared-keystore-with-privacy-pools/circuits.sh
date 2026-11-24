#!/usr/bin/env bash
# Experiment 34: Privacy Pools' withdrawal and ragequit circuits, built here without being copied
# here. privacy-pools-core is Apache-2.0 and its circuits include circomlib, which is GPL-3.0, so the
# circuits are copied from work/privacy-pools-core at the pin into work/x34-circuits at build time,
# with only their include paths rewritten to this repository's circomlib 2.0.5 (the version the pool
# pins). The two main components are this experiment's, at the deployed maximum tree depth of 32:
#   withdraw:   public [withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context]
#   commitment: public [value, label] (the ragequit circuit)
# so the public signals come out in the order the pool's ProofLib reads them. Then a Groth16 key for
# each, phase 1 from the PSE perpetual powers of tau (2^16, the size the pool's own scripts use),
# phase 2 one contribution here, and snarkjs's Solidity verifier. Run from the repository root:
#
#   bash experiments/34-a-shared-keystore-with-privacy-pools/circuits.sh work/ptau [patch]
#
# With a patch (arm B), the patch is applied to the copied circuits before compiling, and the build
# goes to work/x34-circuits-b instead.
set -euo pipefail
PTAU=${1:?ptau dir}
PATCH=${2:-}
PIN=c312dcd58f6ad085204be61923c49f8065e4e9ae
SRC=work/privacy-pools-core
B=work/x34-circuits${PATCH:+-b}
[ -d "$SRC/.git" ] || git clone -q https://github.com/0xbow-io/privacy-pools-core "$SRC"
git -C "$SRC" checkout -q "$PIN"
rm -rf "$B" && mkdir -p "$B/src"
for f in commitment merkleTree withdraw; do
  sed -E -e 's#include "\.\./\.\./\.\./node_modules/circomlib/circuits/([^"]*)"#include "circomlib/circuits/\1"#' \
    "$SRC/packages/circuits/circuits/$f.circom" > "$B/src/$f.circom"
done
if [ -n "$PATCH" ]; then (cd "$B/src" && patch -s -p1 < "$OLDPWD/$PATCH"); fi
sha256sum "$SRC"/packages/circuits/circuits/*.circom > "$B/sources.txt"
# Arm B's patch adds the owner tag's two halves, last among the public inputs.
PUB="withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context${PATCH:+, ownerTagHi, ownerTagLo}"
printf 'pragma circom 2.2.0;\ninclude "withdraw.circom";\ncomponent main {public [%s]} = Withdraw(32);\n' "$PUB" > "$B/src/withdraw_main.circom"
printf 'pragma circom 2.2.0;\ninclude "commitment.circom";\ncomponent main {public [value, label]} = CommitmentHasher();\n' > "$B/src/commitment_main.circom"
for c in withdraw commitment; do
  npx circom2 "$B/src/${c}_main.circom" --r1cs --wasm -o "$B" -l node_modules -l "$B/src" > "$B/$c.compile.txt"
  npx snarkjs r1cs info "$B/${c}_main.r1cs" > "$B/$c.info.txt"
  npx snarkjs groth16 setup "$B/${c}_main.r1cs" "$PTAU/ppot_0080_16.ptau" "$B/${c}_0.zkey" > /dev/null
  npx snarkjs zkey contribute "$B/${c}_0.zkey" "$B/$c.zkey" -n="experiment 34 $c" -e="$(head -c 64 /dev/urandom | base64 -w0)" > /dev/null
  npx snarkjs zkey export verificationkey "$B/$c.zkey" "$B/$c.vkey.json" > /dev/null
  npx snarkjs zkey export solidityverifier "$B/$c.zkey" "$B/${c}_verifier.sol" > /dev/null
done
grep -h "# of Constraints" "$B"/*.info.txt
echo "built $B from privacy-pools-core ${PIN:0:7}"
