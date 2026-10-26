# Committee log

The working log of the session that builds the committees (C1, C2, C3, C5, C6) and runs
experiments 08 to 10. This repository's status log is `PLAN.md` on `plan`; this session writes
only to `tooling-committee` and its own `exp/NN-name` branches, so it logs here, on the branch it
works on, and each experiment's README carries its own record.

## 2026-10-21, first session: C2

**Done.** `committee/co-withdraw`, a library and command line: a three-party committee proving
the Tornado Cash withdrawal circuit, the one X1's pool verifies, with TACEO's co-snarks
(`co-groth16`'s REP3 prover, pinned at `436f63fa`), over the proving key kohaku-rs's wallet
proves with (`kohaku-tornadocash-circuit` at `ab056ab`).

- **The circuit is circom v1** and its key is websnark's. co-circom compiles circom 2, so the
  committee does not extend the witness. The client does, as before proving alone, and shares
  the whole witness: co-circom's own `split-witness` path.
- **One piece is new: `WebsnarkReduction`.** Neither of co-groth16's witness maps fits a
  websnark key, whose quotient bases take $H$'s coefficients, $m - 1$ of them, over snarkjs'
  root of unity from 7. It is linear but for co-groth16's own `local_mul_vec`, so it adds no
  communication. Checked against websnark's prover in the clear and three-party
  (`cargo test --release -p co-withdraw`, 7 tests).
- **The share format is fixed**, in `committee/README.md`, "The witness's share format (fixed)":
  REP3 over BN254's scalar field; co-snarks' `CompressedRep3SharedWitness<ark_bn254::Fr>` in
  bincode 1, replicated or seeded-replicated; the constant and six public inputs in the clear;
  28,293 private values; 1,811,012 bytes per member, replicated. W13 writes this.

**Result.** `npx tsx scripts/committee-c2.ts 2026-10-21`, from `bb67ced`, record
`test/fixtures/committee/c2-2026-10-21.json`, input a fresh note from `co-withdraw demo-inputs`:
- the three members agreed on one proof;
- the patched verifier `0x87a7C1f7...`, read from X1's refund pool's code, answered
  `eth_call` with 1 at block 490,662, and with 0 when the recipient was changed by one;
- noble's BN254 pairing agrees, against the key whose coordinates are all in that verifier's
  code (`npm test`, 51 tests).

| Per member, one proof | Messages sent / received | Bytes sent / received |
|---|---|---|
| member 0 | 6 / 6 | 752 / 752 |
| member 1 | 6 / 6 | 784 / 752 |
| member 2 | 6 / 6 | 752 / 784 |

That is REP3's seed exchange and the prover's two openings: under 1 KB per member. Wall-clock,
the setup and the proof together, was 1,573 ms per member, all three on one 4-core machine over
loopback TCP: a LAN time. The shares, 1.8 MB to each member, are sent by the client, not by the
members to one another.

**Needs from.** Nothing. The wallet session's W13 writes the format above; kohaku-rs's
`websnark-rs` witness is already the order the format names.

**For the owner.** Nothing yet. `tooling-committee` is to merge before the coordinator's
experiments 06 and 07; the pull request waits for the owner's word through the coordinator.

## 2026-10-21, first session, continued: C1

**Done.** One fixed committee of four with two keys, as two crates with command lines:
- `committee/fhe-committee`, its own workspace over Zama's threshold-fhe at `c668fdd` and
  tfhe-rs `1.0.1`: setup, the client's proven input, the coprocessor, and noise-flooding
  distributed decryption with each member's traffic counted;
- `committee/bls-committee`, over Commonware `v2026.9.0` with this session's
  `feldman_desmedt::run` (cmw-monorepo `489e313`): the DKG, a quorum's signature on the result,
  and the best a set below the quorum can make.

- **The input format is fixed**, in `committee/README.md`, "The input format (fixed)": one
  `FheUint64` in a tfhe-rs 1.0.1 `ProvenCompactCiphertextList`, packed, proven under the
  committee's CRS with `ZkComputeLoad::Verify`, bound to metadata the request chooses,
  `safe_serialize`d; 18,786 bytes. W12 writes this.
- **The signed result is fixed**, same README, "The signed result (fixed)": namespace
  `FRAME_FHE_RESULT_V1`, message `chain_id || request || handle || value` (128 bytes), `MinSig`,
  hashed as a blind ticket is, so the ticket paymaster's EIP-2537 check serves with its
  namespace and message changed. M10 and X5 check this.

**Result.** `npx tsx scripts/committee-c1.ts 2026-10-21`, from `d84fb97`, record
`test/fixtures/committee/c1-2026-10-21.json`:
- the client encrypted 41 bound to the request's metadata; the proof verified, and the
  coprocessor refused the same input under other metadata; it added 1;
- the four members decrypted 42, each sending 9 messages, 6,660 bytes, in 3 rounds (PRSS
  setup, noise preprocessing, opening). The decryption took 9.8 s, all four in one process on
  one 4-core machine, in memory: a LAN time at best;
- the BLS DKG: 9 messages, 3,483 bytes, 3 rounds per member, about 6 ms of compute each;
- three of four signed; the chain's EIP-2537 pairing precompile (`eth_call` at block 491,179)
  accepted the signature, and refused the interpolation two members made; `sign` refuses two
  signers outright. noble agrees on both, and on every partial (`npm test`, 56 tests).

Sizes: compact public key 33,018 bytes; CRS 3,431,027; the public key set 1,193,804,535 (the
switch-and-squash key, which every member and the coprocessor read); a member's share 450,483;
the result ciphertext 527,833.

**Two things the Fhenix run will meet:**
1. **The TFHE key is dealt, not generated by a DKG.** threshold-fhe has a distributed keygen,
   but its secure preprocessing for these parameters is beyond a run on one machine, and its own
   library example deals and shares the key, as this does. The BLS key has no dealer. What the
   chain and the nodes see does not change; who once held the whole TFHE key does. The register
   asks for a DKG where the system has one: that is for the owner (below).
2. **The input's proof is over BLS12-446**, the curve tfhe-rs 1.0.1 fixes for its proofs of
   knowledge. The EVM has no precompile for it, so a `VERIFY` frame would check it in bytecode.
   That bears on X5's "would show it wrong" (the input's proof checked in a frame within the
   budget). It is recorded here, not tested: the request transaction is W12's and X5's.

