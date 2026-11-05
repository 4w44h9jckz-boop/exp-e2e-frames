# Experiment 25 (X18): INTMAX3's withdrawals as L1.5 jobs

**Status: pre-registered 2026-11-05,** before any build, code, deployment or transaction.
Predictions, what would show each wrong, and the deviations are fixed here. Results are added below
them, and nothing above the results is edited after a run.

## The question

[INTMAX3](https://github.com/InternetMaximalism/intmax3-zkp), read at `979318d`, is a research
prototype of a post-quantum ZK rollup that keeps almost no state on L1 and is built around payment
channels:
- channel balances are Regev/LWE ciphertexts;
- members co-sign each channel state with hash-based signatures;
- users keep their own balance proofs;
- each block posts a transaction-tree root and a validity proof.

Its specification (`doc/architecture-audit/abstract2.md`, current section dated 2026-09-06, and
`detail2.md`) gives it two ways out to L1. Both have one shape: permissionless steps that carry a
proof, which nothing on chain pays for, then a step only the exit recipient's own L1 address can
send. In the specification's words, "Keyless proving is not gasless publication."

An L1.5 job, as experiment 23 defines it, is computation done by whoever takes it, holding nothing
the next job needs, with the result settled directly on L1. This experiment asks four things:
- whether INTMAX3's withdrawals can run as such jobs;
- whether a recipient holding no ETH still gets paid;
- whether, on a chain with [EIP-8288](https://eips.ethereum.org/EIPS/eip-8288), the exit's own key
  can be post-quantum too;
- which of the jobs an open node carries, under
  [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141)'s own rules and under the test network's.

## INTMAX3's withdrawals, as its code has them

| Path | Step | Who may send it | What it checks |
|---|---|---|---|
| partial withdrawal (the channel stays open) | P1: a block with the burn leg, and its validity proof | INTMAX3's block producer | the block, the validity proof |
| | P2: `IntmaxRollup.withdrawNative` | anyone | a withdrawal proof (MLE/WHIR); credits the recipient |
| | P3: `IntmaxRollup.withdraw` | the recipient only (`msg.sender`) | the credit; pays it |
| close and claim (no co-signer needed) | C0: `requestClose` or `requestCloseAsParticipant` | the member's own recipient address only | the freeze nonce |
| | C1: attest the signed head's backing | anyone | a backing proof |
| | C2: submit the close | anyone | a close proof |
| | C3: `finalizeCloseGuarded` | anyone, after the challenge period | the close |
| | C4: materialize the fund vector | anyone | the finalized backing |
| | C5: `submitWithdrawalClaim` | anyone | a withdrawal-claim proof that binds the recipient |
| | C6: `claimWithdrawalCredit` | the recipient only (`msg.sender`) | the claim; pays it |

INTMAX3 quotes about 11.2 million gas for one on-chain MLE/WHIR verification of a real proof
(`detail2-implementation-notes.md`), and 19,073,837 gas for a close, intrinsic cost included
(`detail3.md`). Those figures stay quoted until arm 0 measures them. On any chain but 31337, the
close's challenge period is at least 86,400 seconds (`CHALLENGE_PERIOD_SECS_FLOOR`), and no deployer
can opt out.

## Design

### The tools, pinned

- **INTMAX3** at `979318dbf48eee360235fab9b5675b82e8cfde12`. Its submodules are taken at their
  gitlinks, with Rust `nightly-2025-03-23` as its `rust-toolchain.toml` pins, and Foundry for its
  contracts.
- **Licences.**
  - Its contracts carry MIT notices. The variants below are derived from them and keep the notice.
  - Its Rust circuits declare no licence, so they are built from INTMAX3's own repository into the
    gitignored `work/`, and never copied here, as experiment 19 builds Tornado.
- **Real proofs** throughout. They come from INTMAX3's own provers, with its verifier cohort
  regenerated for each chain's deployment by its own procedure,
  `doc/tasks/regen-and-redeploy-runbook.md`.
- **Two chains:**
  - **The Hegota test network, chain 8141.** INTMAX3's one-day challenge floor applies.
  - **The local chain:** ethrex with experiment 19's EIP-8288 patch, at chain id 31337, so that
    INTMAX3's short devnet windows apply, as its own end-to-end tests use them.
- **skandha** at experiment 22's pins: `ede942f`, under the test network's profile and under
  EIP-8141's own descriptor; and `ef266b3`'s `eip-8288-master` node path, on the local chain. Two
  nodes in front of each chain, B booted from A.

### Ways to pay for a job

These are the research owner's four, each run side by side:
- **M1, a paymaster repaid from the payout,** on INTMAX3's unchanged contracts. The recipient is an
  exit account with code. A paymaster's `VERIFY` approves payment, and a later frame repays it from
  the amount the account pulls (P3, C6). C0 pays nothing out, so there the paymaster is a sponsor,
  recorded as such.
- **M2, a self-paying escrow.** This is a variant of the payout in `IntmaxRollup` and in the
  Manager, in which the escrow is the frame transaction's sender for P3 or C6. It approves payment
  in `VERIFY` when the fee is at most the payout, as experiment 24's `PoolSelf` does. It is a
  proposal, not INTMAX3's design.
- **M3, a fee to the prover the proof commits to.** A funded taker sends a proof job (P2 or C5) and
  is paid a stated fee from the withdrawal in the same transaction. The recipient's exit account
  pays it, on pulling, to the `withdrawalProver` the proof commits to.
- **M4, the job posted to L1 first.** What a taker needs, and the fee, are posted to an L1 job
  contract. A taker then sends the fulfilment (P2 with P3, or C5 with C6) through node A.

### The recipient

- **On the test network:** an ordinary secp256k1 address holding no ETH, with an exit account for
  M1, M3 and M4.
- **On the local chain:** a leanSPHINCS account (experiment 22's `SphincsAccount`) holding no ETH.
  Every sender there is a leanSPHINCS account funded at genesis: the producer, the takers, the
  paymaster and the poster.

### Arms

0. **Reproduce.** Build the stack and regenerate the verifier cohort. Run INTMAX3's own flow on the
   local chain: a deposit, a channel, a transfer. Verify one real withdrawal proof on chain, and
   record each step's gas.
1. **Partial withdrawal,** under each way to pay, on each chain, under each rule set at node A.
   Recorded per transaction:
   - node A's verdict;
   - whether node B received it;
   - whether a block mined it, and its gas.
2. **Close and claim,** likewise. On the test network, C3 waits out the challenge period, and is
   sent a day later.
3. **Who can take a proof job.** The inputs each proof job needs, which of them only a channel
   member holds, and what a taker learns.
4. **No ETH.** A recipient holding no ETH, under each way to pay and under none.
5. **The local chain's blocks,** scanned for any secp256k1 or P-256 signature.

## Predictions

1. **Real proofs verify.** The stack builds and proves in this container. INTMAX3's own verifiers
   accept a real withdrawal proof, a real close and a real claim, on both chains.
2. **No proof job fits `VERIFY`.** Every proof step's verification costs more than 500,000 gas, so
   no proof job can be paid for by a contract approving payment in `VERIFY`, under either rule set.
3. **Funded takers are carried.** A proof job sent by a funded taker, with the proof checked in an
   execution frame, is admitted at node A under both rule sets. A block mines it wherever the
   chain's per-transaction gas cap allows its limit.
4. **Without ETH, nothing pays.** On INTMAX3's unchanged contracts and with no way to pay, a
   recipient holding no ETH cannot complete P3 or C6.
5. **M1 needs the test network's rules.** The paymaster's `VERIFY` must read INTMAX3's payout record
   in another contract's storage, so node A refuses M1 under EIP-8141's own rules and admits it
   under the test network's.
6. **M2 fits EIP-8141's own rules.** The self-paying payout checks no proof: its `VERIFY` stays
   under 100,000 gas, and node A admits it under both rule sets.
7. **M3 pays the taker.** In one transaction the taker lands the proof and receives the stated fee.
   The fee covers the taker's gas at the test network's base fee.
8. **M4 is mined in two steps.** The posted job and its fulfilment are both mined. Node A admits
   the fulfilment wherever it admits the fulfilment's own parts.
9. **The exit is post-quantum.** No block of the local chain's runs carries a secp256k1 or P-256
   signature.

Arm 3 is recorded, not predicted.

## What would show it wrong

| Prediction | Shown wrong if |
|---|---|
| 1 | the stack does not build or prove here, or an INTMAX3 verifier refuses a real proof |
| 2 | a proof step's verification costs 500,000 gas or less |
| 3 | node A refuses a funded taker's proof job under either rule set, or a block refuses one within the chain's cap |
| 4 | a recipient with no ETH completes P3 or C6 on unchanged contracts with no payer |
| 5 | node A admits M1 under EIP-8141's own rules, or refuses it under the test network's |
| 6 | M2's `VERIFY` exceeds 100,000 gas, or node A refuses it under either rule set |
| 7 | the taker's fee does not reach it in the same transaction, or does not cover its gas |
| 8 | the posted job or its fulfilment is not mined |
| 9 | any block of the local chain's runs carries a secp256k1 or P-256 signature |

## Deviations, stated before the run

- **INTMAX3 is a prototype.** Its own documents keep public release closed until an independent
  cryptographic review. A run on a test network is not a deployment of INTMAX3. It moves no value,
  and it says nothing about INTMAX3's security.
- **M2 and M3 change INTMAX3's contracts.** They are this experiment's proposals, derived under the
  contracts' MIT licence, and are named as variants wherever they appear.
- **No silent fallback.** The container has 4 cores, 15 GB of memory and about 4 GB of free disk.
  If the stack cannot build or prove here, the run stops and the research owner decides. Mocked
  proofs are not substituted.
- **The test network's close takes a day.** INTMAX3's 86,400-second floor applies, so its C3 to C6
  are a second run, a day after the first.
- **The block producer's job is INTMAX3's own.** P1 is run by INTMAX3's producer as its code runs it,
  and recorded. It is not rebuilt as an L1.5 job, since members co-sign each block's transaction-tree
  root, and anyone could not simply take it.
- **The fee in M3 and M4 is this experiment's choice.** It is stated before each run and recorded.

## Path

`build.sh` (INTMAX3 into `work/intmax3-979318dbf48e/`), `run.ts` (arms 0 to 5, `--chain
local|testnet`), and results in `results/`, each with its commit, command and inputs.

## Results, arm 0's build (2026-11-05)

Record [`results/0-build.json`](results/0-build.json):
`bash experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/build.sh 0-build`. INTMAX3 at its pin,
with its submodules at their gitlinks, built with its own toolchain (`nightly-2025-03-23`). Its
release binaries and its contracts each built with exit 0, in 1,092 s on 4 cores.

## Results, arm 0's reproduction, run 1 (2026-11-05)

Records [`results/1-reproduce-anvil.json`](results/1-reproduce-anvil.json), from
`bash experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/reproduce.sh 1-reproduce-anvil`, and
[`results/1-reproduce-anvil-chain.json`](results/1-reproduce-anvil-chain.json), read back from
the anvil the test left running:
`npx tsx experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/chainlog.ts http://127.0.0.1:8553 1-reproduce-anvil-chain`.
The first record was written again by `summarize.py` from the same log, to keep the proof lines
and the kernel's line, which the script as first committed did not.

**Killed for memory.** INTMAX3's own test ran for 1,241 s, compiling its test dependencies
included, and was stopped by the kernel's out-of-memory killer. The test process held 13,832,048
KiB of anonymous memory, against this container's limit of 14,337,302,528 bytes. It died wrapping
the four-block validity proof into its MLE form, the step before the first block is posted. So no
block reached the chain, and no withdrawal was proved.

What it proved before that, as its own output prints it:

| Proof | Time | Size (bytes) |
|---|---:|---:|
| balance, receive deposit | 14.6 s | 133,600 |
| spend, bootstrap | 1.3 s | 132,696 |
| balance, send (bootstrap) | 16.5 s | 133,600 |
| the burn's E-2 build and proof | 1.8 s | 242,850 |
| spend, the burn | 1.3 s | 132,696 |
| balance, send (the burn) | 16.5 s | 133,600 |
| the four-block hash chain | 215.8 s | |
| validity | 187.1 s | |

The chain holds the 17 transactions sent before the kill, all succeeding:
- eight deployments through the CREATE2 deployer, 652,108 to 5,156,934 gas;
- six plain creations, 975,776 to 5,343,038 gas;
- `setKzgVerifier` (47,454), `setBlockProducer` (45,709) and `registerChannel` (191,395).

INTMAX3's own benchmark of its validity prover (`doc/benches/validity-prover-2026-08-20.md`, on a
48 GiB host) measured a peak of 11.23 GiB for that prover alone. It says a prover host "should have
at least 16 GiB available to this process, and 24 GiB is the safer floor". This container's limit
is 13.35 GiB, and the test holds the balance, validity and withdrawal circuits in one process.

**Prediction 1 is shown wrong for this container, so far:** the stack builds here, but its test
does not prove through here at rayon's default of one thread per core.

## Amendment 1, 2026-11-05, after run 1 and before run 2

The deviation above says the run stops if the stack cannot prove here. One setting is tried first,
since it changes nothing that is proved: run 2 sets `RAYON_NUM_THREADS=1`, which rayon reads at
start, so INTMAX3's provers run on one thread. `reproduce.sh` passes it through and records it.
Nothing in INTMAX3 changes, and no proof is mocked. If run 2 is killed for memory too, arm 0 stops
here and the research owner decides.

## Results, arm 0's reproduction, run 2 (2026-11-05)

Records [`results/2-reproduce-anvil-one-thread.json`](results/2-reproduce-anvil-one-thread.json),
from `RAYON_NUM_THREADS=1 bash experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/reproduce.sh 2-reproduce-anvil-one-thread`,
and [`results/2-reproduce-anvil-one-thread-chain.json`](results/2-reproduce-anvil-one-thread-chain.json),
read back from its anvil as in run 1.

**Killed for memory again, at the same step.** The test ran for 1,574 s and was stopped by the
kernel's out-of-memory killer, holding 13,844,096 KiB, while wrapping the validity proof. One
thread moved the peak by 12,048 KiB and made all but one proof two to three times slower:

| Proof | Run 1, one thread per core | Run 2, one thread |
|---|---:|---:|
| balance, receive deposit | 14.6 s | 46.4 s |
| spend, bootstrap | 1.3 s | 3.9 s |
| balance, send (bootstrap) | 16.5 s | 44.5 s |
| the burn's E-2 build and proof | 1.8 s | 1.5 s |
| spend, the burn | 1.3 s | 3.9 s |
| balance, send (the burn) | 16.5 s | 47.5 s |
| the four-block hash chain | 215.8 s | 468.4 s |
| validity | 187.1 s | 497.8 s |

The chain holds the same 17 transactions as run 1, at the same gas each.

**Arm 0 stops here, as amendment 1 said.** The memory the test needs is in the circuits it holds,
not in its threads. INTMAX3's withdrawal is not reproduced in this container, so no later arm
runs on its real proofs here, and no proof is mocked in their place. **Prediction 1 is shown wrong
for this container:** the stack builds, and its own test cannot prove through here. The research
owner decides where arm 0 runs next.

The local chain's run, prepared in `launcher.ts` and `reproduce.sh`'s `X18_CHAIN=local` mode, was
not started. ethrex would share the same memory limit with the test.
