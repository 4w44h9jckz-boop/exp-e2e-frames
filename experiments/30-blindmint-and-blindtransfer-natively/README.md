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
2. **Run 3, after run 2 and before it ran.**
   - **Run 2 to case (f):** cases (a) to (f) came out as predicted (`results/2-purchase-gas.json`,
     kept as the record of run 2).
   - **Where run 2 stopped:** at case (d), the first time two payouts under one key shared a
     block. The node built that block and then refused to import it, block after block, with
     "World State Root does not match". Neither payout was ever mined, and the runner timed out.
   - **Why.** This chain's client validates a block by executing its transactions in parallel,
     seeding each one from the block's access list (EIP-7928).
     - The patch recorded every write it made there, but not the slots and accounts it read.
     - So in validation, the second payout's read of `minted` was not seeded, and it saw the
       count from before the block. It paid, where the builder had refused it, and the roots
       differed.
   - **The change:** each slot the operations read is now marked accessed and recorded in the
     access list, as `SLOAD` records it, and each account they read as `BALANCE` records it. The
     semantics and the schedule are unchanged. `ethrex-blind.patch` is regenerated, and the
     binary rebuilt.
   - **What it shows:** a native operation with state must declare everything it reads to the
     block access list, or a parallel validator replays it on stale state. A specification of
     such an operation has to say what it reads, as `SPEC.md`'s "State" now implies.
3. **Run 4, after run 3 and a diagnostic, before run 4 ran.** Deviation 2's diagnosis was
   incomplete.
   - **Run 3** (`results/3-access-list.json`, kept as its record) came out as predicted to case
     (f). It then stopped at case (d) in the same way as run 2.
   - **The diagnostic.** A run with the client's parallel validation switched off
     (`ETHREX_NO_BAL_PARALLEL_EXEC`; its output is not a result and is not kept) passed (d): both
     payouts in block 36, one paid and one refused. It ran to the end, and broke invariant (i).
   - **The fault, read from that run's counts.** Whenever the escrow's balance reached zero, its
     counts read 0 and 0 afterwards. That happened after (d) and after the last batch.
     - The escrow account has no code. At a zero nonce and a zero balance it is empty under
       EIP-161, so the client removes it, and with it the storage that holds the counts.
     - (d) is the first case to bring the escrow to zero, with its first payout in the same block
       as the second. A sequential validator removes the account just as the builder did. A
       parallel validator, which rebuilds state from the block's access list, cannot express the
       removal of an account that holds storage, so its root differs.
   - **The change.** The escrow's nonce is set to 1 at the first purchase, as `SPEC.md` already
     does for the serial account. It can then never be empty.
     - This is a change to the specification, recorded in `SPEC.md` with its date.
     - Deviation 2's access-list declarations stay, since they are needed regardless.
     - The schedule is unchanged.
   - **What it shows:** protocol state kept in a codeless account must keep that account
     non-empty, or EIP-161 deletes the state the first time the account's balance reaches zero.
4. **Run 5, after run 4 and before run 5 ran.**
   - **Run 4** (`results/4-escrow-alive.json`, kept as the record under the client's default
     validation) came out as predicted through case (g) and the first three steps of (h). That
     includes (d): both payouts in one block, one paid.
   - **Where it stopped:** the prune. The node built the block and refused to import it:
     "BAL validation failed for tx 0: account 0xd548...3848 nonce changed by execution (0) but BAL
     has no nonce change". That account is `chi2`'s serial account.
   - **Why.** The prune clears the serial account's nonce and its whole storage at the
     transaction's end. A block access list (EIP-7928) records changes slot by slot and has no way
     to say "this account's storage was wiped". So a validator that executes from the list finds
     changes the list does not name. The same limit is why EIP-6780 keeps such a wipe to accounts
     created in the same transaction.
   - **The change, for the record of the semantics only:** run 5 repeats the experiment with the
     client's parallel validation switched off (`ETHREX_NO_BAL_PARALLEL_EXEC=true`), so that
     pruning and invariant (i) can be observed. Nothing else changes.
   - **How it is read.** Run 4 is the result under the default validation. Run 5 is the
     semantics under sequential validation. Pruning by dropping the account whole is not valid on
     a chain whose blocks carry an access list. There, every pruned serial must be named, as a
     write of zero, which makes the cost linear in the number of serials. The serials are in the
     trie, so the protocol can find them, but each must be named.

