#!/usr/bin/env bash
# Experiment 19 (X14), version 4: Tornado Cash's published withdrawal circuit, built here without
# being copied here. tornado-core is GPL-3.0 and this repository is Apache-2.0, so the circuit is
# fetched into work/ at a pinned commit and ported there, at build time, to circom 2's syntax:
#   - the pragma; include paths to this repository's circomlib;
#   - "signal private input" -> "signal input";
#   - circomlib 2's MiMCSponge(nInputs, nRounds, nOutputs): MiMCSponge(2, 1) -> MiMCSponge(2, 220, 1);
#   - a missing semicolon after "s * (1 - s) === 0";
#   - the ternary over hashers[i - 1], which circom 2 refuses at i = 0, as an if;
#   - the public inputs named on main: root, nullifierHash, recipient, relayer, fee, refund.
# No statement changes. Then a Groth16 key, phase 1 from the PSE perpetual powers of tau (2^17),
# phase 2 one contribution here, as experiment 15's setup-keys.sh. Run from the repository root:
#
#   bash experiments/19-x14-hash-based-stealth-addresses-under-8288/tornado.sh work/ptau
set -euo pipefail
PTAU=${1:?ptau dir}
PIN=1ef6a263ac6a0e476d063fcb269a9df65a1bd56a
W=work/tornado-core
B=experiments/19-x14-hash-based-stealth-addresses-under-8288/build
[ -d "$W/.git" ] || git clone -q https://github.com/tornadocash/tornado-core.git "$W"
git -C "$W" checkout -q "$PIN"
# circom2 runs under WASI and cannot follow work/'s symlink, so the port sits in build/, which git
# ignores: nothing compiled from the GPL circuit is committed, only its hashes in the results.
P=$B/port
mkdir -p "$P" "$B"
sha256sum "$W/circuits/withdraw.circom" "$W/circuits/merkleTree.circom" > "$B/tornado-sources.txt"
port() {
  { echo 'pragma circom 2.0.0;'; sed -E \
      -e 's#include "\.\./node_modules/circomlib/circuits/([^"]*)"#include "circomlib/circuits/\1"#' \
      -e 's/signal private input/signal input/' \
      -e 's/MiMCSponge\(2, 1\)/MiMCSponge(2, 220, 1)/' \
      -e 's/^(\s*)s \* \(1 - s\) === 0$/\1s * (1 - s) === 0;/' \
      -e 's/^(\s*)selectors\[i\]\.in\[0\] <== i == 0 \? leaf : hashers\[i - 1\]\.hash;/\1if (i == 0) { selectors[i].in[0] <== leaf; } else { selectors[i].in[0] <== hashers[i - 1].hash; }/' \
      -e 's/^component main = Withdraw\(20\);/component main {public [root, nullifierHash, recipient, relayer, fee, refund]} = Withdraw(20);/' \
      "$1"; } > "$2"
}
port "$W/circuits/merkleTree.circom" "$P/merkleTree.circom"
port "$W/circuits/withdraw.circom" "$P/withdraw.circom"
npx circom2 "$P/withdraw.circom" --r1cs --wasm -o "$B" -l node_modules -l "$P"
npx snarkjs groth16 setup "$B/withdraw.r1cs" "$PTAU/ppot_0080_17.ptau" "$B/withdraw_0.zkey" >/dev/null
npx snarkjs zkey contribute "$B/withdraw_0.zkey" "$B/withdraw.zkey" -n="experiment 19 withdraw" -e="$(head -c 64 /dev/urandom | base64 -w0)" \
  | grep -i -A4 "contribution hash" | sed "s/^/withdraw: /" >> "$B/contributions.txt"
rm "$B/withdraw_0.zkey"
npx snarkjs zkey export verificationkey "$B/withdraw.zkey" "$B/withdraw.vkey.json" >/dev/null
npx snarkjs zkey verify "$B/withdraw.r1cs" "$PTAU/ppot_0080_17.ptau" "$B/withdraw.zkey" | tail -1
sha256sum "$B/withdraw.zkey" "$B/withdraw.r1cs" "$B/withdraw_js/withdraw.wasm"
