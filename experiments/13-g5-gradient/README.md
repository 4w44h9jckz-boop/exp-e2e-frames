# Experiment 13: one sealed comparison at every step of the trust gradient

**Status: written before any transaction.** This README states the claim, the cells it
predicts, how each row is measured, what would show it wrong and the plan. The runner and the
offline checks follow, and are pushed before the first transaction.

**The function.** Two owners each hold a 64-bit bid, `a` and `b`, and have each committed to it
with $C = \mathrm{Poseidon}(x, r)$. The output is one bit, $\mathrm{out} = [a > b]$. The
commitments and the circuit are exp-frames experiment 52's: `joint.circom`, its proving key
`joint.zkey` and the verifier and `SealedPair` contract it deployed on the testnet.

**The claim.** Running that function one step at a time along the trust gradient, from no
intermediary to a persistent operator, changes six things in the way the cells below predict:
who sees the plaintext, what privacy rests on, who must be online, what fairness there is, what
the bit reveals, and which operator remains. Each step still settles on chain in one frame
transaction that a `VERIFY` frame checks.

## The steps

| Column | Who computes | Settles through | Run here or carried |
|---|---|---|---|
| Self-update | the one owner | | not applicable: the function needs two owners' inputs, and no one owner holds both |
| Direct coordination | the two owners, jointly, with no third party | `SealedPair`, on one joint Groth16 proof | carried from exp-frames experiment 52's record |
| MPC committee, returning a proof | three members holding replicated shares of both bids (TACEO's co-circom, REP3) | the same `SealedPair`, the same verifier, the same key | **run here** |
| FHE committee, returning a threshold signature | this repository's committee: a dealt threshold TFHE key and a Commonware DKG BLS key | experiment 06's result contract, on the committee's signature | **run here** |
| Enclave, attestation | one simulated enclave, its key vouched for by an attestation key | a signature check in `VERIFY` | carried from exp-frames experiment 51's record |
| Enclave, proof | the same enclave, also returning a zero-knowledge proof | a proof check in `VERIFY` | carried from exp-frames experiment 51's record |

## The cells it predicts, written before the run

For the four computing columns run or carried. "Shares" means the members' input shares.

| Row | Direct coordination | MPC committee | FHE committee | Enclave (both routes) |
|---|---|---|---|---|
| Who sees the plaintext | no one but its owner | no one directly; enough shares together rebuild it | no one directly; a quorum of key holders can decrypt it | the enclave, inside |
| What privacy rests on | the joint computation, and the counterparty finishing it | the members not colluding | the key holders not colluding, and the dealer having erased the key | the hardware, its manufacturer and its operator |
| Who must be online | both owners | every member | the decrypting members and a signing quorum | the operator |
| Fairness | none: the owner who finishes last learns the bit first and can stop | depends on the protocol | depends on the protocol | depends on the operator |
| What the output says | the bit, which can narrow the other owner's bid | the same | the same | the same |
| Operator left | none past the session | ephemeral: one evaluation | persistent: the key outlives the evaluation | persistent: a machine and its key |

**What would show it wrong.** Any cell in that table measured otherwise for this function, at
any column. A row that the run cannot measure is recorded as not measured, and does not count
either way.

## The rows added, recorded with no prediction

- Which party could get a false bit accepted on chain, and which check catches it.
- Rounds and bytes per party.
- Latency, with the network it was measured over.
- The price of stopping partway, and which party knows the bit at that point.
- Gas: the `VERIFY` frame and the whole transaction, against the testnet's 500,000 and
  EIP-8141's 100,000.
- The post-quantum status of what each column rests on.

## How each row is measured

- **Who sees the plaintext.** Which processes held the bids in the clear, or held enough to
  rebuild them. For the MPC committee: whether two members' input shares rebuild a bid,
  computed offline from the share files this run wrote. For the FHE committee: which key
  material decrypts, from the setup this run made.
- **What privacy rests on.** The same, and what holding that material would take.
- **Who must be online.** The step is run with members missing, and the outcome recorded: the
  MPC witness with two of three members, and the FHE signature below its quorum (experiment
  06's variant). The FHE decryption is not run short: the committee's code runs it with all
  four members, and that is read from the code, not measured.
- **Fairness, and what an abort costs.** Who learns the bit first, in the order the protocol
  runs, and what is left on chain if the step stops there: the bonds `SealedPair` holds and
  their deadline, or nothing for the result contract.
- **What the output says.** The bit, and the range of the other bid it implies, from the
  owner's side.
- **Operator left.** What remains after the evaluation that could run another one: shares,
  keys, a machine.
- **Wrong result.** For each column, which party could produce a result the chain accepts that
  is not the function of the bids, and which check would catch it. The run sends one wrong
  result per run column: the settlement with `out` flipped, and the committee's signature over
  another value.
- **Rounds, bytes and latency.** For the MPC committee, bytes on the loopback interface while the
  members run and nothing else does, both directions, all members, TLS included. For the FHE
  committee, the committee's own counters. Every latency here is a loopback figure on one
  machine: a LAN time at best.

## The plan

1. **Setup, to the chain directly.**
   - Two owners derived for this run, funded.
   - For the MPC column: Alice opens a `SealedPair` session with a bond and her commitment, and
     Bob joins with his.
   - For the FHE column: the result contract deployed with the committee's BLS key.
2. **The MPC committee.** Each owner splits its own bid into three shares. Each member merges
   the shares it receives, and the members extend the witness together.
   - The circuit takes `out` as an input it checks. So the members try `out = 0` first, and the
     check opens one bit: whether the guess is right. If it is not, they run again with
     `out = 1`. Both attempts are recorded.
   - They prove with experiment 52's key. The proof is checked against its verifying key, and
     the settlement is sent to node A.
   - Before the nodes start: the same with only two members, and the loopback bytes.
3. **The FHE committee.** Each owner encrypts its bid with a proof of knowledge bound to the
   session and to itself. The committee checks both proofs, compares, decrypts, and a quorum
   signs the bit in experiment 06's format. The result is sent to node A, with experiment 06's
   variants: a signature below the quorum, one for another request, a second result and a
   replay.
4. **Two nodes,** A and B, peered with each other only, as in the other experiments. B alone
   hands transactions to the chain.
5. **Carried cells.** Experiments 51 and 52's records are read at a pinned commit of exp-frames,
   and each figure carried into the table names the record and field it came from.
6. **The record** keeps every transaction's bytes and hash, each node's log lines for it, whether
   it was mined, and what each member sent. It keeps no bid, randomness, share or key.

## What it does not test

A malicious member or owner. Both committees are semi-honest here, as their libraries are. A
REP3 member who deviates from the protocol can leak another party's secret through the proof,
and this repository's committee signs whatever it decrypts. The enclave is simulated: what it hides from its operator is not
tested, only what the chain can check.
