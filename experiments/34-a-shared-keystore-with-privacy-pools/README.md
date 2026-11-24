# Experiment 34: a shared keystore with Privacy Pools

**Status: pre-registered 2026-11-24,** before any code: the pool's deployment, the programs, the
account and the runner. Arm A is pre-registered in full here. Arm B is pre-registered below in its
design, cases and predictions, with a dated addendum for its circuit and program before any of its
code. Results are added below. Nothing above them is edited after a run; a change of plan before
the run is recorded as a deviation.

## The question

Experiments 32 and 33 built a shared keystore for stealth accounts: an account commits to an
identity, the identity's keys sit in the keystore, and a spend proves an unrevoked leaf whose rule
signed the message. This experiment asks what such an account needs before its funds can move into
a privacy pool without its owner present, and what the pool needs before an automated withdrawer can
hold its notes.

It uses Privacy Pools (`privacy-pools-core` at `c312dcd`).
- **A deposit** sends value to the pool with a precommitment, $P = \mathrm{Poseidon}(n, t)$ for a
  nullifier $n$ and a secret $t$.
- **A withdrawal** proves knowledge of $n$ and $t$ for a commitment in the pool's state and of its
  label in the association set, and pays whoever the proof names.

So whoever chooses the precommitment owns the deposit.

**Arm A** gives an account a scoped rule: a second key, an automated indexer's, may make one call,
a deposit of the account's funds into the pool. The question is whether that call has to bind the
precommitment.

**Arm B** changes a local copy of the pool so that its notes belong to a keystore identity. The
question is whether an indexer that holds a note's secrets can then move its funds only between the
identity's own accounts.

**Claims:**
- **Arm A:** with the precommitment bound, a permissionless trigger can move a stealth account's
  funds into a pool and cannot take them. Without the binding it can.
- **Arm B:** when a keystore identity owns the notes, an indexer holding their secrets can move
  funds only between the identity's own accounts.

**Would show them wrong:**
- arm A's (c) or (e) succeeds, or (b) fails, in which case the condition does not matter for this
  pool;
- arm B's (g) succeeds on the modified pool, or (h) or (i) is refused.

## The pool

- **The contracts,** compiled with solc 0.8.28 from the repository at `c312dcd`, Apache-2.0, with
  their npm dependencies at the versions the repository pins:
  - the Entrypoint, behind an ERC-1967 proxy, initialized with an owner and a postman;
  - one native-ETH pool (`PrivacyPoolSimple`), registered at a minimum deposit of $10^{12}$ wei and
    no vetting fee.
- **The verifiers** are built from the repository's own circuits, the withdrawal circuit at a
  maximum tree depth of 32 and the ragequit circuit. Each has a local Groth16 setup over a
  published phase-1 powers of tau, and its verifier is exported by snarkjs. The production
  ceremony's keys are not used.
- **A local postman** posts, after every deposit, an association-set root that admits every
  deposit's label.
- **Licences.**
  - The repository is Apache-2.0, its circuits included.
  - The circuits include circomlib 2.0.5, which is GPL-3.0.
  - So circuits are compiled only in the ignored `work/`. Arm B's change is committed only as a
    patch to the Apache-2.0 circuit file, never as circomlib's code or a compiled artefact.
- **The chain** is experiment 33's: ethrex `64b8fc09d` with `ethrex-8288.patch` (extended) and
  `ethrex-clock.patch`, the client's EIP-8272 predeploy, and experiment 33's keystore contract. The
  pool's `VERIFY` budget is set to the test network's 500,000, for the reason under arm A's account.

## Arm A. A scoped deposit, on the unmodified pool

### The leaf, the programs and the account

- **A leaf with two rules.** Experiment 32's leaf, with its rule digest
  $R = H(R_{\mathrm{main}}, R_{\mathrm{scope}})$:
  - $R_{\mathrm{main}}$ is experiment 32's rule over the owner's keys;
  - $R_{\mathrm{scope}} = H(H([\tau_{\mathrm{scope}}, 0], k_{\mathrm{scope}}), \lambda)$ for the
    indexer's leanSPHINCS key $k_{\mathrm{scope}}$;
  - $\lambda$ is the root of a list of precommitments: a depth-4 Keccak tree of up to 16 entries,
    which the owner's main rule signs at registration.
