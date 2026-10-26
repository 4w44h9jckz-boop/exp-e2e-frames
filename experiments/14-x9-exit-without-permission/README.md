# Experiment 14: an exit that nobody's permission opens, for a committee that holds state

**Status: claim, what would show it wrong and the plan only.** This README is committed before
any code, contract or transaction. The construction is chosen next, by the committee's and the
wallet's builders, and committed before the first transaction, as in experiments 05 to 13.

**Why.** Experiment 07 ran a committee that holds users' notes in shares, with its proof checked
in its own `VERIFY` frame. Once that committee stopped, nothing moved the note it held. TACEO's
design for private payments has the same shape, and TACEO proposes an escape hatch for it, in
"Escape hatches in MPC, and who may open them" (core.taceo.io, 2026-08-03):
- on every transfer, the network publishes each new note's opening, encrypted to its owner;
- if the queue of intents stalls for a fixed time, the contract changes mode by itself;
- each user then redeems their own note alone.

This experiment builds that shape in frames and asks whether frames add what such an exit needs:
a redemption that no relayer and no committee member takes part in.

**The claim.** With frame transactions, a committee that holds users' notes can be made unable to
hold them hostage:
- **Normal mode.** Users queue intents on chain. The committee processes the head of the queue
  with an update, whose proof its account's `VERIFY` frame checks. With every update it also
  publishes the new note's opening on chain, encrypted to the note's owner.
- **The trigger.** If the head of the queue does not move for $T$ blocks, the contract enters
  escape mode on the next call, by itself. No signature, vote or admin takes part.
- **The escape.** Each owner decrypts its latest opening and redeems its own note with a proof
  made on its own device. The contract is the transaction's sender and payer, so neither a
  relayer nor any committee member takes part, and the owner needs no ether.
- **The return.** The committee may resume only after reconciling every redemption, and no
  update of its may spend a redeemed note.

**What would show it wrong.** Any one of these:
- escape mode needs anything besides time passing and the user's own transaction;
- a user cannot redeem without the committee, a relayer, or ether in an account linked to them;
- a redemption is accepted before $T$ blocks have passed with the queue stalled (amended below:
  "accepted" means "pays out");
- the same note is redeemed twice;
- after it resumes, an update of the committee is accepted that spends a redeemed note, or that
  skips reconciling;
- a published opening lets an observer tell which owner it is for, beyond what the redemption
  itself reveals. A redemption, like any withdrawal, reveals its amount and its recipient.

**Amended before any code, 2026-10-26, at the owner's word.** Two points found while the
builders chose the construction change the claim. Both are fixed here before any code reads an
opening and before any transaction.
- **An eighth condition.** With experiment 01's circuit, whoever knows a note's whole opening can
  redeem it. A committee that made the openings could then redeem every note to itself during
  escape, and an exit the operator can drain is not an exit. So this would also show the claim
  wrong:
  - anyone other than a note's owner, any committee member or all of them together included,
    redeems that note.

  The construction must make that impossible, and it can with the circuit unchanged. The
  circuit's commitment is a Pedersen hash of the nullifier $n$ and the secret $s$, a sum of
  terms over four-bit windows, and $s$ starts on a window boundary. So the commitment splits as
  $H(n \Vert s) = A(n) + B(s)$. The owner keeps $s$ and sends only the point $B(s)$, and each
  member chooses its own windows of $n$. No member knows $n$, nobody but the owner knows $s$, and
  only the owner can prove the redemption.
- **"Refused" before $T$ means "pays nothing".** A `VERIFY` frame may not read the block number
  or the time on this network, so the timeout can be checked only when the transaction executes.
  An early redemption may therefore be mined with its payout reverted. In plan step 3, and in the
  third condition above, "refused" and "accepted" are read as "pays nothing" and "pays out". The
  vault pays the gas of an early attempt, and how many attempts a note allows is recorded as a
  finding about frames.
- **Who sends an intent.** Only one proof fits a `VERIFY` frame, so each update processes one
  intent, and its published opening is tied to whoever sent that intent. The sixth condition
  therefore tests the owner's anonymity only if the owner never sends its own intent. In the run,
  a note's current holder sends the intent for its new owner. This is a choice of the plan, made
  by the coordinator before the run, not a change to the claim.

**Stated before the run, and not tested here:**
- **A garbage opening.** A committee could publish an opening that does not decrypt to the note,
  and the owner would learn it only on the day it needs it. TACEO answers this with a fraud proof
  that only the affected owner can make. Whether this experiment builds one is decided before the
  code and written here then. If it is not built, the record says so.
- **Who sends intents.** An intent here carries what the update needs and is not itself proved.
  TACEO's client proves its intent's well-formedness, and that proof is not tested here.
- **A malicious committee.** The committee is semi-honest, as in experiments 07 to 10. Stopping
  is the fault tested.

**Stand-ins, stated before the run.**
- TACEO's balance circuit is not used. The privacy pool's withdrawal circuit from experiment 01
  proves both the committee's update and the owner's redemption, as in experiment 07.
- $T$ is set small enough for the test network, and its value is written here before the run.

## Pieces

| Piece | Built by | Role |
|---|---|---|
| the vault contract | the committee's builders | intents, updates, published openings, the timeout, escape mode, redemption and reconciliation |
| the committee's side | the committee's builders | an update proved over shares, with the opening it publishes |
| the wallet's side | the wallet's builders | an owner's key for openings; decrypt, prove the redemption on the device, and send it |
| the runner | the coordinator | the run through two skandha nodes on the Hegota test network, and the record |

## The plan

1. **Two nodes,** A and B, peered with each other only. Every transaction is sent to node A,
   except deployments and deposits, which go to the chain directly.
2. **Normal mode.** Two intents are queued, each sent by a note's current holder for its new
   owner, never by the owner. The committee processes both, and each update publishes an
   opening. Each owner checks that its opening decrypts to its note.
3. **Too early.** With the queue stalled for fewer than $T$ blocks, a redemption is sent. It must
   pay nothing (amended above).
4. **The committee stops.** Its members' processes end. One more intent is queued, and the head
   of the queue stays put for $T$ blocks.
5. **The escape.** Each owner redeems its own note through node A, with the vault as sender and
   payer. A second redemption of the same note is sent too, and must be refused.
   Before the owners redeem, the committee's members, together, try to redeem an owner's note
   with everything they hold. They must fail (amended above).
6. **The return.** The committee restarts and sends an update that spends a redeemed note, which
   must be refused. Then it reconciles, and then it processes the queue again.
7. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - whether it was mined, and if so its block, status, payer and gas by frame;
   - the vault's mode before and after.

   It keeps no key, share, note secret or decrypted opening.

## Done when

On the test network, through two nodes, the run shows each of these:
- updates with published openings are mined;
- an early redemption pays nothing;
- the committee's members, together, cannot redeem an owner's note;
- after $T$ blocks, each owner's own redemption is mined with the vault as sender and payer;
- a second redemption is refused;
- the resumed committee's update over a redeemed note is refused, and its reconciliation is
  mined.
