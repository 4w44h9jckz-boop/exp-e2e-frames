# Experiment 23 (X15): L1.5 jobs dispatched through the public mempool

**Status: pre-registered 2026-11-05,** before any code, descriptor, runner or transaction.
Predictions, what would show each wrong, and the deviations are fixed here. Results are added below
them, and nothing above the results is edited after a run.

## The question

An L1.5 job is computation done by whoever takes it, holding nothing the next job needs, with the
result settled directly on L1. The claim this experiment tests: with frame transactions
([EIP-8141](https://eips.ethereum.org/EIPS/eip-8141)), keyed nonces
([EIP-8250](https://eips.ethereum.org/EIPS/eip-8250)), recent roots
([EIP-8272](https://eips.ethereum.org/EIPS/eip-8272)) and proof aggregation
([EIP-8288](https://eips.ethereum.org/EIPS/eip-8288)), only the contract pays for a job's
transaction, and any node can relay it.

Every run in this repository so far went through skandha under the Hegota test network's profile:
`VERIFY` up to 500,000 gas, and several pending transactions per sender on disjoint nonce keys.
EIP-8141's own rules for the public mempool allow 100,000 gas, one pending transaction per sender,
and one for a payer that is not the canonical paymaster. This experiment sends four jobs'
transactions through open nodes under the EIPs' own rules, with the test network's beside them. It
records which are admitted, relayed and mined, and for each refusal, what would have to change.

## Design

### The rules, as descriptors

- **The EIPs' own rules,** composed as one descriptor: skandha's `eip-8141.json`, with the
  recent-root modules of the `eip-8272` profile and the dependency modules of `eip-8288-master`,
  each at its EIP's values.
  - EIP-8288 is read at `ethereum/EIPs` master `46976b2`, where `LEANSTARK_SCHEME` is reserved.
  - The descriptor's identifier is recorded with every verdict.
- **The same with leanSTARK admitted:** the `eip-8288` profile's dependency modules in place of
  master's. This is the rule a chain that extends EIP-8288 runs.
- **The test network's profile,** `hegota-testnet`, as every earlier run used.

### The jobs

| Job | From | Its transaction |
|---|---|---|
| a private withdrawal | experiment 05's transfer; experiment 19's version 5 pool and run 3's pots | the contract checks the proof in `VERIFY`, pays from the funds it moves, and uses the nullifier as its nonce key |
| delegated proving | experiment 19's version 2a | a prover other than the owner proves a spend the owner signed inside the proof |
| a matcher's batch | experiment 15's appended claims (R2) and its rounds of four (R3) | one proof settles a batch, checked by the contract that holds the state |
| aggregation | skandha's mempool wrappers on the real prover | a node folds the leanSPHINCS dependencies it received, every interval |

Each job is built afresh from its experiment's own builder, so no nonce is reused.

### Forms

- **Classical:** the proof checked in `VERIFY`, as recorded (Groth16 for experiments 05 and 15),
  on the test network.
- **Dependency:** the proof as a leanSTARK dependency, or the signature as a leanSPHINCS one, on
  the local chain: ethrex at `64b8fc09` with experiment 19's EIP-8288 patch, as written and
  extended.

### Arms

1. **Admission.** Every job, in every form it has, sent to node A under each of the three rule
   sets. Recorded per transaction:
   - node A's verdict and error code;
   - whether node B received it from A;
   - whether a block mined it.
2. **Concurrency.** For the pool and the pots, a second withdrawal from the same sender on a
   disjoint nonce key, sent while the first is pending, under each rule set.
3. **Who can tell.** Delegated proving's transaction set beside the owner's own, field by field, as
   a node receives them.
4. **The fold.** The aggregation job under the EIPs' own rules and with leanSTARK admitted, on the
   local chain, through skandha's real prover. Recorded per interval: which dependencies were
   folded, which were left out, and how long the fold took.

### Two nodes

Two skandha nodes, connected, in front of each chain, at a commit the runs record. Node A receives
every transaction; node B only what A relays.

## Predictions

1. **Groth16 jobs are refused under the EIPs' own rules.** Under the EIPs' own rules, experiment
   05's transfer and experiment 15's batches are refused for their validation gas. Their records
   put the check at 362,119 and at 214,788 to 294,499, against 100,000. Under the test network's
   profile they are admitted and mined.
2. **Proof dependencies wait on EIP-8288.** As EIP-8288 is written, every job whose proof is a
   leanSTARK dependency is refused for the reserved scheme. This covers the pool, the pots, version
   2a and version 1. With leanSTARK admitted, each is admitted, its `VERIFY` under 100,000, and
   mined on the extended chain.
3. **One at a time.** Under the EIPs' own rules, a pot or pool with a withdrawal pending refuses a
   second one on a disjoint nonce key, as the sender is busy. Under the test network's profile it
   admits the second.
4. **Nobody can tell who proved.** Delegated proving's transaction is admitted and refused on
   exactly the terms of the owner's own. No field a node receives differs in kind between the two.
5. **The fold covers signatures only.** The aggregation job folds every leanSPHINCS dependency node
   A received in an interval, and no leanSTARK dependency. With leanSTARK admitted, the leanSTARK
   transactions are admitted and left unfolded. A fold from a cold prover takes longer than the
   1,000 ms interval.
6. **Any node relays.** Every transaction node A admits reaches node B.
7. **No one else pays.** Every admitted job transaction is paid by the contract it settles in. None
   is paid by a relayer's account.

## What would show it wrong

| Prediction | Shown wrong if |
|---|---|
| 1 | either Groth16 job is admitted under the EIPs' own rules, or refused under the test network's |
| 2 | a leanSTARK job is admitted as written; or refused with leanSTARK admitted; or its `VERIFY` exceeds 100,000 |
| 3 | the second withdrawal is admitted under the EIPs' own rules, or refused under the test network's |
| 4 | the two are treated differently, or a field a node receives differs in kind |
| 5 | a leanSTARK dependency is folded; a leanSPHINCS dependency node A received is left out; or a cold fold takes 1,000 ms or less |
| 6 | an admitted transaction never reaches node B |
| 7 | an admitted job transaction's payer is anyone but its contract |

## Deviations, stated before the run

- **The matcher's batch in dependency form waits** until experiment 15's statement is ported to
  leanVM (the track's client-proof entry). Until then, only its classical form is judged.
- **Experiment 05's transfer in dependency form waits** on the same port. Its statement is in Noir,
  with no leanVM backend.
- **leanVM has no zero knowledge yet.** Delegated proving's prover sees the witness, and nothing
  here says it does not.
- **skandha's nodes take no wrappers from the network.** The fold is measured in one node's pool,
  as skandha's own two-node exchange does.
- **The job itself is not dispatched here.** Posting the job, rather than its result, to the
  mempool for any worker to take is the next experiment, chosen after this one's results.

## Path

`descriptors/` (the composed rules), `run.ts` (arms 1 to 3, `--chain testnet|local`), `fold.ts`
(arm 4), and results in `results/`, each with its commit, command and inputs.
