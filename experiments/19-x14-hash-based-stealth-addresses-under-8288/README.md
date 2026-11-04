# Experiment 19 (X14): hash-based stealth addresses against Tornado Cash, under EIP-8288

**Status: pre-registered 2026-11-04,** before any program, contract, client patch, runner or
transaction. It is built after experiment 17's run 2 and experiment 18. Predictions, what would
show each wrong, and the deviations are fixed here; results are added below them, and nothing
above the results is edited after a run.

## The question

[EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) (Draft) lets a frame transaction declare
dependencies, `(scheme, data_hash, verification_key_hash)` triples, that one recursive STARK per
block proves. A leanSPHINCS signature is declared at 3,000 gas and a leanSTARK proof at 30,000, so
a post-quantum private payment could cost tens of thousands of gas instead of millions.

Two kinds of private payment would use it, and they hide different things:
- **A hash-based stealth address.** The sender pays a fresh one-time account that only the
  recipient can spend, and announces an ML-KEM ciphertext the recipient finds by scanning. It hides
  who received the payment; the funding and the spend stay visible.
- **A Tornado Cash pool.** A deposit goes into a tree of notes of one denomination, and a
  withdrawal proves membership without saying which note. It hides which deposit a withdrawal came
  from.

This experiment builds five versions and asks, for each: what it costs, what each named party
learns, how many fit an inclusion list and an aggregation interval, and who can spend when someone
other than the owner generates the proof.

## Design

### The tools, pinned

