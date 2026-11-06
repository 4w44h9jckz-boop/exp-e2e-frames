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
- **Run 2's result** (repository commit `040db1f`, kohaku-rs `a9ca8d3`): all four of the
  procedure's expectations held.
  - **`FheRequest` was deployed and funded** at block 1 (1,717,177 gas). The funder is a fresh
    leanSPHINCS account, so it deployed itself too. Its dependency was proved by leanVM's
    aggregation in 3,283 ms and checked valid.
  - **The proof:** 5,974,185 cycles, 358,440 bytes, 12,733 ms, verified off chain before sending.
    The program `fhe_input_v2_d2048_k1.py` went into the run's program directory under the key
    `0x1afd035c...484d07`.
  - **The changed-ciphertext copy was refused** by ethrex's simulation ("validation prefix frame
    reverted").
  - **The request was mined** at block 16, `[VERIFY, DEP_VERIFY, SENDER]`, for 1,169,329 gas:
    - `VERIFY` 8,007;
    - the dependency frame its declared 30,000;
    - `SENDER` 20,821, with 97,920 state gas.

    The rest is the transaction's intrinsic cost and its calldata, the 16,400-byte ciphertext
    among it. The block's leanSTARK proof was checked by the builder against the triple's digest
    and key, and found valid, in 115 ms.
  - **The same proof at the next request number was refused** by the simulation.

  So the request's statement, a TFHE input's well-formedness at tfhe-rs's parameters, is checked
  on this chain as one leanSTARK dependency. The contract never checks the proof, as
  `docs/leanvm-program-layout.md` has it. Two conditions hold, as everywhere: leanVM has no zero
  knowledge, and leanSTARK is valid only on a chain that extends EIP-8288.
