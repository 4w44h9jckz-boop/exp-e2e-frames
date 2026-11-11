# Experiment 30: BLINDMINT and BLINDTRANSFER, natively, on the local chain

**Status: pre-registered 2026-11-11,** before any code: the ethrex patch, the runner and the
issuer. Results are added below. Nothing above them is edited after a run; a change of plan before
the run is recorded as a deviation.

## The question

A blind account escrows ether under a key and pays a ticket, signed blindly by an issuer, to any
address. It pays only while fewer tickets have been paid under that key than were bought. Today
this can be built from EIP-2537's pairing check, an EIP-8141 `VERIFY` frame and an EIP-8250
single-use nonce key. A separate experiment in `exp-frames` builds that contract version on the
test network.

This experiment asks what the same account costs and guarantees when its rules are native
operations, with the escrow, the two counts and the serial set as protocol state.

**Claim:** natively, the count and the spent set are enforced by the protocol, the spent set can
be pruned by epoch, and a payout checked in a batch under one key costs less than 100,000 gas.

**Would show it wrong:** a payout still costs more than 100,000 gas when batched, or pruning needs
state the protocol does not keep.

## What is built

- **The semantics:** `SPEC.md`, written before the code. There are three precompiles:
  - `BLINDMINT` takes a purchase;
  - `BLINDTRANSFER` pays a batch of tickets under one key;
  - `BLINDPRUNE` drops a closed epoch's serials.
- **The client.** The local ethrex, at the test network's commit `64b8fc09d`, with
  `ethrex-8288.patch` and `scripts/ethrex-writes.patch`, plus a new working-tree patch,
  `scripts/ethrex-blind.patch`. It adds the three precompiles to the VM with access to its state.
  - The patch's files are written to `work/ethrex`, built into a separate binary,
    `work/ethrex-bins/ethrex-8288-writes-blind`, and then removed from the tree, so the standard
    binary is unchanged.
  - `work/` is never committed. ethrex is MIT or Apache-2.0.
  - The precompiles use ethrex's own `blst` for BLS12-381 and its own `ecrecover`.
- **The issuer:** a single BLS12-381 key in TypeScript, with `@noble/curves`. It hashes with the
  same suite and `DST`, and blind-signs: the buyer sends `r * H(m)`, and the issuer returns
  `sk * r * H(m)`.
  - A threshold committee would give the same signature under one G2 key. The precompile cannot
    tell the two apart, so the committee is out of scope here.
- **The runner,** `run.ts`, starts the local chain on the separate binary, at chain id 8141 with a
  genesis that funds test accounts. Those keys are secp256k1 test keys derived from public labels.
  This is not a post-quantum run.
- **Sending:** purchases and payouts are ordinary EIP-1559 transactions sent straight to the
  precompile addresses.
- **Two keys:**
  - `chi1`, whose epoch ends far ahead, for the cases and the batches;
  - `chi2`, whose epoch ends about 40 blocks after its purchases, for pruning.

  `D` is 0.01 ether.

## Cases

Each case records its receipt, the counts before and after, the escrow's balance, and the
recipient's balance.

- **(a) An honest payout,** one ticket.
- **(b) The same ticket twice.** First as a second transaction after (a); then as one batch that
  lists one serial twice.
- **(c) A ticket the issuer signed with no purchase behind it,** sent when `minted = burned` under
  its key.