**Needs from.** Nothing. W12 writes the input format above; M10 checks the signed result above.

**For the owner.**
1. `tooling-committee` (C1 and C2) is ready to merge before the coordinator's experiments 06 and
   07. Opening and merging its pull request is the owner's act; this session opens it only on
   the owner's word through the coordinator.
2. Accept C1's dealt TFHE key for X5, with the reason above, or ask for threshold-fhe's
   distributed keygen to be attempted and its cost recorded instead.

## 2026-10-21, first session, continued: the coordinator's three messages, and C1 amended

Three messages from the coordinator reached this session at 00:57, 01:39 and 01:57 and were read
at 02:26, after C1's first record (02:04) and after experiment 08's first chain attempt had
started (02:12). They were acted on as follows.

- **Third-party code** (pinned, unmodified, licences recorded; rebuilt roles say they test the
  shape, not the product): every piece in `committee/pins.json` now names its licence. kohaku-rs
  states none at its pinned commit: no LICENSE file and no license field. co-snarks' crates used
  here are MIT OR Apache-2.0; its co-circom and compiler, not used, are GPL-3.0-only. Nothing
  inside any third party's code was changed, and no change is needed. The C1 and C2 READMEs and
  C1's record say the roles are rebuilt.
- **Wording.** `committee/README.md`'s sentence on loopback times followed the brief's words; it
  is restated in this repository's own words (`8d11262`).
