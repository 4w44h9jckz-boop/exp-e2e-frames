# Experiment 12: a bound ticket through two open mempool nodes, against copies of what it pays for

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner, the offline checks and the results follow in later commits, and
the checks are pushed before the first transaction is sent.

**The claim.** Some frame transactions have no signer of their own: a privacy pool's withdrawal
approves on its proof, and its fee fields are whatever the sender of the bytes chose. When such a
transaction is paid with a blind ticket whose message also names a one-time key, and that key
must sign the hash the transaction is signed under before the ticket pays, then whoever sees it
pending cannot send a variant of it that the same ticket pays for. Two open mempool nodes, told
nothing beyond the paymaster template they already recognise, refuse every variant before it
reaches a block, and the original is mined.

The same variants are sent first against a ticket that names no key. That is the control: it
shows what the binding has to stop.

**What would show it wrong.** Any one of these:
- against a bound ticket, a variant whose priority fee was raised, or whose calldata was changed,
  is admitted by either node or mined;
- the bound original is refused by a node, or is not mined;
- a node needs anything from the ticket's issuers to decide, or is told which paymasters bind;
- the issuers can tell, from what they saw when signing, which transaction a ticket paid for.

**What it does not test.** A variant that drops the ticket and pays through another payer. That
burns the ticket without stealing its value, and the binding is not meant to stop it. A holder
re-pricing its own transaction is not tested either.

## Pieces

| Piece | Role |
|---|---|
| kohaku-rs, `kohaku-frame-ticket` and `kohaku-frame-secrets` | blind issuance by a committee from Commonware's DKG; the bound and unbound ticket paymasters; the one-time key derived from a seed; the transactions and their variants |
| skandha | two nodes with frame transactions on, both checking tickets before they ask their client. The bound template is in the claim-gated profile, and B alone hands transactions to the chain |
| chain | the ethrex Hegota testnet, chain 8141 |

Each is pinned at a full commit in `pins.json` when the runner lands.

## The plan

1. **Setup, sent to the chain directly.**
   - A fresh seed, made for this run and never recorded.
   - A committee from Commonware's DKG backs two paymasters with one key: one whose ticket
     names no key, and one whose ticket names a one-time key.
   - The funder buys tickets on each, and deposits two notes into a keyed privacy pool already
     on the testnet.
2. **Two nodes,** A and B, peered with each other only. Everything below is sent to node A.
3. **The control.** A withdrawal paid by an unbound ticket is sent, and while it is pending:
   - a copy with its fees raised by the replacement bump;
   - a copy with its calldata changed, its fees raised.
4. **The bound arm.** A withdrawal paid by a bound ticket is sent, and while it is pending:
   - a copy with its fees raised and the one-time key's signature kept;
   - the same copy with that signature entry removed;
   - the same copy re-signed by another key named in the ticket's data;
   - a copy with its calldata changed, its fees raised, the signature kept.
5. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - the node's answer;
   - whether it was mined, and if so its block, status and payer.

   It keeps no key, seed or blinding factor.
