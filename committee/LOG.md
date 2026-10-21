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

C2: done | exp-e2e-frames 0854ff0, committee/README.md "The witness's share format (fixed)", test/fixtures/committee/c2-2026-10-21.json | needs from wallet: none
C1: not started | none | needs from wallet: none
C3: not started | none | needs from wallet: none
C6: not started | none | needs from wallet: none
C5: not started | none | needs from wallet: none
