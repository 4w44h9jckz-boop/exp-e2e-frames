# Experiment 06: an FHE result decrypted and signed by a threshold committee, checked in VERIFY

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner, the offline checks and the results follow in later commits, and
the checks are pushed before the first transaction is sent.

**The claim.** Fhenix's CoFHE keeps a threshold network that decrypts results. Frame transactions
can take away everything else between that network and the chain:
- a result reaches L1 in a transaction whose `VERIFY` frame checks the network's threshold
  signature over the request and the result;
- no other verifier signs;
- an open node admits the result on that check alone.

The network's key is then the only trust left.

**Half of the original claim is already settled, and is not run here.** It said a request's own
`VERIFY` frame would check the encrypted input's proof of knowledge. That proof, as TFHE-rs
makes it, costs at least 3,936,012 gas to check in `VERIFY` (exp-frames experiment 41): about
eight times the testnet's 500,000. So the request side is recorded as failing, and the input is
checked off chain by the committee, as the deployed system's verifier does. This experiment runs
the result side.

**What would show it wrong.** Any one of these:
- a result signed by fewer members than the threshold is accepted by a node, or mined;
- a signature made for one request is accepted for another;
- two results for one request are both mined;
- the result transaction needs anyone besides the committee, an open node and the chain.

The signature check's gas is recorded against the testnet's 500,000 and EIP-8141's 100,000. No
BLS check fits the second, so the claim can hold only at the first.

## Pieces

| Piece | Role |
|---|---|
| exp-e2e-frames `committee/fhe-committee` | a fixed committee of four holding a threshold TFHE key, which is dealt, and a coprocessor that evaluates |
| exp-e2e-frames `committee/bls-committee` | the same committee's threshold BLS key, from Commonware's DKG, signing a result in its fixed format |
| a result contract, in this experiment | its own sender. Its `VERIFY` frame checks the committee's signature over chain ID, request, result handle and value, on EIP-2537's precompiles, with each request as a nonce key |
| skandha | two nodes with frame transactions on. B alone hands transactions to the chain |
| chain | the ethrex Hegota testnet, chain 8141 |

Each is pinned at a full commit in `pins.json` when the runner lands.

## The plan

1. **Setup, sent to the chain directly.** The committee's keys, and the result contract with the
   committee's BLS key in its code.
2. **A request.** An input is encrypted under the committee's TFHE key and checked off chain. The
   coprocessor evaluates it, and a quorum decrypts and signs the result.
3. **Sent to node A:**
   - the result, signed by a quorum;
   - the same result signed by fewer than the quorum;
   - the quorum's signature presented for another request;
   - a second result for the first request, with a different value.
4. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - the node's answer;
   - whether it was mined, and if so its block, status and gas by frame;
   - the committee's messages, bytes and rounds per member, and the network those were measured on.

   It keeps no key or share.
