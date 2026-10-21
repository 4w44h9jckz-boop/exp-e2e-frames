# Experiment 13: one sealed comparison at every step of the trust gradient

**Status: run.** The claim, the predicted cells and the methods were pushed before any code
(`e8e204f`, worded at `95d8a43`), and the runner and checks before the first transaction
(`b1c8d3e`). Run 1 is `results/1-first-run.json`, and the results are at the end. Of the 24
predicted cells, one was measured otherwise.

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

## Results, run 1

Run 1 (2026-10-21, recorded at 08:58 UTC; setup in blocks 495,095 to 495,097), against
`ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`. Alice bid 700 and Bob 650, as in experiment 52,
so the bit is 1. `npx vitest run test/x13.test.ts`: 12 of 12 checks pass.

**The two columns run here, end to end.**
- **MPC committee.**
  - Each owner split its own input and each member merged its shares.
  - The guess `out = 0` stopped all three members at the circuit's line 73,
    `out === gt[5][0]`, in about 0.65 s: the check opened one bit, that the guess was wrong.
  - With `out = 1` the witness took 0.76 s and the three members' proof 0.23 s. They agreed
    on one proof, which experiment 52's verifying key accepts, its public signals
    `(Ca, Cb, session, 1)`.
  - Sent to node A, it reached B by gossip and left through B alone. It settled the session
    in block 495,117, 493,087 gas, with SealedPair as sender and payer. The same proof with the
    bit flipped was refused, `ErrFramePrefixReverted`.
- **FHE committee.**
  - Each owner encrypted its bid with a proof of knowledge bound to the session and to itself,
    about 3 s each, and the committee checked both proofs, about 2.3 s each.
  - The coprocessor compared them in 3.8 s, and all four members decrypted the bit, 1.
  - Three of four signed it. Two members' signature was refused at node A, and so was the
    quorum's signature for another request.
  - All three asked to sign the other bit refused, each with `Locked`.
  - The result, sent to node A, reached B by gossip, left through B alone and was mined in
    block 495,120, 236,927 gas. A second result and the replay were refused.

**The chain cannot tell three of the routes apart.** The MPC committee's settlement used, frame
for frame, the gas experiment 52's joint proof used and the gas one prover's proof used:
expiry 3,051, `VERIFY` 220,481 with 97,920 state gas, settle 54,890 with 97,920. All three are
proofs of one statement under one key, through one contract. Which of them a session settled
by is visible only off chain.

### The table

M: measured in this run. C: carried, from the record named, read back from the chain in this
run where it is a transaction. R: read from the code or the scheme, not measured. A cell in
bold was measured otherwise than predicted.

| Row | Direct coordination | MPC committee | FHE committee | Enclave, attestation | Enclave, proof |
|---|---|---|---|---|---|
| Who sees the plaintext | its owner only: at every stop the other had learned nothing but ciphertexts, or the bit (C, 52) | no one directly; any two members' input shares rebuild both bids, all three pairs tried (M) | **one process, the setup, held the whole key before splitting it, so one party could decrypt alone unless it erased the key (R, the committee's code)**; four members decrypt (M) | the enclave, which holds the key the bids are encrypted to (C, 51) | the same (C, 51) |
| What privacy rests on | the joint protocol and its Paillier key, held by Alice; semi-honest (C, 52) | no two members pooling their shares (M) | the key's holders not pooling, and the dealer's erasure (R) | the enclave and its operator (C, 51) | the same (C, 51) |
| Who must be online | both owners (C, 52) | every member: two without the third timed out at 60 s (M) | all four to decrypt (R, the committee's code); three of four to sign: two were refused (M) | the operator (R) | the operator (R) |
| Fairness | none by cryptography; the bonds price an abort: Bob, stopping after Alice's share had shown him the bit, lost his bond to her (C, 52, S4) | the members learn the bit first, when the check opens it, and could stop before proving; the owners' bonds return at the deadline (M, R) | the members learn the bit first, at decryption, and could stop before signing; nothing on chain is locked (M, R) | the enclave learns the bit first | the same |
| What the output says | the bit: Alice learns $b < 700$, Bob learns $a > 650$ | the same | the same | the same | the same |
| Operator left | none past the session (C, 52) | none that can evaluate again; the input shares, if kept, still rebuild these bids (M) | the key, for every later input (R) | a machine and its keys (C, 51) | the same |

### The rows added

| Row | Direct coordination | MPC committee | FHE committee | Enclave, attestation | Enclave, proof |
|---|---|---|---|---|---|
| Who can get a false bit accepted, and what catches it | no one: the verifier checks the proof against both commitments; `out` flipped refused (C, 52) | no one, all three members together included: the same check; `out` flipped refused (M) | any three members: the contract checks only their signature, and nothing on chain checks the bit (R); the lock refused a second bit only because the members kept it (M) | the attestation key's holder: a wrong output and a measurement that never ran were both accepted in simulation (C, 51, D1 and D2) | no one: the proof binds the ciphertexts and the bit (C, 51, D3) |
| Rounds and bytes per party | 11 round trips; Alice sent 2,452,736 B, Bob 1,275,648 B (C, 52) | not counted by the tool: 1,238,678 B on the loopback for all three members, both directions, TLS included, over both attempts (M) | decryption: 3 rounds, 9 messages and 6,660 B per member (M) | one round: each owner posts a 96-byte ciphertext (C, 51) | the same, with 256 bytes of proof (C, 51) |
| Latency, and over what | witness 9.8 s, prover 132.8 s, both owners in one process (C, 52) | witness 0.76 s and proof 0.23 s, after a 0.65 s failed guess; three processes over loopback TLS (M) | encryption about 3 s per owner; proof checks about 2.3 s each; comparison 3.8 s; decryption 0.7 s inside 3.4 s; in one process (M) | 3.7 s from process start (C, 51) | the same run (C, 51) |
| What stopping partway costs, and who knows the bit then | see Fairness; every abort left the one who did not abort at least what it put in (C, 52) | the members, after the check: no settlement, bonds back at the deadline (R) | the members, after decryption: no result (R) | the enclave | the enclave |
| `VERIFY` gas and the whole transaction | 220,481; 493,099 (C, 52, S1) | 220,481; 493,087 (M) | 119,616; 236,927 (M) | 9,696; 152,278 (C, 51, A) | 245,699; 368,405 (C, 51, B) |
| Against 500,000 and 100,000 | fits; over | fits; over | fits; over | fits both | fits; over |
| Post-quantum status of what it rests on | Groth16 on BN254 and Paillier: neither survives; the Poseidon commitments are a hash (R) | Groth16 on BN254: does not survive; REP3's sharing is information-theoretic (R) | the TFHE ciphertexts are lattice-based; the input proof is over BLS12-446 and the signature is BLS12-381: neither survives (R) | P-256: does not survive (R) | Groth16 on BN254: does not survive (R) |

**The cell measured otherwise.** For the FHE committee the prediction named a quorum of key
holders as the parties that could decrypt. The committee's key was dealt: its setup, one
process, made the whole key and then split it. Until that process erases the key, one party can
decrypt alone. The privacy row predicted the erasure; the plaintext row did not, and the run's
setup shows it. A distributed key generation would remove the dealer; it is priced in the
committee's own README and not built.

**What it does not show.** Malicious owners or members, for both committees. A committee that
returns a proof can stop the session, but cannot get a false bit accepted; a committee that
returns a signature can do both. The enclave is simulated, and its columns are carried, not run
here.

