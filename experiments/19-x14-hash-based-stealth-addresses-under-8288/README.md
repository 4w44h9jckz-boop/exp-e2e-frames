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

## Amendment 1, 2026-11-04, before any run: two runs, version 2 in the second

**What changes.** Run 1 builds and runs versions 1, 3, 4 and 5, and arms 4 to 7 as far as they
concern those versions: the delegated prover for versions 1 and 5, the control's linkage,
aggregation, the local chain, and scanning. Run 2 builds and runs versions 2a and 2b, and arms 2
and 3 as they concern version 2.

**Why.** Versions 1 and 5 are short programs written here: a preimage chain, and a depth-20
Keccak membership path. Version 2a needs leanSPHINCS verified inside a leanVM program of its own.
leanVM verifies leanSPHINCS only inside its aggregation guest
(`crates/rec_aggregation/guests/lean_ethereum.py`, `verify_sig_lean_sphincs`). That verifier rests
on dozens of the guest's helpers and constants, and on witness streams the aggregation's Rust code
builds for each signature. Lifting both out is a piece of work of its own, and version 2b sits on
recursion besides.

**What it does not change.** No prediction, threshold or falsifier is edited. Predictions 1 and
2, and version 2's half of prediction 7, are judged in run 2. Everything else is judged in run 1.

**Before the run, on the tooling.**
- The cell encoding of `programs/` was checked against leanVM's own known answer, $H^3(5, 7)$
  from its test programs.
- Both of run 1's programs prove and verify at leanVM `3cbac04`, and a witness for another
  message is refused.

## Results, run 1

Deployment `d5`, run at `31d8619`, blocks 685,330 to 685,349, after four passes that stopped (below)
and Amendment 1. Records: `results/1-first-run.json` (the test network),
`results/1-first-run-bench.json` (proofs and scanning, on an idle machine),
`results/1-first-run-aggregation.txt` (aggregation); fixture `test/fixtures/x14/1-first-run.json`.
EIP-8288 is modelled throughout: each dependency triple travels in the `VERIFY` frame's data, its
proof is checked off chain by `prover/`, and the declared gas is added to what the chain measured.

### Predictions, as far as run 1 reaches

| # | Prediction | Outcome |
|---|---|---|
| 1 | one stub hides the rule | **run 2** (version 2a) |
| 2 | the signature keeps spending with the owner | **held for versions 1 and 5; version 2a in run 2.** A delegated prover given version 1's $k$ and $r$ proved its own message and spent the account to itself; one given version 5's note secrets withdrew the note to itself. Both were mined |
| 3 | the plain signature links | **held.** Both version 3 spends declared the same key, `0x37af418d...8e8a8f95` |
| 4 | the declared price dominates the spend | **in part.** Version 4's withdrawal, 555,548 gas, costs more than every other spend, as predicted. The 200,000 bound failed on state: version 1's spend is 212,373 measured plus 30,000 declared, 242,373, of which 183,600 is the fresh destination's account; version 5's withdrawal is 313,698 plus 30,000, 343,698, of which 183,600 is the destination and 97,920 the nullifier's nonce key. Without that state, the execution of each is 13,479 and 15,552 gas, under half the declared 30,000 |
| 5 | the two chains agree | **run 2** (the local chain) |
| 6 | the local chain refuses both bad blocks | **run 2** (the local chain) |
| 7 | proofs fit a machine one can buy | **held for versions 1 and 5; version 2's comparison in run 2.** Version 1: 4.6 to 5.7 s, 198 KiB, 142 MiB peak; version 5: 4.9 to 6.3 s, 200 KiB, the same peak. Both programs are tiny (32 and 286 cycles) and pay for leanVM's smallest commitment, $2^{18}$ |
| 8 | aggregation holds fewer here than on the project's machine | **held.** 48 leanSPHINCS signatures in 0.673 s and 64 in 1.041 s on this machine's 4 cores, 60 to 95 a second, against leanVM's 442.6 a second on its 16-core machine; at least 25 per 1,000 ms interval |
| 9 | capacity follows the declared prices | **held by arithmetic; on a chain in run 2.** $2^{20}$ over 30,000 is 34 leanSTARK spends per inclusion list, and over 3,000 is 349 leanSPHINCS spends; `MAX_STARKS_PER_TX` = 1 leaves no transaction both a version 1 spend and a version 5 withdrawal. The modelled test network enforces none of these limits, so they are untested on a chain |
| 10 | scanning finds every payment | **held.** 40 of 40 among 10,000 announcements, no false match, 0.83 ms each; 82 passed the view tag |

### What a payment and a spend cost

| | Version 1 | Version 3 | Version 4 | Version 5 |
|---|---:|---:|---:|---:|
| payment: an account deployed and funded, or a deposit | 1,358,677 | 1,358,677 | 3,267,666 (first leaf) | 2,580,539 (first leaf); 416,213 (second) |
| spend or withdrawal, measured | 212,373 | 211,678 | 555,548 | 313,698 |
| of which state | 183,600 | 183,600 | in the call | 281,520 |
| declared by EIP-8288 | 30,000 | 3,000 | none | 30,000 |
| `VERIFY` execution | 1,233 | 1,038 | none (a plain call) | 3,259 |

