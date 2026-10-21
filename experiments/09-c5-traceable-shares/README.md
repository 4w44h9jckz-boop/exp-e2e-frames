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

## Pieces

| Piece | Pin | Role |
|---|---|---|
| [`rust/`](rust/) | this experiment, crates locked in `rust/Cargo.lock` | the dealer, the boxes, the tracer, the Merkle tree and the evidence; the field from `ark-bn254` and `ark-ff` 0.6.0, keccak256 from `tiny-keccak` 2.0.2. The polynomial arithmetic, decoding and root finding are written here, from the paper |
| [`contracts/StakeSlash.yul`](contracts/StakeSlash.yul) | this experiment | the staking contract; `StakeSlash.hex` is its creation code from solc 0.8.37, EVM osaka, optimizer on, 200 runs, and `npm test` compiles it again |
| chain | ethrex `hegota-testnet-hotfix` at `64b8fc09` | ordinary type-2 transactions from the funder |

No piece of third-party code is changed, and none implements tracing.

## The run

1. **Deal.** Sixteen holders, threshold 7: a random polynomial of degree 6, a random point for each
   holder, and the key, sixteen hashes, with its Merkle root (depth 4).
2. **Boxes**, each from a coalition drawn at random from every holder but one, the innocent:
   - `perfect`: 6 holders (`f = t - 1`), a box that interpolates over its shares and the one it is
     given;
   - `smaller`: 3 holders, given 4 shares;
   - `noisy`: 6 holders, answering right with probability 0.9 a query, independently, and a
     random value otherwise;
   - `vk-aware`: 6 holders, a box that holds the key and answers a random value unless every
     share it is given is at some holder's point;
   - one holder of 7 shares, whose box ignores what it is given.

   Each box is first given genuine shares from 20 buyers, to show it works.
3. **Trace** each box for its `f`, known to the tracer: `N` = 7 pairs for the two exact boxes,
   64 for the others.
4. **Convict.** One transaction deploys `StakeSlash` with the root and 0.001 ETH a holder. One
   sends evidence forged against the innocent holder: a random `w` with that holder's true
   path. One sends the perfect box's evidence.

## Run

```bash
npm install
npm run account && npm run faucet
npx tsx experiments/09-c5-traceable-shares/run.ts [attempt-label] [holders] [threshold]
```

The record is written to `results/<attempt>.json`: the key and its root, each trace with its
queries, evaluations, roots, the holders it named and their evidence, the t-share holder's
answers (hashed), and the three transactions with their gas, bytes and the stakes before and
after. It holds no share, no secret and no coefficient. `npm test` checks it offline, and checks
every named holder again as the judge does.

## Results

Attempt 1 (`results/1-first-run.json`), from `b51404c`, on 2026-10-21, blocks 494,042 to
494,044. An earlier try from `db62eeb` stopped at the node's gas estimate, before any
transaction: with fee fields, the node capped its search at the funder's balance.

| Box | f | Pairs (queries) | Evaluations | Decoded | Named | Buyers answered |
|---|---|---|---|---|---|---|
| perfect | 6 | 7 (14) | 7 | yes | all 6 of the coalition | 20 of 20 |
| smaller | 3 | 7 (14) | 7 | yes | all 3 | 20 of 20 |
| noisy, 0.9 | 6 | 64 (128) | 64 | yes | all 6 | 17 of 20 |
| vk-aware | 6 | 64 (128) | 64 | no | no one | 20 of 20 |
| one holder of 7 shares | - | 64 (128) | 0 | no | no one | - |

- **Tracing reached every coalition, and no one else.** The three boxes the claim covers were
  each traced to exactly their coalition; no trace named a holder outside it. Each trace took
  under 50 ms. Not shown wrong.
- **The evidence convicted on chain.** The slashing transaction
  (`0x9c1367a9...`, block 494,044) carried six openings, 1,184 bytes of calldata in a
  1,299-byte transaction, and used 105,742 gas of the block's 200,000,000. The contract checked
  each `keccak256(w)` against the root itself, zeroed the six stakes, logged each holder, and paid
  0.006 ETH to the caller. Not shown wrong. A seventh log in the receipt is the chain's own
  record of that ether transfer, whose data is the amount; this record's runner read it as a
  holder (`holder: 6000000000000000`), and records logs whole from now on.
- **Forged evidence was refused.** Against holder 14, who was in no coalition, a random `w` with
  the true path reverted (`0x16f0e81e...`, block 494,043, 29,336 gas), and the stake stayed.
- **The deployment cost** 2,749,367 gas: sixteen fresh stake slots and the root.

Recorded either way:
- **The family**: tracing a box built from shares, by black-box queries, not a decoder of a
  ciphertext.
- **Queries**: one pair per evaluation; the exact boxes need `f + 1` evaluations, here 7 pairs.
  The noisy box's 64 pairs left room for Berlekamp-Welch to correct up to 28 wrong evaluations;
  at 0.9 a query, about 19 percent of pairs are wrong. The paper's list decoder reaches boxes
  that answer right less often; this decoder does not, and that case is not run.
- **The judge** checks only that `keccak256(w)` is the named holder's key component, here by
  the contract against the root: no pairing, no proof; about 14,100 gas a convicted holder,
  calldata included (derived: 105,742 less the 21,000 a transaction pays, over six).
- **A box that can read the key evades tracing.** The vk-aware box answered every buyer and
  gave the tracer nothing: the tracer's shares are at random points, which never hash to a
  holder's key component. This is why the key does not go on chain in the clear here; with only
  the root on chain, a coalition knows its own components and no one else's, so it cannot tell
  the tracer's shares from a buyer's. The tracer itself must keep the key private, as the
  paper's tracing assumes.
- **One holder of `t` shares leaves nothing to trace**, as a certainty: its box gave the same
  answer to all eight test queries and the same answer to both queries of every pair, so no
  pair gave an evaluation.
- **The dealer can frame anyone.** It chose every point, so it holds every `w`. Non-imputability
  here protects a holder against a tracer who is not the dealer; a deployment needs holders who
  choose their own points, or a dealer that erases them, and nothing enforces erasure.
- **Front-running**: the contract pays whoever submits the evidence, which the public mempool
  shows. A deployment would pay a beneficiary fixed in advance, or take a commitment first.
- **The tracer is told `f`.** Tracing for an unknown coalition size is not run.
