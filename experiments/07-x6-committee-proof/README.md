# Experiment 07: a proving committee in place of an operator, and what it can still hold

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner, the offline checks and the results follow in later commits, and
the checks are pushed before the first transaction is sent.

**The claim.** TACEO's co-SNARKs let a committee compute together the proof that the user's own
device would compute. Three things follow:
- **For one user's action,** the operator disappears. The committee's proof is the proof the
  device would have made, so the node and the verifier see nothing that tells them apart.
- **For state that users hold together,** the committee itself is the transaction's sender. Its
  proof is checked in its own `VERIFY` frame, and a separate payer approves the fee. Nothing else
  is needed in the prefix.
- **Once the committee stops,** no user can move what the committee held for them. A user who
  still could would show "missing" wrong in the good direction.

**What would show it wrong.** Any one of these:
- the committee's withdrawal differs from a device-proved one in anything a node or the
  verifier sees, beyond the proof's own random points;
- the shared-state update needs more in its prefix than the committee's proof and a payer's
  approval;
- after the committee stops, a user can still move a balance it held.

**A stand-in, stated before the run.** TACEO's private-balance circuit is not public. The
shared-state update is therefore proved over the circuit the committee already proves: the
privacy pool's withdrawal circuit, from experiment 01. The committee's account keeps its own
copy of a note tree's root and a set of spent nullifiers. An update spends a note the committee
holds in shares, proved by the committee, and moves an internal balance to the proof's recipient.
This tests the sender, proof and payer shape that a committee's shared state takes on chain. It
does not test a balance circuit.

## Pieces

| Piece | Role |
|---|---|
| exp-e2e-frames `committee/co-withdraw` | three members proving with co-snarks over shares of a witness |
| kohaku-rs, `kohaku-witness-share` and `kohaku-frame-pool` | the wallet's side: a deposit, the witness in the committee's share format, and the withdrawal around the committee's proof |
| skandha | two nodes with frame transactions on. B alone hands transactions to the chain |
| chain | the ethrex Hegota testnet, chain 8141. Experiment 01's refund pool and the verifier it calls are reused |

Each is pinned at a full commit in `pins.json` when the runner lands.

## The plan

1. **Two nodes,** A and B, peered with each other only. Every transaction below is sent to
   node A, except deployments and deposits, which go to the chain directly.
2. **A withdrawal proved by the committee.**
   - A note is deposited into the refund pool.
   - Its witness is shared to three members, who prove it.
   - The withdrawal is sent and mined.
   - It is set beside a withdrawal the device proved alone, frame by frame: limits, gas, bytes
     and the verifier's answer.
3. **A shared-state update with the committee as sender.**
   - The committee's account is deployed.
   - A note it holds in shares is deposited.
   - The committee proves the update.
   - The account's `VERIFY` frame checks the proof and approves execution, and a payer's frame
     approves the fee.
   - It is mined.
4. **The committee stops.** Its members' processes end and their shares are deleted. The run
   then records what a user can still do:
   - with what the wallet kept;
   - with the chain alone;
   - with any one member's share.
5. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - whether it was mined, and if so its block, status, payer and gas by frame;
   - the members' messages and bytes per proof.

   It keeps no key, share or note secret.