- **A stealth account per payment is expensive on this network:** 1,239,300 of the payment's gas is
  state, the new account and its code at 1,530 a byte. A minimal proxy in front of one shared
  implementation would cut the code to a few dozen bytes; it was not built.
- **The pool's deposit is cheaper after the first leaf** (416,213 against 2,580,539), because the
  first writes every subtree slot fresh.
- **Version 4's withdrawal is the Groth16 check and the nullifier,** in a plain call a relayer pays
  for. Versions 1, 3 and 5 are sent and paid for by the account or the pool itself.

### The local chain

ethrex at the test network's commit, `64b8fc09`, built here in release mode in 15 minutes 17 seconds,
with a 2.0 GB target and 2.2 GB of disk left. The patch, EIP-8288's dependency frame and the
block-level recursive proof verified with leanVM's verifier, was not written in run 1, so
predictions 5 and 6 are judged in run 2, with version 2.

### Findings

- **Delegated proving hands over the account in version 1 and the note in version 5,** on chain and
  not only in principle: both delegated provers spent what they proved for to themselves.
- **The plain leanSPHINCS control shows its key at every spend:** two accounts, one key, visible to
  anyone reading the dependency.
- **Under EIP-8288 the declared price, not execution, is the spend's verification cost:** 30,000
  declared against 1,233 to 3,259 measured in `VERIFY`.
- **On this network's state pricing, what a spend writes outweighs what it verifies:** the fresh
  destination is 183,600 and a nullifier's nonce key 97,920.
- **skandha admitted every frame transaction** and relayed none, as in experiment 18.

### Passes that stopped

| Pass | Stopped at | Fixed by |
|---|---|---|
| d1 | the first payment: the account's code is state at 1,530 a byte, and the frame had state for an empty account | state for the new account and its code |
| d2 | version 1's second spend: accepted by the RPC and lost, sent right after its account's deployment, which a lagging node behind the balancer had not seen | the same raw transaction resent while the chain does not know it, up to three times; none was needed in d5 |
| d3 | version 5's first deposit: out of gas at 900,000, its first leaf writing 23 fresh slots | deposit gas for a first leaf |
| d4 | the record, after every arm had run: the secret search could not serialize a BigInt | the search serializes BigInts; the whole run repeated as d5 |

### Transactions

| Step | Transaction | Block |
|---|---|---:|
| v1: pay and announce through the singleton | see the record, `rows[0]` | 685,332 |
| v1: the owner spends | [`0x036a9c67...`](https://dora.privacy.ethrex.xyz/tx/0x036a9c67eb997521a75f2ac0c9ca9e7fd55ef2436908e633d59052c36216969b) | 685,333 |
| v1: the delegated prover spends to itself | [`0x97688f63...`](https://dora.privacy.ethrex.xyz/tx/0x97688f63b99eee4097cff329b9e371fce8d120dcc5a098b0849b6a4620ef8703) | 685,336 |
| v3: two spends under one key | [`0xbcf789b8...`](https://dora.privacy.ethrex.xyz/tx/0xbcf789b88f2c19c6518af446929eec37d004fc344cc4ebdeb772957857c4aca2), [`0x9b2977c7...`](https://dora.privacy.ethrex.xyz/tx/0x9b2977c719729699c831d99636ab40dea0d7f2e43b7394680b3919ae4d6ae8bb) | 685,338; 685,340 |
| v5: the owner withdraws | [`0xdddc429b...`](https://dora.privacy.ethrex.xyz/tx/0xdddc429bee6da2c6abb53061dd32956dc873d1bfe4901942395d1e49fc34c78c) | 685,344 |
| v5: the delegated prover withdraws to itself | [`0x27fadf49...`](https://dora.privacy.ethrex.xyz/tx/0x27fadf49bc12a37bcf49472f901aa5268ad19faa0b102ae1d9864c56e9a0a9a6) | 685,346 |
| v4: a relayer withdraws with a Groth16 proof | [`0x453e6819...`](https://dora.privacy.ethrex.xyz/tx/0x453e6819bae936dfeb9334ef3bcbb6718ebcd3b229ff5d9bb282c20fb48a55be) | 685,349 |

The test network's relaunches void its hashes; the fixture keeps every frame transaction.

### Tornado's circuit

Built by `tornado.sh` from tornado-core at `1ef6a26` (GPL-3.0, not copied here), with the syntax
port the script lists. The compiled circuit, its key and its port stay out of git; their sha256 are
`withdraw.zkey` `355d98ad...ec1f91`, `withdraw.r1cs` `a1591fd7...af70751`,
`withdraw_js/withdraw.wasm` `19ea5c92...a6fee2`.
