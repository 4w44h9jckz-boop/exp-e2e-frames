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
