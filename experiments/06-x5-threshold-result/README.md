# Experiment 06: an FHE result decrypted and signed by a threshold committee, checked in VERIFY

**Status: run once, results below.** The claim, what would show it wrong and the plan were pushed
at `839f125`; the contract, the runner and the offline checks at `8111713`, before the first
transaction; the run is `results/1-first-run.json`.

**The claim.** Fhenix's CoFHE keeps a threshold network that decrypts results. Frame transactions
can take away everything else between that network and the chain:
- a result reaches L1 in a transaction whose `VERIFY` frame checks the network's threshold
  signature over the request and the result;
- no other verifier signs;
- an open node admits the result on that check alone.

The network's key is then the only trust left.

> **Read after the run, 2026-10-26: Fhenix's deployment is not this shape.** The claim above
> was written from Fhenix's blog and SDK introduction, which describe a threshold network.
> Fhenix's CoFHE documentation and its `TaskManager` contract describe what runs today. One
> Intel TDX enclave holds the whole decryption key and decrypts: "Instead of splitting the
> decryption computation across independent parties, Teecryptor relies on hardware
> attestation". A decrypted value is accepted on chain against one ECDSA signer, which a
> privileged role can replace, and one enclave checks input proofs. Fhenix calls this training
> wheels and plans a threshold network. So this experiment runs Fhenix's planned shape, not its
> deployment. And "as the deployed system's verifier does", below, holds only for checking the
> input off chain: Fhenix's verifier is one enclave, not a committee. Sources:
> cofhe-docs.fhenix.zone (Teecryptor, Key management, Future plans); FhenixProtocol/cofhe-contracts
> at `b5c20ed4`, `TaskManager.sol`. The claim above is kept as written before the run.

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

## Results, run 1 (`results/1-first-run.json`)

On the ethrex Hegota testnet, chain 8141, 2026-10-21. `test/x5.test.ts` checks the record offline:
11 of 11 pass.

| Sent to node A | Node A's answer | Mined |
|---|---|---|
| the result the quorum signed (3 of 4 members) | admitted, gossiped to B, handed to the chain by B | block 494,263, status 1 |
| the same result, signed by two members | `ErrFramePrefixReverted` | no |
| the quorum's signature presented for another request | `ErrFramePrefixReverted` | no |
| a second result for the same request, value 43, fees bumped, while the first was pending | `ErrFramePrefixReverted` | no |
| the first result's bytes again, once mined | `ErrNonceTooLow` | no |

- **The result contract** is 1,520 bytes of code: its runtime and the committee's 256-byte key.
  It was deployed by the funder at block 494,260.
- **The result transaction:** two frames, no signature, the contract as sender and payer.
  - Its `VERIFY` frame, the committee signature's check, used **119,616 gas**. That is inside the
    testnet's 500,000 and above EIP-8141's 100,000. No BLS check fits the second.
  - The whole transaction used 236,963 gas. That includes the request's nonce key, which is set
    on first use.
- **The committee.** The second result got no signature: each member answered `Locked` for the
  request it had already signed. So the node never had a second signed result to decide between.
  Had a corrupted quorum signed one, the nonce key would still have let only one be mined.
- **Communication, per member, for the decryption:** 3 rounds, 9 messages and 6,660 bytes sent.
  All four members ran in one process on one machine, in memory, so the times are a LAN time at
  best:

  | Step | Time |
  |---|---|
  | setup | 30.4 s |
  | encrypt | 3.8 s |
  | the input's check, off chain | 2.8 s |
  | evaluate | 5.1 s |
  | decrypt | 16.9 s |
  | the BLS key's DKG | 45 ms |

**Against what would show it wrong: nothing observed.**
- A result signed below the quorum was refused before inclusion, and not mined.
- A signature was not accepted for another request.
- At most one result for the request was mined.
- The result needed only the committee's signature, two open nodes and the chain: no other
  verifier and no other signer.

**What the run does not show.**
- **The input side.** The request's input proof was checked off chain, by the coprocessor's step,
  because no `VERIFY` frame can afford it (experiment 41).
- **The key.** The TFHE key was dealt, so the dealer saw it whole once. The committee's README
  prices the distributed key generation that would remove the dealer.
- **Real deployments.** The committee and the coprocessor are rebuilt roles over the published
  libraries, not Fhenix's own network.
