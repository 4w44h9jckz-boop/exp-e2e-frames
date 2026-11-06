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

1. **Experimental features, after run 1's delegate cases.** In run 1 the device refused all four
   delegate cases (a) to (d) before any delegate screen, with "Failed to decode message:
   Experimental features are disabled". The firmware marks `EthereumSignTxEIP1559.auth7702` as an
   `experimental_field` (`common/protob/messages-ethereum.proto`). It rejects that field unless
   the device's experimental-features setting is on, which a user turns on with
   `apply_settings(experimental_features=True)`. So the delegate cases are rerun, as run 2, with
   that setting on. No prediction, case or vector changes. Run 1's refusals are kept as a result
   of their own: on a device in its default setting, every EIP-7702 delegation is refused. Run 1's
   execution-digest results stand as they are.

## Results, 2026-11-06

**The device.** The firmware at `8ef55098`, built as the Safe 5 emulator with
`xtask build firmware --emulator -m t3t1 --debug-link`, reports firmware 2.13.1 and the Delizia
layout. Its account at `m/44'/60'/0'/0/0` is `0x73d0385F4d8E00C5e6504C6030F47BF6212736A8`. The
build needed SDL3, which Ubuntu 24.04 does not package, so SDL3 3.4.20 and SDL3_image 3.4.8 were
built from libsdl-org's release sources into the ignored `work/`.

**Commands:**
- `npx tsx typed-data.ts <vectors.json> <label> inputs`, for each of the two sets at
  `exp-frames` `4da238c`. It writes `inputs/`, and every one of the 21 typed-data inputs hashes
  to its vector's own `E`.
- `<checkout>/.venv/bin/python run.py --out results/1-first-run.json`, which is run 1.
- `<checkout>/.venv/bin/python run.py --delegates-only --experimental --out results/2-delegates-experimental.json`, which is run 2 (deviation 1).
- `npx tsx verify.ts <run> inputs`, which writes `results/*-scored.json`.

**The execution digest, run 1.**

| Vector (both sets) | Frames | Full path, screens | Short path, screens |
|---|---|---|---|
| `self-paying` | 2 | 29 | 6 |
| `sponsored-transfer`, `keyed-nonces`, `legacy-nonce-7`, `key-zero` | 3 | 38 or 39 | 6 |
| `blobs` | 3 | 42 | 6 |
| `deploy-first`, `value-and-default` | 4 | 47 | 6 |
| `atomic-approve-swap`, `with-expiry` | 4 | 48 | 6 |
| `many-frames` | 12 | 136 | 6 |

| # | Prediction | Outcome |
|---|---|---|
| 1 | All 21 vectors signed on the full path | **held.** All 21 signed, on both paths, `many-frames` included |
| 2 | Every signature recovers to the device over the vector's own `E` | **held.** All 42 do, so the device's EIP-712 hash equals `E` for every vector. That makes a further implementation of `E`, sharing no code with the other four |
| 3 | The domain's four fields shown in full on the full path | **held** |
| 4 | Each frame's seven fields shown, data as full raw hex, never decoded or hashed, with the screen count growing with the data | **held.** The hex on the screens, joined across pages, equals each frame's data byte for byte, for every frame of every vector. Screens grow from 29 for two frames to 136 for twelve |
| 5 | On the short path, a vector signs without any frame shown, in a count independent of its frames | **held.** Every vector signs in 6 screens: the signing address, the domain over two pages, the message's four field names, and the final confirmation over two pages. No target, value or data appears |

**The delegate list, run 2, with the experimental-features setting on (deviation 1).**

| Case | Outcome | Screens |
|---|---|---|
| (a) Simple7702Account, chain 1 | **signed.** The authorization recovers to the device over `keccak256(0x05 \|\| rlp([1, delegate, 1]))`, with nonce 1, the transaction's nonce plus one | a warning ("Authorize your account to a third-party contract using EIP-7702?"), then "Delegating ETH #1 To Simple7702Account Network Ethereum", then the transaction's recipient (itself), its summary and confirmation |
| (b) an unnamed address, chain 1 | **refused,** "Unknown EIP-7702 delegate address" | none: no warning and no way to continue |
| (c) the zero address, chain 1 | **signed,** a revocation, with an authorization that recovers to the device | "Revoke ETH #1 from smart account delegation?", then the transaction's screens |
| (d) Simple7702Account, chain 8141 | **refused,** "EIP-7702: unknown network" | none |

| # | Prediction | Outcome |
|---|---|---|
| 6 | (a) signs after a screen naming Simple7702Account, its authorization recovering to the device | **held** |
| 7 | (b) refused with "Unknown EIP-7702 delegate address", no screen offering to continue | **held** |
| 8 | (c) signs after a revocation screen | **held** |
| 9 | (d) refused with "EIP-7702: unknown network" before any delegate screen | **held** |

**Run 1's delegate cases.** With the setting off, all four were refused before any screen:
"Failed to decode message: Experimental features are disabled". So on a device in its default
setting, every EIP-7702 delegation, revocation included, is refused. Turning the setting on
shows "Enable experimental features? Only for development and beta testing!"

**What it means.**
- **The execution digest can be signed today** on unchanged firmware, and the device computes it
  correctly.
- **The screens can show everything a frame does,** but only as raw fields. A 1,000-byte frame
  takes dozens of pages of hex.
- **The device also offers a path that shows no frame at all,** and that path is six screens long
  whatever the transaction holds. A user who declines "show more" signs every frame unseen.
- **For EIP-7702, the firmware's compiled list and its known networks are the whole gate.** No
  warning lets a user past them. Behind both sits a setting that by default refuses delegation
  altogether.
