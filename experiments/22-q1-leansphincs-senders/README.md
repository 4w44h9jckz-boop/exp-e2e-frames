# Experiment 22 (Q1): every experiment's senders and owners on leanSPHINCS keys

**Status: pre-registered 2026-11-04,** before any code, account, client change, runner or
transaction. Predictions, what would show each wrong, and the deviations are fixed here. Results
are added below them, and nothing above the results is edited after a run.

## The question

Every experiment in this repository so far authorizes its transactions with a key a quantum
computer could forge with: secp256k1 for its EOAs and most frame transactions, and P-256 for its
passkeys. The target for Ethereum's post-quantum transition is December 2028, the date Justin
Drake gave at Devcon 8; EF Protocol's September roadmap had December 2029
([blog.ethereum.org](https://blog.ethereum.org/2026/09/07/protocol-priorities)).

[EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) (Draft, read at `ethereum/EIPs` master
`46976b2`) defines `LEANSPHINCS_SCHEME`. An account's `VERIFY` frame can read a dependency triple
`(0x10, data_hash, public_key)` from a dependency frame (mode 4), with a zero `data_hash` standing
for the transaction's signature hash. One recursive STARK per block proves every signature.
Experiment 19's version 3 ran that shape on a local chain.

This experiment asks whether every transaction in experiments 01 to 18 that a key authorizes can
move to such a key, with nothing else in it changing, and whether an open node still admits it and
the chain still mines it.

## Design

### The tools, pinned

- ethrex at `64b8fc09d47d7787eb1a4e3f082aa9e831dc5f8c`, the test network's commit, with
  experiment 19's `ethrex-8288.patch` **as written**. `LEANSPHINCS_SCHEME` is defined at master,
  so this experiment needs no extension.
- leanVM at `3cbac04`, through experiment 19's `prover/` (signing, aggregation and the block
  proof), built with `-C target-cpu=native`.
- skandha at the commit the runs record, two nodes against the local chain and two against the
  test network, under the profile for EIP-8288 as master has it.

### Step 1: the inventory

Every transaction in experiments 01 to 18's run records is sorted by how it is authorized:
- **(a)** a type-2 transaction from an EOA;
- **(b)** a frame transaction whose sender authorizes through the protocol's signature list,
  secp256k1 or P-256;
- **(c)** a frame transaction whose `VERIFY` checks a key held in the account's own code or
  storage;
- **(d)** a frame transaction authorized by no key: a proof, a ticket, or a committee's signature
  checked in `VERIFY`.

Shapes (a) to (c) are this experiment's. Shape (d) is listed and not rebuilt: its proofs, tickets
and committee signatures move in other experiments of the same track.

### Step 2: the rebuild

For each transaction of shapes (a) to (c), the same transaction with a leanSPHINCS account as its
sender:
- the account is code that checks, in `VERIFY`, that a dependency frame declares its own key with
  a zero `data_hash`, then approves, as experiment 19's version 3 does;
- the frames after the payer is set, and for shape (a) the call's target, value and data, are
  copied from the record. The one change allowed is the sender's address, wherever a frame's data
  names it;
- on the local chain, each experiment's contracts are deployed from leanSPHINCS accounts where the
  rebuilt transactions need them. Where they are not, application frames may revert. The key's
  gas is measured either way, and the application's is taken from the classical record.

### Two chains

- **The local chain:** ethrex with the patch as written, the leanSPHINCS accounts funded at
  genesis, two skandha nodes in front of it. The block proof checks every signature.
- **The test network, modelled:** the triple travels in the account's own `VERIFY` data, as
  experiment 19's modelled path did. Nothing checks the signature there. The funder pays once into
  each account and never sends a transaction in a run's path.

### Arms

1. The inventory over every run record of experiments 01 to 18.
2. The rebuild of every shape (a) to (c) transaction on the local chain, through node A.
3. Three bad forms of one rebuilt transaction, on the local chain:
   - a triple naming another key;
   - no dependency frame;
   - a signature over another transaction's hash.
4. The same rebuilt shapes, one transaction each, on the test network, modelled, through node A.
5. A scan of every block of the local chain for any secp256k1 or P-256 signature.

### Measures

- Per rebuilt transaction: gas, bytes, the `VERIFY` frame's gas, admission at node A, and whether
  node B received it. On the local chain, the block that mined it.
- Per block on the local chain:
  - the number of leanSPHINCS dependencies;
  - the block proof's size, proving time and peak memory;
  - the producer's block interval.
- Per bad form: where it stopped, at the node or at the block proof.

## Predictions

1. **Four shapes cover everything.** Every transaction in experiments 01 to 18's run records is of
   shape (a), (b), (c) or (d).
2. **Nothing else changes.** Every shape (a) to (c) transaction has a leanSPHINCS form whose other
   frames, and for shape (a) whose target, value and data, are the record's. The one difference
   allowed is the sender's address where a frame's data names it.
3. **Admitted and mined.** On the local chain, node A admits every rebuilt transaction and the
   chain mines it.
4. **Never mined.** None of the three bad forms is mined. Which of the node and the block proof
   stops each is recorded, not predicted.
5. **The key costs what the arithmetic says.** On the local chain, each rebuilt transaction's gas
   differs from its classical record's by the key's own cost, within 5,000 gas. That cost is
   computed before the run from the frame tooling's constants: the dependency frame's 3,000
   declared gas and 96 bytes, plus the new `VERIFY`, minus the classical signature (2,800 for
   secp256k1 and 6,700 for P-256 in the signature list, the record's own `VERIFY` for shape (c),
   or a type-2 transaction's base cost for shape (a)).
6. **Every block is proved in time.** On the coordinator's 4 cores, every block the local chain
   builds in this experiment is proved within the producer's block interval.
7. **No classical signature on the local chain.** No block of the local chain carries a secp256k1
   or P-256 signature, in a signature list or as a type-2 transaction's signature.
8. **Modelled, still admitted.** On the test network, node A admits each rebuilt shape with the
   triple in its `VERIFY` data.

## What would show it wrong

| Prediction | Shown wrong if |
|---|---|
| 1 | a recorded transaction fits none of the four shapes |
| 2 | a rebuilt transaction needs any other frame, target, value or data byte to change |
| 3 | node A refuses a rebuilt transaction, or the chain does not mine it |
| 4 | a bad form is mined |
| 5 | a rebuilt transaction's gas differs from the record's by more than 5,000 beyond the key's computed cost |
| 6 | a block's proof takes longer than the producer's block interval |
| 7 | any classical signature appears in any block of the local chain |
| 8 | node A refuses a modelled shape on the test network |

## Deviations, stated before the run

- **A sweep, not a re-run.** It shows that each transaction's shape moves to the new key and is
  admitted and mined. It does not re-test the earlier experiments' own predictions. Where the key
  is part of an experiment's claim, a separate pre-registered run in that experiment does:
  - experiment 11's recovery;
  - experiment 14's exit;
  - experiment 03's and experiment 13's passkeys;
  - experiment 12's one-time key, with `exp-frames` experiment 49.
- **Application state is partial.** Rebuilt transactions run against the application state the
  sweep deploys, and no more. Their application frames may revert, and that is recorded.
- **The mempool's wrappers are modelled.** skandha's aggregator does not prove; only the block
  proof does. Wrappers are re-measured when the aggregator proves for real.
- **The test network is modelled.** Nothing there checks a leanSPHINCS signature.
- **leanSPHINCS's parameters are not final,** as in experiment 19.
- **Not a privacy result.** A signature hides nothing, so leanVM's missing zero knowledge does not
  condition anything here.

## Path

`inventory.ts` (arm 1), `sweep.ts` (arms 2 to 4, `--chain local|testnet`), `scan.ts` (arm 5), and
results in `results/`, each with its commit, command and inputs.

## Amendment 1, 2026-11-05, before any rebuild

Two facts read after the pre-registration, before any code for arm 2:
- **skandha carries no dependency's witness.** Its node "neither takes EIP-8288 wrappers nor folds
  them", and does not decode dependency frames beyond their bytes (skandha's `FRAMES.md`, "What it
  does not do"). So on the local chain the two nodes admit, relay and hand off each rebuilt
  transaction. Its leanSPHINCS signature reaches the block builder out of band, in the builder's
  witness directory, as experiment 19's local runs did, and the block proof checks it. Prediction
  4's "at the node" can therefore only be a refusal the client's simulation makes, since the node
  sees no signature.
- **The patch takes a zero `data_hash` as EIP-8288 does.** ethrex's patch puts the transaction's
  `compute_sig_hash` in place of a zero `data_hash`, and names a witness by the substituted triple,
  as EIP-8288 at `46976b2` defines it. So the account signs the signature hash, as designed.

The account is `contracts/SphincsAccount.yul`: a contract whose `VERIFY` approves when a
dependency frame declares `(0x10, 0, its key)`, and whose `SENDER` frames call out through
`execute`. Genesis gives it its code and its balance, so no transaction funds it. A one-transfer
smoke run on the local chain comes before the rebuild, and its record is kept beside the others.
No prediction changes.

## Amendment 2, 2026-11-05, after two smoke runs and before the rebuild

Both smoke runs were refused at skandha's node A, and neither was mined:
- [`results/2-smoke.json`](results/2-smoke.json): `ErrInvalidChainId`. skandha's surface profiles
  fix their chain ids, 8141 for `hegota-testnet`, and ethrex's Hegota genesis fixture has 9. The
  local chain now takes 8141.
- [`results/3-smoke.json`](results/3-smoke.json): `ErrFrameMalformed`. skandha at `ede942f` admits
  frame modes 0 to 2 only. A descriptor with EIP-8288's modules compiles to its older profile, whose
  dependency frame is mode 3, never master's mode 4. A dependency left without a wrapper would also
  stay unproven, and the node takes no wrappers.

So **prediction 3 is shown wrong as stated, for skandha at `ede942f`.** The open mempool node this
repository runs cannot carry a transaction a leanSPHINCS key authorizes, as EIP-8288 at master
writes it. That is recorded as the result it is, not worked around. From here each rebuilt
transaction goes to node A first, and its answer is recorded. Then it goes to the local ethrex's
own pool, so the chain's side, the block proof and the gas, is still measured. Predictions 1, 2
and 4 to 8 are unchanged.

## Results, arm 1 (2026-11-05)

Record [`results/4-resolved.json`](results/4-resolved.json), at commit `1583498`:
`npx tsx experiments/22-q1-leansphincs-senders/inventory.ts 4-resolved`. Records 1 to 3 are the
same scan before its hand resolutions, and are kept. Experiments 01 and 02 write their records to
`test/fixtures/runs/`, and records 1 to 3 missed them; record 4 reads them.

| Shape | Transactions | What authorizes them |
|---|---|---|
| (a) | 32 | a type-2 transaction's secp256k1 signature |
| (b) | 320 | a secp256k1 or P-256 entry in the signature list |
| (c) | 9 | a secp256k1 or P-256 key in the account's own code |
| (c), hash-based | 7 | a WOTS key under a Merkle root in the account's code, checked with keccak alone |
| (d) | 60 | 43 Groth16 proofs, 1 Groth16 proof with a BLS ticket, 6 BLS signatures, 7 ECDSA signatures of a committee, and 3 by nothing |
| fits none | 0 | |

**Prediction 1 held.** All 428 transactions from experiments 01 to 18's records are of one of the
four shapes. One reading is stated here: three transactions in experiment 03's vectors come from
`0x40456702...`. That is an 8-byte account (`PUSH1 3 PUSH1 0 PUSH1 0 APPROVE STOP`) which
approves any transaction. They are counted as (d), "authorized by no key", which is (d)'s
heading, though none of its three examples (a proof, a ticket, a committee's signature) fits them.
A reader who takes the examples as the definition would count three transactions that fit no
shape.

What the scan could not settle alone, and how each was settled, is in the record's
`resolutions`:
- **Pools.** Each pool calls its Groth16 verifier with computed gas, from an address held inside
  its code. So the static scan saw no pairing. Four pools and the two sponsors in front of them
  are resolved by hand. The sponsors check only that the last frame withdraws to them; the pool's
  proof authorizes.
- **WOTS accounts.** Five accounts in experiment 03's vectors are exp-frames experiment 17's
  `WotsAccount`: one ARBITRARY signature read with `SIGDATACOPY`. Two of them are the main
  accounts that README lists. The other two variants are identified by their signatures'
  lengths, which are exactly $2 + n + L n + H n$: 2,498 bytes for n32-w16 and 738 for n16-w16.
- **Experiment 16's pool** checks three of four attesters' ECDSA signatures, a committee's. It is
  (d), as before.

Shapes (a) and (b) take no judgement: they are the transaction's type and its signature list. The
(c) and (d) split is the scan plus these resolutions, and every (c) and (d) entry lists its
targets.

So 361 transactions are authorized by a key that a quantum computer could forge:
- 352 of shapes (a) and (b);
- 9 of shape (c).

Seven more are of shape (c) but already hash-based. Arm 2 rebuilds all 368, as step 2 says, and
reports the seven apart. The 60 of shape (d) are not this experiment's. Its Groth16 proofs, BLS
signatures and the committee's ECDSA signatures are quantum-forgeable too, and move in other
experiments of the same track.

## Amendment 3, 2026-11-05, after arm 1 and before arm 2

Arm 1 fixed what arm 2 rebuilds: 368 transactions from 122 senders. Reading their frames set the
rules below before any rebuilt transaction was built or sent. No prediction changes.

- **One account per sender.** Each sender gets its own leanSPHINCS account, funded at genesis with
  10,000 ETH, and its transactions keep their order. A new sender starts at sequence 0 on every
  nonce key. So each rebuilt transaction keeps its nonce keys and takes the chain's next sequence
  on them. The nonce belongs to the sender, and is counted as part of the address change.
- **The prefix.** Everything up to the last frame that approves (a `VERIFY` of scope 1 to 3) is
  the authorization. It is replaced by the account's `VERIFY` (scope 3) and its dependency frame.
  Two kinds of prefix frame are kept, in place:
  - 17 `VERIFY` frames that approve nothing (scope 0);
  - `DEFAULT` frames, except one that deploys the original sender through the CREATE2 deployer.
    Six do; the new sender is at genesis instead.

  88 transactions had a payer other than their sender. Their payer becomes the account itself,
  since "the frames after the payer is set" are what step 2 copies. A paymaster's own secp256k1
  signature would otherwise stay on the local chain, against prediction 7.
- **The account keeps the sender's own code.** 67 transactions have frames that call their own
  sender: a batch, or a function of the sender's code. `SphincsAccount` now carries a second
  word, an implementation, before its key. A call from itself that is not `execute` runs the
  implementation by `DELEGATECALL`:
  - the original sender's code, copied to genesis at an address derived from the old one;
  - for an EIP-7702 account, its delegate;
  - nothing for a codeless sender, whose self-call runs empty code, as on the test network.

  Only the key check moves.
- **Shape (a).** A type-2 or type-3 transaction becomes `VERIFY`, the dependency frame, and one
  `SENDER` frame with its target, value and data. One is a contract creation, and a frame has no
  creation. Its rebuilt form calls the CREATE2 deployer that genesis holds, with a zero salt, so
  its target and data change. Prediction 2 is scored against it.
- **Blobs.** Seven transactions carry one blob each (four of type 3, three frame transactions).
  Their records do not keep the blobs, which are ciphertexts under keys that were not kept. Their
  rebuilt forms carry the same number of blobs of fresh bytes, so their versioned hashes differ.
  That is a missing input, not a change the key needs, and it is reported apart from prediction 2.
- **Application state.** Every contract a copied frame calls is copied to genesis, with its code
  from the test network and empty storage. That stands in for deploying it from leanSPHINCS
  accounts; it is amendment 1's genesis funding, applied to code. Frames that need state revert,
  and are recorded.
- **Sending.** Wave $k$ sends each sender's $k$-th transaction. Each goes to node A, then, as
  amendment 2 says, to the local ethrex's own pool. The next wave starts when the wave is mined,
  or after 180 s.
- **Prediction 5, measured.** On each side:

  $$\text{key cost} = \text{gasUsed} - \sum_{\text{copied frames}} (\text{execution} + \text{state})$$

  So an application frame that reverts on the local chain moves neither side. The measured
  difference is the rebuilt key cost less the record's. The predicted difference is prediction
  5's arithmetic as written:
  - plus the dependency frame's 3,000 and its 96 bytes' calldata cost, and the new `VERIFY`'s gas;
  - minus 2,800 per secp256k1 entry and 6,700 per P-256 entry in the record's signature list;
  - for shape (c), minus the record's own `VERIFY` frames' gas;
  - for shape (a), minus 21,000.

  The prediction holds for a transaction when the two differ by at most 5,000. The arithmetic as
  written has no term for gas the rebuild removes besides the key, such as a replaced payer's
  `VERIFY`. For shape (a) it also leaves out a frame transaction's own intrinsic cost: 12,000,
  plus 475 per frame, plus 6,000 if it moves value. The record shows each such term beside the
  score, and the score is not adjusted for them.
- **Arm 3** runs on the first mined rebuilt transaction's sender, after arm 5's scan. The bad
  form whose signature covers another hash goes last. The builder takes no proof that would leave
  a transaction out, so it may stall the chain, and stalling would be the result.

## Amendment 4, 2026-11-05, after a trial and before arm 2

A trial of `sweep.ts` on the first 12 transactions, with arms 3 and 5, is kept as
[`results/5-sweep-trial.json`](results/5-sweep-trial.json). It is not arm 2's result. It found one
fault in the rebuild, one fault in the measure and one in the waiting, all fixed before arm 2.
No prediction changes.

- **The rebuilt `VERIFY` takes the record's state limit.** Three of the twelve were refused by
  the pool's simulation ("validation prefix frame reverted"). Their records pay a fresh nonce
  key's storage slot, 97,920 or 195,840 state gas, in the sender's own `VERIFY`. The rebuilt
  `VERIFY` had a state limit of zero.
- **The new `VERIFY` is counted by its execution gas.** Its state gas is the nonce's, paid on both
  sides, so it is in both key costs. Prediction 5's "new `VERIFY`" is the key check. For the same
  reason, shape (c)'s "record's own `VERIFY`" is its execution gas.
- **A wave waits only for what a pool admitted.** A refusal is final for that wave.

What the trial showed, and arm 2 will meet again:
- Two transactions were refused because a copied EIP-8272 frame names a test-network slot (8,523
  and 96,462) that the new chain has not reached. That is chain history the local chain does not
  have, like application state, and it is recorded as such.
- After the signature over another transaction's hash was admitted, the chain stopped. The
  builder rebuilt block 767's proof 21 times, and each time the import check refused it. The head
  stayed at 766.

## Amendment 5, 2026-11-05, before the node-path pass

skandha now has a node path for EIP-8288 master's dependency frames, at `ef266b3` on its
`claude/zealous-ptolemy-g7w9h5` branch: the surface profile `eip-8288-master` with the chain id as
a parameter, and a JSON-RPC method, `frames_sendWrapper`, that takes a mode-0 wrapper beside its
transaction and checks each leanSPHINCS signature with experiment 19's prover (`verify-sphincs`,
from `3209255`). Amendment 2 recorded prediction 3 as shown wrong for skandha at `ede942f`. That
result stands. This pass asks the same question at the new pin, and changes no prediction.

- **The pass** is `sweep.ts --node-path`, pinned in `pins.json` as `skandhaNodePath`. It runs after
  arm 2's record, on a fresh local chain, over the same 368 transactions by the same rules.
- **Both nodes** run under `eip-8288-master`, with chain id 8141 and the prover. Each rebuilt
  transaction goes to node A as a wrapper:
  - its own triple, with the zero `data_hash` written as the signature hash;
  - the witness's 7,740-byte signature as the triple's proof.

  A refusal at node A still goes on to the local ethrex's pool, as amendment 2 says, so the
  chain's side is measured either way.
- **Prediction 3 is scored at this pin:** node A admits every rebuilt transaction, and the chain
  mines it.
- **Node B holds no transaction with a dependency.** The node path relays none, and a copy from a
  peer is answered "ignore". That is scored as the expected outcome, not as a refusal.
- **Arm 3's forms go to node A only.** The pool is not asked, so a form node A refuses never
  reaches the builder:
  - the triple naming another key goes as a wrapper;
  - the transaction with no dependency frame goes by `eth_sendRawTransaction`;
  - the signature over another hash goes as a wrapper, where the expected answer is
    `ErrWrapperProof`.

  Which of the three node A stops, and whether the chain still moves after them, is recorded.

## Results, arms 2, 3 and 5 (2026-11-05)

Record [`results/6-sweep.json`](results/6-sweep.json), from commit `eed8c19`:
`npx tsx experiments/22-q1-leansphincs-senders/sweep.ts 6-sweep`. A first attempt at that commit's
parent stopped at its first blob before writing any record (amendment 4's fixes were in place;
`getRandomValues` fills at most 64 KiB, fixed in `eed8c19`).

All 368 keyed transactions from arm 1 were rebuilt, from 122 senders, with 35 contracts copied
to genesis. Each went to node A and then to the local ethrex's own pool, in 88 waves.

| | (a) | (b) | (c) | all |
|---|---|---|---|---|
| rebuilt | 32 | 320 | 16 | 368 |
| admitted at node A | 0 | 0 | 0 | 0 |
| mined | 32 | 289 | 16 | 337 |
| mined, every frame succeeding | | | | 193 |

Of the 144 mined with a frame failing, 15 had a failing frame in their record too. The rest are
application state the local chain does not have, as the design allows.

Why 31 were not mined, each by the local ethrex's pool:
- **17, a fault in the rebuild.** "validation prefix frame reverted". Each uses a fresh nonce key,
  and its record pays that key's storage slot in the payer's `VERIFY`, which the rebuild replaced.
  Amendment 4 gave the rebuilt `VERIFY` the sender's own state limit only. Amendment 6 fixes it.
- **10, chain time.** "expiry deadline has passed". A copied expiry frame names a deadline that is
  in the past for the local chain.
- **3, chain history.** A copied EIP-8272 frame names a test-network slot (8,523, 96,462, 524,377)
  that the new chain has not reached.
- **1, the record itself.** Its own limits total 31,966,580 gas, and it used 26,745,004. The local
  chain enforces EIP-7825's 25,000,000 and refuses it. The test network mined it at block 306,334.

### Predictions

| # | Prediction | Outcome |
|---|---|---|
| 2 | nothing else changes | **shown wrong for one transaction.** Experiment 09's contract creation has no frame form: its rebuilt form calls the CREATE2 deployer, so its target and data change. It was mined, at block 25. Every other rebuilt transaction differs from its record only by the rules amendments 3 and 4 fixed: the sender's address, in 117 places across 88 transactions, and the payer of 88. Seven carry fresh blobs, since their records keep none (amendment 3), and all seven were mined |
| 3 | admitted and mined | **shown wrong as stated**, as amendment 2 found. Node A refused all 368: `ErrFrameMalformed` for 361, for their dependency frame, and `ErrOversizedData` for the seven sent with a blob. Node B received none. The chain mined 337 of them through its own pool. 17 of the 31 it did not mine are the rebuild's fault; amendment 6's pass reruns them |
| 4 | never mined | **held.** The triple naming another key, and the transaction with no dependency frame, were each refused by the pool's simulation ("validation prefix frame reverted"). Node A refused the second itself (`ErrFramePrefixReverted`), since it has no dependency frame to stop node A decoding it. The signature over another transaction's hash passed simulation and was admitted. It stopped at the block proof: the import check refused block 362's proof 21 times, the builder kept rebuilding it, and the head stayed at 361. So one bad witness halts the patched chain |
| 5 | the key costs what the arithmetic says | **shown wrong as stated:** 151 of 337 within 5,000 gas. The measure (amendment 3) holds where it is clean. Where the sender paid itself and every copied frame ran the same on both chains, 61 of 62 held, at a median of 917 gas under the arithmetic. It fails elsewhere for three reasons, the first two stated before the run. **First**, a replaced payer's `VERIFY` or a dropped deploy frame, which the arithmetic as written does not subtract; 73 mined transactions have one, and 5 of them held. **Second**, shape (a)'s frame transaction's own intrinsic cost, 13,425 gas for a transfer; no (a) transaction held. **Third**, where an application frame reverts on the local chain, the transaction's gas does not split by frame. EIP-7623's calldata floor and state-gas refunds bind on one side and not the other, so the key cost moves with the application. That is a limit of the measure, found by this run. The record keeps each term beside each score |
| 6 | every block is proved in time | **shown wrong as stated.** All 121 block proofs took longer than the producer's 1,000 ms: 2,720 to 5,014 ms, median 3,017. That is for 1 to 56 leanSPHINCS signatures, at 247,369 to 314,577 bytes and 370 to 1,076 MiB of peak memory; the largest, 56 signatures, took 5.0 s. Checking each took 2,559 to 3,311 ms. Proving sits on the producer's critical path, so a block with dependencies came 1 to 9 s after its parent |
| 7 | no classical signature | **held.** Arm 5 scanned all 124 blocks through the last mined rebuilt transaction: no transaction of its own type, and no secp256k1 or P-256 entry in any signature list. Nothing was mined after them |

The rebuilt `VERIFY` cost 639 to 2,019 gas, with a median of 708. The dependency frame declared
3,000. Prediction 8 is arm 4's, on the test network.

## Amendment 6, 2026-11-05, after arm 2 and before the node-path pass

Arm 2 found the rebuild's state limit fault above. The rebuilt `VERIFY` approves execution and
payment both, so it now takes the largest state limit among all the approving `VERIFY` frames it
replaces, the payer's included. Amendment 5's node-path pass runs with the fix. It is therefore
also arm 2's second run over the same 368 transactions, and the 17 are scored there. Nothing
else in amendment 5 changes, and no prediction changes.

## Results, arm 4 (2026-11-05)

Record [`results/7-testnet.json`](results/7-testnet.json), at commit `4d6a57d`:
`npx tsx experiments/22-q1-leansphincs-senders/testnet.ts 7-testnet 6-sweep`. A first attempt
stopped at the funder's gas estimate, which the client priced at its default fee cap; nothing was
sent.

One transaction of each shape was taken: the first arm 2 mined with every frame succeeding, and
neither a blob nor a creation. Each was rebuilt by arm 2's rules, with the triple in the
modelled account's own `VERIFY` data. The funder deployed and funded each account in one call to
the CREATE2 deployer (617,775 to 618,015 gas), and sent nothing else.

| Shape | Record | Node A | Node B | Mined | Gas | Signature, checked off chain |
|---|---|---|---|---|---|---|
| (a) | experiment 12, a type-2 transfer | admitted | received | block 701,216 | 25,286 | verified |
| (b) | experiment 03, a frame transfer | admitted | received | block 701,217 | 25,286 | verified |
| (c) | experiment 13, an account with its own key | admitted | received | block 701,218 | 158,422 | verified |

**Prediction 8 held:** node A admitted each rebuilt shape with the triple in its `VERIFY` data,
under the test network's profile, and node B received each one by gossip. The (c) account's
implementation is the original sender's own code, at its address; the other two had codeless
senders. The modelled `VERIFY` cost 299 gas. The (a) and (b) transfers cost less than their
records (204,600 and 210,982), because their recipients now exist and no account is created.
That gas is not the key's, and arm 4 scores admission only.

## Results, the node-path pass (2026-11-05)

Record [`results/8-node-path.json`](results/8-node-path.json), from commit `d229f06`:
`npx tsx experiments/22-q1-leansphincs-senders/sweep.ts 8-node-path --node-path`. skandha ran at
`ef266b3`, with both nodes under `eip-8288-master` at chain id 8141 and experiment 19's prover
checking each wrapper's signature. This is also arm 2's second run, with amendment 6's fix.

| | (a) | (b) | (c) | all |
|---|---|---|---|---|
| rebuilt | 32 | 320 | 16 | 368 |
| admitted at node A | | | | 320 |
| mined | 32 | 306 | 16 | 354 |

**Node A refused 48:**
- **26, `ErrNonceTooHigh`.** Each was then admitted by the local ethrex's pool and mined, so its
  nonce was right. Node A's view of the sender's nonce lagged the head when the next wave arrived,
  a second or two after the last was mined.
- **14, `ErrFrameUnrecognizedPrefix`.** Each keeps one or two scope-0 protocol frames in its prefix:
  an EIP-8272 recent root, or an expiry check. The `eip-8288-master` profile recognizes no prefix
  with them. 13 of the 14 are among the chain-time and chain-history refusals below.
- **7, `ErrOversizedData`.** These are the seven sent with a blob.
- **1, `ErrGasLimit`.** This is the record whose own limits exceed the cap.

**The chain mined 354.** All 320 that node A admitted were mined, and so were 34 that node A
refused, through the local ethrex's own pool. The 17 that arm 2 lost to the rebuild's fault were all
mined. 14 were not mined: 10 for an expiry deadline already passed, 3 for a test-network slot the
chain has not reached, and 1 for its own gas limit, as in arm 2.

**Node B received none,** as amendment 5 expected: the node path relays no transaction with a
dependency.

### Predictions at this pin

| # | Prediction | Outcome |
|---|---|---|
| 3 | admitted and mined | **still shown wrong as stated,** but by a different margin. At `ede942f` node A admitted none; at `ef266b3` it admitted 320 of 368, and the chain mined every one it admitted. Of the 48 it refused, 26 were the node's own lag and 14 were prefix shapes its profile does not take. The chain mined 354; the 14 it did not are chain time, chain history and one record over the cap, none the key's |
| 4 | never mined | **held, and now at the node.** The triple naming another key and the transaction with no dependency frame were refused at node A with `ErrFramePrefixReverted`. The signature over another transaction's hash was refused with `ErrWrapperProof`, the prover's `verify-sphincs` checking it at admission. None reached the builder, and the chain kept moving: its head went from 533 to 563 in the 30 s after |
| 5 | the key costs what the arithmetic says | **shown wrong as stated,** as in arm 2: 151 of 354 |
| 6 | every block is proved in time | **shown wrong as stated.** All 102 proofs took 2,737 to 7,055 ms for up to 63 signatures, against 1,000 ms. All 102 checked valid |
| 7 | no classical signature | **held:** 177 blocks scanned, none |

So skandha's node path moves prediction 3 from no admissions to 87%. It also moves prediction 4's
stopping point from the block, where one bad witness halted the chain, to the node, where the chain
does not notice it.

## Amendment 7, 2026-11-05, before the node-path pass at `e9512aa`

The mempool session fixed node A's nonce read at skandha `e9512aa`, in `packages/node` only. Each
admission now takes the client's latest head before it reads a sender's nonce. This pass reruns
the node-path pass at that pin, recorded beside `8-node-path.json`, which stays.

- **The pass** is `sweep.ts --node-path --pin skandhaNodePathNonceFix`, the pin added to
  `pins.json`. Everything else is amendment 5's: a fresh local chain, the same 368 transactions by
  the same rules, both nodes under `eip-8288-master`, and arm 3's forms to node A only.
- **Expected at this pin:** none of node A's refusals is `ErrNonceTooHigh`. The other 22 refusals
  stay as they were: 14 for prefix frames the profile does not take, 7 with a blob, and 1 over the
  cap.
- **Prediction 3 is scored again at this pin.** It is still shown wrong as stated if node A refuses
  any rebuilt transaction, and the record says by how many and why.
