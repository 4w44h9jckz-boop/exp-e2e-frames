# Draft: BLINDMINT, BLINDTRANSFER and BLINDPRUNE

**Status: a draft written for experiment 30, before its code. It is not submitted anywhere.** It
fixes the semantics the experiment builds into the local chain's ethrex as three precompiles. The
gas schedule is this draft's own, built from the prices of the operations each step replaces.

## Abstract

A blind account holds ether in escrow under a key `chi`. A buyer pays `D` in under `chi`, and an
issuer signs the buyer's ticket without seeing it. Whoever holds the unblinded ticket can move `D`
to any address. The protocol counts what was paid in and what was paid out under each key, and
pays a ticket only while fewer have been paid than bought. So a forged ticket can never create
ether. Each ticket's serial is spent once, and a closed epoch's serials can be deleted as a whole.

## Motivation

A ticket checked by a contract today needs three things:
- a pairing check, which is over the 100,000-gas validation limit of EIP-8141 on its own;
- a single-use nonce key that is kept forever;
- a count written in a separate step, which can disagree with what was paid if that step fails.

Native operations can check tickets under one key in a batch, keep the count and the payment in
one step, and drop a closed epoch's serials.

## Specification

### Constants

| Name | Value |
|---|---|
| `BLINDMINT` | `0x0000000000000000000000000000000000000b11` |
| `BLINDTRANSFER` | `0x0000000000000000000000000000000000000b12` |
| `BLINDPRUNE` | `0x0000000000000000000000000000000000000b13` |
| `ESCROW` | `BLINDMINT`, the account that holds every key's escrow and counts |
| `DST` | `BLIND_V1_BLS12381G1_XMD:SHA-256_SSWU_RO_` |
| `PAYOUT_TAG` | the 15 bytes `BLIND_PAYOUT_V1` |
| `SERIALS_TAG` | the 13 bytes `BLIND_SERIALS` |

### Encodings

- **Points** are in the uncompressed serialization of the BLS12-381 "ZCash" format: a G1 point
  in 96 bytes, a G2 point in 192 bytes.
- **Integers** are 32 bytes, big-endian.
- **The key:** `chi = keccak256(pk || D || end)`, where:
  - `pk` is the issuer's G2 public key;
  - `D` is the denomination in wei;
  - `end` is the last block of the epoch.
- **A ticket's message** is `m = chi || serial || otk`. `serial` is 32 bytes the buyer chose at
  random. `otk` is the 20-byte address of a one-time secp256k1 key the buyer holds.
- **The issuer's signature** is `sigma = sk * H(m)`. `H` is RFC 9380's
  `BLS12381G1_XMD:SHA-256_SSWU_RO_` with `DST`. The issuer signs the blinded `r * H(m)`, and the
  buyer unblinds.

### State

- **The counts,** in `ESCROW`'s storage for each key:
  - `burned[chi]` at slot `keccak256(chi || 0)`;
  - `minted[chi]` at slot `keccak256(chi || 1)`;
  - `pruned[chi]` at slot `keccak256(chi || 2)`.
- **The serial set** is the storage of its own account,
  `S(chi) = keccak256(SERIALS_TAG || chi)[12:]`. Slot `serial` holds 1 once that serial is spent.
- **Keeping it alive.** The account's nonce is set to 1 the first time it is written, so that
  EIP-161 never treats it as empty.

### `BLINDMINT`

- **Input:** `pk (192) || D (32) || end (32) || k (32)`, 288 bytes.
- **The call fails if any of these holds:**
  - the length is wrong;
  - `k = 0` or `D = 0`;
  - `msg.value != k * D`;
  - `block.number > end`;
  - `pk` is not a point of G2's prime-order subgroup;
  - the call is static.
- **Effect:** `burned[chi] += k`. The value is credited to `ESCROW`, as for any call with value.
- **Output:** `chi`.
- **Gas:** 100, plus 2,100 to read `burned`, plus 20,000 if it was 0 or 2,900 if not.

