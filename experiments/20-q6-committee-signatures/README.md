# Experiment 20 (Q6): committee signatures after a quantum computer

**Status: pre-registered 2026-11-04,** before any contract, runner, key or transaction. The
claim, the predictions, what would show each wrong and the plan are fixed here; results are added
below them, and nothing above the results is edited after a run.

**Why now.** Ethereum's post-quantum target is December 2028, as Justin Drake gave it at
Devcon 8; the September roadmap had December 2029. Every committee in these experiments signs
with a key a quantum computer could forge: threshold BLS12-381 in X5 (experiment 06) and X9
(experiment 14), and ECDSA in X11's attesters (experiment 16). This experiment gives each a
hash-based successor and measures what it costs and what it loses. The classical records stay as
they are; the runs here are new runs beside them.

## The claim

Every committee signature in these experiments has a hash-based successor that the chain checks
within its budget. A committee of $n$ members, $q$ of whom must sign, signs as $q$ named
leanSPHINCS signatures. Each is declared as an EIP-8288 dependency, and one recursive proof per
block, leanVM's aggregation, makes them all true. The contract's `VERIFY` checks only that the
declared dependencies name at least $q$ distinct members of its committee, on its message.

What this loses is recorded, not argued away:
- **The hidden signer set.** A threshold BLS signature does not say which members signed. Named
  signatures do: every observer learns which $q$ members signed each statement.
- **One key that outlives its members.** Experiment 08 reshared one BLS key to new committees
  without the chain noticing. A set of named keys has no reshare: a new member means a new key the
  contract must learn.

## What would show it wrong

Any one of these, in any arm:
- a committee check does not fit its budget: a `VERIFY` frame over the nodes' 500,000 gas with its
  declared dependencies counted, or a check whose transaction is not mined;
- a set below the quorum is accepted: fewer than $q$ named signatures, one member counted twice, a
  key outside the committee, or a signature on another message, admitted by a node or paid on chain;
- the block proof over a run's signatures cannot be built on the local chain on this machine.

## Two conditions, stated in every result

- **leanVM has no zero knowledge yet.** Nothing here claims privacy from a leanVM proof. The
  signer set is public by construction anyway, which is this experiment's loss.
- **EIP-8288 as written.** leanSPHINCS dependencies are valid at EIP-8288's master, so the local
  chain runs the EIP as written, with no extension. `LEANSTARK_SCHEME` is not used.

## The tools, pinned

As experiment 19 pinned them, and from its branch: leanVM at `3cbac04` with its leanSPHINCS
(32-byte keys, 7,740-byte signatures, "not the definitive parameter set"), experiment 19's
`prover/` built with `-C target-cpu=native`, `lean.ts`, and `local.ts` with `ethrex.sh` and
`ethrex-8288.patch`: ethrex at the test network's commit, `64b8fc09`, with EIP-8288's dependency
frame and block proof patched in.

## Arms

