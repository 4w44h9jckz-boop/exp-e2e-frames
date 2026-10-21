# Experiment 12: a bound ticket through two open mempool nodes, against copies of what it pays for

**Status: run.** The claim, what would show it wrong and the plan below were committed before
any transaction (aedba5d), and the runner and its checks before the first (faa8190). The results
are at the end. None of the four conditions that would show the claim wrong occurred in run 2.

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

## Runs

| Run | When (UTC) | Outcome |
|---|---|---|
| 1 | 2026-10-21, 07:28 to 07:34 | Stopped at the example's first step; nothing was sent, and no record was written |
| 2 | 2026-10-21, 07:44 to 07:46 | Recorded: `results/2-second-run.json` |

**Run 1.** The example's first step tops up the seed's owner 0 from the funder, in a frame with
no state gas. The testnet charges EIP-8037 state gas, 183,600, to create an account. So the
top-up works only for an owner 0 that already exists, which is what the example's own runs
had, since they reused one seed. With this experiment's fresh seed, the transfer reverted in
simulation and the example stopped before sending anything. Simulating the same frame without
sending it showed the cause:
- with 10,000 to 400,000 execution gas and no state gas, the transfer to a fresh address fails;
- with the new account's state gas added, it succeeds;
- to an account that exists, 10,000 execution gas is enough.

The pinned example was not changed. The runner now creates owner 0 first, with an ordinary
transfer of 0.001 ETH from the funder (b59eea9), and records that transaction. The gap was
reported to the example's authors.

**A check narrowed after run 2.** "Records no key, seed or mnemonic" read the record whole. It
matched `SEED_FILE` in the record's description of the commands, which names the variable that
was set, not its contents. The check now leaves the commands out, and also fails on twelve or
more BIP-39 words in a row anywhere else in the record. In run 2's record the longest such run
is four words, and the funder's key does not appear.

## Results, run 2

Every transaction below was sent to node A. Node B, which alone hands transactions to the chain,
saw only what A gossiped. Both nodes ran with `--frames.claims`, and neither was told which
paymasters bind: each node's start line says so. The client was
`ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`.

**Setup, to the chain.** Owner 0 was created in block 494,423. The bound paymaster
(`0x8c2d5c99...`) has the 1,185-byte template whose keccak the profile names; the unbound one
(`0x7022ba04...`) has the 1,105-byte template. A spend from a fresh sender on each ticket
was mined through B: the unbound one in block 494,433, the bound one in block 494,435.

**The control: an unbound ticket.**

| Sent to node A | Node A | Node B | Chain |
|---|---|---|---|
| the withdrawal | admitted | gossiped, handed on | not mined: replaced |
| a copy with its fees raised, signed by no one | admitted | gossiped, handed on | mined in block 494,438, paid by the unbound paymaster |
| a copy with its fees raised and one calldata byte changed | refused, `ErrFramePrefixReverted` | never seen | not mined |

Anyone who saw the withdrawal pending could replace it with a copy at a higher fee. Their copy
was mined in its place and the ticket paid for it. Changing the recipient did not work even
here, because the pool's proof covers it.

**The bound arm.**

| Sent to node A | Node A | Node B | Chain |
|---|---|---|---|
| the withdrawal | admitted | gossiped, handed on | mined in block 494,441, paid by the bound paymaster |
| a copy with its fees raised, the one-time key's signature kept | refused, `ErrInvalidSender` | never seen | not mined |
| the same, its signature entry removed | refused, `ErrFramePrefixReverted` | never seen | not mined |
| the same, another key named in the frame's data and signing | refused, `ErrFramePrefixReverted` | never seen | not mined |
| a copy with its fees raised and one calldata byte changed, the signature kept | refused, `ErrInvalidSender` | never seen | not mined |

The kept signature covers the hash the transaction is signed under, so a copy at another fee
fails the protocol's own signature check. Without that signature, or with another key's, the
bound paymaster's `VERIFY` frame reverts.

**Gas.** In simulation the paymaster's `VERIFY` frame used 122,233 gas for the bound ticket
and 122,006 for the unbound one. The two mined withdrawals used 697,243 gas (bound) and 692,524
(the unbound copy). The pool's `VERIFY` frame, the same in both, used 244,817.

**The issuers.** What each issuer saw while signing contains neither bound ticket's binder
address (`test/x8.test.ts`, "the issuers saw no binder"). That check looks for the binder only;
it does not test whether the blinded points could be linked to the spent tickets.

**Checks.** `npx vitest run test/x8.test.ts`: 9 of 9 pass on run 2's record.

**What this does not show.** Two nodes on one machine over loopback, one run, and one copy of
each kind. It does not show what a node that does not recognise the template would admit, nor
whether a builder that receives the original from somewhere else would mine a copy.
