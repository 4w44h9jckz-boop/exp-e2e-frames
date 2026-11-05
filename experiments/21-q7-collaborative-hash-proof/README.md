# Experiment 21 (Q7): a committee's withdrawal proof after a quantum computer

**Status: pre-registered 2026-11-05,** before any build, runner or measurement. The reading
below was done first, and it decides the plan. The claim, the predictions, what would show each
wrong and the plan are fixed here. Results are added below them, and nothing above the results is
edited after a run.

**Why.** In experiment 07 (X6), three members proved one user's privacy-pool withdrawal together
with TACEO's co-snarks: Groth16 over BN254, over replicated shares of the witness. A quantum
computer breaks that proof's soundness. This experiment asks what the same committee costs with
a hash-based collaborative prover.

**This is a port that measures the model, not TACEO's system.** It measures whether the model
behind it (a committee proving over shares of one user's witness) has a hash-based form, and at
what cost. TACEO's own design (balances held in shares, a coSNARK per update, experiment 07's note)
is not rebuilt, and nothing here measures TACEO's software.

## The reading, done before this pre-registration

What a committee needs is a prover that runs over secret shares of the witness and outputs a
hash-based proof. Read on 2026-11-05:

- **No collaborative prover for leanVM or for any leanSTARK was found.** Experiment 19's leanVM
  prover (leanVM at `3cbac04`) runs on one machine over the whole witness.
- **ePrint 2026/729** describes a code-based collaborative SNARK: a Spartan-style PIOP over a
  tensor code built from two Reed-Solomon codes, made non-interactive by hashing. Its authors'
  implementation is public: github.com/ChristodoulosPappas/Code-Based-Scalable-coSNARKs at
  `1c50a74` (2025-11-14), C++ with MPI. Read from its source, not yet built:
  - **It proves synthetic statements only.** `main.cpp` generates its own R1CS of $2^M$
    constraints (`generate_R1CS_matrixes`). It reads no circuit and no witness.
  - **It writes no proof and has no separate verifier.** The verifier runs inside the same
    process, and the program prints the provers' and verifier's times, the proof's size, the bytes
    the provers exchanged, and the rounds.
  - **Its field is the Mersenne prime $2^{61} - 1$** (`virgo_prime_field`), and its hash is
    Blake3.
  - **Its committee sizes:** the provers are the MPI processes, $N$ of them, and the code sets
    $k = N/4$ (`main.cpp`). That makes 4 the smallest committee with $k \geq 1$. Experiment 07's
    committee was 3.
- **ePrint 2021/1530** sketches a collaborative form of a hash-based SNARK. No implementation
  was found.

**So the full route cannot be run here.** The brief's natural route was a committee proving X6's
statement with ePrint 2026/729's prover, its proof wrapped in leanVM, the wrap checked by
`x14-prover verify` against the digest and program key that the program layout fixes
(`docs/leanvm-program-layout.md`, `72068fd`). It is missing three pieces, and none is a small
change:
1. a front end that reads X6's statement and a witness's shares;
2. a proof the prover writes out, and a verifier outside the prover's process;
3. a leanVM program that verifies such a proof: arithmetic modulo $2^{61} - 1$, Blake3, and
   the tensor code's openings.

The brief's fallback applies: measure the smallest collaborative evaluation that would serve,
and stop with that number.

## The claim

A committee of hash-based provers can prove a statement the size of X6's withdrawal over shares
of its witness, at a cost the committee can bear on one ordinary machine. The cost is measured as:
- each prover's time;
- the proof's size and the verifier's time;
- the bytes the provers exchange.

All are set beside experiment 07's co-snarks committee and beside one device proving the
statement alone with leanVM.

## Two conditions, stated in every result

- **leanVM has no zero knowledge yet.** A leanVM proof hides nothing it was given. The
  single-device baseline here is a cost comparison, not a privacy claim.
- **EIP-8288 reserves `LEANSTARK_SCHEME`.** No proof here reaches a chain: the committee's proof
  is not in a form any chain or verifier here accepts (piece 3 above).

And a third, for the collaborative prover: **whether this implementation is zero knowledge is
not established.** The paper's abstract says its codeword test can be made zero knowledge. This
experiment neither checks that in the code nor relies on it.

## The size of X6's statement

