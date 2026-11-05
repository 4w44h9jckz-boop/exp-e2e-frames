# Experiment 24 (X17): a Tornado Cash withdrawal with a relayer, and without one

**Status: pre-registered 2026-11-05,** before any code, contract, runner or transaction.
Predictions, what would show each wrong, and the deviations are fixed here. Results are added below
them, and nothing above the results is edited after a run.

## The question

A user who withdraws from a privacy pool to a fresh address has no ETH there to pay for gas. Today
someone else submits the withdrawal and pays for it, and takes a fee from it: a relayer for Tornado
Cash, a broadcaster for Railgun. With frame transactions
([EIP-8141](https://eips.ethereum.org/EIPS/eip-8141)) the pool can instead send its own withdrawal
and pay for it from the note, and any node can relay it.

This experiment asks whether that is better for the user in fact, on three counts:
- what the withdrawal costs;
- who can stop it;
- what it leaves on chain.

It compares the deployed design, measured, with the same circuit and tree paying for itself. A
second deployed pool's own path is quoted beside them.

## Design

### Three arms

| Arm | What | Who sends and pays |
|---|---|---|
| A | Tornado Cash as deployed: experiment 19's version 4, a MiMC tree over BN254 and its Groth16 verifier, built from `tornado-core` by experiment 19's `tornado.sh` | a relayer's account, which takes a fee from the note |
| B | the same circuit, verifier and tree in a pool that checks the proof in its own `VERIFY` frame, pays from the note, and uses the nullifier hash as its EIP-8250 nonce key | the pool itself |
| R | Railgun, quoted: its unshield path and its broadcasters, from Railgun's own documentation, with the gas of unshield transactions read from mainnet receipts | a broadcaster, or an address holding ETH |

Arm B changes nothing in the statement a withdrawal proves. Only the contract around the
verifier changes: it gains a `VERIFY` path, and the nullifier lives as a nonce key rather than in a
mapping.

### Where

- The Hegota test network, through two connected skandha nodes. Node A receives each withdrawal;
  node B only what A relays.
- Each node is judged under the test network's profile and under EIP-8141's own rules, as
  experiment 23 composes them.

### Measures

- Per withdrawal:
  - gas, execution and state;
  - what the user gives up from the note: the fee in arm A, gas in arm B;
  - every account the mined transaction names.
- Per arm, who can stop a withdrawal:
  - which party, if it refuses, leaves the user with no other path short of holding ETH;
  - which nodes or parties the transaction passed through.
- For arm R, from primary sources only:
  - the broadcaster's fee rule;
  - the unshield's gas on mainnet, over the receipts read, with their block range.

## Predictions

1. **Same work, no fee.** Arm B's withdrawal costs at most 10% more gas than arm A's, since the
   Groth16 check and the nullifier dominate both. The relayer's fee is gone.
2. **Open nodes carry it, on the test network's rules only.** Under the test network's profile, both
   nodes admit arm B's withdrawal and it is mined. Under EIP-8141's own rules it is refused for its
   validation gas, over 100,000. Arm A's plain transaction is admitted under both.
3. **One relayer, one address.** On chain, arm A's transaction names the relayer's account as its
   sender and payer, so one relayer's withdrawals share an address. Arm B's names only the pool and
   the recipient.
4. **Who can stop it.**
   - In arm A, a user whose fresh address holds no ETH has no path if every relayer refuses.
   - In arm B, either node alone gets the withdrawal into a block, under the test network's
     profile.
5. **Railgun is arm A's shape.** Railgun's documentation describes an unshield sent by a
   broadcaster or by an address that holds ETH, and no path with neither.

## What would show it wrong

| Prediction | Shown wrong if |
|---|---|
| 1 | arm B's withdrawal costs more than 1.10 times arm A's |
| 2 | arm B is refused under the test network's profile, or admitted under EIP-8141's own rules; or arm A is refused under either |
| 3 | arm B's mined transaction names any account but the pool and the recipient; or arm A's does not name the relayer |
| 4 | arm A's user reaches a block with no relayer and no ETH; or arm B needs a particular node |
| 5 | Railgun's documentation describes an unshield path that needs neither a broadcaster nor an address holding ETH |

## Deviations, stated before the run

- **Arm B is a redeployment.** The deployed Tornado Cash contracts cannot send their own
  transactions, so arm B tests the design, not the deployment. A deployed pool would need a new
  contract, and its users would need to move to it.
- **Relayer fees are a market.** Arm A's fee is set to a value Tornado Cash's own relayer
  configuration allows, and the record gives its source. Gas is compared directly.
- **Arm R is quoted, not run.** Its fees and paths are Railgun's own statements.
- **No network-level privacy.** Who sees the user's network address is the same question in both
  arms: a relayer, or the first node. It is recorded, not measured.
- **The test network's rules are not mainnet's.** Prediction 2 states both on purpose.

## Path

`pool/` (arm B's contract), `run.ts` (arms A and B), `railgun.ts` (arm R's receipts), and results in
`results/`, each with its commit, command and inputs. Tornado Cash's GPL-3.0 code is built by
experiment 19's `tornado.sh` into the ignored `build/` and is not copied here.

## Amendment 1, 2026-11-05, before any code

[exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) experiment 30 had already priced the
relayer against the no-relayer path, and it was not read for the pre-registration above:
- **on mainnet,** every withdrawal from Tornado Cash's four ETH pools and Privacy Pools' ETH pool
  over 30 days (blocks 25,972,879 to 26,188,878): 10,085 withdrawals, 85% relayed, and notes paid
  224.51 ETH in fees where the same withdrawals with no relayer would have cost 4.65 ETH. Its
  median fee per pool is 3.6 to 729 times the no-relayer cost;
- **on the test network,** its `RefundPool`, a pool that sends and pays for its own withdrawal and
  refunds the fee's surplus in a last frame: 579,661 gas, the note paying 1.023 times its gas.

So this experiment takes the fee side from it rather than setting a fee, and runs only what
experiment 30 did not.
- **Arm A's fee** is experiment 30's measured median for each pool, cited, not configured. The
  deviation "Relayer fees are a market" is replaced by that.
- **Arm B** borrows `RefundPool`'s layout: the fee floor at the maximum cost, and the last frame
  that refunds the surplus. It reads the root from the pool's own storage, not through EIP-8272,
  so that EIP-8141's own rules judge the validation gas alone. Its frames are `[pool VERIFY,
  pool SENDER withdraw, pool DEFAULT refund]`.
- **Prediction 1 is unchanged.** It compares gas on the test network, arm A's relayer withdrawal
  against arm B's.
- **Arm R** reads Railgun's documentation itself. Experiment 30 quotes it as checking the
  broadcaster's fee note against "a previously advertised rate * the estimated gas".

No prediction or "what would show it wrong" changes.

## Results, run 1

Recorded 2026-11-05: arms A and B in [`results/1-first-run.json`](results/1-first-run.json), at
`0c7a459` with the deposit's gas fixed in the next commit, deployment `d2`, test-network blocks
699,880 to 699,903; arm R in [`results/1-railgun.json`](results/1-railgun.json), mainnet blocks
26,340,455 to 26,347,654. A first pass under deployment `d1` stopped at arm A's deposit, which
reverted at 1,500,000 gas against Hegota's state gas; nothing was withdrawn, and `d1`'s three
contracts are left unused. Every proof was checked by snarkjs before it was sent.

### Predictions

| # | Prediction | Outcome |
|---|---|---|
| 1 | same work, no fee | **held.** Arm B's withdrawals used 554,614 and 552,956 gas against arm A's 564,729: 0.982 and 0.979 times. No relayer was paid |
| 2 | open nodes carry it, on the test network's rules only | **held.** Node C, under skandha's `eip-8141.json`, refused arm B's withdrawal with `ErrFrameVerifyGas` (FP-6): its `VERIFY` used 227,356 execution gas against 100,000. Nodes A and B, under the test network's profile, admitted both, and each was mined. Arm A's plain transaction was admitted by the execution client's own pool; EIP-8141's rules are for frame transactions and do not apply to it |
| 3 | one relayer, one address | **held.** Arm A's mined transaction names the relayer's account as sender and payer, the pool, and the recipient. Arm B's names only the pool, as sender, payer and every frame's target, and the recipient |
| 4 | who can stop it | **held.** Arm A's recipient, holding no ETH, could not send its own withdrawal: "Account does not have enough balance to cover the tx cost". Arm B's first withdrawal went to node A with B up, and B received it by gossip; the second went to node B with A stopped, and was mined |
| 5 | Railgun is arm A's shape | **held,** on Railgun's own documentation, below |

### What each note gave up

| Arm | Withdrawal | Gas | Charged (wei) | The note gave up (wei) |
|---|---|---:|---:|---:|
| A | the relayer's | 564,729 | 4,517,832, paid by the relayer | 20,800,000,000,000, the relayer's fee: 208 basis points, experiment 30's median on the 0.1 ETH pool |
| B | the first | 554,614 | 4,436,912, paid by the pool | 4,545,488: the fee of 200,000,000 less a refund of 195,454,512 |
| B | the second, the pool's last note | 552,956 | 4,423,648, paid by the pool | 200,000,000: **no refund** |

The effective gas price was 8 wei throughout, so the charges are tiny in absolute terms. The
relayer's fee is a share of the note; arm B's cost is gas.

### Found

- **The pool's last note loses its refund.** The refund frame runs while the transaction's
  maximum cost is still reserved from the pool's balance: 726,520 gas of limits and the intrinsic
  gas, at a maximum fee of 100 wei. With no other note's funds in the pool, that left less than
  the refund owed, so the refund's call failed and the frame stopped. The second withdrawal's
  refund frame used 9,758 gas against the first's 11,428, the difference being the log it never
  reached. After the transaction the unused reservation came back to the pool, which now holds
  195,684,928 wei that belong to nobody. exp-frames experiment 30's `RefundPool` has the same
  structure, and its measured withdrawal was not its last note. A pool that keeps a float, or a
  refund that the protocol pays out after the reservation is released, would avoid it.
- **The cost of the proof check is what EIP-8141's own rules refuse.** Arm B's `VERIFY` is the
  Groth16 check and the root lookup, 227,356 gas. Nothing else in the transaction is over any
  limit.
- **Relaying worked.** Node A gossiped arm B's first withdrawal to node B, and either node alone
  got a withdrawal into a block.

### Arm R: Railgun

From docs.railgun.org, read 2026-11-05:
- "Community Broadcasters are public 0x wallets that submit gas to the underlying blockchain on
  RAILGUN privacy users' behalf. Actions coming from 0zk addresses appear to originate from
  Broadcaster addresses." (`wiki/learn/privacy-system/community-broadcasters`)
- The broadcaster checks a fee note "against a previously advertised rate * the estimated gas of
  the transaction" (the same page), and "Users pay a small premium on top of the gas cost"
  (`developer-guide/wallet/broadcasters`). Unshields also pay a protocol fee of 0.25%
  (`developer-guide/wallet/transactions/unshielding`).
- The one path without a broadcaster is "an owned public wallet to self-sign a transaction",
  which the docs fund "with gas using a Base Token Unshield"
  (`developer-guide/wallet/transactions/ux-private-transactions`).
- The EIP-7702 flow, marked "Status: Released", still has the transaction sent by "a broadcaster
  or the user's own public wallet" (`wiki/learn/integrating-railgun/eip-7702-integration`).
- No page read describes a path with neither. The Adapt Modules page does not say who submits or
  pays.

From mainnet receipts, 7,200 blocks: 231 transactions emitted 271 `Unshield` events, from 39
distinct senders, the busiest sending 30.3% of them. Their median gas was 1,275,684, from 517,429
to 10,700,171, since an unshield is often one step of a larger transaction. A broadcaster and a
self-signing user are both plain senders on chain and are not told apart here.