- **Three programs** on experiment 32's library:
  - `register4` proves the leaf at version 0 and its registration tag from one $s$, and that the
    main rule signed $H([\tau_{\mathrm{list}}, 0], \lambda)$;
  - `scoped` proves what experiment 32's `spend` proves about the account, the leaf and the
    revocation tree, but for the leaf's scoped key. It also proves that $k_{\mathrm{scope}}$ signed
    $m$ and that the precommitment $P$ is in the list under $\lambda$. It publishes
    $D = H(H(C, m), H(\rho, P))$;
  - `scoped-open`, the control: the same without the list membership, so the scope fixes the pool
    and nothing else.
- **The account,** experiment 33's stub with one more mode.
  - A proof under the account's scoped program key allows exactly one call: a `SENDER` frame to the
    account itself, `depositAll(P)`. At execution the account calls the Entrypoint's
    `deposit(P)` with its whole balance after the transaction's reserved cost.
  - $m = H(\mathrm{DOMAIN}, \mathrm{account}, \mathrm{nonce}, P)$, and the stub computes $D$ from the
    frame's $P$.
  - Every other call shape under the scoped key is refused in `VERIFY`.
  - The Entrypoint's address is fixed in the account's code, and the account is deployed with
    either `scoped` or `scoped-open` as its scoped program.
- **The transaction,** submitted by a relayer with no keys and no funds. The account is the sender
  and the payer:
  - the recent-root verifier;
  - a `DEFAULT` frame deploying the account through the CREATE2 deployer;
  - the account's `VERIFY`;
  - the dependency;
  - the `SENDER` frame.

  A deployment inside the validation prefix needs more than EIP-8141's 100,000 gas, as experiment
  29 found for its `deploy-first` case. Hence the 500,000 budget.
- **The binding, derived form,** is not attempted. It would derive $P$ in the proof as
  `Poseidon(n, t)` over BN254's field. In leanVM, whose field is $\mathrm{GF}(2^{192})$, that means
  emulating a prime field, a project of its own. The list form is the required one.

### Cases

- **(a) Honest.** A payment arrives at an undeployed account bound to a list. The relayer deploys
  it and deposits the first listed precommitment. The postman admits the label, and the owner's
  device withdraws the note with its own $n$ and $t$ to an address of its own.
- **(b) Control.** An account under `scoped-open`. The indexer deposits a precommitment of its own,
  then withdraws the note to its own address.
- **(c) The substitution, with the list.** An account under `scoped`. The indexer tries a
  precommitment of its own.
- **(d) A list entry used twice.** A second account of the same identity deposits the
  precommitment (a) used.
- **(e) Other calls by the scoped key:**
  - (e1) a transfer, `spend(destination, amount)`;
  - (e2) a deposit to another Entrypoint, sent directly;
  - (e3) a call to the pool, sent directly.
- **(f) The gas.** In (a) and (b), the account pays everything from what it received, and the
  relayer's balance does not change.

### Measures

- Each case's outcome: admitted or refused at the node, and why; included or not; each frame's
  status.
- Gas by frame for the deploy-and-deposit transaction, and the deposit's value against what the
  account received.
- Proving time, cycles and proof size for `register4`, `scoped` and `scoped-open`; the list proof's
  cost as `scoped` against `scoped-open`.
- The withdrawal's gas and its Groth16 proving time, for (a) and (b).

### Predictions, written before the run

1. **Outcomes.**
   - (a) is included, and the owner's withdrawal pays the owner.
   - (b) is included, and the indexer's withdrawal pays the indexer: the control shows the
     condition matters.
   - (c) is refused in the prover: the indexer's precommitment is not in the list.
   - (d) is admitted and included with its `SENDER` frame failing on the Entrypoint's
     `PrecommitmentAlreadyUsed`. The account pays the gas, and nothing is deposited.
   - (e1), (e2) and (e3) are each refused at the node, in the account's `VERIFY`.
   - (f): the relayer's balance is unchanged, and the deposit is what the account received less the
     transaction's cost.
2. **The list proof costs under 500 cycles** over `scoped-open`: four Keccak calls and their path
   bits.
3. **Gas.** The validation prefix, the deployment frame included, fits the 500,000 budget, and the
   deposit's `SENDER` frame is under 1,000,000. A withdrawal costs under 600,000.

## Arm B. A pool whose notes a keystore identity owns, local only

**What is built,** detailed in an addendum before any of its code:
- **A modified withdrawal circuit.** The note's secret is $t = \mathrm{Poseidon}(T, \sigma)$ for a
  per-note owner tag $T = H_{\mathrm{tag}}(s, i)$ and a salt $\sigma$. A withdrawal reveals $T$ as a
  public input, and the pool records it as used.
