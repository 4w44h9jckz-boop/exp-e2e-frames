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

**Correction, 2026-11-04, after run 1.** Prediction 7's times above were measured with `prover/`
built without `-C target-cpu=native`, the flag leanVM's own workspace builds with
(`work/leanVM/.cargo/config.toml`); a crate outside that workspace does not inherit it. In a trial
before run 2, one version 2a proof took 6,171 ms without the flag and 85 ms with it, at the same
cycles and proof size. The outcome above stands, every proof being under 10 seconds either way, but
its times are this build's and not leanVM's. Run 2 measures versions 1 and 5 again with the flag
(Amendment 2), and prediction 7 is judged on those. Aggregation (prediction 8) ran through leanVM's
own binary and is unaffected.

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

## Amendment 2, 2026-11-04, after run 1 and before run 2

**What changes.**
1. **Version 2b commits three rules:** version 2a's two, one key and two of three keys, and version
   1's preimage rule as a third inner program, so that accounts of a signature rule and of a
   hash-preimage rule can share one program key. Prediction 11 below is added for it.
2. **Version 2a is built as follows,** fixed here before it runs.
   - `programs/v2a_rules.py` proves $C = H(K, r)$ with
     $K = H(H(\mathit{rule}, \mathit{pk}_0), H(\mathit{pk}_1, \mathit{pk}_2))$, that the rule accepts
     leanSPHINCS signatures on $m$, and publishes $D = H(H(C, m), T)$ with $T = H(H(r, K), m)$:
     version 1's shape, so the account is version 1's stub. $T$ carries nothing the signatures do
     not bind. Rule 1 is $\mathit{pk}_0$ alone, with $\mathit{pk}_1$ and $\mathit{pk}_2$ zero; rule 2
     is two different keys of the three, which ones staying private.
   - The signatures are checked by leanVM's own in-circuit verifier, `verify_sig_lean_sphincs`
     and the 14 functions and 40 constants it reaches in leanVM's aggregation guest
     (`crates/rec_aggregation/guests/lean_ethereum.py` at `3cbac04`, MIT or Apache-2.0), lifted
     verbatim by `lift.py`. Its 19 placeholders are filled with the values leanVM's host computes,
     which its CLI dumps under `DBG_PLACEHOLDERS`. The witness is built as leanVM's host builds it:
     `prover/` ports `lean_sphincs_hints` and its helpers, and takes the owner's signatures, never a
     signing key.
   - `contracts/Stealth.yul` sends version 2 down version 1's path, under the program key it was
     deployed with: `VK2A`, the keccak256 of `programs/v2a_rules.py`. The factory carries the stub,
     so run 2 deploys a new factory.
3. **`prover/` is built with `-C target-cpu=native`** (`prover/.cargo/config.toml`), as leanVM's own
   workspace builds. Run 2 proves versions 1 and 5 again beside 2a, on the same idle machine, and
   prediction 7 is judged on run 2's figures for every version (the correction above).
4. **How prediction 1's "byte-identical code" is read.** The pre-registration has the account store
   $C$; run 1's stub carries $C$ instead in its code's last words, after the version and the program
   key. Two accounts' code therefore differs in exactly those 32 bytes, where storage would have
   differed. Prediction 1 is judged on the rest: the runtime, the version and the program key must be
   byte-identical, and the 32 bytes of $C$ the only difference.
5. **Disk.** Clones from experiments already recorded were deleted from the gitignored `work/` for
   the local chain's build, at the owner's instruction; each experiment's runner rebuilds its own.

**Why.** Item 1 is the owner's choice. Item 2 fixes what Amendment 1 left open. Item 3 is a fault in
run 1's tooling, found in a trial before run 2. Item 4 is a gap between the pre-registration and run
1's construction, which prediction 1 would otherwise meet unannounced.

**What it does not change.** No prediction, threshold or falsifier is edited. Prediction 11 is added.

