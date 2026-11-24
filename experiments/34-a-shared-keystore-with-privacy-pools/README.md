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
