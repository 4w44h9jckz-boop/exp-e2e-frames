# Experiment 07: a proving committee in place of an operator, and what it can still hold

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner and the offline checks are in the same commit as this status
line, pushed before the first transaction. The plan was made concrete in that commit; the
changes are listed under "Amended before the first transaction" at the end.

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
copy of a note tree's root, and the chain's own nonce keys serve as its set of spent nullifiers.
An update spends a note the committee holds in shares, proved by the committee, and moves an
internal balance to the proof's recipient.
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

## Amended before the first transaction

The runner (`run.ts`), its Rust half (`rust/`), the account (`contracts/CommitteeAccount.yul`)
and the checks (`test/x6.test.ts`) make the plan concrete. Where they differ from the plan's
words above, this is what runs:

- **No deposit for the stand-in.** The account's tree is three fresh notes that exist only
  off chain. Its root is appended to the account's code at deployment, and the committee holds
  the second note in shares. So step 3 deploys the account and funds a fresh payer in one
  transaction, and deposits nothing.
- **The spent set is the nonce-key table.** The update's only EIP-8250 nonce key is the note's
  nullifier hash, at sequence 0. The account's `VERIFY` checks that, and stores nothing.
- **The account's ledger.** One unit is credited to the proof's recipient, in a mapping the
  account keeps. The proof's relayer, fee and refund must be zero.
- **Step 4, made concrete.** A third note is deposited into the refund pool, and its witness
  shared, but it is never proved. Two members' shares are deleted. Member 0 is then started
  alone with its share, with a time limit, and its exit is recorded; then its share is deleted
  too. The run records which files the wallet kept, and sends node A the note's withdrawal with
  256 zero bytes in place of the proof: what the chain alone allows.
- **The device's withdrawal** is kohaku-rs's `refund_withdrawal`, which proves on this machine
  and prices its limits from a simulation. The committee's is built by the runner from
  `share_withdrawal`'s output at the pool's default limits, with the worst-case fee. The two are
  compared field by field as the plan says. Any difference shows the claim's first condition
  wrong, whatever its cause.