- **A modified pool** that also requires an EIP-8288 dependency on an extended experiment 32
  program. That program proves:
  - $T$ belongs to the identity whose key signed the withdrawal's context;
  - under the indexer's scoped key, the recipient is an account of the same identity,
    $C' = H_{\mathrm{pay}}(H_{\mathrm{id}}(s), r')$.
- A local Groth16 setup for the modified circuit.

**Cases.**
- (g) An indexer holding a note's $n$ and $t$ withdraws to an address of its own: on the unmodified
  pool, the control, and on the modified pool.
- (h) The indexer withdraws to a fresh stealth account of the same identity, on the modified pool.
- (i) The owner's main key withdraws to any address, on the modified pool.
- (j) A ragequit by the stealth account, through a keystore spend, on both pools.

**Measures.**
- A withdrawal's gas, Groth16 plus the dependency, against the unmodified pool's.
- The change in the circuit's constraint count.
- Proving time on both sides.

**Predictions.**
- (g) succeeds on the unmodified pool and fails on the modified one, in the proof or in the
  dependency.
- (h), (i) and (j) are included.
- The constraint count grows by one Poseidon over two inputs, about 240.

## What this does not show

- **A local deployment and a local setup.** The production ceremony does not cover the modified
  circuit.
- **The postman admits every deposit,** so nothing here bears on the association set's own policy.
- **leanVM has no zero knowledge at `3cbac04`,** so every privacy reading is conditional, as in
  experiments 32 and 33.
- **Groth16 is not post-quantum.** This experiment tests custody, not post-quantum security.
- **The timing of automated deposits is out of scope.**
- **This is not a report of a flaw in Privacy Pools' contracts.** Case (b) is a module that omits a
  check. Arm B's pool is a local modification, not a proposal to the pool's maintainers.

## Stops

- If the deployment cannot sit in the validation prefix on this client, (a) to (f) fall back to a
  deployment by a separate transaction. The relayer then pays that one transaction, and the record
  says so.
- If a case cannot be built as stated, it stops, and the record says what was tried.

## Arm A: deviations, written before run 1

Smoke runs on 2026-11-24, whose records are not kept, tested the runner on the chain before the
recorded run. They changed the plan in five ways.

1. **The pool's two Poseidon libraries and the Entrypoint's implementation are in the genesis.**
   - EIP-8037 charges 1,530 gas of state per byte of deployed code. `PoseidonT3` is 23,576 bytes,
     about 36.1 million gas of state, and its deployment reverted with all of the 15,000,000 gas the
     first smoke run gave it.
   - The three are placed at fixed addresses as the code a creation there would leave: each
     library's own address, which its code checks, and the implementation's address in the UUPS
     immutable. The proxy, the pool and the verifiers are deployed by transactions as planned.
   - The implementation's own storage is empty, so its initialisers are not disabled as its
     constructor would have done. Nothing in the run calls the implementation except through the
     proxy.
