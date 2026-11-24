# Experiment 32: a shared keystore for stealth accounts, proved in leanVM

**Status: pre-registered 2026-11-24,** before any code: the programs, the keystore, the table tool
and the runner. Results are added below. Nothing above them is edited after a run; a change of
plan before the run is recorded as a deviation.

## The question

Experiment 19's version 2a puts an account's rule and its leanSPHINCS keys inside the account's
commitment. Every account is spent by a proof that the rule accepts signatures on the message, and
the account's code is one stub shared by all.

That leaves a user with many accounts, each holding its own copy of the keys. A key rotation is one
transaction per account, and a burst of rotations links the accounts by timing.

This experiment moves the keys out of the accounts and into one shared keystore.
- **The account** commits to an identity secret $s$ and a per-payment secret $r$, and to no key.
- **The identity's keys** sit in the keystore as a salted leaf, one per version.
- **Revoking a version** inserts its tag into a second tree, one that supports a proof that a tag
  is absent.
- **A spend** proves that the account's identity holds a leaf in the keystore, whose tag is not
  revoked, and whose rule accepts signatures on the message.
- **A rotation** proves the same of the current version, and that its keys signed the next
  version's leaf.

The keystore's root is one digest over both trees. A spend names a root, so this experiment proves
the statements in leanVM against a keystore kept off chain. Experiment 33 puts the keystore on the
local chain.

**Claim:** the statement revokes a key against every later root, and the identity secret and the
payment secret without the current key neither spend nor add a key.

**Would show it wrong:**
- a spend under a revoked version verifies against a root written after the revocation, case (c);
- a spend verifies with a key that is not the leaf's, case (e);
- a proof verifies for another account or another message, case (g);
- the keystore accepts a leaf for a known identity without a signed rotation, case (f);
- an identity with one key and one with two of three differ in anything a verifier sees, case (i).

## What is built

### Hashes

$H(x, y)$ is Keccak-256 of the 64 bytes $x \Vert y$, leanVM's one hash at `3cbac04`, as experiment 19
uses it. Here $x$ and $y$ are 32-byte values, each two of leanVM's 16-byte cells. Each role has its
own tag, a small integer $\tau$ in the low lane of the first cell of the first input, so no two roles
hash the same bytes:

| Value | Definition | Calls |
|---|---|---|
| the identity's public key | $K = H([\tau_{\mathrm{id}}, 0], s)$ | 1 |
| the account | $C = H(H([\tau_{\mathrm{pay}}, 0], K), r)$ | 2 |
| a rule over three keys | $R = H(H([\mathit{rule}, 0], k_0), H(k_1, k_2))$, as version 2a's $K$ | 3 |
| a leaf at version $v$ | $L = H(H([\tau_{\mathrm{leaf}}, g^v], s), H(R, H(\mathit{rec}, \mathit{salt})))$ | 4 |
| its revocation tag | $N = H([\tau_{\mathrm{rev}}, g^v], s)$ | 1 |
| the registration tag | $Q = H([\tau_{\mathrm{reg}}, 0], s)$ | 1 |
| an entry of the revocation tree | $E(a, b) = H([\tau_{\mathrm{ent}}, 0], [a, b])$ | 1 |
| the keystore's root | $\rho = H(\mathrm{root}(\mathcal{T}), \mathrm{root}(\mathcal{N}))$ | 1 |

- **Each key** is a leanSPHINCS public key, two cells, as in version 2a.
- **$\mathit{rule}$** is 1 (key 0 signs) or 2 (two different keys of the three sign). A rule of one
  key has keys 1 and 2 zero.
- **$\mathit{rec}$** is the recovery rule, a digest of the same form as $R$ over the recovery keys.
- **$\mathit{salt}$** is 32 random bytes.
- **The version** enters as $g^v$, with $g$ leanVM's generator of $\mathrm{GF}(2^{64})^*$. That is
  how leanVM's own host writes a count. So the next version is $g \cdot g^v$, one multiplication,
  and the leaf at version 0 holds $g^0 = 1$. This run uses versions below 256.

### The two trees

- **$\mathcal{T}$** is an append-only binary Merkle tree of depth 20.
  - Its nodes are $H(\mathit{left}, \mathit{right})$.
  - An empty leaf is 32 zero bytes.
  - A leaf's position is not part of any statement.
- **$\mathcal{N}$** is an indexed Merkle tree of depth 20 over revocation keys.
  - A revocation key $\kappa$ is the first cell of $N$, read as an unsigned 128-bit integer.
  - Each entry $E(a, b)$ says that no key lies strictly between $a$ and $b$.
  - The tree starts with the single entry $E(0, 2^{128} - 1)$.
  - Inserting $\kappa$ splits the entry $(a, b)$ with $a < \kappa < b$ into $(a, \kappa)$, which
    replaces it in place, and $(\kappa, b)$, which is appended.