**Prediction 11.** **One outer key hides the rule across versions.** Under version 2b, three
accounts, one of one key, one of two of three keys and one of version 1's preimage rule, are the same
stub as prediction 1 reads it, their spends declare the same program key, their spend transactions
have the same calldata length, and their gas differs by less than 100. **Shown wrong by** two of the
three with different code beyond $C$ or different program keys, different calldata lengths, or gas
100 or more apart.

**Before the run, on the tooling.**
- `programs/v2a_rules.py` proves and verifies under both rules at leanVM `3cbac04`.
- Two forged witnesses are refused inside the circuit: the signature on $m$ given for another
  message (`verify_sig_lean_sphincs`), and one key's signature given twice under two of three
  (`main`'s check that the two keys differ). leanVM's host refuses the first even earlier, since the
  signature does not open at the other message; `prover/` builds each signature's witness at the
  message it signs, so the forgery reaches the circuit.


## Results, run 2, part 1: version 2a and the proofs again

Deployment `r2-d1`, run at `e3e70f9` (Amendment 2), blocks 685,927 to 685,937, in one pass. The run's
only uncommitted file was the bench's own result. Records: `results/2-second-run.json` (the test
network), `results/2-second-run-bench.json` (proofs and scanning, on an idle machine, `prover/` built
with `-C target-cpu=native`); fixture `test/fixtures/x14/2-second-run.json`. EIP-8288 is modelled as
in run 1. The local chain and version 2b are not in this part.

### Predictions, as far as part 1 reaches

| # | Prediction | Outcome |
|---|---|---|
| 1 | one stub hides the rule | **held.** The account of one key and the account of two of three keys have 693 bytes of code each, the 597-byte runtime, the version and the program key byte-identical and the 32 bytes of $C$ the only difference (Amendment 2, item 4). Both spends declare `VK2A`, carry 196 bytes of calldata and use 212,356 gas: a difference of 0 |
| 2 | the signature keeps spending with the owner | **held for version 2a,** completing run 1's half for versions 1 and 5. The delegated prover held the rule, the keys, $r$, the owner's message and the owner's signature on it. Its proof of its own message was refused inside the circuit (`verify_sig_lean_sphincs`); the owner's proof sent with its own destination was refused in `VERIFY` ("validation prefix frame reverted"). The one spend it could send paid the owner's destination; its own balance stayed 0 |
| 4 | the declared price dominates the spend | **in part, for version 2a as for version 1.** 212,356 measured plus 30,000 declared is 242,356, over the 200,000 bound on state: 183,600 of it is the fresh destination's account. `VERIFY` executes 1,204 gas and the spend 12,246 |
| 7 | proofs fit a machine one can buy | **held for versions 1, 2a and 5,** on the native build (below); version 2b's comparison waits for 2b |
| 10 | scanning finds every payment | **held again.** 40 of 40 among 10,000, no false match, 0.83 ms each; 80 passed the view tag |

### What a proof costs, native build

Three measured passes after a warm-up, 4 cores of a 2.10 GHz Xeon, 15.7 GiB.

| | cycles | bytecode | proving, ms | proof | verifying, ms | peak RSS |
|---|---:|---:|---|---:|---:|---:|
| version 1 | 32 | $2^{6}$ | 53, 55, 55 | 200.3 KiB | 15.5 | 139.6 MiB |
| version 5 | 286 | $2^{9}$ | 64, 65, 59 | 202.4 KiB | 14.0 | 139.6 MiB |
| version 2a, one key | 6,805 | $2^{16}$ | 61, 66, 55 | 236.9 KiB | 83.8 | 139.6 MiB |
| version 2a, two of three | 11,715 | $2^{16}$ | 77, 91, 83 | 221.4 KiB | 92.0 | 139.6 MiB |

- Run 1 measured versions 1 and 5 at 4.6 to 6.3 s; the same programs take 53 to 65 ms with the flag
  leanVM builds with, about 75 to 110 times less (the correction under run 1).
