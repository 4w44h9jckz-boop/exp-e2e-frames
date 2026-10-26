# Experiment 05: a private transfer proved on the device, mined through open mempool nodes with no sequencer

**Status: run.** The claim, what would show it wrong and the plan below were committed before
any transaction (4a69ccf), and the runner and its checks before the first (7e5b018). The results
are at the end. In run 2 the proof was checked within the testnet's validation budget and not
within EIP-8141's, and no note was spent twice.

**The claim.** A rollup in Aztec's style exists to order private transfers and to carry their
proofs to L1. Frame transactions can take its place:
- the device proves the private transfer;
- a `VERIFY` frame checks that proof and approves the fee from the pool;
- each note it spends is one of the transaction's nonce keys;
- a `SENDER` frame does the public part, inserting the new notes.

Open mempool nodes then order the transfers and refuse a second spend of a note, with no
sequencer, and the chain includes them.

> **Read after the run, 2026-10-26: how Aztec itself differs.** This run removes Aztec's
> proposer, committee and provers, not a double-spend check Aztec lacks. Aztec's nodes already
> refuse a transaction "for repeating a nullifier" before relaying it, and its rollup circuit
> makes a second spend unprovable. Aztec's client proof is a different system from this
> circuit's: it is verified inside Aztec's rollup circuits and has no verifier of its own on L1.
> Aztec hides which contract ran ("The addresses of all private calls are hidden from
> observers"), which a pool as sender gives up. And Aztec's mainnet rollup has an escape hatch:
> a bonded proposer may "bypass the committee and propose blocks" in periodic windows. Sources:
> docs.aztec.network v6.0.0, "Transactions"; AztecProtocol/aztec-packages at `c1b606f9`,
> `l1-contracts/src/core/EscapeHatch.sol`; aztec-labs-eng/aztec-node at `e0c29915`,
> `yarn-project/p2p/src/msg_validators/tx_validator/double_spend_validator.ts`. The claim above
> is kept as written before the run.

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

## Runs

| Run | When (UTC) | Outcome |
|---|---|---|
| 1 | 2026-10-21, 07:34 to 07:36 | Stopped at the first proof. The pool was deployed and funded (blocks 494,341 and 494,342), and no spend was sent. No record was written |
| 2 | 2026-10-21, 07:46 to 07:48 | Recorded: `results/2-second-run.json` |

**Run 1.** The runner gave the prover the Groth16 key directory as a relative path. The Groth16
tool runs in a scratch directory of its own, so it did not find the proving key and the first
proof failed. The same request proved offline once the path was absolute. The runner now passes
an absolute path, and makes the `out/` directory that experiment 42's script writes each proof
into (af659a1). The pool from run 1 is left on the testnet unused.

**A difference from the plan.** The plan says four notes are deposited. Experiment 42's script,
which the runner calls unchanged, deposits five in one transaction; double spend (b) uses the
fifth.

## Results, run 2

The client was `ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`. Node A ran with
`--frames.enable` alone and node B with `--frames.handoff` as well; both ran the
`hegota-testnet` profile. The proofs were made on this machine with Noir 1.0.0-rc.6 and the
Groth16 key committed in exp-frames experiment 42, about 1.7 s each.

**Setup, to the chain.** A fresh pool (`0xaF36C0d0...`) behind the Groth16 verifier and adapter
already on the testnet was deployed in block 494,446, and five notes were deposited in block
494,447.

**The transfer.** Notes 0 and 2 were spent and two notes created. The transaction is 909 bytes,
has no signature, and has the pool as both sender and payer. It was sent to node A, which
admitted it and relayed it; node B received it by gossip and handed it to the chain; A handed
nothing on. It was mined in block 494,452 with every frame succeeding.

| Frame | Mode | What it does | Execution gas | State gas |
|---|---|---|---|---|
| 0 | `VERIFY` | the root the proof names is recent | 5,579 | 0 |
| 1 | `VERIFY` | the Groth16 proof, approving execution and payment | 356,540 | 195,840 |
| 2 | `SENDER` | inserts the two new notes | 2,337,165 | 97,920 |

The state gas in frame 1 is the two nullifiers' first use as nonce keys, which EIP-8250 charges
to the frame that approves payment. The validation prefix used 362,119 execution gas: within the
testnet's 500,000, and over EIP-8141's 100,000 by a factor of about 3.6. So the claim holds on
the testnet as configured and not under the EIP's budget.

**Double spends.** Each carried a proof that verifies on its own, and each was refused by node A,
never gossiped to B and never mined.

| Sent to node A | Answer | Why the node refused it |
|---|---|---|
| (a) while the transfer is pending: the same two notes, to other outputs | `ErrReplaceUnderpriced` | the same sender and the same nonce keys make it the same transaction to the node, so it would replace the transfer, and its fee was not 10% higher |
| (b) while the transfer is pending: note 0 beside the unspent note 4 | `ErrFrameSenderBusy` | it shares a nonce key with the pending transfer, and the profile admits a second transaction from one sender only when their keys are disjoint |
| (c) after the transfer is mined: (a) again | `ErrNonceTooLow` | the nullifiers' nonce keys are already used on chain |

The node rules are skandha's FP-12, read from `packages/framepool/src/pool.ts` and
`packages/framepool/src/config.ts` at the pinned commit. (a) also means that a copy at a fee 10%
higher would have replaced the pending transfer rather than been refused. Only one of the two
could then be pending, and only one mined, so no note is spent twice either way. Only the holder
of the notes' key can make such a copy, since it needs a new proof.

**What a shared nullifier set would still need.** Derived from EIP-8250's text (Draft, read
at ethereum/EIPs `258836f9`) and this run's record, not measured. A keyed nonce is stored under
`slot(sender, nonce_key)`, so the nullifier set this pool gets from its nonce keys belongs to its
sender, the pool. Two pools are two senders with two such sets: the same nullifier spent in
each would be two first uses, and nothing in the protocol would join them. A nullifier set
shared across pools would need every pool to be one sender, or nullifiers kept in contract
storage that each pool reads in `VERIFY`, which the validation rules restrict. The same EIP
keeps EIP-8141's limit of one pending frame transaction per sender in the public mempool. So
under the EIP's own mempool rule, a pool that is one sender has one transfer pending at a time.
The testnet profile this run used admits a second one when the two use disjoint nonce keys.

**Checks.** `npx vitest run test/x4.test.ts`: 8 of 8 pass on run 2's record.

**What this does not show.** Two nodes on one machine over loopback, one transfer, and one run.
It does not show how many transfers from one pool a node holds at once when their notes are
disjoint, which the profile allows; nor anything under the `eip-8141` profile, where the prefix
does not fit.