For each committee, a contract like the classical one, with its signature check replaced. The
committee's member keys are in the contract's code. A dependency frame (EIP-8288's mode 4) carries
the triples $(\mathtt{0x10}, m, \mathit{pk}_i)$; the contract's `VERIFY` requires at least $q$ of
them, each naming a distinct member, in increasing member order, on its message $m$.

1. **X5's result,** $q = 3$ of $n = 4$: experiment 06's `ResultBoard`, with $m$ the keccak256 of
   its fixed message (chain ID, request, result handle, value) under a domain tag.
2. **X9's reconciliation,** $q = 3$ of $n = 3$: experiment 14's `ExitVault`, with the threshold
   BLS check in `reconcile` replaced. Everything else in the vault is unchanged, and escape is
   opened with a stall and a redemption, as experiment 14's runner does.
3. **X11's settlement and slash,** $q = 3$ of $n = 4$: experiment 16's `ReadPool`, with its ECDSA
   quorum replaced for settlement and refund, and its slashing evidence, one member's two
   conflicting signatures, declared as two dependencies under that member's key.
4. **Refusals, for each arm:** two signatures of three; one member's signature declared twice; a
   key outside the committee; a signature on another message. Each must be refused at the node.
5. **Aggregation.** On the local chain, every block holding these transactions is proved by
   leanVM's aggregation before it is built on. Off chain, the prover aggregates 3 to 64
   signatures, to say how many committee statements an interval holds on this machine.
6. **The two losses, measured.**
   - For every mined committee transaction, which members an observer learns, against the
     classical record, where a BLS signature named none.
   - What replacing one member costs: a new contract or a key update, in gas, against experiment
     08's reshare, which changed nothing on chain.

Each arm runs on the local chain as EIP-8288 is written, and on the test network with EIP-8288
modelled, as experiment 19 did. On the test network, the triples travel in the `VERIFY` frame's
data, the signatures are checked and aggregated off chain by the prover, and the reported gas is
the measured gas plus 3,000 per declared leanSPHINCS dependency. Every figure says which.

## Predictions

| # | Prediction | Would show it wrong |
|---|---|---|
| 1 | Each named check fits: `VERIFY` uses under 60,000 gas of execution plus 3,000 per declared signature, against the classical check's cost in its record | a check over the budget, or over 60,000 plus the declared gas |
| 2 | Every refusal in arm 4 is refused at the node, on both chains | one admitted, or one paid |
| 3 | Every local block holding these signatures is proved by leanVM's aggregation within the local chain's slot | a block that cannot be proved, or not in time |
| 4 | An observer names the signers of every committee transaction, as the classical records named none | a committee transaction whose signers cannot be read from its own data |
| 5 | Replacing one member costs a deployment or a key update, measured in gas, where experiment 08's reshare cost nothing on chain | a member replaced without anything on chain changing |

## C3's case: a key that signs once per epoch (derived, not run)

The register asks for a threshold leanXMSS key for a committee that signs once per epoch, for
experiment 08's case. That construction exists, measured elsewhere, and is not public, so it is not
rerun here; its figures are cited in the project's own records, and here it is described only as
"a threshold leanXMSS construction, measured elsewhere".

- **The question:** which of experiment 08's signatures a key that signs once per epoch can make,
  and what it costs to give a new committee such a key, against experiment 08's reshare.
- **Expected, stated now:** it cannot make the ticket issuers' signatures, which are many per
  epoch; it fits one statement per epoch, such as a committee naming its successor. Re-keying a
  production-size key costs orders of magnitude more compute and bandwidth than experiment 08's
  reshare at 256 members (6.3 s of compute a member).
- **What would show it wrong:** a signature experiment 08 makes many times per epoch that the
  once-per-epoch key can make; or a re-keying no costlier than the reshare.

## Done when

X5's, X9's and X11's committee checks each have a post-quantum run on both chains, or a stated
reason; every refusal is recorded; and the two losses are measured, with C3's case written from
the cited figures.

## Results

**Run 1, 2026-11-04.** Code at `b9bab94`. Records: `results/1-local.json`,
`results/1-local-x9.json`, `results/1-testnet.json` and `results/1-testnet-x9.json`, one per
runner and chain; `results/1-bench.json` and `results/1-aggregation.txt` (arm 5). No member seed,
note or key is in any record; each runner refuses to write a record that contains one.

The two conditions hold for every figure here: leanVM has no zero knowledge yet, and EIP-8288 runs
as written (leanSPHINCS dependencies only; `LEANSTARK_SCHEME` unused).

**The chains.**
- *Local:* experiment 19's patched ethrex at `64b8fc09`, EIP-8288 setting `written`, dev mode
  (one block every 1,000 ms), base fee 7 wei, with `--mempool.max-verify-gas 500000`, the test
  network's value. That flag is needed by experiment 14's Groth16 redemptions, which open X9's
  escape, not by any named check. Each dependency's signature reaches the node as a witness file
  before its transaction. The builder aggregates a block's leanSPHINCS dependencies with leanVM,
  and the import path checks the aggregate against the block's triples.
- *Test network:* chain 8141, EIP-8288 modelled. The triples ride at the end of `VERIFY`'s data.
  Reported gas is the measured gas plus 3,000 per triple. Each mined transaction's signatures were
  aggregated and the aggregate verified off chain by the same prover.

Two things were set before run 1 and are stated here:
- **A keyed nonce needs state gas in `VERIFY`.** Every contract here is its own payer, and a
  fresh EIP-8250 nonce key costs 97,920 state gas from the `VERIFY` frame's limit. Experiment 16
  already set this; the first rehearsal of the result board did not, and every transaction was
  refused until it did.
- **`TIMEOUT` and `ESCAPE_WINDOW` are 10 blocks each** in X9's vault, on both chains. Experiment
  14 used its committee tool's values.

**Arms 1 to 3: the named checks.** In the table below, gas is execution gas, local / test
network; the dependency frame's declared price is excluded. "Total" is the whole transaction:
measured on the local chain, measured plus declared on the test network. The classical figures
are from each experiment's own record.

| Check | Signers | `VERIFY` | Declared | Total, local / testnet | Classical `VERIFY` |
|---|---|---|---|---|---|
| X5 result | 0, 1, 2 | 3,469 / 3,470 | 9,000 | 144,561 / 153,086 | 119,616 (BLS, experiment 06) |
| X5 result | 1, 2, 3 | 4,183 / 4,184 | 9,000 | 144,561 / 153,086 | |
| X5 result | all four | 4,663 / 4,667 | 12,000 | 150,705 / 162,230 | |
| X5 result, new board | 0, 2, new 3 | 3,945 / 3,946 | 9,000 | 144,561 / 153,086 | |
| X9 reconciliation | 0, 1, 2 | 10,691 / 10,698 | 9,000 | 160,628 / 160,160 | 126,738 to 129,038 (BLS, experiment 14) |
| X11 settlement, 4 tickets | 0, 1, 2 | 11,104 / 11,085 | 9,000 | 443,353 / 442,883 | 19,122 (ECDSA, experiment 16) |
| X11 refund | 1, 2, 3 | 11,725 / 11,706 | 9,000 | 443,184 / 442,690 | 18,955 |
| X11 slash, two batches | 1, 1 | 7,825 / 7,806 | 6,000 | 377,313 / 382,838 | 12,101 and 12,660 |
| X11 slash, batch and refund | 2, 2 | 6,681 / 6,662 | 6,000 | 169,137 / 174,662 | |

Every row was mined with every frame succeeding, on both chains.
- Totals differ between rows mainly by the state each transaction creates: a settlement or refund
  pays a fresh address and writes two fresh slots.
- The modelled total on the test network differs from the local measurement of the same
  transaction by $-470$ to $+8{,}525$ gas: within 500 for X9's reconciliation and X11's
  settlement and refund, and 5,525 or 8,525 higher for the slashes and X5's results.
  - Both totals include 3,000 per declared triple: locally as the dependency frame's charge, on
    the test network by the model.
  - The `VERIFY` frames' execution agrees within 20 gas.
  - The remainder is outside the frames, in what each chain charges for the transaction's bytes,
    and was not traced further. The model is close for these contracts but not exact.
- After the slashes, each slashed member's bond fell by the slash amount, as in experiment 16.

**Arm 4: the refusals.** These are 13 per chain, 26 in all:
- for each committee, two signatures of three; one member's signature declared twice; a key
  outside the committee as the third; and the third member's signature on another message;
- for X11 also a slash whose two triples are under two members' keys.

Every one was refused by the node on both chains ("validation prefix frame reverted"), and none
was mined or paid. A declared triple whose witness signs another message is a different case:
the node cannot prove the block. Experiment 19 measured that case as a bad block (arm 6 there),
and it is not repeated here.

**Arm 5: aggregation.**
- *Local blocks.* Nine local blocks held these signatures (eight in `1-local`, one in
  `1-local-x9`), with two to four dependencies each.
  - Every block's aggregate was built by the node, 2,458 to 2,711 ms per block, with a proof of
    246 to 275 KB.
  - Every block was checked valid on import, 2,341 to 2,513 ms per check, before the next was
    built on.
  - Each build and each check is a fresh prover process.
- *Off chain, warm* (`1-aggregation.txt`). leanVM's own aggregation on this machine (4 cores,
  15 GiB), three passes after a warm-up:
  - 3 signatures in 0.182 s, 16 in 0.257 s, 32 in 0.457 s, 64 in 0.824 s;
  - proofs of 240 to 290 KiB, verified in 13 to 18 ms.