Experiment 07's withdrawal circuit has 28,300 witness values (`committee/co-withdraw/README.md`).
$2^{15} = 32{,}768$ is the least power of two above that, and this prover's sizes are powers of
two. The evaluation therefore proves a synthetic R1CS of $2^{15}$ constraints as the size of X6's
statement. It is a stand-in for the circuit, since the prover reads none, and a circuit's
constraint count is not exactly its witness count. $2^{16}$ is measured beside it, to show how
cost grows.

The single-device baseline is the same withdrawal statement as leanVM proves it: experiment 19's
`v5_tornado.py` (Tornado's statement in a Keccak tree, 286 cycles), proved by experiment 19's
prover on this machine. The two statements differ in their hash (MiMC in the circuit, Keccak in
leanVM), and the comparison says so.

## The plan

1. **Build** the authors' implementation at `1c50a74` with its own `setup.sh` steps (CMake,
   Release), against this machine's MPI. Record the compiler and MPI versions. Any change needed
   to build is recorded as a patch in this directory.
2. **Measure** `mpirun -np N ./pigeon 0 M 1` (the main benchmark), with three passes and one
   warm-up at each point, and record every printed figure:
   - $N = 4$ at $M = 15$ and $16$ (the smallest committee);
   - $N = 8$ at $M = 15$ and $16$.

   This machine has 4 cores, so $N = 8$ oversubscribes them, and every figure says so. The
   provers talk over MPI on one host, which is loopback, not a network.
3. **Measure the baseline:** experiment 19's prover on `v5_tornado.py`, three passes after a
   warm-up, with its proving time, proof size and verifying time.
4. **Cite the classical figures** from experiment 07: three members, about 1.43 s each, 752 to
   784 bytes sent by each per proof.
5. **Stop.** Record what the full route still needs (pieces 1 to 3) and what each would replace.

## Predictions

| # | Prediction | Would show it wrong |
|---|---|---|
| 1 | Four provers prove a $2^{15}$-constraint statement on this machine, each in under 10 s | it does not build or run at that size, or a prover takes 10 s or more |
| 2 | The committee's proof is larger than one device's leanVM proof of the withdrawal (about 200 KiB in experiment 19) | a proof of 200 KiB or less |
| 3 | The provers exchange at least 1 MB per proof, three orders of magnitude more than co-snarks' 752 to 784 bytes per member | under 1 MB |
| 4 | The committee's proof is not one `x14-prover verify` accepts against the program layout's digest and key, so a node and verifier would tell it from a device's proof | a committee proof in the layout's form, accepted |

Prediction 4 is Q7's own falsifier, stated as the reading expects it: without pieces 1 to 3 the
committee's proof cannot look like the device's.

## Done when

The four measurement points and the baseline are recorded, or a stated reason why one could not
be. Each prediction is judged, and what the full route still needs is written down. Then the
experiment stops.

## Results

**Run 1, 2026-11-05.**
- **Records:**
  - `results/1-baseline.json` (plan step 3);
  - `results/1-pigeon/` (plan step 2): every pass's whole output, and `build.txt`.
- **Runners:** `baseline.ts` and `pigeon.sh`.
- **The collaborative prover's build:** the authors' repository at
  `1c50a7410fa464ad325e0014d0d5fedd196d86c5`, built unchanged with CMake (Release), g++ 13.3.0,
  Open MPI 4.1.6. It links the prebuilt `lib/libXKCP.a` that ships in the repository, sha256
  `30f4e676a12c1723bbd6f973cd3e2a45526fbfa0a21cdf2a86e2c7371dc4686c`.
- **The owner approved** building and running that repository in this session, after the
  session's automatic permission check had first refused it as external code.

The two conditions hold: leanVM has no zero knowledge yet, and no proof here reaches a chain. The
collaborative prover's own zero knowledge is not established.

**Two things found when running, stated here:**
- **The repository's scripts call a mode that does not exist.** `test_local.sh` and `bench.sh`
  run `pigeon 10 ...`, a benchmark `main.cpp` does not have. The run used benchmark 0, circuit
  type 1, as pre-registered.
- **What circuit type 1 is.** It is a synthetic circuit of $2^M$ gates. A sixteenth of them are
  inputs, and the rest are additions or multiplications, chosen at random with `srand(42)`.
  The same circuit is proved at every pass.

**The machine and the network.** One host: an Intel Xeon at 2.10 GHz, 4 cores, 15 GiB. The
provers are MPI processes on that host, so every wall-clock figure below is a loopback figure, not
a network's. $N = 8$ runs 8 provers on 4 cores (`--oversubscribe`).

