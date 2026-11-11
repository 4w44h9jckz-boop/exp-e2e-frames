# Draft: a blind ticket as an input to a UTXO-style spend frame

**Status: a draft written for experiment 31, part A. A specification and a state-accounting
model, not a build; not submitted anywhere.**

It extends the spend frame of "Native UTXOs on Ethereum" (ethresear.ch topic 25368) with a third
kind of input. It reuses experiment 30's keys, counts and serial sets (that experiment's
`SPEC.md`) unchanged.

## The spend frame, as proposed there

A single value-conserving EIP-8141 frame folds three things into one transition: UTXO inputs, UTXO
outputs, and account flows and gas.

- **A UTXO input** carries `{index, creation_block, opening_path}`. The spender proves the
  opening `(source, value, recipient)` against the historical openings root of `creation_block`.
- **The only state a spent UTXO leaves** is one bit at `index` in a packed bitmap, kept forever.
- **The recipient's authorisation** comes from the frame transaction's signature list. Recipient
  code never runs.

## A third input kind: a blind ticket

```
TicketInput {
  key:      (pk, D, end)    // chi = keccak256(pk || D || end), as in experiment 30
  serial:   bytes32         // chosen by the buyer at random, inside the blinded message
  otk:      address         // the one-time key named inside the blinded message
}
TicketGroup {
  key:      (pk, D, end)
  sigma:    G1 point        // the sum of the group's ticket signatures: one pairing per group
  inputs:   [TicketInput]   // all under this key
}
```

**Validity, per group, before the frame's value-conservation check:**
1. `block.number <= end`.
2. `minted[chi] + |inputs| <= burned[chi]`.
3. No serial repeats in the frame, and none is in `S(chi)`.
4. `e(sigma, g2) = e(sum H(chi || serial || otk), pk)`.
5. Each `otk` authorises the frame's outputs. Its signature is one entry in the frame
   transaction's signature list, over the frame's output commitment. So a copy with other outputs
   fails, as experiment 30's case (f) did with a recipient.

**Effects:** each serial is marked in `S(chi)`, `minted[chi]` rises by the group's size, and the
group contributes `D` per input to the frame's input value.

**Outputs** are UTXOs as proposed. A payout to a stealth address is one UTXO whose `recipient` is
that address, and whose opening sits in the creation log, not in state.

## Why the spent fact cannot be a bit at an index

A UTXO's index is assigned when it is created, and its opening names its source. A ticket has no
creation event of its own: it was bought as a purchase under `chi` and blind-signed off chain.

Giving it an index at purchase would name the purchase, and a spend proving that index would link
the payout to its buyer. That is exactly what the blind signature exists to prevent.

So the spent fact is the serial, which the buyer drew at random and the issuer never saw. It has to
be kept as a full 32-byte key, since a random value cannot be packed into a bitmap.

## The state, per payout

| Input kind | State written | Lifetime | What the frame lets an observer link |
|---|---|---|---|
| UTXO | one bit at `index` | forever | the input to its creation: `source`, `value`, `recipient` |
| Blind ticket | one slot in `S(chi)`: a 32-byte key and a 32-byte value | until `chi`'s epoch closes, then deleted by name (experiment 30 found a block access list cannot express deleting the set whole) | the input to `chi`: the denomination, the epoch and the issuer's key. Not the purchase |
| Keyed nonce, the contract version today (EIP-8250) | one nonce-manager slot | forever | the input to `chi`, as above |

`model.py` prices these in bytes and in byte-hours, using part B's measured serial lifetimes.

## What it costs

- **Against a UTXO,** a ticket input writes 512 times the bytes, 64 against 0.125. But it frees them
  within one epoch, where a UTXO's bit stays forever.
- **Against today's keyed nonce,** it writes the same slot and frees it.
- **The frame gains a pairing per key group.** That is 102,900 gas at EIP-2537's prices, shared by
  the group's inputs, as experiment 30 measured for a batch.
- **The epoch's set must be deleted one serial at a time** on a chain with block access lists. So
  the deletion's work, though not its permanence, is still linear in the payouts.

## What it does not settle

- **Who pays the frame's gas.** The frame's account flows can take it from the inputs' value, as
  the native-UTXO proposal does for its own inputs. Experiment 30's precompile left this open.
- **Whether `S(chi)` could be a bitmap of serials reduced into a small range.** It could not without
  the issuer learning which bucket each serial falls in, which reintroduces a link.