- **(c') A forged ticket:** a signature no issuer made, a random G1 point.
- **(d) Two payouts under one key in one block,** each a valid ticket, with one purchase left.
  Both are sent before the next block. If they land in different blocks, the case is repeated, up
  to three times, and every attempt is recorded.
- **(e) A payout to a recipient whose code reverts on any call.**
- **(f) A redirected copy:**
  - (f1) a copy of a payout with the recipient changed and the one-time key's signature kept;
  - (f2) a copy whose one-time key is replaced by the attacker's, signed by it.

  After both, the original is sent.
- **(g) Batches** of 1, 2, 3, 4, 8 and 16 tickets under `chi1`, each paid in one transaction.
  - Every batch's recipients are fresh, empty addresses.
  - Batches of 1 and 4 are repeated with recipients that already exist, so the price of creating
    an account is shown on its own.
- **(h) Pruning under `chi2`:**
  - a prune before `end`;
  - after `end`: a payout, a purchase, the prune, a second prune, and a payout after it;
  - then each spent serial's slot read back, and `eth_getProof` for the serial account.
- **(i) The invariant,** checked at the end: the escrow's balance equals the sum over keys of
  $D \cdot (\mathit{burned} - \mathit{minted})$.

## Measures

- **Each case's outcome:** paid or refused, from the receipt's status and the state read after.
- **Gas, in three figures for each payout transaction:**
  - the receipt's `gasUsed`;
  - the transaction's intrinsic and calldata gas, from the raw transaction;
  - the precompile's own charge, which the patch writes to the node's log.

  Each is divided by the batch size. The intrinsic and calldata gas are reported apart from the
  precompile's charge.

## Predictions, written before the run

1. **Outcomes:**
   - (a) paid;
   - (b) both forms refused;
   - (c) refused by the count;
   - (c') refused by the pairing;
   - (d) both in one block, exactly one paid;
   - (e) paid, with the count equal to what was paid, since the payment runs no code;
   - (f1) and (f2) refused, then the original paid;
   - (h) the early prune is refused; after `end`, the payout and the purchase are refused, the
     prune succeeds, and the second prune and the later payout are refused. Every spent serial's
     slot reads 0 afterwards, and the serial account is gone;
   - (i) the invariant holds.
2. **The precompile's charge for each payout follows from `SPEC.md`'s schedule.**
   - With existing recipients it is $109000/n + 45950$:

     | $n$ | Gas a payout |
     |---|---|
     | 1 | 155,000 |
     | 2 | 100,450 |
     | 3 | 82,283 |
     | 4 | 73,200 |
     | 8 | 59,575 |
     | 16 | 52,763 |

   - With fresh recipients it is 25,000 more for each payout.
   - The first payout under a key adds 25,000 once, for the serial account.

   So the precompile alone is under 100,000 from $n = 3$ with existing recipients, and from
   $n = 4$ with fresh ones.
3. **With the transaction's intrinsic gas** (21,000) **and calldata** (about 384 bytes, plus 137
   for each ticket) added, the receipt's `gasUsed` divided by $n$ is about
   $136000/n + 47850$ with existing recipients, and 25,000 more with fresh ones. So it is under
   100,000:
   - from $n = 3$ with existing recipients, about 93,000;
   - with fresh recipients, only from $n = 8$, about 90,000. At $n = 4$ it is about 107,000.

## How the result is read, fixed now

- **The claim holds** if:
  - every case's outcome is as predicted;
  - pruning removes the serials with no state beyond the counts and the epoch's end, which the
    call itself carries;
  - some batch size gives a payout under 100,000 gas in the receipt.
- **The claim is wrong** if:
  - no batch size up to 16 gets under 100,000 in the receipt;
  - or pruning needs state the protocol does not keep;
  - or a case breaks the count.

**What this measures and what it does not.** The precompile's charge comes from a schedule this
experiment chose, built from the prices of the operations each step replaces, so it is a priced
model rather than a discovery. The run's evidence is:
- that a client can enforce these rules;
- that the cases come out as the rules say;
- what a transaction pays around the precompile's charge;
- that pruning by epoch works on a real state trie.

## Limits

- **One issuer key,** not a committee.
- **Who pays a payout's gas.** Here a funded test account does, which would link it. The
  specification leaves this open.
- **Pruning is tested at small sizes.** It deletes an account's whole storage at once, the
  unbounded deletion EIP-6780 removed from `SELFDESTRUCT`. A real version must bound it.
- **Not post-quantum:** BLS12-381.
- **Escrow left after an epoch closes is locked,** as the specification says.
- **A local chain only.** These are not proposed changes to any client.

## Files

- `SPEC.md`: the semantics, written before the code.
- `run.ts`: the runner.
- `results/`: each run's JSON.
- `../../scripts/ethrex-blind.patch` and `../../scripts/ethrex-blind.sh`: the client patch and its
  build.

## Deviations

1. **Run 2, after run 1 and before it ran.**
   - **What stopped run 1:** its first purchase, `BLINDMINT` under `chi1`, failed with all 200,000
     of its gas used. The node's log shows no `blind:` line for it, so it never reached the
     operation.
   - **Why:** the purchase sends value to the escrow account, which does not exist before the
     first purchase. Under EIP-8037 that costs the new-account state gas, $120 \cdot 1530 =
     183600$, before the precompile runs. With 21,000 intrinsic gas and the calldata, that is over
     the runner's limit. Every later case was then refused by the count, as it should be with
     nothing bought.
   - **The change:** purchases get a 500,000 gas limit. A limit is the runner's choice, not the
     specification's, and nothing else changes. Run 1 was stopped there, its node was stopped,
     and it wrote no results file.
   - **What it shows:** the first purchase under the whole scheme pays to create the escrow
     account. A real version would create that account at the fork.

## Results

Not yet run.