## Results

**Five runs, 2026-11-11.** The client is ethrex `64b8fc09d` with three patches:
`ethrex-8288.patch`, `ethrex-writes.patch`, and `ethrex-blind.patch` at its final state,
`cde6563b376b` (sha256 prefix).

| Run | Validation | Record | How far it got |
|---|---|---|---|
| 1 | default | none | stopped at its first purchase, for gas (deviation 1) |
| 2 | default | `results/2-purchase-gas.json` | (a) to (f) as predicted; stopped at (d) (deviation 2) |
| 3 | default | `results/3-access-list.json` | the same; stopped at (d) (deviation 3) |
| 4 | default | `results/4-escrow-alive.json` | everything as predicted through (g) and the first three steps of (h); stopped at the prune (deviation 4) |
| 5 | sequential | `results/5-sequential-validation.json` | every case, to the end |

Runs 4 and 5 agree case for case, and gas for gas, up to where run 4 stopped.

### Outcomes

Every one was as predicted, with one exception, in (h).
- **(a) Paid.** The count went to 1 of 4, the escrow fell by D, and the fresh recipient received D.
- **(b) Refused,** both forms: the spent serial, and a batch naming one serial twice.
- **(c') The forged signature was refused** by the pairing, with purchases left under the key.
- **(e) The reverting contract was paid.** The payment runs no code at the recipient, so the
  count equals what was paid.
- **(f) Both copies were refused,** then the original was paid:
  - (f1), the recipient changed with the one-time key's signature kept;
  - (f2), the attacker's own one-time key.
- **(d) Both payouts landed in block 36 and exactly one was paid,** on the first attempt. This
  held under the default validation from run 4 on, once the escrow could no longer empty.
- **(c) Refused by the count:** 4 bought, 4 paid when it was sent.
- **(g) Every batch was paid,** with each recipient credited D.
- **(h) Pruning:**
  - the prune before the end was refused;
  - after the end, the payout and the purchase were refused;
  - the prune succeeded under sequential validation (run 5), and the second prune and the payout
    after it were refused;
  - `eth_getProof` for the serial account then shows it gone: nonce 0, balance 0, the empty
    storage root, and both spent serials 0.
  - **The exception:** `eth_getStorageAt` still returns 1 for both serials. This client's direct
    storage reads disagree with its own trie after an account that existed before the
    transaction is wiped whole. The prediction holds by the proof and fails by the plain read.
  - **Under the default validation (run 4),** the prune's block was refused at import, as
    deviation 4 records.
- **(i) The invariant holds.** The escrow holds D, the one unpaid ticket under `chi2`. The counts
  are 43 of 43 under `chi1` and 2 of 3 under `chi2`.

### Gas

The node logged the precompile's charge for every operation, and every charge equals
`SPEC.md`'s schedule exactly. For example:
- a purchase: 22,200 for a new key and 5,100 for an existing one;
- the prune: 25,000;
- (a): 204,950, which is one ticket plus the serial account's creation plus a fresh recipient.

The pre-registration's table put a single payout at 155,000, where the schedule gives
$109000 + 45950 = 154950$, a slip of 50 in the table and not in the schedule. The batches, the
same in runs 4 and 5:

| Batch | Recipients | Receipt `gasUsed` | Per payout | Precompile per payout | The transaction's own gas |
|---|---|---|---|---|---|
| 1 | fresh | 202,230 | 202,230 | 179,950 | 22,280 |
| 2 | fresh | 275,360 | 137,680 | 125,450 | 24,460 |
| 3 | fresh | 348,502 | 116,167 | 107,283 | 26,652 |
| 4 | fresh | 421,620 | 105,405 | 98,200 | 28,820 |
| 8 | fresh | 714,152 | 89,269 | 84,575 | 37,552 |
| 16 | fresh | 1,299,168 | 81,198 | 77,763 | 54,968 |
| 1 | existing | 177,242 | 177,242 | 154,950 | 22,292 |
| 4 | existing | 321,644 | 80,411 | 73,200 | 28,844 |

- **The transaction's own gas** is the receipt less the logged charge: about 20,100 plus about
  2,180 for each ticket's 137 bytes. That is a little under the 21,000 plus calldata the
  pre-registration assumed.
- **Under 100,000 a payout, in the receipt:** from 8 tickets with fresh recipients (89,269) and
  from 4 with existing ones (80,411). Four tickets to fresh recipients came to 105,405, where the
  pre-registration said about 107,000.
- **The precompile alone** is under 100,000 from 4 tickets with fresh recipients, as predicted.

### How it reads

- **The count and the spent set are enforced by the protocol.**
  - Every case came out as the rules say.
  - The invariant holds.
  - A recipient cannot make the count and the payment disagree, since the payment runs no code.
- **A payout checked in a batch under one key costs under 100,000 gas,** from 8 tickets to fresh
  recipients or 4 to existing ones. That figure is mostly the experiment's own schedule: the client
  charged it exactly, and what the run adds is the transaction's own gas around it.
- **Pruning by epoch works only where a block is validated by running it in order.**
  - On a chain whose blocks carry an access list (EIP-7928), the serial account cannot be dropped
    whole. The list has no entry for wiping an account's storage, so each pruned serial must be
    named as a write of zero, and pruning costs grow with the number of serials.
  - The serials are in the trie, so the claim's own falsifier, "pruning needs state the protocol
    does not keep", is not met.
  - But the cheap drop of a whole epoch that motivated a native version is not available.

**Three things the deviations found, each needed by any native operation with state on this
chain:**
- **The account that holds its state must never be empty,** or EIP-161 deletes the state with it
  (deviation 3).
- **It must declare every slot and account it reads to the block access list,** as `SLOAD` and
  `BALANCE` do (deviation 2).
- **It cannot delete storage wholesale** (deviation 4).

### Beside the contract version

The same account built from today's pieces is `exp-frames` experiment 59 (`exp/59-blind-account`
at `3a9fa7f`, run on the test network on 2026-11-11). It is quoted from that README and not rerun
here.