### `BLINDTRANSFER`

- **Input:** `pk (192) || D (32) || end (32) || sigma (96) || n (32)`, then `n` entries of
  `serial (32) || otk (20) || recipient (20) || sig (65)`. `sig` is `r || s || v`, with `v` 27 or
  28.
- **The call fails if any of these holds,** checked in this order before any effect:
  1. the length is not `384 + 137 n`, or `n = 0`, or the call carries value or is static;
  2. `block.number > end`, or `pruned[chi] = 1`;
  3. `minted[chi] + n > burned[chi]`;
  4. two entries share a serial, or any `S(chi)[serial]` is set;
  5. for some entry, `ecrecover(keccak256(PAYOUT_TAG || chainid || chi || serial || recipient), sig) != otk`;
  6. `e(sigma, g2) != e(sum_i H(chi || serial_i || otk_i), pk)`. That is one pairing check for
     the whole batch: every ticket is under the same `pk`, so the signatures add.
- **Effects:**
  - every `S(chi)[serial_i]` is set to 1;
  - `minted[chi] += n`;
  - `D` is moved from `ESCROW` to each recipient's balance, with no code run at the recipient.
- **Output:** 32 bytes, the value 1.
- **Gas,** charged before the effects:
  - a base of 1,100;
  - the pairing check of two pairs at EIP-2537's price, $32600 \cdot 2 + 37700 = 102900$;
  - 5,000 for the count;
  - for each entry 45,950: hashing to G1 at two `MAP_FP_TO_G1` and one `G1ADD` (11,375), 100
    for `expand_message`, 375 to add it to the sum, 3,000 for `ecrecover`, 22,100 for the serial's
    slot, and 9,000 for the payment;
  - 25,000 if `S(chi)` did not exist;
  - 25,000 for each recipient that was empty.

### `BLINDPRUNE`

- **Input:** `pk (192) || D (32) || end (32)`, 256 bytes.
- **The call fails if** the length is wrong, `block.number <= end`, `pruned[chi] = 1`, or the call
  is static.
- **Effects:**
  - `pruned[chi] = 1`;
  - `S(chi)` is added to the transaction's self-destruct set, so at the transaction's end its nonce
    and storage are cleared and the empty account is removed. That is EIP-8246's handling of a
    self-destructed account.
- **Output:** 32 bytes, the value 1.
- **Gas:** 25,000.

### Failure

A failed call behaves as a failing precompile: it uses all the gas given to it, returns nothing,
and changes no state.

## Rationale

- **The count is per key.** A forged ticket, or an issuer that signs too many, can take at most
  what honest buyers paid in under that key. It cannot reach another key's escrow, and it cannot
  create ether.
- **The payment runs no code,** like a withdrawal on the beacon chain. So a recipient cannot make
  the count and the payment disagree by reverting.
- **One pairing per batch.** All tickets in a batch are under one `pk`, so
  `e(sum sigma_i, g2) = e(sum H(m_i), pk)` checks them together. The serials must differ, since
  the messages must.
- **Serials by epoch.** Tickets under `chi` are refused after `end`. So once the epoch is closed
  the serial set is never read again, and it can be dropped whole. The counts stay.

## Security considerations

- BLS12-381 is not post-quantum. The scheme must be retired before a quantum adversary can act
  within an epoch.
- Whoever holds `pk`'s secret can sign tickets. The count bounds what that party can take to the
  float of the key's buyers.
- The crowd a payout hides in is the purchases under its `chi`. Purchases are public.
- **Ether left in escrow after `end`,** tickets bought and never paid, stays locked. This draft
  does not say who may recover it, since nobody can prove they bought it without linking the
  purchase.
- **Deleting a serial set** deletes an account's whole storage at once. That is the unbounded
  deletion that EIP-6780 removed from `SELFDESTRUCT`, so a real version must bound or meter it.
- **Who pays a payout's gas** is not answered here. A funded sender links the payout to itself,
  so a real version needs the payout to pay its own fee.