- Every program here commits about $2^{18}$ to $2^{19}$ cells in all, leanVM's floor, so the proof
  size barely moves with the statement: version 2a's two leanSPHINCS checks cost 11,715 cycles and
  still prove in under 0.1 s.
- The peak RSS is the same 139.6 MiB for every program: the prover's floor, not the statement's.

### What a payment and a spend cost, version 2a

| | one key | two of three keys |
|---|---:|---:|
| payment: an account deployed and funded, and announced | 1,363,267 | 1,363,267 |
| spend, measured | 212,356 | 212,356 |
| of which state | 183,600 | 183,600 |
| declared by EIP-8288 | 30,000 | 30,000 |
| `VERIFY` execution | 1,204 | 1,204 |

The payment is 4,590 gas above run 1's, three more bytes of stub code at 1,530 a byte: version 2's
path in `Stealth.yul`.

### Findings

- **An account's rule leaves no trace on chain.** One key and two of three keys give the same code
  but for $C$, the same program key, the same calldata and the same gas. A chain observer learns
  that a version 2 account was spent, and nothing of its rule or keys.
- **A signature inside the proof keeps spend authority with the owner when someone else proves.**
  Versions 1 and 5 hand the spend to whoever proves; version 2a's prover could prove and send only
  the spend the owner signed. Until leanVM has zero knowledge, that prover still sees the rule, the
  keys and the signatures.
- **EIP-8288 at master reserves `LEANSTARK_SCHEME`:** "a frame that uses it is invalid until
  `get_deps_hash` is defined for it", and `get_deps_hash` is defined for leanSPHINCS dependencies
  only. Versions 1, 2 and 5 declare leanSTARK dependencies, so under EIP-8288 as written none of them
  is a valid transaction. The pre-registration and run 1 modelled leanSTARK dependencies at the
  declared 30,000 without noting this. It bears on the local chain, which is not built yet.
- **leanVM's recursion verifies sub-proofs of its own bytecode only.** Its aggregation guest checks
  "sub-proofs OF THIS SAME BYTECODE", its in-circuit verifier is compiled for the inner program's
  bytecode size, "here the inner bytecode is this one", and the inner bytecode's evaluation is
  deferred to the final verifier ("bytecode Public DEFERRED"), which holds the bytecode. A
  block-level proof over leanSTARK dependencies, and version 2b's outer program over a committed
  program, both need a proof of another program verified in circuit, which leanVM at `3cbac04` does
  not do. If it did by deferral, the final verifier would need the inner program, which is the rule
  version 2b hides.

### Transactions, run 2

