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

None yet.
