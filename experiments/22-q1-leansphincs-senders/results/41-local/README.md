# exp-frames experiment 41's request (Q8), on experiment 22's local chain with EIP-8288 extended

Records of `q8-local.ts`, one directory per run, by exp-frames experiment 41's procedure
"Running the request on a chain with EIP-8288 extended" (branch `exp/49-q8-fhe-input` at
`eb76c78`). The request's binary is kohaku-rs's `request` example, at the commit the command names,
built with `target-cpu=native`.

- `1-first-run/`, stated before it runs: kohaku-rs `a9ca8d3`. The chain is ethrex `64b8fc09` with
  experiment 19's patch, extended, so a leanSTARK dependency is valid and its proof is checked in
  the block. The pool's `VERIFY` budget is ethrex's default, EIP-8141's 100,000. The program
  directory is fresh, in `work/`, holding experiment 19's programs and the request's instantiated
  program, as `docs/leanvm-program-layout.md` section 5 asks. The genesis funds the seed's
  leanSPHINCS funder, and no secp256k1 key is used. The procedure's expectations:
  - `FheRequest` is deployed and funded;
  - the changed-ciphertext copy is refused;
  - the request, `[VERIFY, DEP_VERIFY, SENDER]`, is mined, with its proof checked by the block;
  - the same proof at the next request number is refused.

  The record keeps the builder's checks, so a block that holds the request shows its leanSTARK
  proof checked, or the reason it was not.
- **Run 1's result:** stopped at the funder's first transaction, with "validation prefix frame
  reverted". The fault was the runner's. It asked `pq_wallet` for the funder's address without
  `CARRIER=dependency`, and the address depends on the carrier, since the account's code does. So
  the genesis funded another address, and the request's funder could not pay. Nothing about the
  request was tested.
- `2-second-run/`, stated before it runs: as run 1, with the runner passing `CARRIER=dependency`
  to `pq_wallet` too (`q8-local.ts`).