| | Contract (experiment 59) | Native (here) |
|---|---|---|
| Checking one ticket | 124,677 execution in `VERIFY` | 117,750 of the schedule: the pairing, hash to G1, `ecrecover` |
| Each extra ticket's check in a batch | about 16,100 | 14,850 |
| Largest batch | 5, capped by state gas | 16 run, no cap met |
| Recording a serial | 97,920 state gas (a keyed nonce's first use) | 22,100 (a slot, at pre-EIP-8037 prices) |
| A fresh recipient | 183,600 state gas | 25,000 (pre-EIP-8037 price) |
| One payout to a fresh address, whole | 550,385 | 202,230 |
| A reverting recipient | credited, and claimed later | paid; no code runs |

**The two checks cost about the same.** The pairing dominates both, and both check a batch with
one pairing.

**The totals are not like for like.** The contract pays this chain's EIP-8037 state gas for a
new slot and a new account. The native schedule prices them at the older rates, as `SPEC.md`
chose. So most of the gap between 550,385 and 202,230 is that choice of state price, not
nativeness.

**What the native version does that the contract does not:**
- it keeps the count and the payment in one step, with no code at the recipient;
- it batches past the contract's cap of 5;
- it records a serial as a slot, not as a keyed nonce.

The pruning it was meant to add is not available on a chain with block access lists.
