# exp-e2e-frames: plan

> **This branch (`plan`) is never merged.** It holds the roadmap, status and working notes.
> Code and write-ups go on mergeable branches.

## Branch model

| Branch | Purpose | Merges into |
|---|---|---|
| `main` | The shared library plus every finished experiment | none |
| `plan` | This file: roadmap, status, notes | never |
| `tooling` | The shared library (`src/e2e`), scripts and tests | `main` |
| `exp/NN-name` | One end-to-end experiment: `run.ts`, `pins.json`, its README and its runs as fixtures | `main` |

- Merge `tooling` first, as a merge commit, so each experiment's pull request shows only its own
  commits. Library changes an experiment needs go to `tooling` first.
- Every experiment pins each piece at a full commit in its own `pins.json`. Moving a pin is a new
  run, recorded beside the old ones, never in place of them.
- A run's record is written by the run, never by hand, and the tests check it offline.

## Roadmap

| # | Experiment | Needs | Status |
|---|---|---|---|
| 01 | A privacy withdrawal with no relayer and no sequencer: handed to one node, gossiped to a second, submitted by it alone, mined with no signature | kohaku-rs's `refund_withdrawal`; skandha's frame transactions over RPC and gossip, with the testnet's recent-root frame | done: three attempts recorded, the third by `run.ts` |
| 02 | The same withdrawal listed by a skandha includer, filling a budget per list | skandha as an includer, with a budget per list | done: one attempt, by `run.ts`, listed by both nodes and mined |
| 03 | One frame format across wallets: exp-frames' library, kohaku-rs's frame-kit and an implementation from the EIP texts against a public vector set | the two wallets' encoders and decoders; mined fixtures from exp-frames' `main` | done: encoding agrees everywhere. Decoding was shown wrong in the first run (both accept encodings a decoder must refuse, and disagree on four); the second run, after both wallets tightened their decoders, leaves only kohaku-rs's 64-bit chain ID |
| 04 | A private sender's whole path: a fresh account pays with a blind ticket, a junk ticket is refused before any proof is checked, and the spend is mined | blind tickets in kohaku-rs; ticket-checked admission in skandha | done: one attempt, by `run.ts`; two junk spends refused before the client, four ticket-paid spends from fresh accounts mined |

## Status log

- **2026-10-20**: `tooling` (the library, account and faucet scripts, offline tests over run
  records) and experiment 01. Its first attempt, by hand, was refused by skandha's testnet profile,
  which did not yet take EIP-8272's recent-root frame. The second, by hand after skandha took it,
  was mined in block 478,768. The third, by `run.ts` from pinned checkouts, was mined in block
  479,311. Writing `run.ts` found two bugs in the library: a node booted from another prints that
  peer's ID before its own, and `vitest` picked up the tests of the checkouts under `work/`. Both
  are fixed on `tooling`.
- **2026-10-20**: `tooling-inclusion-list` (the library asks a node for the list it would publish,
  and the offline tests check recorded lists against their budget and size) and experiment 02. Its
  first run, against skandha `7697963`, was listed by both nodes under both fills while pending
  and mined in block 479,771. One pending withdrawal cannot show how the two fills differ; skandha's
  fill-rule vectors do.
- **2026-10-20**: experiment 03, the first interoperability entry: a public vector set in
  `vectors/frame-tx/` and three implementations run against it. Encoding agrees with the chain on
  all 182 mined transactions; decoding does not, so the claim is shown wrong as written before the
  run. X3 moves to 04.
- **2026-10-20**: experiment 03's second run, against the two wallets' tightened decoders
  (exp-frames `3c8d2cb`, kohaku-rs `058d89d`) and the same vector set. All three implementations
  refuse all 19 encodings a decoder must refuse and agree on the 10 execution digests. Of the 200 transaction
  cases, kohaku-rs refuses one, whose chain ID is over 64 bits, which it keeps as a `u64` by
  choice. Merged in #6.
- **2026-10-20**: experiment 04, the private sender's whole path. Two issuer sets, each with its own
  ticket paymaster, which neither skandha node was told about. Node A refused a junk signature and
  a valid ticket carried to the other set's paymaster, both before asking its client. Four spends
  from fresh accounts with no ether were mined in blocks 482,836 and 482,855, each paid by its own
  set's paymaster. blst, skandha, ethrex's precompiles and noble agree on every ticket. One
  pending transaction per ticket paymaster set the pace: one spend per paymaster per block.
  Merged in #7.
- **2026-10-21**: the roadmap is done. Experiments 01 to 04 are on `main`, through pull requests #1
  to #7, and no fifth experiment is planned. A new one starts with a row above and a branch of its
  own.
