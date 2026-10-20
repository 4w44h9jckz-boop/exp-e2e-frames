# Experiment 01: a privacy withdrawal with no relayer and no sequencer

**The claim.** A privacy withdrawal can reach the chain with no relayer and no sequencer. The
wallet proves it, open mempool nodes check it and pass it on, and the chain orders it. No party
that holds an identity sends it or pays for it.

**What would show it wrong**, written before the first run:
- a node refuses a withdrawal the chain would mine;
- the two nodes reach different verdicts at the same head;
- the withdrawal needs a signature, or a funded account, to reach the chain;
- it reaches a client by any route other than the second node's hand-off.

## Pieces

| Piece | Pin (`pins.json`) | Role |
|---|---|---|
| kohaku-rs | `2836329` | `kohaku-frame-pool`'s `refund_withdrawal`: a fresh deposit, then a withdrawal proved in Rust and handed to one URL alone |
| skandha | `2cc35b0` | two nodes, as its `FRAMES.md` gives them. A takes the withdrawal over `eth_sendRawTransaction` and never hands anything to a client; B is booted from A and hands what it admits to the client |
| chain | ethrex `hegota-testnet-hotfix` at `64b8fc09` | simulates each validation prefix for the nodes, and builds the block |

Each node has the other as its only peer, which the run checks before it sends.

## The transaction

The withdrawal of experiment 30 in [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames),
built in Rust. The pool is its own sender and its own payer, and nothing in it is signed.

| Frame | Mode | Target | What it does | Gas, execution + state |
|---|---|---|---|---|
| 1 | `VERIFY` | `0x...8272` | proves that the note's root is recent (EIP-8272) | 5,579 |
| 2 | `VERIFY` | the pool | checks the withdrawal's proof and approves payment from the pool | 244,744 + 97,920 |
| 3 | `SENDER` | the pool | `withdraw`: marks the nullifier spent and pays the recipient | 14,255 + 183,600 |
| 4 | `DEFAULT` | the pool | refunds the fee's surplus, so the note pays only a little over its gas | 11,531 |

## Run

```bash
npm install
npm run account && npm run faucet
npx tsx experiments/01-x1-relayer-free-withdrawal/run.ts [attempt-label]
```

The run takes these steps:
1. Checks out both pieces at their pins and builds them (`bun`, `cargo`).
2. Starts A and B and waits until each has the other as its only peer.
3. Runs the withdrawal with node A's RPC as its only destination.
4. Waits until both nodes log it as included, or A refuses it.
5. Writes the run's record to `test/fixtures/runs/<hash>.json` and stops both nodes.

`npm test` then checks the record offline. The sender's standard error is never kept, because it
prints the note's preimage.

## Results

| Attempt | skandha | Withdrawal | Block | Outcome |
|---|---|---|---|---|
| 1, by hand | `eee680f` | [`0x156ac00e...`](https://dora.privacy.ethrex.xyz/tx/0x156ac00e79ecca78caca6b2b8ef330920b9121e2a3bf9f271f803c58d9c73a6f) | none | refused by A before it asked the client: `ErrFrameUnrecognizedPrefix` |
| 2, by hand | `2cc35b0` | [`0x1986a5f5...`](https://dora.privacy.ethrex.xyz/tx/0x1986a5f540ac24bf23e9b10c3e5a3b96c235929c68f43a1fdcaa953148aa8ead) | 478,768 | mined: A admitted it on the client's verdict and relayed it, B received it by gossip from A and handed it to the client, both removed it as included |
| 3, `run.ts` | `2cc35b0` | [`0xe5c6a8f3...`](https://dora.privacy.ethrex.xyz/tx/0xe5c6a8f30510e999dc182047c84d872024d7e8096d26cc29c1f4340cdb35c675) | 479,311 | mined, the same path, from pinned checkouts with nothing done by hand |

In attempts 2 and 3 the withdrawal carried no signature, and its sender and payer were the pool
(`0xe196...baf9`). The deposits before them came from a funded account; the claim covers the
withdrawal.

## Observations

1. **The first refusal was the node's model of the chain, not the chain.** The withdrawal's first
   frame is EIP-8272's recent-root frame. The testnet runs EIP-8272, but skandha's testnet
   profile did not model it, so A refused the withdrawal before asking the client. The fix went
   into the specification skandha follows first, then into skandha (`2cc35b0`), and the same
   commands then passed. Nothing on the wallet's side changed.
2. **Only B submits.** A never hands anything to a client. It only asks the client for verdicts.
   In both mined runs the client received the withdrawal once, from B's hand-off, after B had
   received it by gossip from A's peer ID.
3. **The note pays 1.023 times its gas.** The last frame refunds the fee's surplus, counting its
   own whole limit as used, so the pool keeps that frame's unused 13,469 gas.
4. **The testnet's budget is not the EIP's.** The withdrawal's `VERIFY` frames declare
   $11{,}973 + 310{,}930 = 322{,}903$ gas. The testnet's nodes admit up to 500,000; EIP-8141's
   public mempool admits 100,000. On a network that follows the EIP, this withdrawal would not be
   admitted until the proof is carried another way.
5. **Limits.** Two nodes on one machine, sharing one client and one RPC endpoint, one transaction
   a run. The run shows that the path works and that two nodes agree on it, not how it behaves
   under load, with several clients or across a network.