- *Off chain, cold* (`1-bench.json`). The prover the node runs, one fresh process per call, on
  real committee signatures (one message, distinct keys):
  - 3 signatures in 2.64 to 2.73 s, 64 in 3.39 to 3.67 s;
  - verification 2.28 to 2.56 s.

  About 2.3 s of each cold call is fixed setup.
- *Signing* takes a member a median of 52.9 ms.

At the warm rate, one 1,000 ms interval holds at least 64 signatures on this machine: 21
statements of three signatures, or 16 of four.

**Arm 6: the two losses.**
- **The signer set.** Every mined committee transaction names its signers in its own data: the
  triples' keys, each one a member's key in the contract's code. That is 9 transactions per
  chain, and `observed` in each record lists them: for example `[0, 1, 2]`, `[1, 2, 3]`, all
  four, and `[1, 1]` for a slash. Experiments 06 and 14 recorded one BLS signature per
  statement, which names no member.
- **Replacing a member.** Member 3 of X5's committee was replaced by deploying a new board with
  the new key, 1,794,532 gas on each chain, plus 26,102 for its float. The new board then
  recorded a result signed by members 0, 2 and the new member 3. Nothing could be updated in
  place: the keys are in the code. The same holds for the other two contracts, whose deployments
  cost 5,943,813 gas (the pool, with its float) and 9,353,346 (the vault, with its float) on the
  local chain. Moving a vault's or pool's funds and state to a new deployment would cost more
  again, and was not measured. Experiment 08's reshare changed nothing on chain.

