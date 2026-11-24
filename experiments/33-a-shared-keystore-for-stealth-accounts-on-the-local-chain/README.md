# Experiment 33: a shared keystore for stealth accounts, on the local chain

**Status: pre-registered 2026-11-24,** before any code: the contracts, the client patches and the
runner. Results are added below. Nothing above them is edited after a run; a change of plan before
the run is recorded as a deviation.

## The question

Experiment 32 proved a shared keystore's statements in leanVM, against a keystore kept off chain:
- an account commits to an identity secret, not a key;
- the identity's keys sit in the keystore as a leaf, one per version;
- revoking a version inserts its tag into an indexed tree;
- a spend proves an unrevoked leaf whose rule signed the message.

It found that the statement refuses a revoked key against every root written after the
revocation, and accepts it against a root written before. So how long a revoked key keeps spending
is set by which roots a spend may name. On Ethereum that is EIP-8272's job. A root source writes
its root to the recent-root contract, and a spend names it with a verifier frame in its validation
prefix. The verifier frame accepts any root of the last 8,191 slots.

This experiment puts the keystore on the local chain as an EIP-8272 root source and spends
experiment 32's accounts through it.

**Claim:** a keystore spend is a valid frame transaction on the patched client. It costs EIP-8288's
declared 30,000 gas for its proof, plus the recent-root check and the stub. Revocation takes up to
the EIP-8272 window, and a maximum-age field in the verifier frame bounds it to the account's
choice.

**Would show it wrong:**
- the honest spend, case (a), is admitted under neither reading of case (e);
- a spend under the revoked key naming the new root is included, case (c);
- the maximum-age field does not bound the window, case (f);
- two accounts with different rules can be told apart on chain, case (g).

## What is built

### The client

- **The base.** ethrex at the test network's commit `64b8fc09d`, with experiment 19's
  `ethrex-8288.patch` in its extended setting. A leanSTARK dependency is checked in its block by
  experiment 19's prover, against the program whose file hashes to the dependency's key. The
  programs are experiment 32's, assembled at its commit `26e807b`.
- **The genesis** adds what the local chain lacked, from the client's own definitions:
  - the EIP-8272 predeploy at `0x0000000000000000000000000000000000008272`, with the client's
    `RECENT_ROOT_CODE`;
  - derived slots: a block's slot is $\lfloor (t - t_0) / s \rfloor$ for its timestamp $t$, the
    genesis timestamp $t_0$ and $s = 1$ second, the client's own setting for a chain with no
    consensus client.
- **A clock patch,** `ethrex-clock.patch`, a working-tree patch. The dev block producer adds to each
  block's timestamp an offset in seconds, read from a file the runner names. Raising the offset by
  8,191 moves the next block 8,191 slots on. This is the stand-in for a chain that produces slots
  fast enough. Nothing else reads the offset.
- **A maximum-age patch,** `ethrex-maxage.patch`, for case (f) only, built into a separate binary.
  - The recent-root verifier frame takes a second form: one byte `0x01`, then $n$ tuples of
    `source_id (32) || slot (8) || root (32) || max_age (8)`, with $1 \le n \le 16$.
  - The predeploy's code is replaced by one that keeps the write and the 72-byte form unchanged and
    adds this form. Each tuple must also satisfy $\mathit{current} - \mathit{slot} \le \mathit{maxAge}$.
  - The client's checks of the frame's shape and of the predeploy's code hash follow the new code.
  - An odd length is never a multiple of 72 or 64, so the forms cannot be confused.
- **Licences.** ethrex is MIT or Apache-2.0. Every patch is applied and built in the ignored
  `work/`, and no ethrex source is committed.

### The contracts