**The collaborative prover** (`pigeon 0 M 1`, three passes after a warm-up). Each prover's time is
its whole proving time as the program prints it ("Pt"). Proof size, the provers' total
communication ("Com") and rounds are as printed, identical in every pass. Verification is the
in-process verifier's time.

| Point | Each prover's time | Proof | Provers' communication, in all | Rounds | Verifying |
|---|---|---|---|---|---|
| $N = 4$, $2^{15}$ (X6's size) | 0.79 to 0.96 s | 865.9 KB | 8.80 MB | 227 | 16 to 18 ms |
| $N = 4$, $2^{16}$ | 1.85 to 2.10 s | 1,058.0 KB | 16.50 MB | 247 | 27 to 28 ms |
| $N = 8$, $2^{15}$, oversubscribed | 0.38 to 0.57 s | 858.9 KB | 10.53 MB | 207 | 13 to 26 ms |
| $N = 8$, $2^{16}$, oversubscribed | 0.72 to 0.89 s | 1,070.3 KB | 18.53 MB | 227 | 16 to 23 ms |

The program prints KB and MB, and its source divides by 1,024. At $N = 8$ each prover holds half
the share it holds at $N = 4$, and its time falls even with 8 processes on 4 cores. How the
oversubscribed processes interleave was not measured.

**Beside it, the same withdrawal proved two other ways:**

| | Who proves | Time | Proof | Exchanged per proof |
|---|---|---|---|---|
| Experiment 07, co-snarks (Groth16, BN254) | 3 members over replicated shares, loopback TCP | about 1.43 s each | Groth16's 256 bytes | 752 to 784 bytes sent by each member |
| This run, ePrint 2026/729's prover | 4 provers, $2^{15}$ synthetic gates, loopback MPI | 0.79 to 0.96 s each | 865.9 KB | 8.80 MB in all |
| One device, leanVM (`v5_tornado.py`) | the user alone, the whole witness | 55 to 72 ms | 205,928 bytes | none |

- The leanVM proof is experiment 19's program: 286 cycles, 41.5 MB peak.
- `x14-prover verify` accepted it against its digest $D$ and the program's key in 10 ms.
- Its statement uses Keccak where experiment 07's circuit uses MiMC. The committee's statement is
  a synthetic circuit of the circuit's size, not the circuit itself.

**Against each prediction:**
1. **Four provers prove a statement of X6's size, each in under 10 s: held.** 0.79 to 0.96 s at
   $2^{15}$, and 1.85 to 2.10 s at $2^{16}$, on loopback. That is about co-snarks' time for the
   real circuit, on a synthetic circuit of the same size.
2. **The committee's proof is larger than one device's leanVM proof: held.** It is 865.9 KB
   against 205,928 bytes, about 4.3 times larger. It is about 3,500 times Groth16's 256 bytes.
3. **The provers exchange at least 1 MB per proof: held.** They exchange 8.80 MB in all at
   $N = 4$, about 2.2 MB per prover. That is about 3,000 times what each co-snarks member sent (752 to 784 bytes).
4. **The committee's proof is not one `x14-prover verify` accepts, so a verifier would tell it
   from a device's: held, by construction, not by a failed check.**
   - The committee's proof never leaves the prover's process, which writes no proof file. It is
     over another field and another hash, and no leanVM program verifies it.
   - There was therefore nothing to hand to `x14-prover verify`.
   - Q7's falsifier stands: on this route, a committee's withdrawal and a device's withdrawal
     differ in what the verifier sees.

**What the full route still needs, and what each piece replaces:**
1. **A front end** that takes X6's withdrawal statement (or `v5_tornado.py`'s) and a witness's
   shares, in place of the synthetic generator. Without it, nothing here proves a withdrawal.
2. **A proof the provers write out, and a verifier outside their process,** in place of the
   in-process check. Without it, no one but the provers can check the proof.
3. **A leanVM program that verifies that proof:** arithmetic modulo $2^{61} - 1$, Blake3, and the
   tensor code's openings. It would replace the committee's 865.9 KB proof with one leanVM proof
   of about 200 KB, under one program key and one digest $D$, as the program layout fixes. That
   is the step that would make the committee's proof look like the device's. Its proving time was
   not measured; it adds a single prover's wrap after the committee's work.

**Done when: done.** The four points and the baseline are recorded, each prediction is judged,
and what the full route needs is written. The experiment stops here.
