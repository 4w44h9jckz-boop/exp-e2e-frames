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
| 03 | A private sender's whole path: a fresh account pays with a blind ticket, a junk ticket is refused before any proof is checked, and the spend is mined | blind tickets in kohaku-rs; ticket-checked admission in skandha | later, after 02 |

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