- **`Keystore.yul`, the root source.**
  - It keeps the two trees' roots, their sizes and the used registration tags, and its root
    $\rho = H(\mathrm{root}(\mathcal{T}), \mathrm{root}(\mathcal{N}))$. After each change it writes
    $\rho$ to the recent-root contract under a fixed salt.
  - It is the sender and payer of its own registrations and rotations, funded in the genesis, like
    experiment 26's rollup. Its `VERIFY` reads the transaction's dependency frame by introspection
    and accepts only a leanSTARK triple under the matching program's key, whose digest it computes
    from the call's own arguments.
  - **A registration** carries $L_0$ and $Q$. The digest is $H(L_0, Q)$, $Q$ must be unused, and
    $L_0$ is appended.
  - **A rotation** carries $N$, $L'$ and the mode $g^0$. The digest is
    $H(H(\rho, N), H(L', [g^0, 0]))$ with $\rho$ the current root. The rotation then:
    - checks that the revocation entry it names brackets $\kappa$;
    - replaces that entry by $E(a, \kappa)$;
    - appends $E(\kappa, b)$;
    - appends $L'$.
  - The paths the updates need travel in the call's data and are checked against the stored roots
    before and after each step, so the contract stores no tree.
  - **A refresh,** open to anyone, writes the current $\rho$ again at the current slot.
  - Recovery and cancellation stay off chain, as experiment 32 ran them; they are not this
    experiment's cases.
- **`Account.yul`, the stub,** experiment 19's version 2a stub changed in one respect: the root
  comes from the verifier frame.
  - `VERIFY` reads the recent-root frame's tuple by introspection, and requires its `source_id` to
    be the keystore's.
  - It computes $m$ as experiment 19's stub does, and $D = H(H(C, m), \rho)$ with the tuple's root.
  - It requires the dependency triple to be `0x11 || D || key(spend)`.
  - The account is the sender and payer of its own spend.
  - For case (f) a second build of the stub also reads the tuple's `max_age` and requires it to be at
    most its own bound, 64 slots.
- **The factory** deploys each account at its counterfactual address with CREATE2, from $C$ and the
  stub, as experiment 19's factory does.

### The runner

`run.ts` starts the local chain, registers identities, deploys and funds accounts, and sends every
case. The proofs are made by experiment 32's `x32.ts` against a reference keystore that mirrors the
contract, and the runner checks after every write that the two hold the same root.
- **Gas** comes from the account itself, funded by a plain transfer. Experiment 32's statement is
  over the execution digest, which leaves the payer out, so a blind-ticket paymaster would change
  no step of the account's own validation. Running one here is not attempted.
- **Keys and seeds** are derived from public labels. The genesis funds test accounts whose keys are
  derived the same way. This is not a test-network run, and no key of value is used.

## Cases

- **(a) A spend.** Its frames, in reading 2's order of case (e):
  - the recent-root verifier;
  - the stub's `VERIFY`;
  - the dependency;
  - the spend in a `SENDER` frame.
- **(b) A rotation,** then a spend at the next version against the root the rotation wrote.
- **(c) The revoked key.**
  - (c1) a spend under the revoked version, naming the root from before the rotation, inside the
    window;
  - (c2) the same spend naming the root after it. The prover refuses this statement, as
    experiment 32 found, so (c2) is sent with the triple and without a proof, to see what the chain
    does with it.
- **(d) No keystore write for 8,191 slots.**
  - (d1) a spend naming the last root;
  - (d2) a refresh by an account that is not the keystore's;
  - (d3) the spend again, naming the refreshed root.
- **(e) The validation prefix.** The same spend in two orders, under the client's own mempool rules:
  - reading 1, the dependency before the approving `VERIFY`, as EIP-8288's own test cases place it;
  - reading 2, the dependency after it, where EIP-8141 puts frames outside the public mempool's
    validation.

  Each is sent to the node, and its admission, its inclusion and the error, if any, are recorded.
- **(f) The fix.** On the maximum-age binary, with the bounded stub:
  - (f1) (c1)'s spend while the root is younger than the bound;
  - (f2) the same once the root is older than the bound but inside the 8,191-slot window;
  - (f3) an honest spend naming a fresh root, the control.
- **(g) Two accounts, one key and two of three,** each spent once. Compared:
  - the gas of every frame;
  - the transaction's calldata length;
  - the account's code.

## Measures

- **Each case's outcome:** admitted or refused at the node, and the error; included or not; the
  receipt's status.
- **Gas by frame,** from the frame receipts: the recent-root verifier, the stub's `VERIFY`, the
  dependency and the spend. The recent-root check is compared with the 4,900 gas estimated for it
  before any measurement.
- **The account's deployment,** its receipt's gas and state gas.
- **The keystore's writes:** a registration's, a rotation's and a refresh's gas.
- **(f)'s extra cost:** the verifier frame's and the stub's gas in the maximum-age form, against the
  72-byte form.

## Predictions, written before the run

1. **Outcomes.**
   - (a), (b), (c1), (d2), (d3) and (f1) and (f3) are included.
   - (c2) is not included: no block carrying it can be proved.
   - (d1) is refused at the node, its root older than the window.
   - (f2) is refused at the node: the bounded stub's `VERIFY` reverts.
2. **Case (e).**
   - Reading 2 is admitted and included.
   - Reading 1 is refused at admission, since the client's prefix match has no place for a
     dependency frame before the approving frame. This is the least certain prediction here: the
     patch lets a dependency frame sit inside the prefix during execution, and admission may differ.
3. **Gas.**
   - The recent-root frame costs within 2,000 of the 4,900 estimate.
   - The dependency frame costs its declared 30,000.
   - A spend's frames before execution, recent root plus `VERIFY` plus dependency, stay under
     EIP-8141's 100,000 validation budget.
4. **Case (g).**
   - The two accounts' code is identical but for $C$.
   - Their calldata lengths are equal: the proof travels beside the block, not in the transaction.
   - Every frame's gas is equal within 100.
5. **(f)'s field** adds under 500 gas to the verifier frame and the stub together.

## How the result is read, fixed now

- **The claim holds** if (a) is included in at least one reading, (c2) is never included, (f2) is
  refused while (f1) and (f3) are included, and (g) shows no difference beyond $C$.
- **The claim is wrong** if any one of those fails.
- **The window itself is the finding either way.** (c1) shows a revoked key spending inside it on
  the unpatched client, and (f) shows whether one field closes it.

## What this does not show

- **leanVM has no zero knowledge at `3cbac04`.** A proof reveals its witness to whoever holds it.
  On this chain only the block's builder does, since the proof travels beside the block.
- **The proof is checked directly in its block,** experiment 19's extended setting, because
  leanVM's recursion folds only its own program. No aggregation of spends is measured.
- **The clock patch is a stand-in.** A real chain passes 8,191 slots in about 27 hours.
- **The maximum-age form is this experiment's own,** not in any EIP. Its shape is one way to carry
  the field, and its gas is that shape's.
- **One node, no public mempool beyond it,** so (e) is this client's admission rule, not the
  network's.

## Stops

- If the client cannot be made to produce a slot 8,191 ahead, (d) stops, and the record says why.
- If a case cannot be built as stated, it stops, and the record says what was tried.
