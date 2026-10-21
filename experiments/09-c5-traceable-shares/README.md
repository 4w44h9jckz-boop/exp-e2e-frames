# Experiment 09: a reconstruction box traced to the holders who built it

**The scheme.** Traceable secret sharing for a shared secret, the construction based on Shamir
secret sharing with non-imputability, from ePrint 2024/405 (last revised 2024-08-12), read in
full before any code here was written. It is the one scheme this repository implements itself,
and only from the paper. ePrint 2023/1724, which traces a decryption key through a decoder that
reaches a quorum, is a different setting and is not run.

**The claim** (Appendix F of the series, on this paper): tracing reaches a coalition of `f < t`
holders who build a reconstruction box, a program with their shares inside that takes `t - f`
further shares and returns the secret, together with the buyer who supplies those shares. From
black-box access to the box, the tracer names the `f` holders, and the evidence convicts them on
chain: a staking contract checks it itself and slashes their stakes.

**What would show it wrong.** Written before the first run, as the checks in
[`test/c5.test.ts`](../../test/c5.test.ts), and pushed before the first transaction:
- the tracer fails to name a member of the coalition, or names an innocent holder;
- the contract cannot check the evidence within a block: the slashing transaction is not mined,
  or uses more gas than a block holds.

**Done when** a box from a coalition is traced to its members and a slashing transaction is
mined, and it is shown, as a certainty rather than a hypothesis, that one holder of `t` shares
leaves nothing to trace: such a holder needs no box built from shares, and a box that ignores
its inputs answers every query alike.

**Recorded either way:**
- the family: tracing a box built from shares, not a decoder;
- the box's model as the paper states it: stateless, black-box, given `t - f` shares and
  returning the secret with probability at least `epsilon` (its Definitions 4 and 7);
- the number of queries to the box;
- the slashing transaction's bytes and gas, and what the paper's judge checks (its `Verify`);
- whether a box that can read the verification key evades tracing (the paper's tracing is
  private: its experiment never gives the adversary that key);
- that the paper's non-imputability protects against a tracer who is not the dealer: the dealer
  chooses every evaluation point.

## The scheme as built

Over BN254's scalar field, with keccak256 as the one-way function:
- **Share.** The secret `s` and `t - 1` random coefficients make `q`. Holder `i` gets a random
  point `x_i` and `y_i = q(x_i)`. Its key component is `u_i = keccak256(x_i)`.
- **Trace.** The paper's tracing algorithm (its Figure 4) for a known `f`: `N` pairs of queries,
  each pair `t - f - 1` random shares plus one share that differs between the two queries by a
  random `delta`, which gives one evaluation of a degree-`f` polynomial whose roots are the
  coalition's points; then decoding, roots, and a match against the key.
- **Decoding.** The paper uses any decoder for Reed-Solomon codes in its sense (Guruswami-Sudan
  for concreteness). This uses Berlekamp-Welch, which solves that problem when more than
  `(N + f) / 2` of the evaluations are right, with a list of one. It is the one departure, and
  the record says when it holds.
- **Verify** (the paper's judge): for each named holder `i_j`, `keccak256(w_j) = u_{i_j}`.

## The staking contract

The verification key does not go on chain in the clear: a box that can read it can refuse every
share whose point does not hash to a registered holder, and the tracer's random shares never do.
So the contract holds a Merkle root over `(i, u_i)`, and a slashing transaction opens it only for
the convicted: for each, `i`, `w_i`, and the path from `keccak256(i || keccak256(w_i))` to the
root. The contract checks every path itself, then pays the convicted holders' stakes to the
caller.

## Results

None yet: the claim and the checks above are pushed before the first transaction.
