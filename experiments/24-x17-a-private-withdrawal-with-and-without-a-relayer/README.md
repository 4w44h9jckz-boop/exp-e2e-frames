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
