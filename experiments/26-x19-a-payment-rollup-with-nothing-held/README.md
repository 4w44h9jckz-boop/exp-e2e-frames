# Experiment 26 (X19): a payment rollup in which no party holds what the next step needs

**Status: pre-registered 2026-11-05,** before any code, program, contract, runner or transaction.
Predictions, what would show each wrong, and the deviations are fixed here. Results are added below
them, and nothing above the results is edited after a run.

## The question

Experiment 25 read [INTMAX3](https://github.com/InternetMaximalism/intmax3-zkp) at `979318d`, a
research prototype of a payment rollup built on channels. It found five places where one party
holds or blocks what the next step needs:
- **the block producer:** every block needs a co-signing round over its root;
- **the server-side provers:** they see the users' witnesses;
- **the user's device:** it alone keeps the balance proofs, the latest signed head and the exit kit;
- **the channel's co-signers:** every transfer needs all of them;
- **the exit's last steps:** only the recipient's own L1 address can send them.

Experiment 25 also found that INTMAX3's own validity prover does not complete in this container's
13.35 GiB, so a user cannot prove its own withdrawal on a machine of that size.

This experiment builds a **model** of a payment rollup shaped like INTMAX3, in this family's leanVM
programs and contracts. It asks whether each of the first, second, third and fifth holds can be
removed, and at what cost. It is not INTMAX3, and nothing here is INTMAX3's design. The channel's
co-signers are kept: a transfer still needs all of them, and the exit needs none of them.

## The model

- **State.** A rollup contract holds the root of a Keccak tree of channel leaves. A leaf commits to
  a channel's members' leanSPHINCS keys, its balance and a salt:

  $$\mathit{leaf} = H(\mathit{keys}, H(\mathit{balance}, \mathit{salt}))$$

  Only the root is on chain. The balance is a hash commitment, not INTMAX3's Regev ciphertext.
- **A transfer is a signed leaf, not a signed block.** Every member of the sending channel signs a
  *transfer leaf* with its leanSPHINCS key: the channel, its new state commitment, the receiving
  channel, an amount commitment, a fee, an expiry block and a nullifier. Any aggregator holding
  signed transfer leaves can build a block.
- **The user proves its own statement.** The sending member proves, in a leanVM program over its
  own witness (its balance and its old and new salts), three things:
  - its old leaf and its new leaf commit to the same keys;
  - the new balance is the old less the amount and the fee;
  - nothing went negative.

  The program publishes one digest, as `docs/leanvm-program-layout.md` fixes it, and nothing
  else:

  $$D = H(\mathit{oldLeaf}, \mathit{newLeaf}, \mathit{transferLeaf})$$

  The tree path is not a witness. The tree's leaves are commitments, and a transfer names its
  channel.
- **A block** is posted by any aggregator in one frame transaction:
  - the leaves, in calldata;
  - each member's signature as a leanSPHINCS dependency;
  - the user proofs as leanSTARK dependencies, folded into one proof if part 2 succeeds, one per
    transaction if not.

  The rollup's `VERIFY` checks that every included nullifier is new, that no leaf is past its
  expiry, and that the block includes every queued leaf older than $k$ blocks. It recomputes each
  transfer's digest from calldata and finds its triple. It then approves, and the block's validity
  covers the dependencies. Its execution frame checks each old leaf's path against the root, in
  order, and writes the new root. The tree's update is checked on chain, at a few Keccaks per
  level, so no proof is needed for it.
- **The inclusion queue.** A member whose leaf no aggregator includes posts the signed leaf to the
  rollup's queue in its own transaction. A block that omits a queued leaf older than $k$ blocks is
  refused by the rollup's `VERIFY`.
- **The member's state in blobs.** After each change the member encrypts its new head and exit kit
  to its own ML-KEM-768 key, pads it to one fixed size, and posts it as blob data with a pointer the
  rollup records. A member holding only its seed and an RPC rebuilds the exit kit from the chain.
- **The exit as jobs.** A member freezes its channel with a leanSPHINCS dependency over the
  freeze, which any taker can send for a fee taken from the exit. The payout goes to an escrow that
  pays for its own release transaction from the amount it releases, as experiment 24's `PoolSelf`
  does. So a recipient holding no ETH is paid.

## Design

### The tools, pinned

- **The local chain:** ethrex `64b8fc09` with experiment 19's patch, in the `extended` setting, so
  that a leanSTARK dependency is valid and its proof is checked in the block. Its program
  directory is a fresh one in `work/`.
- **leanVM** at `3cbac04`, through experiment 19's `prover/`, built with `-C target-cpu=native`.
- **No secp256k1 key.** Every sender is a leanSPHINCS account funded at genesis: the members, two
  aggregators, the takers and the poster. They use experiment 22's `SphincsAccount`.
- **The test network is not used.** leanSTARK dependencies are valid only on a chain that extends
  EIP-8288.

### Parts

1. **Blocks without a signing round.** Two channels of two members each, and two aggregators.
   Aggregator A builds blocks. Aggregator B refuses one member's leaf. That member queues the leaf,
   and A's next blocks must include it within $k$ blocks or be refused. Then three bad blocks, each
   refused: one with a forged signature, one reusing a nullifier, one with an expired leaf.
2. **Proofs split between the user and anyone.** Each sending member proves its own statement.
   - **The fold, if it can be written.** leanVM's recursion verifies proofs of its own bytecode only
     (experiment 19). So the fold is one program with two modes:
     - a leaf mode, which is the user's statement;
     - a node mode, which verifies two proofs of the same program and publishes the hash of their
       two digests.

     The aggregator runs only the node mode, on proofs and digests. The rollup recomputes the root
     digest from the transfers' digests in the same tree shape.
   - **Its source.** The node mode's in-circuit verifier is lifted from leanVM's own aggregation
     guest at the pin, as experiment 19's `lift.py` lifted its leanSPHINCS verifier, with a test
     that checks every lifted function against the guest.
   - **If it cannot be written at the pin,** that is recorded with the reason, and each transfer's
     proof goes in a block transaction of its own.
3. **Recovery from a key and L1.** After part 1, one member deletes everything but its seed. It
   rebuilds its head and exit kit from the blob pointers and blobs, within the local chain's blob
   window, and goes on to part 4 with them.
4. **The exit as jobs.** A taker that is not the member sends the freeze, paid from the exit. The
   payout to a recipient holding no ETH is released by the escrow's own transaction.
5. **The local chain's blocks,** scanned for any secp256k1 or P-256 signature.

### Measures

- **Per transaction:** gas, by frame; state gas; calldata; whether the block's dependency proofs
  checked valid.
- **Per proof:** cycles, proving time, size, peak memory. The machine and the build flags are
  recorded with each.
- **Per block:** the number of transfers, the dependencies, and the builder's proving and checking
  time.
- **Against INTMAX3's own figures, quoted as INTMAX3's:**
  - about 25 s for a full balance proof on Apple silicon or a small arm64 box, "indicative" in its
    README's words;
  - about 11.2 million gas for one on-chain MLE/WHIR verification;
  - its validity prover's 11.23 GiB peak on a 48 GiB host;
  - experiment 25's 13.88 GiB here, at which that prover was killed.

## Predictions

1. **Any aggregator can build a block.** Aggregator A's blocks are mined with no signature from any
   party but the senders. A block with a forged signature, a reused nullifier or an expired leaf
   is refused.
2. **The queue bounds an aggregator's delay to $k$ blocks.** After aggregator B refuses a leaf and
   the member queues it, every block that omits it after $k$ blocks is refused, and the leaf is
   mined within $k + 1$ blocks of its queueing.
3. **No prover sees a witness.** No input that the aggregators, the builder or a taker receive holds
   a member's balance or salt.
4. **The fold folds.** Part 2's fold program is written at leanVM's pin, its node mode reads only
   proofs and digests, and a block of four transfers carries one leanSTARK dependency, which the
   chain checks valid.
5. **Recovery needs only the seed and L1.** The member that deleted its state rebuilds an exit kit
   identical to the one it deleted, and exits with it. Every posted backup has the same size.
6. **The exit needs neither the recipient's ETH nor a co-signer.** The freeze is sent by a taker,
   the payout is released by the escrow's own transaction, and the recipient holds no ETH
   throughout.
7. **Every proof fits a device.** Every proof in the runs is made in under 4 GiB of memory and under
   60 s on this machine.
8. **Within an order of magnitude.** A user's proof takes no more than ten times INTMAX3's quoted
   25 s. A block's verification on chain costs no more than ten times INTMAX3's quoted 11.2 million
   gas.
9. **No classical signature.** No block of the runs carries a secp256k1 or P-256 signature.

## What would show it wrong

| # | Shown wrong if |
|---|---|
| 1 | a block needs any signature but the senders' to be mined, or any of the three bad blocks is mined |
| 2 | a block that omits a leaf queued more than $k$ blocks earlier is mined, or the queued leaf is not mined within $k + 1$ blocks |
| 3 | any input the aggregators, the builder or a taker receive holds a balance or a salt |
| 4 | the fold cannot be written at the pin, or its node mode reads a witness, or the block's one dependency is not checked valid |
| 5 | the rebuilt exit kit differs from the deleted one, or the exit with it fails, or two backups differ in size |
| 6 | the exit needs the recipient's ETH, its own transaction, or any co-signer's signature |
| 7 | any proof needs 4 GiB or more, or 60 s or more |
| 8 | a user's proof takes more than 250 s, or a block's on-chain verification more than 112 million gas |
| 9 | any block of the runs carries a secp256k1 or P-256 signature |

## Deviations, stated before the run

- **A model, not INTMAX3.** Balances are hash commitments, not Regev ciphertexts. So a transfer's
  arithmetic is proved over a committed balance, not computed under encryption. Channels have two
  members. Nothing here measures INTMAX3, and INTMAX3's figures are quoted as INTMAX3's.
- **The two conditions hold throughout.** leanVM has no zero knowledge at its pin, so every privacy
  result is conditional on it gaining zero knowledge. EIP-8288 reserves `LEANSTARK_SCHEME`, so
  every result holds on the extended local chain only.
- **$k$ and the expiry are small** for the run: $k = 4$ blocks, an expiry of 64 blocks.
- **The blob window is the local chain's,** and recovery is tested within it. An archiver past the
  window is out of scope.
- **Prediction 4's fallback is a finding, not a pass.** If the fold cannot be written, part 2 runs
  with one proof per block transaction, and the record says what that costs per transfer.
- **The receiving side is recorded, not proved.** The rollup records each transfer's receiving
  channel and amount commitment as a pending credit. The receiver's proof that absorbs it into
  its own leaf is out of scope.

## Path

- `programs/`: the user's statement, then the fold.
- `contracts/`: the rollup, its queue and the escrow.
- `run.ts`: parts 1 to 5 on the local chain.
- `results/`: each run's record, with its commit, command and inputs.

## Amendment 1, 2026-11-05, before any code

Working out the contract fixed six choices the design above left open. None changes a prediction.

- **The rollup is its own sender.** A block transaction's sender and payer is the rollup, as
  experiment 24's `PoolSelf` is. Its `VERIFY` approves both execution and payment, and it pays
  the gas from its balance, which deposits fund. An aggregator therefore holds no key and signs
  nothing. It assembles the transaction from signed leaves and proofs, and names an address for
  its fee. Each block transaction uses its transfer's nullifier as its EIP-8250 nonce key, so two
  aggregators' blocks never share a nonce.
- **$k$ and the expiry count rollup blocks,** which the rollup numbers in its own storage, not L1
  blocks. EIP-8141's validation reads no block number, as experiment 18 found, so `VERIFY` reads
  the rollup's own counter instead.
- **The path is checked in `VERIFY`.** `VERIFY` checks each old leaf's path against the stored
  root, and the execution frame writes the new root. So a block built on a stale root is refused,
  not mined and reverted.
- **The queue's rule in `VERIFY`.** The rollup keeps its queue in order. If the oldest unincluded
  queued leaf was queued more than $k$ rollup blocks ago, `VERIFY` refuses any block that does not
  include it. Anyone can post a block, so the queue matters in one case: when other blocks keep
  moving the root, a member's own block keeps going stale, and the queue makes the others include
  its leaf.
- **Until the fold exists, a block carries one transfer.** That is the fallback stated above, since
  a transaction carries one leanSTARK dependency (`docs/leanvm-program-layout.md`).
- **The exit reveals its opening.** Freezing needs one member's leanSPHINCS dependency over the
  freeze. Claiming reveals the channel's balance, its salt and its recipient, which the rollup
  checks against the leaf with `keccak256` alone. So the exit needs no proof. The leaf commits the
  recipient beside the keys:

  $$\mathit{keys} = H(\mathit{key}_0, \mathit{key}_1, \mathit{recipient})$$

## Amendment 2, 2026-11-05, before the first run

The contract and runner fixed five more choices. Each is stated before any transaction.

- **Every transaction's sender is the rollup:** blocks, the queue, backups, the freeze and the
  claim. So no account in the runs holds a key, and the leanSPHINCS accounts of the design above
  are not needed. Members sign only as dependencies. Prediction 9 is unchanged.
- **Channels are registered and funded at genesis.** The rollup stores each channel's keys hash,
  and the root of the two channels' leaves, with 5 ETH in each. Deposits are out of scope.
- **The forged-signature block's form.** On the patched chain, a dependency whose signature does not
  verify halts the builder, as experiment 22 found. So the forged block names, in its triple, a key
  that is not the channel's, with that key's own valid signature. The rollup's `VERIFY` refuses
  it, because a triple's key must be the channel's. A wrong signature under the channel's own key
  is not sent.
- **The queue's boundary.** For a leaf queued at rollup block count $q$, blocks $q + 1$ to $q + k$
  may omit it, and block $q + k + 1$ must include it. Prediction 2 is scored that way.
- **The rollup is the escrow.** The claim's payout is released by the rollup's own transaction,
  which pays its gas from the amount it releases. So the recipient holds no ETH and sends nothing.
  This is the self-paying escrow of prediction 6. The claim reveals the channel's opening, so it
  needs no proof, as amendment 1 says. A taker's fee needs one member's signature over the taker
  and the fee.

## Run 1 (2026-11-05): stopped on the runner's fault

Record [`results/1-part-1.json`](results/1-part-1.json), from commit `2467f3f`:
`npx tsx experiments/26-x19-a-payment-rollup-with-nothing-held/run.ts 1-part-1`.

- **The first two transfers were mined,** each a block posted with no signature in the
  transaction. The rollup was the sender, and the members' signatures and the user's proof came as
  dependencies, which every block's check found valid.
  - The rollup's `VERIFY` took 20,340 and 20,331 gas.
  - The dependency frame took its declared 36,000.
  - The `SENDER` frame took 40,747 and 40,738. The first also paid 281,520 state gas for the
    rollup's first block count and the aggregator's new account.
  - Each user proof took 8,614 cycles and 66 to 83 ms, at about 252 KB and under 150 MB.
- **The run then stopped, on the runner's fault.** It sent the queue transaction before handing
  the builder the members' signatures on the queued leaf. The builder could not prove block 6, so
  it rebuilt that block without end ("no aggregate proof for the block's leanSPHINCS
  dependencies"), and the chain stalled. This is the halt experiment 22 found for a dependency
  with no valid witness. The runner now hands every signature over before sending.

No prediction is scored on run 1.

## Results, run 2: part 1 (2026-11-05)

Record [`results/2-part-1.json`](results/2-part-1.json), from commit `364056f`:
`npx tsx experiments/26-x19-a-payment-rollup-with-nothing-held/run.ts 2-part-1`. Twelve
transactions, every block's dependencies checked valid (8 of 8), and at the end the rollup's root
was the public tree's.

| Step | Outcome | Gas | `VERIFY` | dependencies | `SENDER`, with state |
|---|---|---:|---:|---:|---:|
| A: channel 0 pays channel 1 | mined | 508,288 | 20,340 | 36,000 | 40,747 + 281,520 |
| A: channel 1 pays channel 0 | mined | 226,714 | 20,331 | 36,000 | 40,738 |
| channel 0 queues the leaf B refused | mined | 467,140 | 7,110 | 6,000 | 41,921 + 293,760 |
| A: channel 1's transfers 1 to 4, the queued leaf 0 to 3 blocks old | mined, each | 231,262 each | 22,620 | 36,000 | 42,937 |
| A: channel 1's transfer, omitting the queued leaf after 4 blocks | **refused** by `VERIFY` | | | | |
| A: the queued leaf | mined | 339,494 | 24,801 | 36,000 | 51,068 + 97,920 |
| bad: a triple naming a key that is not the channel's | **refused** by `VERIFY` | | | | |
| bad: a nullifier already used | **refused** by the nonce ("expected 1, got 0") | | | | |
| bad: a leaf past its expiry | **refused** by `VERIFY` | | | | |

`VERIFY` also paid 97,920 state gas for each keyed nonce's first use, which every new nullifier is.
The first block's other state gas is the rollup's first block count and the aggregator's new
account. The queue's is its first entry.

The eleven user proofs each took 8,614 cycles. They took 65.6 to 105.6 ms, at 248,688 to 253,456
bytes and at most 146.6 MB. The builder proved each block's leanSPHINCS dependencies in 2,859 to
3,738 ms.

### Predictions, as far as part 1 tests them

| # | Prediction | Outcome |
|---|---|---|
| 1 | any aggregator can build a block | **held.** Aggregator A's blocks were mined with no signature in the transaction, and none from any party but the channel's members, as dependencies. All three bad blocks were refused |
| 2 | the queue bounds the delay to $k$ blocks | **held.** The leaf was queued at count 2. Four blocks omitted it, the fifth was refused for omitting it, and the queued leaf was mined as rollup block 7, which is $q + k + 1$ |
| 3 | no prover sees a witness | **held for part 1.** None of the eleven handed transfers held either channel's balance or salt, by a scan of everything the aggregator received |
| 7 | every proof fits a device | **so far:** every proof took under 0.11 s and under 150 MB |
| 8 | within an order of magnitude | **for part 1:** a user's proof takes about 0.1 s, against INTMAX3's quoted 25 s. A block costs 226,714 to 508,288 gas, the user's proof's check being the dependency frame's declared 30,000, against INTMAX3's quoted 11.2 million for one on-chain verification. The proof is checked by the block, off the EVM, as EIP-8288 has it |

Predictions 4, 5, 6 and 9 are for the full run.

## Amendment 3, 2026-11-05, before the full run

**The backup goes in calldata, not a blob.** The local chain keeps no blob once its transaction is
mined:
- ethrex's `engine_getBlobs` reads only its pool;
- its store keeps no sidecar;
- no consensus client runs here.

So a member could not read back a blob from the chain, and part 3 would test nothing. The sealed
backup goes in the backup transaction's `SENDER` data instead. It is 1,664 bytes, every backup the
same length: ML-KEM-768's ciphertext, an IV and a tag, the padded head, then zeros. The rollup's
`VERIFY` checks one member's leanSPHINCS signature over its hash. The rollup records the hash and
logs it. On a chain whose consensus client keeps sidecars, the same bytes go in a blob, and its
cost is the blob's. That cost is not measured here.

The tree a recovering member rebuilds is the rollup's `Transfer` logs. Each log carries the
channel's new leaf. So the tree is rebuildable from L1 once every channel has moved, as both
channels have by part 3. A channel untouched since genesis would need its genesis leaf published,
which this model's genesis does not do.

## Run 3 (2026-11-05): parts 1, 3 and 4 up to the claim, which failed on the runner's limit

Record [`results/3-full.json`](results/3-full.json), from commit `25e3ca8`:
`npx tsx experiments/26-x19-a-payment-rollup-with-nothing-held/run.ts 3-full`.

- **Part 1 ran as in run 2,** every step with the same outcome. Each block's gas was within 48 of
  run 2's.
- **Both backups were mined, each 1,664 bytes,** at 334,641 and 236,721 gas.
- **Part 3, recovery, held.** From the seed alone, channel 0's member:
  - found both backups in the rollup's logs;
  - opened the latest, which another member's seed could not;
  - rebuilt a head identical to the deleted one;
  - rebuilt from the `Transfer` logs a tree whose root is the rollup's.
- **Part 4 began.** A taker sent the freeze, signed by one member, and it was mined (235,218 gas).
  A transfer from the frozen channel was then refused by `VERIFY`.
- **The claim was mined, and its `SENDER` frame failed.** It used all of its 150,000 execution
  gas. The claim writes one new slot, its claimed flag at 97,920 state gas. It also pays two new
  accounts, the taker and the recipient, at 183,600 each. That is 465,120 state gas against the
  frame's 400,000, the runner's limit.

The runner now gives every `SENDER` frame 600,000 of state gas, and the rollup's `VERIFY` still
asks for at least 300,000. No prediction is scored on run 3; the full run is run 4.

## Results, run 4: parts 1, 3, 4 and 5 (2026-11-05)

Record [`results/4-full.json`](results/4-full.json), from commit `e0e1349`:
`npx tsx experiments/26-x19-a-payment-rollup-with-nothing-held/run.ts 4-full`. Seventeen
transactions in 45 blocks, every block's dependencies checked valid (12 of 12). Part 2's fold is not
built yet, so every block carries one transfer.

- **Part 1** ran as in run 2: the same outcome at every step, and each block's gas within 48 of
  run 2's.
- **Part 3, recovery.** Channel 0's member kept only its seed. With it alone, the member:
  - found its two backups in the rollup's `Backup` logs, both 1,664 bytes;
  - read the latest from its transaction's calldata and opened it, which channel 1's member's seed
    could not;
  - rebuilt a head identical to the deleted one;
  - rebuilt the tree from the `Transfer` logs, with the rollup's root.
- **Part 4, the exit as jobs.** Every step's sender was the rollup. A taker assembled and sent
  each step, with one member's leanSPHINCS signature as its dependency:
  - the freeze: mined, 235,182 gas;
  - a transfer from the frozen channel: refused by `VERIFY`;
  - the claim, from the recovered head and the rebuilt tree: mined, 646,545 gas. Its `SENDER` frame
    took 36,509, and 465,120 state gas for the claimed flag and the two new accounts.
- **The payout.** The recipient held 0 wei and had sent nothing before the claim. After it, the
  recipient held 4,698,999,997,907,073,900 wei, and its nonce was still 0. That is the channel's
  4,699,999,998,000,000,000, less the taker's $10^{15}$ wei and the transaction's maximum cost of
  92,926,100 wei, which the rollup withheld to pay the gas. The taker received its $10^{15}$ wei.
- **Part 5, the scan:** 45 blocks, and no secp256k1 or P-256 signature in any.
- **Costs.** The twelve user proofs took 8,614 cycles each, 64.4 to 96.1 ms and at most 153.7 MB.
  The builder proved each block's leanSPHINCS dependencies in 2,806 to 3,897 ms, at most 413 MB.

### Predictions

| # | Prediction | Outcome |
|---|---|---|
| 1 | any aggregator can build a block | **held,** as in run 2 |
| 2 | the queue bounds the delay to $k$ blocks | **held,** as in run 2: the queued leaf was mined as rollup block $q + k + 1$, and the block that omitted it there was refused |
| 3 | no prover sees a witness | **held for the aggregators and the builder; shown wrong as stated for the claim's taker.** Nothing the aggregators received held a balance or a salt. The claim reveals the channel's final balance and salt, by amendment 1's choice, so the taker that sends it sees both. The balance is public at the exit anyway, as the payout. The salt need not be, and a proof of the opening would keep it private, at the cost of a leanSTARK dependency in the claim |
| 4 | the fold folds | **not yet run.** The fold is not built. Every block of runs 2 to 4 carried one transfer, which is the stated fallback |
| 5 | recovery needs only the seed and L1 | **held,** in calldata rather than blobs (amendment 3). The rebuilt head was identical, the exit with it succeeded, and both backups were 1,664 bytes |
| 6 | the exit needs neither the recipient's ETH nor a co-signer | **held.** The freeze and the claim were each sent by a taker, signed by one member of two, and released by the rollup's own transaction. The recipient held no ETH and sent nothing |
| 7 | every proof fits a device | **held.** Every user proof was under 0.1 s and 154 MB, and every block proof under 3.9 s and 413 MB |
| 8 | within an order of magnitude | **held.** A user's proof took under 0.1 s, against INTMAX3's quoted 25 s. A block's transaction costs 226,714 to 508,288 gas, against INTMAX3's quoted 11.2 million for one on-chain verification. The proof's check is the dependency frame's declared 30,000, done by the block off the EVM, as EIP-8288 has it |
| 9 | no classical signature | **held:** 45 blocks scanned, none |

Against experiment 25: INTMAX3's own validity prover was killed in this container at 13.88 GiB.
Here every proof the model needs is made in under 0.5 GB. The model proves less, though. It has
hash commitments, not Regev ciphertexts, one transfer a block, and no receiver's proof. So the
comparison is of where each design puts its proving, not of equal work.

## The fold, read at leanVM's pin (2026-11-05, before any fold code)

Prediction 4 needs one program that verifies proofs of itself. leanVM at `3cbac04` has exactly one
such program, its aggregation guest (`crates/rec_aggregation/guests/lean_ethereum.py`). It is built
for one statement, signature claims and a data-availability root, by three parts that work only
together:
- **The guest:** 4,352 lines of zkDSL, with 147 placeholders. The host fills each from the
  structural layout of the guest's own bytecode (`aggregation.rs`, `placeholder_map`).
- **The host:** builds the guest's witness for each child from the child's real layout and its
  proof's summary (`gen_verify`). It batches each child's deferred bytecode claim into the node's
  own (`aggregate_deferred_claims`).
- **The final verifier:** the root's deferred claim is discharged only natively, by the aggregation
  crate's `EthereumProof::verify`, not by leanVM's plain `verify`. The local chain's builder checks a
  leanSTARK dependency with `x14-prover verify`, which calls the plain one.

So a fold for this experiment's statement changes all three:
- a guest with the transfer statement as its leaf mode;
- a host that builds and batches its children;
- a verifier on the chain's side that discharges the deferred claim.

None of the three exists for another statement at the pin. Prediction 4 is scored when the research
owner has chosen whether that work is done here.

### Prediction 4, scored (2026-11-05)

The research owner chose to record the fold and not to build it here.

**Prediction 4 is shown wrong as stated: the fold was not written at leanVM's pin.** The reason is
the reading above. At `3cbac04`, leanVM's recursion is one statement's guest, host and native
verifier, built together, and a fold for another statement changes all three, the chain's verifier
among them. The fallback was measured in runs 2 to 4: one transfer a block, at about 231,000 gas a
transfer once the rollup's slots exist. A block of $n$ transfers would need $n$ leanSTARK
dependencies, which one transaction does not carry (`docs/leanvm-program-layout.md`), or a fold.
So the model's throughput is one transfer per block transaction. Whether a general same-program
recursion makes folding cheap is left open.

X19's record ends here. Seven of nine predictions held. Prediction 3 held for the aggregators and
the builder but not for the claim's taker, and prediction 4 is not written at the pin.