- **Formats in the library READMEs**: `co-withdraw/README.md` (the witness's share format),
  `fhe-committee/README.md` (the input format), `bls-committee/README.md` (the signed result,
  the lock, Commonware's parameters).
- **C1's amendments**, written into `committee/README.md` before its rerun:
  - the budget named: 500,000, the testnet nodes'; the pairing alone is 102,900 (derived);
  - would show it wrong also: a signature accepted for another request; two results for one
    request each signed;
  - a lock per request in each member, `q > (n + t)/2` (3 > 2.5);
  - recorded: Commonware's threshold parameter is `q` (`Sharing::required()`, `n - f`, degree
    `q - 1`); its Feldman DKG does **not** fix the qualified set before key-dependent values are
    revealed (each dealer's commitment goes out in round one; Commonware documents the `O(lg N)`
    bias itself);
  - `t` members, then `q - 1`, try to forge from their shares and the DKG's public output.
- **The first C1 record**, made before the amendment was read, is kept unchanged at
  `test/fixtures/committee/before-amendments/c1-2026-10-21.json`, outside what `npm test` scans.
- **Experiment 08's first chain attempt** (started 02:12 from `525b303`) was stopped at 02:27,
  before any spend: only its setup transaction, the funder's nonce 0 (deploy and buy four
  tickets), was mined. The runner's record was not written, so its hash is not kept; the attempt
  is void and will be rerun under the amended claim. Its measurement run was stopped too.
- **The testnet key.** `PRIVATE_KEY` is not set in this session's environment. The repository's
  own `npm run account` made one in the gitignored `.env` (address `0x58703D6A...79115`), funded
  from the faucet; it is never printed or committed.

**Result, C1 rerun.** `npx tsx scripts/committee-c1.ts 2026-10-21-amended`, from `8d11262`,
record `test/fixtures/committee/c1-2026-10-21-amended.json`, chain reads at block 491,465:
- 41 + 1 decrypted as 42 by four members (9 messages, 6,660 bytes, 3 rounds each; 9.3 s in one
  process: a LAN time at best);
- three of four signed; the precompile accepted it, and refused it for another request;
- a second result (43) for the same request: members 0, 1 and 2 refused (locked), 3 signed: one
  partial. With member 0 corrupted: 1 and 2 refused, two partials. No signature either time;
- member 3 alone, and members 0 and 1, with their shares and the DKG's public output: eight
  forging attempts, every one refused by noble and by the precompile;
- `npm test`: 61 checks pass.

**For the owner.** Unchanged from the entry above: the pull request for `tooling-committee`, and
the dealt TFHE key.

## 2026-10-21, second session (after the 06:00 reset)

**Owner's answers, done:** pull request #8 (`tooling-committee` into `main`)
opened; C1's README says the dealer saw the whole TFHE key once, lists who holds or sees what,
and prices threshold-fhe's distributed keygen from its specification without running it (five
online rounds and 430 to 742 million triples, quoted; about 0.9 TB a member, derived), `c714e81`.

**C3, experiment 08** (`exp/08-c3-epoch-reshare`): both arms ran on chain from `0896276`, record
`results/chain-2-amended.json`, committed at `f2f6698`. Arm A kept one key across committees of
4, 7 and 10 under one paymaster; its retired committee's kept shares still signed, as stated
before the run. Arm B registered each fresh key with a paymaster of its own (2,434,267 gas each);
its retired committee's ticket was refused at the latest paymaster (`ErrClaimInvalid`). Two
comparisons in the test were formatting fixes (address case, gas in hex); the checks are as
pushed. The owner's later reporting items: `member` mode for 423 and 512 added (`0adec74`); the
size measurement up to 256 and the member run are still to record, then the README's results.

