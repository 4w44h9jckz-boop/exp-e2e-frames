# Experiment 04: a fresh sender paid with a blind ticket, checked by an open mempool node before its client

**The claim.** A private sender spends from a fresh account with no ether. Its gas is paid with a
blind ticket: a committee of issuers signed a point the buyer blinded, so no issuer can match the
ticket to the spend. An open mempool node that has been told nothing about tickets:
- finds the ticket paymaster by its code;
- checks the ticket itself;
- refuses a junk ticket before it asks its client anything;
- admits the spend and passes it on, and it is mined.

Tickets from two issuer sets, each with its own paymaster, are each checked by two codebases:
- the node, skandha in TypeScript;
- the paymaster's `VERIFY` frame on chain, on EIP-2537's precompiles.

**What would show it wrong.** Written while the pieces were building, as the checks in
[`test/x3.test.ts`](../../test/x3.test.ts). They were pushed at `1529641` at 11:28:56 UTC, before
the first transaction was sent at 11:29:10. This README was written after the run.
- the node asks its client about a ticket that does not verify, or admits it;
- the node refuses a fresh, valid ticket, or has to be told which paymasters issue tickets;
- a spend is mined but not paid by the paymaster of the set that issued its ticket;
- a ticket verifies under the other set's key, or the bytes mined are not the ticket recorded.

## Pieces

| Piece | Pin (`pins.json`) | Role |
|---|---|---|
| kohaku-rs | `eea02a3` | `kohaku-frame-ticket`: Commonware's DKG for each issuer set, blind issuance, the `TicketPaymaster` and the spend. The runner in [`rust/`](rust/) drives it |
| skandha | `2b1b4b0` | two nodes, both with `--frames.claims`. They check a ticket by exp-mempool-l2s `10-claim-gated-admission.md` version 4 and `11-surface.md` version 3, and play that specification's vectors at `10fd022` |
| chain | ethrex `hegota-testnet-hotfix` at `64b8fc09` | simulates each validation prefix for the nodes, and builds the blocks |