| Step | Transaction | Block |
|---|---|---:|
| v2a: the owner spends, one key | [`0xf5fe165a...`](https://dora.privacy.ethrex.xyz/tx/0xf5fe165a2f218cff218d5a9779b738864a1d213a951ebb891f0bacb921361a24) | 685,934 |
| v2a: the owner spends, two of three keys | [`0x5af13152...`](https://dora.privacy.ethrex.xyz/tx/0x5af1315227308d9a1d0a443ec77fa9b66c02e2b07218df33e48a836103bb70dc) | 685,935 |
| v2a: the delegated prover sends the owner's spend | [`0x07c1b679...`](https://dora.privacy.ethrex.xyz/tx/0x07c1b6795240fe9077cbbc3f14948698d97229cacb237c2443dce1f8ba992215) | 685,937 |

## Amendment 3, 2026-11-04, after run 2's first part and before the local chain and version 2b

**What changes.**
1. **The local chain runs EIP-8288 as written, then with an extension.** ethrex at `64b8fc09` is
   patched (`ethrex-8288.patch`, applied by `ethrex.sh` to `work/ethrex`), under one switch with two
   settings:
   - **as written:** a frame of mode 4 is a dependency frame under every static rule the EIP lists,
     with `LEANSPHINCS_SCHEME` the only valid scheme, so a frame declaring `LEANSTARK_SCHEME` makes
     its transaction invalid; it executes no code, and its receipt has status 1, execution gas equal
     to its limit and no state gas. A block is valid only if its proof covers `dependencies(block)`:
     the block's leanSPHINCS dependencies, aggregated by leanVM's own aggregation at `3cbac04` and
     checked with leanVM's own verifier.
   - **extended:** the same, and `LEANSTARK_SCHEME` is valid too. Each leanSTARK dependency's proof
     is checked directly in the block, in the form of EIP-8288's mode-0 wrapper: the program whose
     keccak256 is the dependency's key, proved over the dependency's data hash as its public input.
   The two TBD constants are this experiment's, as the pre-registration says: `DEPS_HASH` is
   Keccak-256 over `get_deps_hash`'s concatenation, extended to put each dependency's scheme byte
   first; `AGGREGATED_VK` is leanVM's aggregation program at `3cbac04`, the bytecode its own verifier
   pins.
2. **Where the proof travels.** The block's proof is built by the patched node's payload builder,
   keyed by the block's dependency hash, and checked when the node imports the block. It travels
   beside the block, not in a new header field: the header encoding and the engine API are left as
   they are, so the block hash does not commit to the proof. Which blocks are valid is unchanged by
   this.
3. **How witnesses reach the builder.** The runner hands each dependency's witness (a leanSPHINCS
   signature, or a leanSTARK proof) to the node before the transaction, standing in for EIP-8288's
   mode-0 wrapper. leanVM runs outside the client, as `prover/`'s binary, because it needs a newer
   Rust than the 1.93 that ethrex pins.
4. **Bad blocks (arm 6).** On a switch the runner sets, the builder makes the next block's proof
   either over the block's dependencies less one, or over other dependencies; the node must refuse
   to import each. The block is then built again with a good proof.
5. **One bytecode on both chains.** `Stealth.yul` and `Pool5.yul` take their dependency from a
   mode-4 frame when frame 1 is one, and otherwise from their own `VERIFY` data, as on the test
   network. Every version is run again on the test network with this code, so that prediction 5
   compares the same contracts.
6. **Version 2b by interpretation, not recursion.** One fixed program, `programs/v2b_interpreter.py`,
   reads the committed rule as data: up to three slots, each a leanSPHINCS key or a preimage key
   $H(k, \mathit{tag})$, and a threshold $t$. $K$ is the hash of the rule; a spend proves $t$ distinct
   slots satisfied, a key's slot by its signature on $m$ and a preimage slot by its $k$, and publishes
   $D = H(H(C, m), T)$ as versions 1 and 2a do. Prediction 11's three accounts are one key with
   $t = 1$, three keys with $t = 2$, and one preimage slot with $t = 1$, version 1's rule.

**Why.** EIP-8288 at master reserves `LEANSTARK_SCHEME` (run 2's findings), so as written the chain
would refuse versions 1, 2 and 5, and that refusal is itself a result; the extension is what the
pre-registration assumed. leanVM at `3cbac04` verifies in circuit only sub-proofs of its own bytecode,
so neither a block proof over leanSTARK dependencies nor version 2b by recursion can be built from it,
and version 2b by recursion with the inner program deferred would show the rule to the final
verifier. These are the owner's choices.

**What it does not change.** No prediction, threshold or falsifier is edited. Predictions 5 and 6 are
judged on both settings. Version 2b's half of prediction 7 compares the interpreter with version 2a.
What version 2b tests is a rule language, not arbitrary code; arbitrary code would need recursion
over other programs, the same gap as the block proof's.

## Results, run 2, part 2: the local chain

After Amendment 3. Records:
- `results/2-part2-testnet.json` and `results/2-part2-testnet-v2a.json`: every version again on the
  test network with the contracts that read a dependency frame, the modelled figures prediction 5
  compares with. Run at `4c92a00`, blocks 686,092 to 686,119.
- `results/2-part2-local-written.json` and `results/2-part2-local-extended.json`: the local chain,
  ethrex `64b8fc09` with `ethrex-8288.patch` (sha256 `aae80848...`), in dev mode on ethrex's Hegota
  genesis with ERC-5564's singleton added at its address. Both run at `abc713c`.

Fixtures are in `test/fixtures/x14/`. The local records' `blocks.last` reads 0, because the runner
read it after stopping the node; every row carries its own block.

### Predictions 5 and 6

| # | Prediction | Outcome |
|---|---|---|
| 5 | the two chains agree | **held in both settings.** Every transaction run on both chains is within 535 gas of its modelled figure (the testnet's measured gas plus the declared gas). Spends cost 495 to 535 more on the local chain, payments 128 less, and deposits the same. As written, the comparison covers version 3's spends and every payment and deposit, since versions 1, 2a and 5 cannot spend |
| 6 | the local chain refuses both bad blocks | **held in both settings.** As written, the block whose proof omitted its leanSPHINCS dependency was refused ("no aggregate proof for the block's leanSPHINCS dependencies"), and so was the block whose proof covered another key's signature on another message (leanVM's verifier: `Snark(GkrLayer(20))`). Extended, the same two, and two leanSTARK blocks: one whose proof omitted version 1's dependency, and one carrying a proof of another statement. Each spend was mined in the next block, built again with a good proof |

### EIP-8288 as written

- **Versions 1, 2a and 5 are refused at submission:** "Invalid frame transaction: Frame 1: dependency
  0: LEANSTARK_SCHEME is reserved (EIP-8288 as written)". Their payments and deposits are mined; their
  funds cannot move.
- **Version 3 spends,** its block proved by leanVM's own aggregation: 263,737 to 265,401 bytes for one
  signature, built in 2.8 to 3.0 s at 388 MiB, including leanVM compiling its guest on each call, and
  checked in 2.5 to 2.6 s.

### Extended

Every version but 4 spends. A spend is three frames: `VERIFY`, the dependency frame, the spend.

| Spend | gas | `VERIFY` | dependency frame | spend frame, execution + state |
|---|---:|---:|---:|---:|
| version 3 | 215,292 | 1,189 | 3,000 | 12,246 + 183,600 |
| version 1 | 242,954 | 1,351 | 30,000 | 12,246 + 183,600 |
| version 2a, one key | 243,000 | 1,373 | 30,000 | 12,246 + 183,600 |
| version 2a, two of three | 242,988 | 1,373 | 30,000 | 12,246 + 183,600 |
| version 5 | 344,287 | 3,373 + 97,920 state | 30,000 | 12,293 + 183,600 |

A block of leanSTARK dependencies only is checked in 19 to 282 ms, one proof at a time; a block with
a leanSPHINCS dependency in 2.5 to 2.8 s, nearly all of it the aggregate's verifier compiling its
guest.

### Passes that stopped, the local chain

| Pass | Stopped at | Fixed by |
|---|---|---|
| w1 | the first deployment: the node does not serve `ethrex_simulateFrameTransaction` | `--http.api eth,net,web3,ethrex` |
| w2, w3 | the first block: ethrex's dev producer sends `engine_forkchoiceUpdatedV4`, which refuses Hegota attributes, and the node shuts down after three tries | the patch gives the dev producer `forkchoiceUpdatedV5` and `newPayloadV6` from Hegota on |
| w4 | completed, but recorded viem's generic heading instead of the node's reason for each refusal | the node's reason recorded; the whole run repeated as w5 |

ethrex also wrote its engine API secret, `jwt.hex`, to the working directory; it was deleted, and
`local.ts` now puts it in the run's own directory.

### Findings, part 2

- **Under EIP-8288 as written, no private version can spend.** Only the plain leanSPHINCS control,
  version 3, whose key appears on chain at every spend, is a valid transaction.
- **With leanSTARK admitted, the EIP's own frame and block rule work unchanged in shape,** and the
  modelled test network predicted every spend's gas within 535.
- **leanVM's aggregation cannot fold leanSTARK dependencies,** so the extension checks each proof
  directly: the block's verification work grows with its leanSTARK spends, which is what the
  recursive proof exists to prevent.
- **The digest's order differs between the EIP and leanVM.** `get_deps_hash` puts a leanSPHINCS
  dependency's message before its key; leanVM's aggregation hashes the key first. The client here
  compares the proof's claim set with the block's dependencies.

## Results, run 2, part 3: version 2b

Deployment `r2-d3`, run at `abc713c`, blocks 686,254 to 686,261, in one pass. Records:
`results/2-part3-testnet-v2b.json`, and `results/2-part3-bench.json` (every program again, on an idle
machine, with the native build); fixture `test/fixtures/x14/2-part3-testnet-v2b.json`.

| # | Prediction | Outcome |
|---|---|---|
| 11 | one outer key hides the rule across versions | **held.** The three accounts, one key with $t = 1$, three keys with $t = 2$ and version 1's preimage rule, have 753 bytes of code each, the same but for $C$, declare the same program key `VK2B`, carry 196 bytes of calldata and use 212,477 gas each: a spread of 0 |
| 7 | proofs fit a machine one can buy, and a version 2b proof costs more than a version 2a proof | **the bounds held for every version; the comparison was shown wrong.** Every proof is under 0.11 s, 140 MiB and between 199 and 240 KiB. On the same signatures, version 2b's interpreter costs what version 2a costs: 6,778 cycles against 6,769 for one key, 11,732 against 11,737 for two of three, the same committed size, and proving times that overlap. The prediction was written for 2b by recursion (Amendment 3) |

| Bench, native build | cycles | proving, ms | proof |
|---|---:|---|---:|
| version 1 | 32 | 54, 50, 49 | 199.6 KiB |
| version 5 | 286 | 71, 60, 58 | 201.6 KiB |
| version 2a, one key | 6,769 | 69, 51, 50 | 239.4 KiB |
| version 2a, two of three | 11,737 | 70, 80, 100 | 221.6 KiB |
| version 2b, one key | 6,778 | 65, 66, 55 | 236.5 KiB |
| version 2b, two of three | 11,732 | 82, 80, 73 | 222.3 KiB |
| version 2b, version 1's preimage rule | 1,939 | 64, 64, 69 | 220.2 KiB |

Scanning held a third time: 40 of 40 among 10,000, no false match, 0.79 ms each.

### Findings, part 3

- **One interpreter puts a preimage rule and signature rules behind one key.** A chain observer cannot
  tell a version 1 style account from a two-of-three account; under versions 1 and 2a they were two
  program keys, two anonymity sets.
- **Interpretation costs nothing measurable over a fixed rule set here,** because leanVM's commitment
  floor dominates: the preimage rule's 1,939 cycles prove in the same time as the two signatures'
  11,732.
- **A preimage slot keeps version 1's weakness:** whoever proves holds $k$. The interpreter hides the
  rule, and the rule still decides who can spend.

## Predictions after run 2

| # | Prediction | Outcome |
|---|---|---|
| 1 | one stub hides the rule | held (run 2, part 1) |
| 2 | the signature keeps spending with the owner | held: version 2a's prover could not redirect; version 1's and 5's could (runs 1 and 2) |
| 3 | the plain signature links | held (run 1) |
| 4 | the declared price dominates the spend | in part: every spend's state (183,600 for a fresh destination) breaks the 200,000 bound; version 4 costs the most (runs 1 and 2) |
| 5 | the two chains agree | held in both settings, within 535 (part 2) |
| 6 | the local chain refuses both bad blocks | held in both settings (part 2) |
| 7 | proofs fit a machine one can buy | the bounds held for every version; the 2b-costs-more comparison was shown wrong (part 3) |
| 8 | aggregation holds fewer here than on the project's machine | held (run 1) |
| 9 | capacity follows the declared prices | held by arithmetic; the patch does not enforce `MAX_SIGS_PER_TX`, `MAX_STARKS_PER_TX` or the inclusion list's gas, so the limits remain untested on a chain |
| 10 | scanning finds every payment | held (runs 1 and 2) |
| 11 | one outer key hides the rule across versions | held (part 3) |

## After run 2, not pre-registered: the recorded transactions against rapidblocks' conflict rule

An after-the-fact check, not a prediction. Rapidblocks (ethresear.ch topics 26152 and 26157, read
2026-11-04) lets concurrent blocks commit without a reorg when they touch no common key. Keys are per
storage slot and per account field; a balance credit that nothing reads does not count. A
transaction that touches a key a concurrent earlier block modified waits for the slow path.
`conflicts.ts` reads each run 2 test-network transaction's writes from the block's EIP-7928 access
list (`eth_getBlockAccessList`) and asks, for every pair of transactions of one kind, which keys
both write, credits aside. Record: `results/2-conflicts.json` (regenerated over every pair when run
3 was checked; the verdicts did not change).

| Kind | Two of them | Key both write |
|---|---|---|
| spend, versions 1, 2a, 2b, 3 | independent | none: each account pays from its own balance, under its own nonce key |
| payment, every version | conflict | the factory's nonce, which every `CREATE2` increments |
| version 5 deposit | conflict | 21 storage slots of the pool's tree |
| version 5 withdrawal | conflict | the pool's balance, debited for the payout and for its own gas |

Version 4 has one deposit and one withdrawal in the record, so no pair; its withdrawal debits the
pool's balance, as version 5's does.

- **A lower bound.** The access list gives reads per block, not per transaction, so a key one
  transaction reads and another writes is not counted. A withdrawal's read of a recent root, for
  instance, is not.
- **The test network serves no historical state:** `eth_getBalance` answers the latest balance at
  every block. A balance's direction comes from the access lists of the run's own blocks.
- **What it says.** One-time accounts are independent at spend time. A pool that sends and pays for
  its own withdrawals makes its balance a key every withdrawal writes, and its tree a set of keys
  every deposit writes; a factory makes its nonce one every payment writes.

## Run 3, pre-registered 2026-11-04, before any of its code: the shared keys removed, and measured again

**Why.** The check above found three keys that two transactions of one kind both write: a
factory's nonce (every payment), a pool's balance (every withdrawal) and a pool's tree (every
deposit). Under rapidblocks, each sends those transactions to the slow path. Run 3 removes the
first two and keeps the third, which pooling needs, then reruns the check. The owner's choice,
after options; the two fixes the options first named were corrected before this pre-registration:
any contract that deploys bumps its own nonce, so a payment with no shared nonce is a creation
transaction from the payer, and a per-withdrawal gas payer would leave the payout's debit, so the
pool's funds are split instead.

**Two designs.**
- **Version 1, payer-deployed (`v1d`).** A payment is two transactions from the payer: a
  contract-creation transaction whose initcode is `Stealth`'s with version 1's words and the funding
  as its value, and the announcement through ERC-5564's singleton. The account's address comes from
  the payer's own nonce, and no contract deploys it. The stub and the spend are version 1's.
- **Version 5, sharded pots (`v5p`).** `Pool6` keeps version 5's Keccak tree. Each deposit inserts
  its leaf, publishes the new root through EIP-8272 (`source_id = keccak256(pool || salt)`), and
  forwards the denomination to pot `leafIndex mod k`. `Pot` is $k$ accounts, each the sender and
  payer of its own withdrawals: its `VERIFY` takes the root from EIP-8272's verifier frame, checks
  the dependency as version 5 does, and accepts only nullifiers whose pot is itself,
  `nf mod k = i`, so that a note cannot be withdrawn from two pots under two nonce keys. The proof
  is version 5's program, unchanged. Here $k = 4$, and each pot starts with a float, since a note
  is withdrawn from the pot its nullifier names and not the one its deposit funded.

**Arms.** Two `v1d` payments from the payer, both spent. Four `v5p` deposits, and four withdrawals
whose nullifiers name pots so that at least one pair shares a pot and at least one pair does not;
the notes are drawn from `PRIVATE_KEY` and a label until they do. On the test network, EIP-8288
modelled, through skandha as before. Then `conflicts.ts` over run 3's records, every pair of
each kind.

**Predictions.**

12. **Payer-deployed payments are independent.** Two `v1d` payments, creation and announcement,
    share no written key once their payer's own account is set aside.
13. **Pots make withdrawals independent across pots.** Two withdrawals from different pots share no
    written key; two from one pot share exactly that pot's balance.
14. **Deposits still conflict.** Two deposits share the tree's storage slots.
15. **The fixes are cheap.** A `v1d` payment, both transactions, costs at most 10% more than run 2's
    factory payment, and a `v5p` withdrawal at most 10% more than run 2's version 5 withdrawal, its
    EIP-8272 frame included.

| Prediction | Shown wrong by |
|---|---|
| 12 | a written key the two payments share, their payer aside |
| 13 | a written key shared by two withdrawals from different pots, or a key other than the pot's balance shared by two from one |
| 14 | two deposits sharing no written key |
| 15 | either cost more than 10% above run 2's |

**What does not change.** Predictions 1 to 11 and their outcomes. The check stays a lower bound,
since the access list gives reads per block.

**If it stops.** If the test network refuses a creation transaction's state for the stub, or
EIP-8272's verifier frame refuses the pool's root, the pass stops and is recorded with the reason.

## Results, run 3

Deployment `r3-d1`, run at `1663bc5`, blocks 686,840 to 686,856, in one pass. Records:
`results/3-third-run.json`, `results/3-conflicts.json`; fixture `test/fixtures/x14/3-third-run.json`.
The four notes drawn named pots 1, 1, 2 and 0.

| # | Prediction | Outcome |
|---|---|---|
| 12 | payer-deployed payments are independent | **held.** The two creation transactions share no written key, and neither do the two announcements, the payer's own account aside. Their accounts' spends are independent too |
| 13 | pots make withdrawals independent across pots | **held.** The two withdrawals from pot 1 share pot 1's balance and nothing else; the other five pairs, from different pots, share no written key |
| 14 | deposits still conflict | **held.** Every pair of deposits shares 20 or 21 of the tree's storage slots; EIP-8272's storage is not among them |
| 15 | the fixes are cheap | **held.** A payer-deployed payment is 1,371,863 for the creation and 99,224 for the announcement, 1,471,087 in all, 1.1% above run 2's factory payment on the same stub (1,455,067). A pot withdrawal is 318,917, its EIP-8272 frame 5,579 of it, 1.6% above run 2's version 5 withdrawal (313,792) |

"Run 2's factory payment" is read as run 2's on the same 753-byte stub, the test-network rerun of
part 2; the 693-byte stub of part 1 paid 1,363,267.

### What else run 3 showed

- **skandha refused the first withdrawal,** sent just after the last deposit: "EIP-8272
  recent-root reference is too new: slot 727248 is not referenceable before slot 727248". The
  chain included it a block later. A root becomes usable one slot after the deposit that
  publishes it.
- **The pots' liquidity is the cost the conflict table does not show.** A note is withdrawn from
  the pot its nullifier names, not the one its deposit funded, so the pots' balances drift apart;
  here each pot started with a float. Keeping $k$ pots solvent takes rebalancing, and a rebalance
  debits the pot it refills from.
- **A payer-deployed account's address comes from the payer's nonce,** so the recipient checks the
  announced account's code for $C$ rather than recomputing a CREATE2 address. The link from payer
  to account is the same as through the factory: the payer funds it either way.
- **Pooling's one inherent shared key is the tree:** after the fixes, deposits still serialize
  under rapidblocks, and withdrawals conflict only when two name one pot, $1/k$ of the time for
  uniform nullifiers.