**C6, experiment 10** (`exp/10-c6-accountable-signers`): three attempts.
- Attempt 1 (`def840e`): the accountable form refused from 64 members by the paymaster's own
  0.001 ETH denomination (the keys' data makes the max cost larger), not by the node.
- Attempt 2 (`3c0f046`, 0.01 ETH): all mined but, at 256, the individual mode, refused because its
  declared limit (the fit plus 10%) took the prefix over 500,000.
- Attempt 3 (`4bb2de7`, 2% margin): every form mined at every size to 256 except the ECDSA control
  at 256 (about 600,000 needed; refused for its budget). Accountable at 256: 322,587 gas aggregate,
  427,801 individual. The threshold signature is identical from two quorums at every size. Not
  shown wrong; 49 checks pass. README results at `d5ba3c7`.
- Attempts 1 and 2 are kept in `results/superseded/` with their causes. The test's ECDSA check,
  which I had added beyond the two pushed before the run, now records the control either way.
- The owner's later reporting items are in the README, derived or named as not run.

**Process note.** An edit to experiment 10's README went through the artifact tool by mistake
and published that README as a private page (it holds nothing but this public README); deleting
it is the owner's call.

**For the owner.** Merging pull request #8. Nothing else new.

C2: done | exp-e2e-frames c714e81, PR #8 | needs from wallet: none
C1: done | exp-e2e-frames c714e81, PR #8, test/fixtures/committee/c1-2026-10-21-amended.json | needs from wallet: none
C3: partial; chain run done, size measurement and README results next | exp-e2e-frames 0adec74 on exp/08-c3-epoch-reshare, results/chain-2-amended.json | needs from wallet: none
C6: done, ready for acceptance | exp-e2e-frames d5ba3c7 on exp/10-c6-accountable-signers, results/3-margin-2.json | needs from wallet: none
C5: waiting for the paper, as the owner directed | none | needs from wallet: none

## 2026-10-21, third session

**C3, experiment 08** (`exp/08-c3-epoch-reshare`): the size measurement (4 to 256, every member
in turn in one process) and `member` mode (423 and 512) recorded, results written, `0c3a6c1`.
A member's reshare at 256 takes 6.3 s of compute, plus 450 ms for three WAN trips, against an
epoch of 384 s; all 256 in turn took 1,421 s, the simulation's cost. Bytes a member sends grow as
`n^2` point to point (14.8 MB at 256). At 423 and 512 a dealer's unique bytes are about 5.4 times
the post's `32n + 48t`, and with its log sent to every player about 2,000 to 2,400 times. Not
shown wrong; 13 checks pass. Experiment 10's run shared the CPU during sizes up to 128.

**C5, experiment 09** (`exp/09-c5-traceable-shares`): the paper (ePrint 2024/405, last revised
2024-08-12) read first; the claim, what would show it wrong and the test pushed before any code
(`e5cd26f`), the tracer, staking contract and runner before the first transaction (`db62eeb`).
One try stopped at the node's gas estimate before any transaction (`b51404c` fixes it). Attempt
1, blocks 494,042 to 494,044: the perfect, smaller and noisy boxes traced to exactly their
coalitions; the slashing transaction convicted six holders in 105,742 gas, checked by the
contract against a Merkle root of the key; evidence forged against an innocent holder reverted.
A box that can read the key evades tracing, so only the root goes on chain. The dealer can frame
anyone. Not shown wrong; 23 checks pass. Results at `9b51380`.

**For the owner.** C3 and C5 ready for acceptance. One harness slip is recorded in C5's README:
the runner mislabelled the chain's ether-transfer log as a holder; the record is unchanged and the
runner now records logs whole.

C2: done | exp-e2e-frames b7c19a1 (PR #8 merged) | needs from wallet: none
C1: done | exp-e2e-frames b7c19a1 (PR #8 merged), test/fixtures/committee/c1-2026-10-21-amended.json | needs from wallet: none
C3: done, ready for acceptance | exp-e2e-frames 0c3a6c1 on exp/08-c3-epoch-reshare, results/chain-2-amended.json, measure-1-first-run.json, member-1-first-run.json | needs from wallet: none
C6: done, ready for acceptance | exp-e2e-frames d5ba3c7 on exp/10-c6-accountable-signers, results/3-margin-2.json | needs from wallet: none
C5: done, ready for acceptance | exp-e2e-frames 9b51380 on exp/09-c5-traceable-shares, results/1-first-run.json | needs from wallet: none

## 2026-10-21, fourth session

**co-withdraw**: `member --peers` takes the three addresses comma-separated or as three values,
as its help text says, `7201b52`. It was defined to take three values only, while its help said
comma-separated; X6's second run passed one comma-separated value, which voided its probe of a
member left alone.

**fhe-committee's `compare`** (G5, `exp/13-g5-gradient` at `eb96472`): read and kept on the G5
branch as it is. Each owner's input is checked against its own metadata before `a > b` is
evaluated, and the result is cast to `FheUint64` so that `decrypt` and the result claim read it
unchanged. A shadowed name could read better; it is not worth a push on its own.

C2: done | exp-e2e-frames b7c19a1 (PR #8 merged) | needs from wallet: none
C1: done | exp-e2e-frames b7c19a1 (PR #8 merged); co-withdraw --peers fix 7201b52 on tooling-committee | needs from wallet: none
C3: done, ready for acceptance | exp-e2e-frames 0c3a6c1 on exp/08-c3-epoch-reshare | needs from wallet: none
C6: done, ready for acceptance | exp-e2e-frames d5ba3c7 on exp/10-c6-accountable-signers | needs from wallet: none
C5: done, ready for acceptance | exp-e2e-frames 357f229 on exp/09-c5-traceable-shares (record from 9b51380; wording only since) | needs from wallet: none

**Accepted** (the coordinator, 11:26): C3, C5 and C6, in the register's status table.

C2: done | exp-e2e-frames b7c19a1 (PR #8 merged) | needs from wallet: none
C1: done | exp-e2e-frames b7c19a1 (PR #8 merged); co-withdraw --peers fix 7201b52 on tooling-committee | needs from wallet: none
C3: done, accepted | exp-e2e-frames 0c3a6c1 on exp/08-c3-epoch-reshare | needs from wallet: none
C6: done, accepted | exp-e2e-frames d5ba3c7 on exp/10-c6-accountable-signers | needs from wallet: none
C5: done, accepted | exp-e2e-frames 357f229 on exp/09-c5-traceable-shares (record from 9b51380) | needs from wallet: none

## 2026-10-22, fifth session

Carried here by the coordinator, from the committee session's text.

PR #15 (tooling-committee, head d9bc154) closed without merging at 04:33 UTC in favour of #17, one pull request for every open branch at the owner's request. d9bc154 is an ancestor of #17's head bb7a4ec; committee/LOG.md there names no private repository; #17 keeps solc at exactly 0.8.37.

Status: C1, C2 done; C3, C5, C6 done and accepted; all in #17; nothing needed from the wallet session.

## 2026-10-26, sixth session: X9

Carried here by the coordinator, from the committee session's text.

X9's construction was chosen with the wallet session and checked by the coordinator. It was built
and pushed before any testnet transaction, at exp-e2e-frames `eafbdf3` on `exp/14-x9-exit`:
- **The vault.** `ExitVault` is experiment 30's refund pool with X9 added.
- **The timeout.** It is checked in `withdraw`, because a `VERIFY` frame cannot read the block
  number.
- **Escape.** It lasts at least $E = 30$ blocks, and reconcile needs a 3-of-3 BLS signature.
- **Only the owner redeems.** The nullifier is split by Pedersen windows across the three
  members, and the owner keeps $s$. No member, nor all of them together, can redeem.
- **Openings.** They are key-private, three 99-byte messages per update.
- **Rehearsal.** Every plan step was rehearsed on a local ethrex at the testnet's commit. The
  rehearsal found that reconcile's single nonce sequence could lock the committee out, and that
  was fixed before the push.
- **No fraud proof** was built.

The coordinator reran the checks on `eafbdf3`:
- `npx vitest run`: 220 tests pass, plus X6's one expected failure;
- `cargo test --release --workspace` in `committee/`: bls-committee 4 of 4, co-withdraw 9 of 9 and
  exit-committee 9 of 9.

The branch is merged into #18's branch (`798d964`).

X9: committee side ready for the runner | exp-e2e-frames eafbdf3, merged at 798d964 | needs from wallet: the redemption's withdraw state limit 379,440 and nonce sequences 0 to 2, sent to it
