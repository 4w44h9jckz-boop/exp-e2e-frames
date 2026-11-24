# Gas by function: what Ethereum mainnet's execution gas pays for

A measurement of mainnet, not a run on the test network. It sizes the jobs L1 does today, for a
post on wallet-first Ethereum: how much execution gas moves value that belongs to one owner, how
much trades or lends against shared state, and how much is already a job of storing a digest and
checking it.

## Method

`run.ts` reads a sample of blocks from one public provider, `eth.drpc.org`: for each block, its
transactions, its receipts, and `debug_traceBlockByNumber` with the call tracer. A block gets three
attempts before it is left out. The sample is `blocks` blocks spaced evenly over the last `span`
blocks ending at `head`, so passing the head of an earlier record rereads the same blocks.

`classes.ts` puts each transaction in the first class that matches, in this order:

| Class | Decided by |
|---|---|
| `reverted` | receipt status 0 |
| `blob-carrier` | transaction type 3 |
| `rollup-settle` | a state-commitment or proof event of the OP Stack, Arbitrum, ZKsync, Starknet, Scroll or Linea |
| `bridge` | a message event of the OP Stack portal, Arbitrum's bridge or outbox, or ZKsync |
| `trade` | a swap event of Uniswap V2, V3 or V4, PancakeSwap V3, Balancer V2 or Curve, or a fill event of CoW Protocol, UniswapX or 1inch |
| `lend-or-pool` | an event of Aave V3, Morpho Blue, Compound V3 or ERC-4626 |
| `oracle` | a Chainlink update event |
| `validator-deposit` | the beacon deposit contract's `DepositEvent` |
| `token-move` | an ERC-20, ERC-721 or ERC-1155 transfer or approval, or WETH's wrap or unwrap, and none of the above |
| `eth-transfer` | empty calldata |
| `create` | no recipient |
| `other-call` | none of the above |

Every event signature is hashed in `classes.ts` from its text, and the record counts the
transactions each one matched, so a signature written wrong shows as a zero. The gas charged inside
precompiles is summed from the traces: the `gasUsed` of every call frame whose callee is a
precompile, by precompile and by the class of the transaction that made the call.

## What it cannot say

- Classes are by event, not by intent. A protocol whose events are not in the lists falls to
  `token-move` if it moved a token, else `other-call`. So `token-move` is an upper bound on owned
  value, and `trade` and `lend-or-pool` a lower bound on shared state.
- Precompile gas is a lower bound on verification. A verifier also pays for calldata, memory and
  arithmetic outside the precompile.
- Execution gas only. Blob gas is recorded separately and is in no share.
- Storage writes are not separated from computation.
- One provider's view of one sample: a spot reading, not a trend.

## Run 1, 2026-10-29

`results/2026-10-29-head-26296054.json`: 200 blocks spaced over the 50,400 blocks ending at
26,296,054 (blocks 26,245,655 to 26,296,054), 50,329 transactions, 6,302,102,864 execution gas, no
blocks left out, and the trace's gas equal to the receipt's on every transaction. Blob gas was
127,664,128, or 974 blobs.

| Class | Transactions | Execution gas | Share |
|---|---:|---:|---:|
| `token-move` | 22,458 | 2,684,274,257 | 42.59% |
| `trade` | 6,430 | 1,901,832,394 | 30.18% |
| `other-call` | 4,781 | 965,830,172 | 15.33% |
| `eth-transfer` | 14,968 | 319,198,966 | 5.06% |
| `create` | 77 | 123,553,375 | 1.96% |
| `reverted` | 753 | 113,435,257 | 1.80% |
| `lend-or-pool` | 214 | 75,865,402 | 1.20% |
| `bridge` | 103 | 43,661,165 | 0.69% |
| `blob-carrier` | 394 | 39,173,214 | 0.62% |
| `rollup-settle` | 95 | 26,300,378 | 0.42% |
| `oracle` | 52 | 8,741,473 | 0.14% |
| `validator-deposit` | 4 | 236,811 | 0.00% |

Grouped: owned value (`token-move` and `eth-transfer`) is at most 47.7 percent; shared state
(`trade` and `lend-or-pool`) at least 31.4 percent; jobs already of the digest-and-check kind
(`rollup-settle`, `blob-carrier`, `bridge` and `oracle`) about 1.9 percent; unclassified
(`other-call`, `create` and `reverted`) 19.1 percent.

Gas inside precompiles other than `identity` was 108,337,240, or 1.72 percent: `ecrecover`
33,542,720, `bn254-mul` 27,378,000, `modexp` 22,792,472, `bn254-pairing` 18,315,000,
`kzg-point-evaluation` 3,700,000, and under a million each for the rest. It overlaps the classes
above; 65.8 percent of it was inside `other-call` transactions.

Eleven of the 59 event signatures matched nothing in this sample, Starknet's, Scroll's and Linea's
settlement events among them, so `rollup-settle` is a lower bound. The 25 largest `other-call`
recipients and selectors are in the record by address and selector only.

This record reproduces, field for field, the same sample as first measured on the same day by an
earlier implementation of the method: every class, every block's split, every precompile total
and every signature's count. The first attempt of this port lost one block to a provider timeout,
which is why a block now gets three attempts.

## Running it

```bash
npx tsx measurements/gas-by-function/run.ts                     # 200 blocks over the last 50,400
npx tsx measurements/gas-by-function/run.ts 200 50400 26296054  # run 1's sample again
```

It needs no key. A run takes about four minutes, refuses to start if this folder has uncommitted
changes, and writes `results/<date>-head-<head>.json` with the commit and the command.
`test/gas-by-function.test.ts` checks the hashing, the class order, the precompile walk and that
every committed result adds up.
