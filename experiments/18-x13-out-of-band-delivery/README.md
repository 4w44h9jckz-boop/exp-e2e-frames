# Experiment 18 (X13): delivering a note's opening out of band, between parties who do not know each other

**Status: pre-registered 2026-11-03,** before any circuit, contract, runner or transaction.
Predictions, what would show each wrong, and the deviations are fixed here; results are added
below them, and nothing above the results is edited after a run.

## The question

A private payment puts a commitment on chain. The opening (the value and the secrets that let the
recipient spend) has to reach the recipient some other way. Today the shielded systems put it on
chain as a ciphertext and let the recipient find it by trying every one; experiment 17 measured
that path in blobs. Off chain, Aztec's
[documentation](https://docs.aztec.network/developers/docs/aztec-nr/framework-description/note_delivery)
is plain about what its own off-chain mode gives: "Guarantees: None. The sender can fail to
deliver or deliver incorrect content".

This experiment delivers openings off chain between a sender and a recipient who know only a
published key or an invoice, and asks three things:
1. **Does each of four settings work end to end** on the test network: an invoice mailbox, first
   contact by push (through a pool and through a blob), pairwise tags after first contact, and
   delegated detection with fuzzy message detection (FMD)?
2. **Do the guards hold:** a note that commits to the hash of its delivered ciphertext, a timed
   reclaim whose floor the recipient sets, and a blob as the last fallback?
3. **What does each party learn beyond what its job needs?** Each party's own log is set against
   what it needs, and the excess is reported per party. A party that knows whose message it holds
   can drop or delay that one user's messages while serving everyone else, so the excess is a
   security measure as well as a privacy one.

## Design

### The note

A note commits to its delivery:

$$c = \mathrm{H}(\mathit{value}, \mathit{owner}, n, s, h, T, \mathit{refund}), \qquad \mathit{owner} = \mathrm{H}(\mathit{pk}_R, d)$$

- $n$ and $s$ are the nullifier secret and the secret, as in experiment 15;
- $h$ is the hash of the delivered ciphertext, reduced into the field;
- $T$ is the time after which the sender may reclaim;
- $\mathit{refund}$ is the sender's refund key;
- $\mathit{pk}_R$ is the recipient's spending key and $d$ its floor, the minimum delay it accepts
  before a reclaim, published with its key or in its invoice.

H is circomlib's MiMCSponge, the hash of experiment 15's tree and of experiment 06's deployed
hasher. The registry inserts the leaf $\mathrm{H}(c, t_0)$, where $t_0$ is the block time of
insertion, into a depth-20 tree, so $t_0$ is bound to the note without being a public input of
the spend.

### The spend

One circuit, `deliver`, with public inputs `root`, `nullifier`, `tNow` and `outCommitment`. It
proves a leaf in the tree, `nullifier` $= \mathrm{H}(n)$, and one of two branches without saying
which:
- **owner:** the spender knows $\mathit{sk}$ with $\mathrm{H}(\mathit{sk}) = \mathit{pk}_R$;
- **refund:** the spender knows $\mathit{sk}$ with $\mathrm{H}(\mathit{sk}) = \mathit{refund}$,
  and $t_{\mathrm{now}} \ge T$ and $T \ge t_0 + d$.

Either way the value goes to `outCommitment`, a fresh note of the spender's, inserted by the
registry. The registry's `VERIFY` checks the proof, that `nullifier` is unused, and that
$t_{\mathrm{now}}$ is not later than the block's timestamp.

Both branches publish the same nullifier, so a note is spent once. The sender, who made the note,
can compute it, and so sees the block of the recipient's spend. The recipient's wallet spends at a
time drawn uniformly from the window between receiving the opening and $T$ less a margin of 60
seconds, so the spend's block says less about when it was online.

### The ciphertext

The opening is $\mathit{value}, n, s, T, \mathit{refund}$, 136 bytes. On first contact it is
sealed as experiment 17's encrypted note: ML-KEM-768 to the recipient's key, a key derived from
the shared secret and the ciphertext, and ChaCha20-Poly1305 over the opening. The entry is
`view_tag(1) || ct(1088) || sealed(152)`, 1,241 bytes, and $h$ is its keccak hash reduced into the
field.

After first contact, the two sides share the KEM's secret $\mathit{ss}$, and note $k$ travels
under the tag $t_k = \mathrm{keccak}(\mathit{ss}, \texttt{tag}, k)$, sealed under
$\mathrm{keccak}(\mathit{ss}, \texttt{key}, k)$, with no new encapsulation: 152 bytes.

The recipient checks a delivery by decrypting it, recomputing $c$ with $h$ taken from the bytes it
received, and finding the leaf on chain. A ciphertext that was swapped or altered gives no leaf.

### The mailbox

A store run by this experiment, as an HTTP service on this machine:
- `put(tag, bytes, ticket)` and `get(tag, ticket)`, for invoices and pairwise tags;
- `post(bytes, flag, ticket)` and `since(cursor, ticket)`, for the push pool;
- `detect(detectionKey, cursor, ticket)`, for FMD.

Each call is paid with a blind ticket, experiment 16's threshold BLS ticket under a domain of this
experiment's. The store checks the signature and that the serial is unused. It keeps every message
until $T$ and it logs every field it sees, with the time it saw it.

### The transport stand-in

Calls reach the store through a stand-in for an anonymous network, modelled on
[Loopix](https://arxiv.org/abs/1703.00536):
- it removes the caller's address and connection, so the store sees only the call;
- it delays each call by an exponentially distributed time of mean $\delta$, as Loopix's mixes do;
- it adds cover traffic at a rate of $\mu$ calls per client per minute: puts and gets with random
  tags, paid with tickets like any other call.

On the test network the stand-in runs at $\delta = 1$ second and $\mu = 0$. The linkage
measurements below run offline, in a deterministic simulation with a seed, over the grid
$\delta \in \{0, 1, 10, 60\}$ seconds and $\mu \in \{0, 1\}$.

### Fuzzy message detection

FMD2 from Beck, Len, Miers and Green (IACR ePrint 2021/089), on secp256k1 through
`@noble/curves`, with $\gamma = 24$ keys. A recipient gives a detector a key of $n$ of its secret
keys, for a false-positive rate of $2^{-n}$; every pool post carries a flag to its recipient. The
detector returns the posts its key flags, and the recipient trial-decrypts only those.

### Arms

On the test network:
1. **Invoice.** The recipient makes an invoice: an ML-KEM-768 key, a random 32-byte tag,
   $\mathit{pk}_R$ and $d$. The sender deposits a note, puts the ciphertext under the tag, and the
   recipient fetches it, checks it against the leaf and spends.
2. **Push through the pool.** The sender has only the recipient's published key. It deposits, posts
   the entry to the pool among others' entries, and the recipient scans the pool and spends.
3. **Push through a blob.** The same, with the entry in a blob on a type-3 carrier, as experiment
   17 packs one.
4. **Pairwise tags.** After arm 2's first contact, two more notes go under $t_1$ and $t_2$ and are
   fetched by tag.
5. **Withheld.** The sender deposits and never delivers. After $T$ it spends the note on the refund
   branch. The recipient's later spend is refused.
6. **Late, then the fallback.** The recipient is offline. At $T_1 < T$, with no spend seen, the
   sender posts the entry in a blob. The recipient comes back between $T_1$ and $T$, finds it by
   scanning and spends.

Offline:

7. **The guards that must fail.** A refund with $t_{\mathrm{now}} < T$, and a refund of a note
   made with $T < t_0 + d$: no witness satisfies the circuit. A proof with $t_{\mathrm{now}}$ later
   than the block: the registry refuses it. A ciphertext swapped by the store: the recipient finds
   no leaf.
8. **FMD.** A pool of 100,000 posts, 50 of them to our recipient, with $n \in \{4, 8\}$.
9. **Linkage by timing,** in the simulation: 200 payments in one simulated hour between 100 senders
   and 100 recipients. Each sender puts within 2 seconds of its deposit; each recipient comes
   online after a random offline time and fetches its notes, and pairs with first contact fetch
   their later notes by tag in one session. The simulation knows who made each call; the store
   does not. Two attackers on the store's log, fixed now:
   - **put to deposit:** each put is matched to the latest deposit on chain before it that is not
     yet matched; accuracy is the share of puts matched to their own deposit;
   - **sessions:** fetches whose arrival times are less than 5 seconds apart are grouped as one
     client; precision is the share of grouped pairs of fetches that came from the same
     recipient.
10. **The sender's view of the spend,** over the run's notes and 1,000 simulated ones, with the
    random spend time and with an immediate spend.

### Need to know, per party

| Party | Needs | Measured from |
|---|---|---|
| sender | the recipient's key or invoice; at $T$, whether the note was spent | its view of the nullifier set (arm 10) |
| recipient | the opening, and that it matches the leaf | its own log |
| store | a tag, the bytes, a valid ticket | its own log (arms 1 to 6, 9) |
| detector | the detection key | the flagged sets (arm 8) |
| L1 and its observers | that a spend is valid | the transactions (arms 1 to 6) |

## Predictions

1. **The four settings work.** In arms 1 to 4 every note is received, checked against its leaf and
   spent on the owner branch, and every spend is mined.
2. **A spend costs what experiment 15's did.** The registry's `VERIFY` for a spend uses between
   200,000 and 260,000 execution gas, inside the test network's 500,000 and over EIP-8141's public
   100,000, as experiment 15's spends were. The circuit has fewer than 40,000 constraints.
3. **The branch is hidden.** An owner spend (arm 1) and a refund spend (arm 5) have the same public
   inputs in the same layout, and their gas differs by less than 1,000.
4. **The guards hold.**
   - Arm 5's refund is mined after $T$, and the recipient's spend after it is refused for the
     nullifier.
   - Arm 6's recipient finds the fallback blob and spends before $T$.
   - In arm 7, no proof is produced for either early refund, the registry refuses the future
     $t_{\mathrm{now}}$, and the swapped ciphertext finds no leaf.
5. **Pairwise tags need no scan.** Each of arm 4's notes is found with one `get` and no
   decapsulation, and its delivery is 152 bytes against first contact's 1,241.
6. **Scanning costs what experiment 17 measured.** Trial-decrypting a pool or blob entry costs
   between 0.5 and 1.5 ms per entry on one core in JavaScript.
7. **FMD flags at its rate.** In arm 8, all 50 true posts are flagged at both $n$. The share of the
   other 99,950 posts that are flagged lies inside the 99.9 percent binomial interval around
   $2^{-n}$, so the detector's set is about $2^{-n} \cdot 99{,}950 + 50$ posts.
8. **The store learns tags, sizes, times and serials, and nothing else.** Its log from the test
   network has no address, connection or account field, and no serial in it links to an issuance.
9. **Timing links calls when nothing delays them.** In arm 9:
   - With $\delta = 0$ and $\mu = 0$, the store matches each put to its deposit on chain by time
     with accuracy at least 0.9, and groups a pair's tag fetches into one session with precision
     at least 0.9.
   - Both measures fall as $\delta$ grows. At $\delta = 60$ seconds the put-to-deposit accuracy is
     at most 0.3.
   - At every $\delta$, $\mu = 1$ gives a lower session precision than $\mu = 0$.
10. **The random spend time blurs the sender's view.** In arm 10, with an immediate spend, the
    sender's estimate of when the recipient received the opening is within one block (12 seconds)
    for at least 90 percent of notes. With the random spend time, the median error is at least a
    quarter of the window.

## What would show it wrong

| Prediction | Shown wrong by |
|---|---|
| 1 | any note of arms 1 to 4 not received, not matched to its leaf, or not spent |
| 2 | a spend's `VERIFY` outside 200,000 to 260,000, or a circuit of 40,000 constraints or more |
| 3 | different public-input layouts, or a gas difference of 1,000 or more |
| 4 | a refund before $T$ or before $t_0 + d$ proved and accepted, the recipient spending after a refund, arm 6 not finding the blob, or a swapped ciphertext matching a leaf |
| 5 | a pairwise note that needs a scan or a decapsulation, or a delivery other than 152 bytes |
| 6 | a per-entry scan outside 0.5 to 1.5 ms |
| 7 | a missed true post, or a false-positive share outside the interval |
| 8 | any field in the store's log that names or links a caller, or a serial linked to its issuance |
| 9 | put-to-deposit accuracy or session precision below 0.9 at $\delta = 0$; either rising with $\delta$; put-to-deposit accuracy above 0.3 at 60 seconds; cover traffic not lowering session precision |
| 10 | the immediate spend within one block for fewer than 90 percent, or a random-time median error under a quarter of the window |

## Deviations, stated before the run

- **The transport is a stand-in.** It hides addresses and delays calls on one machine; it is not a
  mixnet, and the linkage numbers are the simulation's, under its workload.
- **The store is ours** and honest except where arm 7 makes it swap a ciphertext. A store that
  drops messages is not modelled; the reclaim is the answer to it, and arm 5 stands for it.
- **The ticket issuers are dealt by one process,** as in experiment 16. Issuance is not what this
  experiment tests.
- **Only the hash of the ciphertext is bound,** not its correctness. A sender can deliver bytes
  that hash to $h$ and do not decrypt to the opening; the recipient then cannot spend, and the
  reclaim returns the value to the sender. A proof of correct encryption for ML-KEM-768 is outside
  this experiment.
- **FMD2 has no published test vectors** that we found. It is implemented from the paper, and its
  correctness is shown by prediction 7: every true flag detected, and false positives at the rate.
- **Oblivious message retrieval is not built.** It is FHE server work; its authors' figures are
  quoted where it is discussed, not measured here.
- **MiMC, not Poseidon,** so the tree and hasher are experiment 15's and 06's.
- **Times are short.** $d$ is 60 seconds and $T$ is $t_0$ plus 180 seconds on the test network, so
  the run finishes; a deployment would use hours or days.
- **The recipient's key is a hash preimage** inside the circuit. A deployment would use a key the
  wallet already holds.

## Path

Deposits and spends are frame transactions sent first to a skandha node at `ede942f`, as in
experiments 01 to 15, and its answer is recorded; any it refuses go to the chain directly, and
that is recorded too. Blob carriers are type-3 transactions sent to the chain, as in experiment 17.
Every step is simulated on the test network before it is sent.

## Amendment 1, 2026-11-04, before any code ran: the time check reads the registry's own clock

**What the pre-registration said.** "The registry's `VERIFY` checks the proof, that `nullifier` is
unused, and that $t_{\mathrm{now}}$ is not later than the block's timestamp."

**Why it cannot be built.** EIP-8141 (Draft, read at master on 2026-11-04) bans `TIMESTAMP`
"during the validation prefix", except in its expiry verifier frame, which "reverts unless
`block.timestamp <= expiry_timestamp`". That bounds time from above. A reclaim needs it bounded
from below, $t_{\mathrm{now}} \le$ now, and nothing in validation reads the clock that way. Moving
the check into the `SENDER` frame does not work either: the nullifier is a nonce key consumed at
inclusion, so a spend with a future $t_{\mathrm{now}}$ would pass `VERIFY`, fail in `SENDER`, and
burn the note.

**What is built instead.** The registry keeps its own clock in storage: every deposit, every spend
and a public `tick()` store the block's timestamp, in execution, where `TIMESTAMP` is allowed.
`VERIFY` reads that stored time, which is the sender's own storage and so allowed, and checks
$t_{\mathrm{now}} \le t_{\mathrm{last}}$. Since $t_{\mathrm{last}}$ is never later than the block's
timestamp, the check is at least as strict as the one pre-registered. Since it only grows, a spend
that passes it stays valid in the mempool. A sender who wants to reclaim when the registry has had
no activity since $T$ calls `tick()` first.

**Also changed, for the same reason of reading only the registry's own state:** known roots are
kept in the registry's storage, and `VERIFY` checks the proof's root among them. Experiment 15's
EIP-8272 root frame is not used.

**What it changes in the predictions.** In prediction 4, "the registry refuses the future
$t_{\mathrm{now}}$" now means a $t_{\mathrm{now}}$ later than the registry's stored time, refused
in `VERIFY` before anything is spent. Nothing else changes.

**A finding, stated before the run.** A frame transaction can say "valid until" in validation and
cannot say "valid after". A timelock that validation must respect has to read time from state that
execution wrote.
