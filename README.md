# exp-e2e-frames

End-to-end runs of [EIP-8141 frame transactions](https://eips.ethereum.org/EIPS/eip-8141) on the
public ethrex **Hegota testnet**, across pieces built in other public repositories: a wallet builds
and proves a transaction, open mempool nodes check it and pass it on, and the chain orders it.

[exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) runs one feature at a time against the
chain. This repository runs whole paths, with every piece pinned at a commit, and keeps each run's
record as a fixture that the tests check offline.

## Pieces

| Piece | Repository | What it does in a run |
|---|---|---|
| Wallet | [kohaku-rs](https://github.com/4w44h9jckz-boop/kohaku-rs), Rust | builds, proves and sends frame transactions (`kohaku-frame-pool`, `kohaku-frame-wallet`) |
| Mempool node | [skandha](https://github.com/4w44h9jckz-boop/skandha), TypeScript | admits frame transactions over `eth_sendRawTransaction` and gossip, judged by the conformance vectors it carries (`packages/framepool`, `FRAMES.md`) |
| Chain | the ethrex Hegota testnet | simulates validation prefixes for the nodes, and builds the blocks |

Each experiment names the commit of every piece in its own `pins.json`. A run checks each piece
out at that commit with no history, and builds it there.

## Network

| | |
|---|---|
| Chain ID | `8141` |
| RPC | `https://rpc1.privacy.ethrex.xyz` |
| Explorer | https://dora.privacy.ethrex.xyz |
| Faucet | https://faucet.privacy.ethrex.xyz (1 ETH per address per hour) |
| Client | ethrex `hegota-testnet-hotfix` at `64b8fc09`, as `web3_clientVersion` reports |

The testnet's RPC answers a state read at a past block with today's state, and has no tracing. A
run reads balances live, or derives what it needs from the transaction and its receipt. A relaunch
voids every hash; the recorded runs keep what each showed.

## Setup

```bash
npm install
npm run account   # creates PRIVATE_KEY in .env (gitignored) and shows its address, never the key
npm run faucet    # claims 1 ETH for it
npm test          # checks every recorded run offline
```

A live run also needs `git`, `bun` and `cargo`. It checks out and builds the pinned pieces under
`work/` (gitignored), starts the nodes on `127.0.0.1`, sends, waits, records and stops the nodes.

## Library (`src/e2e`)

| Module | What it does |
|---|---|
| `env.ts` | The key from `.env`, never printed; the testnet's URLs |
| `rpc.ts` | JSON-RPC, and the chain's facts about a mined frame transaction |
| `sh.ts` | Commands, long-running processes in their own process group, and polling |
| `repo.ts` | A piece checked out at a pinned commit, with no history |
| `skandha.ts` | skandha built and run as its `FRAMES.md` says: config, nodes, peers, `--frames.log` lines |
| `kohaku.ts` | kohaku-rs examples built and run; a sender's standard error is never kept, because it prints the note's preimage |
| `record.ts` | A run's record, written as a fixture under `test/fixtures/runs/` |

## Experiments

Each experiment lives on its own `exp/NN-name` branch and is merged here when done. Its folder has
a README with the claim, what would show it wrong, the transaction's layout, how to run it, the
mined hashes with explorer links, and observations. Planning lives on the `plan` branch, which is
never merged.

| # | Branch | Experiment |
|---|---|---|
| 01 | `exp/01-x1-relayer-free-withdrawal` | [A privacy withdrawal with no relayer and no sequencer](experiments/01-x1-relayer-free-withdrawal/): a Rust wallet's withdrawal handed to one skandha node, gossiped to a second, submitted by it alone and mined with no signature |

## Rules

- A run's record names the commit of every piece, the commands, both nodes' log lines and the
  chain's facts. A result without its record is not reported.
- The key comes from `.env`. It is never committed, printed or recorded.
- Mined transactions worth keeping become fixtures, so they survive a testnet relaunch.