- **leanVM** at
  [`3cbac04`](https://github.com/leanEthereum/leanVM/tree/3cbac047160f4d1465bfe985521603b0a3418556)
  (2026-11-04), Lean Ethereum's zkVM, which EIP-8288 names for aggregation. At that commit:
  - its one hash is Keccak-256, Ethereum's, with Keccak's original padding;
  - leanSPHINCS has the parameters merged that day: a 32-byte public key, a 7,740-byte signature,
    492 permutations to verify, $2^{30}$ signatures per key, and "not the definitive parameter
    set";
  - "Support for zero-knowledge is planned": its proofs do not yet hide their witness.
- **Keccak-256 throughout:** the stealth commitments, leanSPHINCS, both Tornado trees under
  EIP-8288, and the dependency hash.
- **ML-KEM-768** for the announcements, as experiment 17 implemented it.

### Five versions

| # | Version | A spend is authorised by | On chain at the spend |
|---|---|---|---|
| 1 | stealth account, preimage spend | a leanSTARK proof of knowledge of the account's secrets $(k, r)$ | one leanSTARK dependency |
| 2a | stealth account, leanSPHINCS verified privately, fixed rules | a leanSTARK proof that a committed rule accepts the signatures | one leanSTARK dependency under a shared program key |
| 2b | the same, any committed verification code | a leanSTARK proof that runs the committed code | one leanSTARK dependency under a second shared program key |
| 3 | stealth account, plain leanSPHINCS (control) | a leanSPHINCS dependency under the recipient's long-term key | the key itself |
| 4 | Tornado as deployed | a Groth16 proof verified in the EVM | root, nullifier hash, recipient, relayer, fee |
| 5 | Tornado under EIP-8288 | a leanSTARK proof of the same statement | one leanSTARK dependency |

**The stealth account (versions 1 to 3).** A recipient publishes a key $K$ and an ML-KEM key. For
each payment the sender encapsulates, derives $r$ from the shared secret, computes
$C = H(K, r)$, and has a fixed factory deploy and fund an account at a CREATE2 address derived
from $C$, then announces the ciphertext. The account stores $C$ and a nonce.
- **Version 1:** $K = H(k)$. A spend proves $C = H(H(k), r)$ and a tag $T = H(k, r, m)$ for the
  message $m$, which binds the destination, amount, fee, nonce and expiry.
- **Version 2:** $K = H(\mathit{rule}, \mathit{pk})$, where $\mathit{rule}$ names a verification
  rule and $\mathit{pk}$ its leanSPHINCS keys. A spend proves
  $C = H(H(\mathit{rule}, \mathit{pk}), r)$ and that the rule accepts signatures on $m$, with
  $\mathit{rule}$, $\mathit{pk}$, $r$ and the signatures private.
  - **2a:** one program that knows two rules, one key or 2 of 3 keys.
  - **2b:** the rule is a program committed by its hash; one fixed outer program verifies, by
    recursion, a proof of the committed program.
- **Version 3:** the account stores the recipient's long-term leanSPHINCS key and checks a
  leanSPHINCS dependency under it.

Every account in versions 1 and 2 is the same stub: the factory deploys one bytecode, and the
stub's `VERIFY` checks for a leanSTARK dependency under its version's program key whose public
inputs hash to $H(C, m)$.

**Tornado (versions 4 and 5).** One denomination, a depth-20 tree, and Tornado's withdrawal
statement: a note in the tree, its nullifier hash, and the recipient, relayer and fee bound into
the proof.
- **Version 4** is the deployed design: a MiMC tree over BN254 and a Groth16 verifier, built from
  Tornado's published circuit.
- **Version 5** rebuilds the tree with Keccak-256 and proves the same statement in leanVM.

### Enabling EIP-8288, two ways

1. **Modelled, on the Hegota test network.** Every proof and signature is real and is verified by
   leanVM off chain, and an aggregator folds each 1,000 ms interval's dependencies with leanVM's
   recursion. On chain, the triples travel in a frame's data and the account reads them. The
   reported gas is the measured gas plus the declared 3,000 or 30,000 per dependency. Nothing on
   chain checks the aggregate; that half is modelled, and every figure says so.
2. **A local chain.** ethrex at the test network's commit, `64b8fc09`, built from source with
   EIP-8288's dependency frame (`DEP_VERIFY_FRAME_MODE` 4) and the block-level recursive STARK
   patched in, verified with leanVM's verifier crate. EIP-8288 leaves two constants TBD, and they
   are this experiment's own: `AGGREGATED_VK` is the hash of leanVM's recursion program at
   `3cbac04`, and `DEPS_HASH` is Keccak-256.

### Arms

1. **Pay and spend, each version,** on the test network (modelled) and on the local chain. Version
   4 runs on the test network only, since it needs no EIP-8288.
2. **Two rules, one stub.** Two version 2a accounts, one with one key and one with 2 of 3 keys,
   each paid and spent.
3. **A delegated prover.** For versions 1, 2a and 5, a second process is given exactly what it
   needs to prove one spend to the owner's chosen destination, and then tries to produce an
   accepted spend to its own address.
4. **Linkage of the control.** Two version 3 accounts of one recipient, both spent.
5. **Aggregation.** On this machine, the aggregator folds intervals of each version's
   dependencies, and the experiment reports the most each interval holds.
6. **The local chain refuses bad blocks:** one whose recursive proof omits a dependency a
   transaction declared, and one whose proof is for different dependencies.
7. **Scanning.** The recipient scans 10,000 ML-KEM announcements, 40 of them its own.

### Measures

- **Cost:** gas per payment and per spend, split into execution, state and declared dependency
  gas; bytes on chain; for each proof, proving time, size and peak memory; the aggregator's time
  and memory per interval.
- **Who learns what,** from the run's own records, per version, for:
  - a chain observer;
  - the sender;
  - a scanner holding the decapsulation key;
  - the delegated prover, and anyone who sees a proof before leanVM has zero knowledge;
  - a quantum adversary recording today.
- **Capacity:** dependencies per transaction, per inclusion list under EIP-8369's
  `MAX_VERIFY_GAS_PER_IL` of $2^{20}$, and per aggregation interval on this machine.
- **Who can spend,** from arm 3.

## Predictions

1. **One stub hides the rule.** The two accounts of arm 2 have byte-identical code and storage
   layout, their spends declare the same program key, their spend transactions have the same
   calldata length, and their gas differs by less than 100.
2. **The signature keeps spending with the owner.** In arm 3, the version 2a prover cannot produce
   an accepted spend to its own address. The version 1 prover and the version 5 prover each can.
3. **The plain signature links.** In arm 4, both spends show the same leanSPHINCS public key on
   chain.
4. **The declared price dominates the spend.** Under EIP-8288, a spend of versions 1, 2a, 2b and 5
   costs less than 200,000 gas in all, including its 30,000 declared and any state it writes, on
   both chains. A version 4 withdrawal costs more than any of them.
5. **The two chains agree.** For every transaction run on both, the local chain's gas equals the
   modelled figure within 1,000.
6. **The local chain refuses both bad blocks** of arm 6.
7. **Proofs fit a machine one can buy.** On this machine (4 cores of a 2.10 GHz Xeon, 15 GB), each
   proof of versions 1, 2a and 5 takes less than 10 seconds and 8 GiB, and is between 100 and
   500 KiB. A version 2b proof costs more than a version 2a proof.
8. **Aggregation holds fewer here than on the project's machine.** The aggregator folds fewer
   leanSPHINCS signatures per 1,000 ms interval than leanVM's published 442.6 a second on a 16-core
   M4 Max, and at least 25.
9. **Capacity follows the declared prices.** An inclusion list holds 34 leanSTARK spends or 349
   leanSPHINCS spends, and a transaction one leanSTARK spend, so no transaction can both spend a
   stealth account of versions 1 or 2 and withdraw from the pool of version 5.
10. **Scanning finds every payment.** All 40 of the recipient's payments are found among 10,000,
    with no false match.

## What would show it wrong

| Prediction | Shown wrong by |
|---|---|
| 1 | any difference in code, storage layout, program key or calldata length, or a gas difference of 100 or more |
| 2 | the version 2a prover's spend accepted, or the version 1 or version 5 prover's refused |
| 3 | the two spends showing different keys, or none |
| 4 | a spend of 200,000 gas or more under EIP-8288, or a version 4 withdrawal cheaper than one of them |
| 5 | a difference of 1,000 or more |
| 6 | either bad block accepted |
| 7 | a proof of 10 seconds or more, 8 GiB or more, or outside 100 to 500 KiB; a version 2b proof no costlier than 2a |
| 8 | 442.6 or more a second, or fewer than 25 |
| 9 | a different count, or a transaction that both spends a stealth account and withdraws |
| 10 | a missed payment or a false match |

## Deviations, stated before the run

- **Privacy is conditional.** leanVM's proofs do not hide their witness yet. Every privacy result
  for versions 1, 2 and 5 holds only once leanVM has zero knowledge, and until then the witness
  may be visible to the prover, to every node that relays the proof, and to the aggregator. For
  version 2 that would leak the rule, the keys and $r$. For versions 1 and 5 it may leak the
  spending secret itself.
- **EIP-8288 is modelled on the test network,** and its two TBD constants are ours on the local
  chain.
- **leanSPHINCS's parameters are not final,** by the project's own statement; the pinned commit's
  are used.
- **Version 5 is a redeployment,** not the deployed pool: the deployed tree is MiMC over BN254.
- **The stealth account's construction** is a hash-preimage spend with a factory account per
  payment, specified here; the delivery is ML-KEM-768 as in experiment 17.
- **One machine proves and aggregates.** Its figures are this machine's, beside leanVM's published
  ones on its own.
- **If leanVM cannot express a statement,** that pass stops and is recorded with the reason, and
  the statement is not moved to another prover without an amendment.
- **If ethrex cannot be built and patched here,** the local-chain half stops and is recorded with
  the reason, and the modelled half stands alone.

## Path

Payments and spends are frame transactions sent first to a skandha node at `ede942f`, as in
experiments 01 to 18, and its answer is recorded; any it refuses go to the chain directly, and that
is recorded too. Every step is simulated on the test network before it is sent. On the local
chain, every transaction goes to the patched client directly.