**Against each prediction:**
1. **Each named check fits: held.** The largest `VERIFY` used 11,725 execution gas, plus 9,000
   declared, against 60,000 plus the declared gas and the nodes' 500,000. The X5 result's check
   fell from 119,616 to under 4,700, and X9's reconciliation from about 127,000 to 10,698. Both
   now fit EIP-8141's 100,000, which no BLS check does. X11's check is about the same as its
   ECDSA quorum: 11,104 plus 9,000 declared, against 19,122.
2. **Every refusal is refused at the node, on both chains: held.** 26 of 26.
3. **Every local block is proved within the local chain's slot: not held as stated.** Every block
   holding these signatures was proved by leanVM's aggregation and checked valid before it was
   built on. But a cold proof took 2.5 to 2.7 s, against the dev chain's 1,000 ms interval, so the
   chain ran slower than its slot while proving. The warm aggregation of the same sizes takes
   0.16 to 0.19 s, within the slot, and the difference is the prover's fixed setup per process.
   What was pre-registered is the local chain as run, and on that it fails.
4. **An observer names the signers of every committee transaction: held.** 18 of 18, against
   none in the classical records.
5. **Replacing a member costs a deployment: held.** 1,794,532 gas for X5's board, where
   experiment 08's reshare cost nothing on chain.

**C3's case, derived.** The figures for a threshold leanXMSS construction, measured elsewhere,
are in the project's own records and not here.
- On those figures, the expected answer holds. A key that signs once per epoch cannot make
  experiment 08's ticket issuers' signatures, which are many per epoch. It fits one statement per
  epoch, such as a committee naming its successor.
- Giving a new committee a production-size key costs orders of magnitude more compute and
  bandwidth than experiment 08's reshare at 256 members (6.3 s and 14.8 MB from the largest
  member).
- That construction has no reshare like BLS's: a new committee means a new key.

**Done when: done.** X5's, X9's and X11's committee checks each ran on both chains; every refusal
is recorded; both losses are measured; and C3's case is written from the cited figures.
