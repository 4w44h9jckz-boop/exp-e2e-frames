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

## Deviations, written before run 1

Two smoke runs on 2026-11-24, under labels that are not recorded, tested the runner on the chain
before the recorded run. They changed the plan in four ways.

1. **The slot comes from the dev producer, not from timestamps.**
   - In dev mode, ethrex's block producer supplies each block's EIP-7843 slot, one more per block,
     and the client uses it as given. So the genesis needs no derived-slot setting.
   - `ethrex-clock.patch` moves the producer's slot counter instead of its timestamps. A file holding
     $n > 0$ adds $n$ to the next block's slot and is set back to 0.
   - The genesis keeps only the predeploy.
2. **Case (c2) runs last.**
   - Sent without a proof, its transaction is admitted. The patched builder then includes it in every
     block it makes, and its own block check refuses each one ("no proof for leanSTARK dependency").
   - So the head stops, and nothing can follow it on that chain. Experiment 22 found the same halt for
     a signature over another transaction's hash.
   - (c2) is now the main chain's last step. Its wait is bounded at 8 blocks or 60 seconds, and the
     record says whether the head moved.
3. **The keystore accepts a plain transfer,** so the runner can fund it. The first smoke run's funding
   reverted.
4. **Case (f) gains two arms,** so each check that could refuse is seen alone.
   - (f2b): the bounded account, with a tuple claiming a `max_age` of 8,191. The stub refuses it,
     since 8,191 exceeds its bound, though the predeploy would accept the age.
   - (f2c): the unbounded account, with the 72-byte form, on the same chain and the same old root. It
     shows that the revoked key still spends where the field is not used.
   - The patched predeploy is written in Yul (`contracts/RecentRootMaxAge.yul`) rather than the
     client's geas, so its gas differs from the client's own code. The field's cost is therefore
     measured between the two forms on the same patched code.

## Results, run 1 (2026-11-24)

**The record:** `results/1-first-run.json`, from commit `a3a1c0c`.
- **Command:** `npx tsx experiments/33-a-shared-keystore-for-stealth-accounts-on-the-local-chain/run.ts 1-first-run both`.
- **The main chain:** ethrex `64b8fc09d` with `ethrex-8288.patch` (extended) and `ethrex-clock.patch`,
  chain id 8141, and the client's own `RECENT_ROOT_CODE` at `0x8272`.
- **The maximum-age chain:** the same, plus `ethrex-maxage.patch`. Its predeploy is
  `contracts/RecentRootMaxAge.yul`, 555 bytes.
- **The programs** are experiment 32's: `spend` `0xd37202eca8...`, `register` `0xc7ee4d571e...` and
  `rotate` `0x777b68efa5...`. Each leanSTARK proof was checked in its block by experiment 19's prover.
- **The keystore's root agreed with the reference** after every write, on both chains.

### Every case, against the predictions

| Case | Predicted | Got |
|---|---|---|
| (a) spend, one key, reading 2 | included | **included**, at block 34 |
| (b) rotation, then a spend at version 1 against the new root | both included | **both included**. The same account spends after the rotation, since it commits to the identity, not a key |
| (c1) the revoked key, naming the root written at slot 16, before the rotation at slot 41 | included | **included** at slot 46: a revoked key spends 5 slots after its rotation, inside the window |
| (c2) the revoked key, naming the root after the rotation, no proof | not included | **not included,** and the chain stopped: the head did not move in 60 seconds. The builder put the transaction in every block it made, and its block check refused each one: "no proof for leanSTARK dependency" |
| (d1) after a skip of 8,191 slots, a spend naming the last root | refused at the node | **refused:** "EIP-8272 recent-root reference expired: slot 41 is outside the usable window at slot 8240" |
| (d2) a refresh by an account that is not the keystore's | included | **included,** at slot 8,240 |
| (d3) the spend again, naming the refreshed root | included | **included** |
| (e) reading 1, the dependency before the approving `VERIFY` | refused at admission | **refused:** "Frame transaction validation prefix does not match any recognized shape" |
| (e) reading 2, the dependency after it | admitted and included | **included** |
| (f1) bounded account, revoked key, root 23 slots old, `max_age` 64 | included | **included** |
| (f2a) the same with the root 127 slots old | refused at the node | **refused:** "validation prefix frame reverted", in the predeploy's age check |
| (f2b) the same, the tuple claiming `max_age` 8,191 | refused (deviation 4) | **refused:** the same error, from the stub's bound |
| (f2c) unbounded account, the same revoked key and old root, 72-byte form | included (deviation 4) | **included,** at slot 140, 107 slots after the rotation: where the field is not used, the revoked key spends |
| (f3) honest spends on the bounded account, before and after a refresh | included | **both included** |
| (g) one key against two of three | equal but for $C$ | **equal:** see below |

