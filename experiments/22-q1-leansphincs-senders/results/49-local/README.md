# exp-frames experiment 49, arms 2 to 6, on experiment 22's local chain

Records of `q2-local.ts`, one directory per run.

- `1-first-run/` (repository commit `f06b9e1`, kohaku-rs `f80adbe`): nothing was mined. The
  funder's first transaction stayed in ethrex's pool, and every later arm failed behind it. The
  builder refused all 239 blocks it built: "no aggregate proof for the block's leanSPHINCS
  dependencies" (`checks` in `run.json`). The wallet wrote its witnesses as
  `w-0x<key>.json`, with the signature prefixed `0x0x`, because its `hand_in` formats both with a
  helper that already adds `0x`. The patched builder reads `w-<key>.json`. So no witness was
  found, and no signature was checked. The run says nothing about the arms themselves; it is kept
  because it is a run.
- `2-second-run/` (repository commit `0114573`, kohaku-rs `1fe661e`, which names witnesses as the
  builder reads them): 18 blocks with leanSPHINCS dependencies were built, and all 18 proofs
  checked valid. No secp256k1 key was set.
  - **Arm 2:** the account's transaction was mined at 26,225 gas, and a triple naming another key
    was refused by the pool's simulation.
  - **Arm 3:** recovery ran end to end: start, cancel, an outside guardian's start refused, two
    shares sealed with ML-KEM-768, finish past the unlock time, and the new owner's transaction.
  - **Arm 6:** the pool note's deposit was mined.
  - **Arms 4 and 5, and copy (a)'s tickets:** refused by the patched ethrex's pool, "frame
    transaction validation prefix does not match any recognized shape". The wallet's `declare`
    puts the dependency frame after the first `VERIFY`. In a ticket transaction that is between
    the sender's `VERIFY` and the paymaster's, which no recognized prefix allows. Experiment 22's
    rebuilt transactions put it after the last `VERIFY`, and are recognized.
- `3-third-run/` (repository commit `cf48862`, kohaku-rs `e6f1623`, whose
  dependency frame goes after the last `VERIFY`): all 18 block proofs valid. Arms 2, 3 and 6 as
  in run 2. The ticket transaction's prefix is now recognized, and refused on its gas: "prefix gas
  budget exceeded: 240000 > 100000 (MAX_VERIFY_GAS)". The local ethrex's pool runs EIP-8141's own
  100,000, its default. The bound-ticket paymaster's check of a BLS ticket in `VERIFY` does not fit
  that budget, as X17's Groth16 `VERIFY` did not. The test network's pool allows 500,000. Run 4
  takes the test network's budget, `--mempool.max-verify-gas 500000`, and is recorded with it.
- `4-fourth-run/` (repository commit `3706f39`, kohaku-rs `e6f1623`, the local pool's VERIFY budget
  at the test network's 500,000): all 20 block proofs valid.
  - Arms 2, 3 and 6 as in run 2.
  - **Arms 4 and 5:** the bound-ticket spend was mined, at block 12 and 647,473 gas. A fresh
    leanSPHINCS sender deployed itself and posted, paid by a bound ticket whose binder declared
    its leanSPHINCS dependency.
  - **Copies (a), (b) and (c)** were each refused: the binder's signature over another hash, the
    binder's triple removed, and another key named.
  - **The withdrawal failed.** The pool is its own sender, paid by a bound ticket. It was refused
    with "validation prefix frame reverted" for its prefix of a root `VERIFY`, a pool `VERIFY`,
    a pay `VERIFY`, then the dependency frame. Copy (a) of the second seed stopped at the same
    step.
- `5-fifth-run/` (repository commit `62c67ca`, kohaku-rs `8688508`, whose pool, `DependencyFramePool`,
  admits the dependency frame; the local pool's VERIFY budget at 500,000): all 22 block proofs valid.
  - **Arms 2, 3 and 6** as before. Arm 6's deposit, into the new pool, cost 3,426,312.
  - **Arms 4 and 5 ran end to end:**
    - the bound-ticket spend, at 647,461 gas;
    - copies (a) to (c);
    - the withdrawal with the pool as its own sender, paid by a bound ticket, at 698,067;
    - the leanSPHINCS recipient deploying itself and sending a tenth back, paying its own gas, at
      337,177.

    So `3-tickets-local.json` was written.
  - **Copy (a) of the second seed was sent, as `SEND_COPY_A` asks.** Its binder's signature
    covers another hash, its simulation passed, and the local pool admitted it. It then held the
    sender's nonce, so copies (b) and (c) and the rest of that arm were refused ("Attempted to
    replace a pooled transaction with an underpriced transaction"). The run ended before a block
    included it.
  - On this chain such a transaction halts block production when it is included, since the builder
    does not drop it (experiment 22, arm 3). A node that checks the signature first refuses it at
    the node (the node-path pass).
- `6-sixth-run/`, stated before it runs: kohaku-rs `04b4a0f`, whose copy (a) goes to
  `COPY_A_RPC_URL` when set. The local pool's `VERIFY` budget is 500,000. One skandha node runs at
  `e9512aa` (`skandhaNodePathNonceFix`), under `eip-8288-master` with the local chain id and
  experiment 19's prover. `COPY_A_RPC_URL` points at that node for the copy (a) step only, and
  every other step runs against ethrex as before. Both seeds are fresh, as in every run.
  - **What the node is expected to do.** The wallet sends copy (a) with `eth_sendRawTransaction`.
    skandha's node path admits a transaction with a dependency only after a `frames_sendWrapper`
    call has proved it (its `FRAMES.md`, AG-6). So copy (a) is expected to be refused for that
    missing proof, not for its signature. A refusal for the signature would need the copy sent as
    a wrapper, with the binder's signature as its proof. The record keeps the node's answer and its
    log lines, whichever it is.
  - **What the rest is expected to do.** With copy (a) kept out of ethrex's pool, the second seed's
    copies (b) and (c) and the rest of its arm run. Every block proof checks valid, and the chain
    does not halt.
  - **Result** (repository commit `ce4e578`, kohaku-rs `04b4a0f`): all 24 block proofs checked
    valid, 2,784 to 3,344 ms each.
    - Arms 2, 3 and 6 ran as before.
    - The second seed's arm ran to its end, since copy (a) no longer held the sender's nonce:
      - the bound-ticket spend (647,473);
      - copies (b) and (c), refused by ethrex's simulation;
      - the pool-paid withdrawal (698,055);
      - the recipient's own spend (337,177).
  - **Copy (a) was refused by the node, but not for the reason stated above.** Its answer was
    `ErrFrameUnrecognizedPrefix`, before any proof was asked for. A bound-ticket transaction's prefix
    is the sender's `VERIFY`, the paymaster's `VERIFY`, then the dependency frame, a payer-paid
    prefix with a dependency. `eip-8288-master` recognizes no such prefix, and a profile that does
    was asked about and not added for now. So this run
    shows that a node on the node path keeps copy (a) out of every pool and the chain keeps moving.
    It does not show the node checking the binder's signature, which needs both that prefix shape
    and a wrapper.