2. **The account is a clone of a shared implementation.**
   - The frames of a validation prefix may declare at most 500,000 gas of state between them
     (EIP-8141's `MAX_VERIFY_STATE_GAS`, a constant in the client). The planned account carries
     its code itself: 575 bytes and its four words, 703 bytes, about 1.08 million gas of state. Its
     deployment cannot sit in the prefix.
   - Each account is now an EIP-1167 clone of `contracts/Account4.yul` with its four words
     appended: 173 bytes, 264,690 gas of state. The implementation, 582 bytes, is deployed once by
     the dev account and reads the words from the account's code. `APPROVE` under the clone's
     delegatecall passes the client's check, which is that the executing account is the frame's
     target.
   - So the deployment stays in the prefix, and the fallback under Stops is not used. The deploy
     frame's limits are 150,000 gas of execution and 460,000 of state.
   - The bound, for any account deployed in its own prefix: with the account already created by a
     payment, at most $\lfloor 500000 / 1530 \rfloor = 326$ bytes of code. With the account also
     created by the deployment, at most $\lfloor (500000 - 183600) / 1530 \rfloor = 206$ bytes,
     183,600 being a new account's state gas.
3. **The setup's own transactions get more gas,** for EIP-8037's state gas: a payment to a fresh
   address 500,000, the postman's root 3,000,000 and a withdrawal 6,000,000. The withdrawers are
   funded with $10^{17}$ wei rather than $10^{16}$, enough for that limit. These limits are the
   harness's, not the cases'.
4. **Two measures are added,** so that each refusal is attributed.
   - (e1) to (e3): the same transaction with `depositAll(P)` as its call, simulated by the node.
     If it is valid, the refusal is the call shape's alone, and not the deployment's, the proof's
     or the tuple's.
   - (d): the Entrypoint's `usedPrecommitments(P)`, and the account's deposit replayed from an
     externally owned account with the account's balance, for the revert reason. The client refuses
     a replay from the account itself, since its sender has code (EIP-3607).
5. **The runner's mirror of the state tree** also inserts each withdrawal's change note, which the
   pool inserts and the first mirror did not. And the runner now stops the node on a failed step:
   a node left by a failed smoke run had kept the port, and two later smoke runs talked to it.

## Arm A: results, run 1 (2026-11-24)

Run as `npx tsx experiments/34-a-shared-keystore-with-privacy-pools/run.ts 1-first-run` from the
repository root at commit `74f22c7`, on the chain above. The record is `results/1-first-run.json`.
Gas is execution plus state, as the frame receipts give it, and fees are 7 wei of base fee and 1 of
priority fee per gas.

### Every case, against the predictions

| Case | Predicted | Observed |
| --- | --- | --- |
| (a) | Included; the owner's withdrawal pays the owner | Included. The device's withdrawal paid it 9,999,999,628,029,700 wei, the whole deposit |
| (b) | Included; the indexer's withdrawal pays the indexer | Included. The indexer's withdrawal paid it 9,999,999,628,030,900 wei, the whole deposit |
| (c) | Refused in the prover | Refused in the prover: the list's root, recomputed from the indexer's precommitment, conflicts with $\lambda$ |
| (d) | Included, the `SENDER` frame failing on `PrecommitmentAlreadyUsed`; the account pays; nothing deposited | Included with its `SENDER` frame failed. `usedPrecommitments(P)` is true, and the replayed deposit reverts with `PrecommitmentAlreadyUsed`. The account paid 3,066,016 wei; nothing was deposited |
| (e1) to (e3) | Refused at the node, in the account's `VERIFY` | Refused at the node ("validation prefix frame reverted"). The same transaction calling `depositAll(P)` simulates valid in each |
| (f) | The relayer's balance unchanged; the deposit is what the account received less the transaction's cost | The relayer's balance was 0 throughout. The deposit is what the account received less the transaction's reserved maximum cost, and the refund stays in the account |

### Gas

The deploy-and-deposit transactions, by frame:

| Frame | (a) | (b) | (d) |
| --- | --- | --- | --- |
| Recent-root verifier | 5,579 | 5,579 | 5,579 |
| Deployment of the 173-byte clone | 15,256 + 264,690 | 15,256 + 264,690 | 15,256 + 264,690 |
| The account's `VERIFY` | 5,651 | 5,651 | 5,651 |
| Dependency | 30,000 | 30,000 | 30,000 |
| `SENDER`, `depositAll(P)` | 237,696 + 783,360 | 284,162 + 489,600 | 41,561, failed |
| Transaction | 1,352,735 | 1,105,429 | 383,252 |

- **The validation prefix** used 56,486 gas of execution and 264,690 of state, each within its
  500,000.
- **The deposit's state gas** is new storage at 97,920 a slot: eight slots for the pool's first
  deposit in (a), five in (b).
- **The other transactions:**
  - a payment to a fresh address, 204,600, of which 183,600 is the new account;
  - registering the bound identity, 424,139, and the open one, 326,573;
  - the withdrawals, 898,478 in (a) and 713,785 in (b);
  - the postman's roots, 689,061 and 591,141.
- **The pool's setup:** the pool 11,698,089, the proxy 1,395,097, the verifiers 3,303,576 and
  2,736,168, and the account implementation 1,107,606.

### Proofs

| Program | Case | Cycles | Proof, bytes |
| --- | --- | --- | --- |
| `register4` | The bound identity | 6,855 | 244,568 |
| `register4` | The open identity | 6,843 | 243,864 |
| `scoped` | (a) | 20,453 | 247,336 |
| `scoped` | (d) | 20,430 | 244,384 |
| `scoped` | (e1) to (e3) | 20,448 | 246,728 |
| `scoped_open` | (b) | 20,368 | 246,600 |

- **Each scoped proof** costs between 62 and 85 cycles more than the `scoped_open` proof. They sign
  different messages, and a signature's verification varies by a few dozen cycles with its message.
- **snarkjs proved the two withdrawals** in 3,053 and 2,852 ms, in this container.

### Against the predictions

1. **Outcomes.** Every prediction held but half of (f).
   - The deposit is the account's balance less the transaction's *reserved* cost, its gas limits at
     the maximum fee: 3,719,703 gas at 100 wei, 371,970,300 wei.
   - The transaction was charged 10,821,880 wei, and the rest, 361,148,420 wei, was refunded to the
     account after the call.
   - That residue is below the pool's minimum deposit of $10^{12}$ wei, so the scoped key can never
     move it. Only the owner's main rule can.
2. **The list proof costs under 500 cycles.** Held: 62 to 85.
3. **Gas.**
   - The prefix fits its 500,000. Held.
   - The deposit's `SENDER` frame under 1,000,000. Held for execution, missed for (a) with its
     state gas: 1,021,056.
   - A withdrawal under 600,000. Wrong: 898,478 and 713,785.
   - The gas predictions were written without EIP-8037's state gas, which a new slot costs 97,920
     of. An ordinary transaction's receipt does not split the two, so the withdrawals' split is not
     measured.

### What it means

- **Arm A's claim holds as far as it was tested.**
  - With $P$ bound by the list, a relayer with no keys, triggered by anyone, moved a stealth
    account's balance into the pool. The scoped key could not take it: (c) was refused in the
    prover and (e1) to (e3) at the node.
  - Without the binding it can: in (b), the indexer deposits its own precommitment and withdraws to
    itself.
  - So the condition matters for this pool. A scoped deposit must bind the precommitment, and a
    list the owner signs binds it for under a hundred cycles.
- **A used entry costs the account its gas and nothing else,** since the Entrypoint's own
  `usedPrecommitments` refuses it. Nothing in the account or the proof stops a scoped key from
  repeating (d) on a new nonce, or on any other account bound to the same list, until the balance
  cannot pay the reserved cost. That was not run.
- **Not run: the fee fields.**
  - Neither the account's `VERIFY` nor the message $m$ covers the transaction's fees. So whoever
    builds the scoped transaction chooses them.
  - (d) shows the account pays whatever its transaction is charged. A relayer with a high priority
    fee would move the balance to the block's fee recipient, and the deposit would be what was left.
  - If the relayer is, or pays, the builder, that is a way to take the funds the cases do not test.
    The claim "cannot take them" holds only for the paths tested.
  - An addendum below pre-registers the case before it runs.

## Arm A: addendum, written after run 1 and before run 2 (2026-11-24)

Run 1 left one path to the funds untested: the transaction's fees, which the relayer chooses and
neither the account's `VERIFY` nor the message $m$ covers. Run 2 tests it on a fresh chain with the
same setup. It runs these cases only; cases (a) to (e) are not repeated.

**The capped account.** A second implementation, made by the runner from `contracts/Account4.yul`
by inserting one check at the start of `validate`:
`if gt(txparam(0x04), 1000) { revert(0, 0) }`. Its `VERIFY` refuses a transaction whose maximum fee
per gas, `TXPARAM` 0x04, is over 1,000 wei. Its clones are built as before, and the first
implementation is unchanged.

**Cases.**
- **(f2) The fee, chosen by the relayer.** A payment of $B = 10^{16}$ wei arrives at a fresh account
  bound to the list. The relayer builds (a)'s transaction with the next unused list entry, but:
  - it sets the `SENDER` frame's limits close to its use, 300,000 of execution and 783,360 of
    state;
  - it sets a maximum fee per gas $f = \lfloor (B - 2 \cdot 10^{12}) / L \rfloor$ for the
    transaction's total gas limit $L$, and a priority fee of $f$. So the reserved cost leaves about
    twice the pool's minimum deposit to be deposited.
- **(f3a) The honest transaction, capped.** (a)'s transaction, at run 1's fees, on a fresh account
  under the capped implementation.
- **(f3b) The relayer's fee, capped.** (f2)'s transaction on another fresh account under the capped
  implementation, with a control: the same transaction at run 1's fees, simulated by the node.

**Measures.** For each case:
- its outcome;
- the account's balance before and after, and the deposit;
- the priority fee the block's fee recipient received, as gas used times the priority fee paid
  per gas, and the fee recipient's balance across the block;
- the capped `VERIFY`'s gas against the uncapped one's.

**Predictions.**
- (f2) is included and deposits about $2 \cdot 10^{12}$ wei. More than half of $B$ goes to the
  block's fee recipient as priority fee, and the rest of the reserved cost returns to the account.
  So a relayer that is, or pays, the builder takes most of the balance, and arm A's claim, as run 1
  tested it, does not cover the fee path.
- (f3a) is included and deposits as (a) did.
- (f3b) is refused at the node, in the account's `VERIFY`, and its control simulates valid.
- The cap costs the capped `VERIFY` under 30 gas.

**What would show them wrong:**
- (f2) refused, or less than half of $B$ taken as fee, in which case the fee path is narrower than
  argued above;
- (f3b) included, in which case the cap does not close it.