### Gas

**A spend, by frame,** on the main chain. Every spend, one key or two of three, revoked or not, cost
249,638 or 249,650, the difference being the nonce's calldata byte.

| Frame | Execution gas | State gas |
|---|---:|---:|
| EIP-8272 recent-root verifier, one tuple | 5,579 | 0 |
| the stub's `VERIFY` | 1,440 | 0 |
| the leanSTARK dependency, as declared | 30,000 | 0 |
| the spend to a fresh address | 12,243 | 183,600 |

- **The recent-root check is 5,579,** 679 above the 4,900 estimated for it before any measurement.
- **The validation prefix, all three leading frames, is 37,019,** well under EIP-8141's 100,000.

**The keystore and the accounts.** Receipts:

| Transaction | Receipt gas | Of which |
|---|---:|---|
| deploying the keystore | 3,148,724 | its constructor builds both empty trees and writes its first root |
| the first registration | 424,139 | 887 `VERIFY`, 30,000 dependency, 73,911 execution, 293,760 state for three new slots |
| a later registration | 326,573 | the same, with 195,840 state for two new slots |
| a rotation | 279,204 | 1,034 `VERIFY`, 30,000 dependency, 103,241 execution, 97,920 state |
| a refresh, from any account | 130,728 | a plain transaction; its state is one new ring slot in the predeploy |
| deploying an account through CREATE2 | 1,403,549 | a plain transaction, state gas included: a new account with 771 bytes of code |

**(f)'s field,** on the maximum-age chain, between the two forms on the same patched predeploy:

| Frame | 72-byte form | Maximum-age form | Difference |
|---|---:|---:|---:|
| recent-root verifier | 5,705 | 5,882 | 177 |
| the stub's `VERIFY` | 1,440 | 1,579 | 139 |

So the field costs 316 gas a spend. The patched predeploy's 72-byte form costs 126 more than the
client's own code, which is written in geas.

### Case (g)

- **The two accounts' code** is 771 bytes each and differs in exactly 32 bytes, $C$.
- **Their transactions** carry 236 bytes of calldata each.
- **Every frame's gas is identical.**
- **The proofs differ:** 246,152 bytes for one key against 268,520 for two of three, as in experiment
  32. On this chain they travel beside the block, so the chain does not show them. The block's
  builder does see them.

### Against the predictions

| # | Prediction | Outcome |
|---|---|---|
| 1 | the outcomes | **held,** every case. (c2) also stopped the chain, which the prediction did not say |
| 2 | (e): reading 2 admitted, reading 1 refused | **held** |
| 3 | the recent-root frame within 2,000 of 4,900; the dependency at 30,000; the prefix under 100,000 | **held:** 5,579, 30,000 and 37,019 |
| 4 | (g): code equal but for $C$, equal calldata, every frame within 100 | **held,** exactly |
| 5 | (f)'s field under 500 gas | **held:** 316 |

### What it means

- **The claim holds.** A keystore spend is a valid frame transaction on this client.
  - It costs its declared 30,000 for the proof, plus 5,579 for the recent-root check and 1,440 for
    the stub.
  - A revoked key spends for as long as the chain accepts a root written before the revocation:
    8,191 slots with EIP-8272 as written.
  - A maximum-age field bounds that to the account's choice, at 316 gas a spend.
- **Two checks refuse a stale root, and either is enough.**
  - With the field, the predeploy refuses a root older than the tuple's `max_age`.
  - The stub refuses a tuple whose `max_age` exceeds its own bound.
  - Without the stub's bound, a spender could set `max_age` to 8,191. Without the predeploy's check,
    the stub could not learn the age at all, since EIP-8272 lets only the predeploy read the slot.
- **The window is real on today's rules.** (c1) and (f2c) show a revoked key spending 5 and 107
  slots after its rotation. Nothing in the account or the statement can stop it.
- **Reading 1 of the validation prefix is not admitted by this client.** Only reading 2 lets a
  keystore spend reach the mempool, which puts the dependency where EIP-8141 says frames are
  outside public validation.
- **One proofless dependency halts the patched builder.** This is experiment 22's finding again, now
  with a leanSTARK dependency, and it is a client's builder policy: it includes what it cannot prove.
- **The refresh is open.** Anyone may pay about 130,000 gas to keep the keystore's root usable, so no
  single party holds that gate. But someone has to, at least once every 8,191 slots.