- **A proof that $\kappa$ is absent** is an entry $(a, b)$ in $\mathcal{N}$ with
  $a < \kappa < b$.
  - In the program, each 128-bit value is read byte by byte, through tables, as an exponent of
    $h$, the primitive element of $\mathrm{GF}(2^{192})^*$ that experiment 26 uses.
  - $a < \kappa$ is shown as $h^{\kappa} = h^{a} \cdot h \cdot h^{d}$ for a hinted 128-bit
    $d \geq 0$, and $\kappa < b$ in the same way.
  - Every exponent is below $2^{130}$, far below $h$'s order $2^{192} - 1$. So each equation is one
    of integers.

### The three programs

All three share one library: the leanSPHINCS verifier lifted from leanVM's aggregation guest by
experiment 19's `lift.py`, version 2a's `verify_one`, and the hashes, paths and comparisons above.
Each program publishes one digest $D$, as `docs/leanvm-program-layout.md` fixes it.

- **`spend`.**
  - Private: $s$, $r$, $v$, the rule, the keys, $\mathit{rec}$, the salt, the signatures, $L$'s
    path in $\mathcal{T}$, and the revocation entry with its path in $\mathcal{N}$.
  - Proves: $C$ from $s$ and $r$; $L$ from $s$ and $v$ in $\mathcal{T}$; $\kappa$ of
    $N(s, v)$ absent from $\mathcal{N}$; both roots under $\rho$; and the rule accepting
    signatures on $m$.
  - Publishes $D = H(H(C, m), \rho)$.
- **`register`.**
  - Private: $s$, the rule, the keys, $\mathit{rec}$ and the salt.
  - Proves: the leaf at version 0 and $Q$ are formed from the same $s$.
  - Publishes $D = H(L_0, Q)$.
  - The keystore appends $L_0$ and accepts each $Q$ once.
