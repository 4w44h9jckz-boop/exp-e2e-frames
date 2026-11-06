# Experiment 28: a hardware wallet signs the execution digest, and names the accounts it lets you delegate to

**Status: pre-registered 2026-11-06,** before any device run. Only the emulator's build had been
started: the firmware was cloned and its pinned Rust toolchain installed. The predictions, what
would show each wrong, and the deviations are fixed here. Results are added below them, and
nothing above the results is edited after a run.

## The question

A hardware wallet's screen is the one display that a dapp cannot draw on. So whether that screen
can show what a signature authorises decides whether the signature is informed. This experiment
asks two things of an unmodified Trezor firmware, run as its emulator.

1. **The execution digest.** Can the device sign the execution digest `E` of a frame transaction
   (EIP-8141, with EIP-8250 keyed nonces), the EIP-712 typed data that `exp-frames` experiment 27
   defines? And what do its screens let a user see of each frame before signing?
2. **The delegate list.** Under EIP-7702, the firmware lets its user delegate only to accounts it
   names. Is that list the only gate, so that only a firmware release adds a delegate?

## What was read first

The firmware is `trezor/trezor-firmware` at `8ef55098ffa25d46c18d514ae685b424beb1f04b`
(2026-11-05). `core` is GPLv3, and `python`, which holds `trezorlib`, is LGPLv3. Read in
`core/src/apps/ethereum`:
- **`sign_typed_data.py` and `layout.py`.** The device:
  - shows the signing address;
  - walks the domain and the message field by field;
  - asks before it shows each array or struct ("Show full array");
  - shows `address` and `bytes` values as raw hex across pages, and other types as text.

  Typed data has no clear-signing path: calldata in a `bytes` field is never decoded.
- **`sign_tx_eip1559.py`.** For EIP-7702 the device refuses:
  - chain id 0;
  - an empty destination;
  - calldata;
  - value;
  - a payment request;
  - an unknown network.

  It also refuses any delegate that `lookup_eip7702_address` does not name, with "Unknown
  EIP-7702 delegate address". It signs only the authorization whose nonce is the transaction's
  nonce plus one, so only an account sending its own transaction can delegate. Delegating to the
  zero address is a revocation, with a screen of its own.
- **`sc_constants.py`.** The list is generated from `sc_constants.py.mako`:

  | Chain ids | Delegate |
  |---|---|
  | 1, 8453, 42161 | Ambire (`0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d`) and Simple7702Account (`0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9`) |
  | 10, 56, 137 | Simple7702Account |
  | 100 | Ambire |

Nothing from the firmware is copied into this repository. It is built in the ignored `work/`
directory, and `trezorlib` is imported from that checkout and never vendored.

## Setup

- **The device.**
  - The firmware at the commit above, built as its Unix emulator for the Trezor Safe 5 model
    (`t3t1`) with `xtask build firmware --emulator -m t3t1`, under the toolchain the repository
    pins (Rust nightly 2026-03-16).
  - The emulator is loaded through the debug link with the standard all-`all` test mnemonic, so
    no real key is involved.
  - Its account is `m/44'/60'/0'/0/0`.
  - Screens are read, and buttons pressed, through the debug link.
- **The vectors.** `exp-frames` at `4da238c`, `experiments/27-execution-digest/erc-assets/`:
  - `vectors.json`: eleven transactions under EIP-8250 at `1a086d5c`;
  - `vectors-eip8250-f3079a0.json`: ten under EIP-8250 at `f3079a09e8`, the revision the ethrex
    Hegota test network follows.

  Each is signed as the typed data its `digest.ts` builds (`executionTypedData`), with the
  vector's own chain id and sender as the domain. So 21 signings, among them `many-frames`: twelve
  frames whose data runs from 0 to 1,000 bytes. The device signs with its own key, not the
  vectors' owner.
- **Two paths per vector.**
  - **The full path:** every "show" prompt is answered yes, and every screen is recorded.
  - **The short path:** every "show" prompt is answered no, and the screens to a signature are
    counted.
- **The delegate cases.** Each is an EIP-7702 transaction from the device's account, signed
  through `trezorlib`'s `sign_tx_eip1559` with an authorization:
  - (a) Simple7702Account on chain 1;
  - (b) an address the list does not name on chain 1 (`0x000000000000000000000000000000000000dEaD`);
  - (c) the zero address on chain 1, a revocation;
  - (d) Simple7702Account on chain 8141, a network the firmware does not know, with no signed
    network definition.

## Predictions

| # | Prediction | Would show it wrong |
|---|---|---|
| 1 | The device signs all 21 vectors on the full path. None is refused for size or nesting, `many-frames` included | any vector refused, or the emulator failing on one |
| 2 | Every signature recovers to the device's address over the vector's own `E`. So the device's EIP-712 hash equals `E` for all 21, making it a further implementation of `E` that shares no code with the four experiment 27 has | any signature recovering to another address over `E` |
| 3 | On the full path, the domain's name, version, chain id and verifying contract (the sender) are each shown in full | any of the four missing or truncated |
| 4 | On the full path, each frame's mode, flags, target, both limits, value and data are shown. The target is a full address, and the data is full raw hex across pages, never decoded and never a hash. The screen count grows with the frames and the data bytes | a field missing; data truncated, hashed or decoded; or a count independent of the data |
| 5 | On the short path, a vector is signed without any frame being shown, in a number of screens that does not depend on its frames | a frame's target, value or data shown on the short path, or the device refusing to sign without showing them |
| 6 | Case (a) signs after a screen naming Simple7702Account. Its authorization recovers to the device's address over `keccak256(0x05 \|\| rlp([1, delegate, nonce + 1]))` | (a) refused, or the authorization recovering to another address |
| 7 | Case (b) is refused with "Unknown EIP-7702 delegate address", and no screen offers to continue | (b) signs, with or without a warning |
| 8 | Case (c) signs after a revocation screen | (c) refused |
| 9 | Case (d) is refused with "EIP-7702: unknown network" before any delegate screen | (d) signs, or is refused for the delegate rather than the network |

Prediction 5, if it holds, is the experiment's main risk to a user: the device can sign `E`
without its user having seen what any frame does. Predictions 7 and 9 together say the gate is the
compiled list and the known networks, both fixed at a firmware release.

## Not in this experiment

- **The list's history:** when each delegate was added and in which release.
- **Signed definitions:** whether host-provided signed definitions can carry a delegate. Both
  this and the history are read from the source elsewhere. Case (d) shows only that a network
  without a definition is refused.
- **A type `0x06` signing flow in the firmware,** and a device that refuses a transaction with no
  assertion frame. Both need a firmware fork.
- **Trezor Suite** and any host application. Only `trezorlib` drives the device.

## Deviations

None yet.
