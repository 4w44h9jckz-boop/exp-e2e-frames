# Experiment 02: the same withdrawal, listed by a skandha includer under a budget per list

**The claim.** While experiment 01's withdrawal is pending, an open mempool node that acts as an
includer puts it in the inclusion list it would publish, with a gas budget for its own list alone.
The withdrawal has no signature and no funded sender, and it is still a list candidate that fits.

**What would show it wrong.** These were fixed before the run, as the offline checks on branch
`tooling-inclusion-list` (`a972d4b`), pushed before the run started. This README was written after
the run.
- while the withdrawal is pending at a node's head, no list that node gives under a budget per list
  names it;
- a recorded list spends more than its budget of $2^{20}$ verify gas, or is larger than 8,192
  bytes.

## Pieces

| Piece | Pin (`pins.json`) | Role |
|---|---|---|
| kohaku-rs | `2836329` | experiment 01's `refund_withdrawal`, handed to node A alone |
| skandha | `7697963` | experiment 01's two nodes, now with an includer: `skandha_frameInclusionList` answers with the list the node would publish from its pool at its head (`FRAMES.md`, "As an includer") |
| chain | ethrex `hegota-testnet-hotfix` at `64b8fc09` | simulates each validation prefix for the nodes, and builds the block |

skandha's includer fills a list in one of two ways, named by the `focil` parameter:
- `eip-8369` gives each list a budget of its own;
- `ethrex` builds the same list. Whoever reads a slot's lists then fills one budget across all of
  them, in the order they arrive.

## The transaction

The same as experiment 01's: four frames, the pool as its own sender and payer, nothing signed.
Its two `VERIFY` frames declare $11{,}973 + 310{,}930 = 322{,}903$ gas. That is the cost a list
counts against its budget.

## Run

```bash
npm install
npm run account && npm run faucet
npx tsx experiments/02-x2-inclusion-list/run.ts [attempt-label]
```

The run takes experiment 01's steps:
1. Checks out both pieces at their pins and builds them.
2. Starts A and B and waits until each has the other as its only peer.
3. Sends the withdrawal to node A's RPC alone.
4. Waits until both nodes log it as included.

While the sender runs, it asks both nodes for their list under both fills every 250 ms. It keeps
every list that names the withdrawal, and each node's first list under each fill, from before
anything was sent. The record is written to `test/fixtures/runs/<hash>.json`. `npm test` checks
it offline: every list against its budget and size, and at least one list under a budget per list
naming the withdrawal, besides experiment 01's checks.

## Results

| Attempt | skandha | Withdrawal | Block | Outcome |
|---|---|---|---|---|
| 1, `run.ts` | `7697963` | [`0x03dc88e6...`](https://dora.privacy.ethrex.xyz/tx/0x03dc88e646be8edc212969164796ac9752f94b17da57189e03dc2acc5b43924d) | 479,771 | listed by both nodes under both fills while pending, then mined by experiment 01's path |

The run asked 452 times. The record keeps 58 lists:
- 4 from before the withdrawal was sent, at head 479,767, all empty;
- 54 naming the withdrawal, all at head 479,770: A's 30 and B's 24, half under each fill.

| Node | Received it | Listed it from | Last listed | Removed it as included |
|---|---|---|---|---|
| A | 06:02:39.598, over RPC | 06:02:39.600 | 06:02:43.918 | 06:02:44.251, head 479,771 |
| B | 06:02:40.036, by gossip from A | 06:02:40.037 | 06:02:42.889 | 06:02:43.401, head 479,771 |

Every list that names it holds that one transaction: 322,903 of 1,048,576 verify gas, 786 of 8,192
bytes. As in experiment 01, A never handed it to the client. B received it by gossip from A and
handed it to the client. It was mined with no signature, the pool as sender and payer.

## Observations

1. **Each node listed it as soon as it admitted it.** Each node's first list naming the withdrawal
   came within 2 ms of its admission, A's on the client's verdict and B's on gossip. Each node kept
   listing it until the head that included it.
2. **The two fills gave the same list here, as they should.** An includer can budget only what it
   lists, so `eip-8369` and `ethrex` differ only when a slot's lists compete for one budget. One
   pending withdrawal and two includers cannot show that difference. It is shown by skandha's
   conformance vectors for the fill rules (IL-4), which replay a committee in which a pooled
   budget denies honest withdrawals and a budget per list does not. This experiment shows the
   other half: a private withdrawal is a candidate the includer actually lists, on the live chain.
3. **Three such withdrawals fill a list.** Its verify cost is 30.8% of a list's $2^{20}$ budget, so
   a fourth does not fit. Its size, 786 bytes, would allow ten.
4. **The list was not used to build the block.** skandha answers with the list it would publish.
   It does not sign it or gossip it, and the testnet's block was built from B's hand-off, as in
   experiment 01. The run shows what an includer would ask for, not that a builder was bound by it.
5. **Under EIP-8141's own budget the withdrawal never reaches a list.** Its `VERIFY` frames
   declare 322,903 gas. The testnet's nodes admit up to 500,000, while EIP-8141's public mempool
   admits 100,000. A node that follows the EIP refuses the withdrawal at admission, before any list
   is built.
6. **Limits.** Two nodes on one machine, sharing one client, one transaction. The run shows that
   the includer lists a private withdrawal and that the two nodes agree, not how lists behave under
   competition, which the vectors cover.