- **`rotate`.**
  - Private: everything `spend` has but $r$ and $m$, plus the new version's rule digest $R'$,
    recovery rule and salt.
  - Proves, for the current version $v$: its leaf is in $\mathcal{T}$, its $\kappa$ is absent from
    $\mathcal{N}$, and both roots are under $\rho$. It also proves the new leaf $L'$ is formed from
    the same $s$ at $g \cdot g^v$, and that a rule signed $m_{\mathrm{rot}} = H([\tau_{\mathrm{rot}}, \mu], L')$.
  - The mode $\mu$ picks the rule:
    - $\mu = 0$, the current rule: the keystore inserts $\kappa$ and appends $L'$ at once;
    - $\mu = 1$, the recovery rule, whose keys the program hashes to $\mathit{rec}$: the keystore
      queues the rotation for a delay;
    - $\mu = 2$, the current rule cancelling a queued rotation with the same $N$ and $L'$: the
      keystore drops it.
  - Publishes $D = H(H(\rho, N), H(L', [\mu, 0]))$. $N$ is public here because the keystore
    inserts it.

### The keystore, the tool and the runner

- **The keystore,** `keystore.ts`, keeps both trees, the set of registration tags, a queue and a
  clock. It accepts a registration, a rotation, a recovery, a cancellation and an execution, each
  with its proof's public values. It refuses:
  - a repeated $Q$;
  - an insertion whose entry does not bracket $\kappa$;
  - a recovery executed before its delay, which is 10 ticks of the clock;
  - an execution whose $N$ was revoked in the meantime.

  It is a reference implementation off chain. Experiment 33 puts it in a contract.
- **The table tool,** `tool/`, prints the tables from leanVM's own field arithmetic, as experiment
  26's tool does, extended to sixteen byte positions for 128-bit values.
- **The prover** is experiment 19's `prover/`, unchanged: a program, its witness streams and its
  leanSPHINCS signatures in; cycles, table rows, proof bytes, proving and verifying times and peak
  memory out.
- **The runner,** `run.ts`, builds the cases below, proves each, and writes one record.
  - Every key comes from a seed through the prover's own `sphincs` command.
  - Every seed is derived from a public label, so a record holds no secret worth keeping.

## Cases

- **(a)** An honest spend at version 0.
- **(b)** A rotation under the current rule, then a spend at the next version against a root
  written after it.
- **(c)** A spend under the revoked version, against a root written after the rotation. Three
  witnesses are tried:
  - (c1) the revoked key's own entry;
  - (c2) the entry below it;
  - (c3) the entry that bracketed it before the rotation, with its old path.
- **(d)** The same spend as (c), against a root written before the rotation.
- **(e)** Knowledge of $s$ and $r$, with a key that is not the leaf's:
  - (e1) the leaf rebuilt with the attacker's keys, so it is not in $\mathcal{T}$;
  - (e2) the leaf's own keys, with a signature by the attacker's key.
- **(f)** A leaf for a known identity without a signed rotation:
  - (f1) a second registration of the same $s$;
  - (f2) a rotation whose signature is by a key that is not the leaf's;
  - (f3) a registration whose $Q$ is from one secret and whose leaf is from another.
- **(g)** A proof for account $C$ and message $m$, checked against the public values of $C'$ and $m$,
  and of $C$ and $m'$.
- **(h)** The recovery rule.
  - Run 1: a recovery is queued, cancelled by the current key within the delay, and an execution
    after that is refused.
  - Run 2: a recovery is queued, its execution is refused one tick before the delay ends, it is
    executed after the delay, then a spend at the new version passes and one at the old fails.
- **(i)** Two identities, one with a single key and one with two of three, each spending five
  times. Compared:
  - the public values;
  - the program key;
  - each proof's size;
  - every table height the proof commits to;
  - the verification time.

  The same comparison is repeated with **padded one-key rules**, an arm added before the run. A
  one-key leaf stores its key in two of the three places, and its rule asks for two signatures by
  that key. So both rules run the same verifier twice.

## Measures

For a spend, a rotation and a registration, under each rule, with three measured proofs after a
warm-up:
- proving time, in milliseconds;
- peak memory, the prover's peak RSS;
- proof size, in bytes, as leanVM serializes it;
- verification time;
- cycles, and the rows of each table;
- the number of Keccak calls the statement makes outside the leanSPHINCS verifier, counted from the
  program. The verifier's own count is read from the table rows.

The machine is the session's: 4 cores, about 15 GiB.

## Predictions, written before the run

1. **Outcomes.**
   - (a), (b) and (d) prove and verify.
   - Every attempt in (c), (e) and (f2) and (f3) fails in the prover: the witness does not satisfy
     the program.
   - (f1) is refused by the keystore.
   - (g) fails verification both ways.
   - (h) runs as described, with the refusals where it says.
2. **The keystore's part costs little beside the signatures.**
   - Outside the verifier, `spend` makes 55 Keccak calls, `rotate` 58 under the current rule and 61
     under the recovery rule, and `register` 9.
   - The 128-bit comparisons add five 128-bit reads, 80 table lookups.
   - So a spend's cycles exceed version 2a's for the same rule by under 2,000: version 2a took
     6,805 for one key and 11,715 for two of three.
3. **Cost bounds, from experiment 19's figures on this machine.** Every proof takes under 0.5 s,
   under 512 MiB of peak memory, and is between 150 and 400 KiB.
4. **Case (i) meets its falsifier as built, and the padded arm does not.**
   - The public values and the program key are equal by construction.
   - In experiment 19, version 2a's one-key and two-of-three proofs had the same bytecode size but
     different sizes: 236.9 and 239.4 KiB against 221.4 and 221.6 KiB.
   - So the two rules are predicted to be told apart by proof size here too.
   - With padding, both rules run the same cycles, and their sizes and table heights are predicted
     to overlap.

## How the result is read, fixed now

- **The claim holds** if (c), (e), (f) and (g) come out as predicted.
- **The claim is wrong** if any one of them does not.
- **Case (i) is reported apart from the claim.**
  - "Differs" means some measured quantity's ranges over the five proofs do not overlap: proof
    size, a table height, or verification time.
  - If the unpadded arm differs and the padded arm does not, the finding is that the rules hide
    only when padded, at one more verification for one-key users.
  - If both differ, the finding is that leanVM's proofs at this pin show which rule spent.
- **The costs are this machine's,** beside experiment 19's on the same kind of machine.

## What this does not show

- **leanVM has no zero knowledge at `3cbac04`.** Every proof is treated as revealing its witness,
  so (i) compares only what a verifier sees, and every privacy reading is conditional on leanVM
  gaining it.
- **The keystore runs off chain.** Its contract, the recent-root window and gas are experiment 33's.
- **leanSPHINCS's parameters are not final.**
- **No ML-KEM.** The sender's encapsulation, which gives the sender $r$, is not built; $r$ is drawn
  from a seed. This experiment tests the statement, not the receiving side.

## Stops

- If leanVM cannot express a part of a statement, that part stops, and the record says why.
- If a proof exceeds 8 GiB of memory, the run stops for that statement, and the record says so.
