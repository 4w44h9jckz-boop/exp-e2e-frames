# Experiment 05: a private transfer proved on the device, mined through open mempool nodes with no sequencer

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner, the offline checks and the results follow in later commits, and
the checks are pushed before the first transaction is sent.

**The claim.** A rollup in Aztec's style exists to order private transfers and to carry their
proofs to L1. Frame transactions can take its place:
- the device proves the private transfer;
- a `VERIFY` frame checks that proof and approves the fee from the pool;
- each note it spends is one of the transaction's nonce keys;
- a `SENDER` frame does the public part, inserting the new notes.

Open mempool nodes then order the transfers and refuse a second spend of a note, with no
sequencer, and the chain includes them.

**What would show it wrong.** Any one of these:
- the transfer's proof, from a proof system the circuit's toolchain can target, cannot be checked
  in a `VERIFY` frame within the testnet's validation budget;
- a note spent twice is admitted by either node, or mined;
- ordering the transfers needs anyone but an open node and the chain.

The proof's gas is recorded against the testnet's 500,000 and against EIP-8141's 100,000. A
result that holds at the first and not the second is reported as both.

**What it does not test.** Aztec's own protocol, its public functions beyond a note insertion, or
a fee paid by a ticket. The circuit is a two-in, two-out transfer on Aztec's note and nullifier
model, written in Noir. It is not Aztec's.

## Pieces

| Piece | Role |
|---|---|
| exp-frames, experiment 42 | the Noir transfer circuit, its Groth16 key and verifier, and the pool that checks the proof in `VERIFY` with each nullifier a nonce key. The verifier and its adapter already on the testnet are reused; their key is committed beside them |
| kohaku-rs, `kohaku-noir-transfer` | the transfer's witness, from the wallet's side |
| skandha | two nodes with frame transactions on. A is told nothing about the pool. B alone hands transactions to the chain |
| chain | the ethrex Hegota testnet, chain 8141 |

Each is pinned at a full commit in `pins.json` when the runner lands.

## The plan

1. **Setup, sent to the chain directly.** A fresh pool behind the existing verifier, and four
   notes deposited into it.
2. **Two nodes,** A and B, peered with each other only. Everything below is sent to node A.
3. **The transfer.** Two notes spent and two created, proved on this machine.
4. **Double spends, each with a proof that verifies on its own:**
   - while the transfer is pending, the same two notes to other outputs;
   - while it is pending, one of the same notes beside an unspent one;
   - after it is mined, the first again.
5. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - the node's answer;
   - whether it was mined, and if so its block, status and gas by frame.

   It keeps no key, note secret or witness.