A node with `--frames.claims` has no list of paymasters and no issuer keys. An account whose code
is the 1,105-byte ticket-paymaster template, then a 256-byte G2 key, then 32 bytes, is a ticket
paymaster, and that key is the issuer (skandha's `FRAMES.md`, "Tickets").

## The run

1. **Two issuer sets, A and B.** Each is four issuers from its own run of Commonware's
   Joint-Feldman DKG, with a quorum of three. Each set's key is appended to its own
   `TicketPaymaster`. The node is told neither the address nor the key.
2. **One transaction from the funder, sent to the chain.** It deploys both paymasters, and buys
   three tickets from A and two from B, at 0.001 ETH each.
3. **Two spends the node must refuse, sent to node A:**
   - a fresh sender with a random G1 point for a signature, through A's paymaster;
   - a valid ticket of set A, carried to B's paymaster.
4. **Two rounds.** In each, one ticket from each set is issued blindly to the funder, for a fresh
   sender's first slot in the current epoch. Each ticket comes from a different quorum, and every
   answer is checked against its issuer's share. Both spends go to node A at once, one through
   each paymaster. A ticket paymaster is not the canonical paymaster, so a node holds it to one
   pending transaction. The next round waits until both spends are mined.

A round starts only with at least 120 seconds left in its 384-second epoch, so that a ticket's
epoch is still the node's head epoch when it arrives.

Node A admits each spend, asking its client after the ticket checks, and gossips it to node B.
Node B, the only node with `--frames.handoff`, hands it to the client.

```text
 TICKET-PAID SPEND    sender = a fresh key (no ether, no code, nonce 0)   signatures = [sender]
 ----------------------------------------------------------------------------------------------
 [0] VERIFY -> sender       default code: APPROVE(EXECUTION)
 [1] VERIFY -> paymaster    the ticket: epoch (8) || salt (32) || BLS12-381 G1 signature (128)
                            checked on EIP-2537's precompiles, then APPROVE(PAYMENT)
 [2] SENDER -> board        post("X3: paid with a blind ticket")
```

## Run

```bash
npm install
npm run account && npm run faucet
npx tsx experiments/04-x3-ticket-paid-spend/run.ts [attempt-label]
```

The run does the following:
1. Checks out both pieces at their pins and builds them.
2. Starts the two nodes and waits until each has the other as its only peer.
3. Runs the runner with node A as its `SEND_RPC_URL`.
4. Waits until both nodes log every spend as included.

The record is written to `results/<attempt>.json`. It holds every transaction, the node's answers,
both nodes' log lines for every hash, both sets' public keys, the issuers' transcripts and the
chain's facts. It holds no key, share or blinding factor. `npm test` checks it offline, and
checks each ticket again with noble's BLS12-381: an implementation of its own, against the
chain's bytes.

## Results

Attempt 1 (`results/1-first-run.json`), on 2026-10-20.

| Paymaster | Set | Code |
|---|---|---|
| [`0xCb226c70...`](https://dora.privacy.ethrex.xyz/address/0xCb226c70d3f8641c2Ee434496dE15FF227a4bad7) | A, 3 tickets bought | 1,393 bytes: the template (keccak256 `0xec9f3f85...`), set A's key, 0.001 ETH |
| [`0x9325BC1d...`](https://dora.privacy.ethrex.xyz/address/0x9325BC1d43B9D1f28a02FeDa0CbbcE76b1331c82) | B, 2 tickets bought | 1,393 bytes: the template, set B's key, 0.001 ETH |

Both were deployed and bought from in
[`0x03b008d1...`](https://dora.privacy.ethrex.xyz/tx/0x03b008d136f34c7dd8ca0a43fcf970533c2d71068801d59775d55b56ff493cf3),
block 482,833, 4,848,907 gas.

**Refused by node A, before it asked its client.** Each `rpc` line has `ErrClaimInvalid`, its
claim read as not valid, and no `client` field. Neither spend reached node B or the chain.

| Spend | Node A | What it carried |
|---|---|---|
| `0x91454f84...` | 11:29:10.937, `ErrClaimInvalid` | a random G1 point for a signature |
| `0xc42635ca...` | 11:29:11.318, `ErrClaimInvalid` | a valid ticket of set A, at set B's paymaster: the node checks the key in the code of the paymaster the frame targets |

**Admitted and mined.** Each spend was paid by its set's paymaster, with 122,006 gas of execution
and 183,600 of state gas in the paymaster's `VERIFY`.

| Round, epoch | Set | Spend | Node A, over RPC | Node B, by gossip from A | Handed off by B | Block | Gas used |
|---|---|---|---|---|---|---|---|
| 0, 4,667,957 | A | [`0xac629544...`](https://dora.privacy.ethrex.xyz/tx/0xac6295446dcc8efc5745ee5e4a63d0ee4a7f2c1579e6de9b38e418edaf02508a) | 11:29:11.966 | 11:29:13.082 | 11:29:13.204 | 482,836 | 330,652 |
| 0, 4,667,957 | B | [`0x942eecb5...`](https://dora.privacy.ethrex.xyz/tx/0x942eecb503c5aca4b5760d167284d9549051ad96b032b1f95aca05c8ac1cc82a) | 11:29:12.485 | 11:29:13.603 | 11:29:13.773 | 482,836 | 330,664 |
| 1, 4,667,958 | A | [`0x906bb746...`](https://dora.privacy.ethrex.xyz/tx/0x906bb746f1b6ddd173c24f741efb81e9393ee8832296e10595e18f00c6c8e414) | 11:31:20.794 | 11:31:21.285 | 11:31:21.408 | 482,855 | 330,652 |
| 1, 4,667,958 | B | [`0xf14ea66a...`](https://dora.privacy.ethrex.xyz/tx/0xf14ea66a4ce4d7972c6eedd759452b68e25ddfd05a83fe85d76db3fb341c846e) | 11:31:21.339 | 11:31:21.813 | 11:31:21.936 | 482,855 | 330,652 |

Each line has `"claim": {"valid": true}` and `"client": "valid"`. Both nodes removed every spend
as included at the head of the block that mined it. Node A never handed a spend to the client.

**Checked offline here** (`npm test`, 6 checks). Each ticket was rebuilt from its recorded slot,
epoch and salt, hashed to G1 by noble's RFC 9380 hasher, and paired:
- it verifies under its own set's key and not under the other's;
- its epoch, salt and signature are in the mined transaction's bytes.

So three implementations agree on every ticket:
- blst through Commonware, which issued them;
- skandha, which checked them before asking its client;
- ethrex's EIP-2537 precompiles, which paid for them.

noble agrees as a fourth.

## Observations

1. **The node needed no configuration.** Two paymasters it had never been told about, with two
   keys, were recognised by their code at the head after the deploy. Each ticket was checked
   against the key of the paymaster its frame targets. So set A's ticket at set B's paymaster was
   refused, though it verifies under A's key.
2. **A junk ticket cost the node one signature check and no simulation.** Neither junk spend has a
   `client` field. The client's own check of such a ticket is the paymaster's `VERIFY`: 122,006
   gas, most of it the pairing.
3. **Tickets from both sets were admitted by the node and paid by the paymaster.** That is two
   issuer sets, each checked by two codebases, every round.
4. **One pending transaction per paymaster sets the pace.** Each round sent one spend through
   each paymaster, and the round waited for both to be mined. A service with many senders behind
   one ticket paymaster gets one spend into each block, at each node.
5. **What a ticket does not price.** A ticket paymaster is recognised by its code, so anyone can
   deploy one with a key of their own and sign their own tickets. The specification states what
   a junk proof then costs such a sender (exp-mempool-l2s `10-claim-gated-admission.md`, CG-10).
   This run did not send one.
