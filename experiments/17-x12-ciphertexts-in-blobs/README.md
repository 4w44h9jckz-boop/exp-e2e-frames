# Experiment 17 (X12): ciphertexts in blobs, a data-availability layer for post-quantum payments

**Status: pre-registered 2026-11-01**, before any contract, runner or transaction. Predictions,
what would show each wrong, and the deviations are fixed here; results are added below them and
nothing above is edited after a run.

## The question

Post-quantum privacy puts a large ciphertext in every payment. An announcement under
[ERC-8441](https://github.com/ethereum/ERCs/pull/2059) (schemeId 3, Draft), a hybrid of ML-KEM-768
and secp256k1, is 1,122 bytes and costs 69,330 gas as a log on Prague, 2.45 times the classical
one, by the scheme's own [measurement](https://github.com/4w44h9jckz-boop/pq-stealth-scheme3-public).
An encrypted note for a shielded pool carries the same ML-KEM-768 ciphertext. A recipient finds
its own only by trying everyone's, so three costs decide whether this works at scale: posting the
ciphertexts, keeping them, and scanning them.

The claim: blobs can carry them, with L1 keeping only each blob's versioned hash and checking KZG
openings against it, at a fraction of a log's cost. Inclusion of one entry and the keeping of a
whole blob can both be enforced on chain with the point-evaluation precompile. And scanning, not
posting, becomes the cost that decides, which changes the griefing arithmetic.

## Design

### Two payloads

| | Bytes | Layout |
|---|---:|---|
| `S`, an ERC-8441 announcement | 1,142 | `stealthAddress(20) || epk(33) || ct(1088) || view_tag(1)` |
| `N`, an encrypted note | 1,169 | `view_tag(1) || ct(1088) || sealed(80)` |

`S` follows ERC-8441 Sections 1 and 2 exactly, implemented here from the specification and checked
against the scheme's own test vectors before any run. ERC-5564 carries `stealthAddress` as an
indexed topic of its event; in a blob it has to travel inside the entry.

`N` is this experiment's own note encryption, ML-KEM-768 only:
`(ct, ss) = ML-KEM-768.Encaps(ek)`,
`view_tag = SHA256("exp-e2e-frames/17/note-view-tag" || ss)[0]`,
`key = SHA3-256("exp-e2e-frames/17/note-key" || ss || ct)`, and `sealed` is ChaCha20-Poly1305
under `key` with a zero nonce over the 64-byte note opening `value(32) || r(32)`.

### One blob

A blob is 4,096 field elements of 32 bytes, and each element carries 31 bytes under a zero high
byte. Element 0 is a header: version, payload kind, entry count, entry length. Elements 1 to
`count` each hold `keccak256(entry)[0..31]`, one per entry, so one point evaluation proves one
entry. The entries follow, each starting at a fresh element. That fits 107 `S` entries or 105 `N`
entries in a blob.

### Contracts

- **Announcer**, the baseline: ERC-5564's `announce` emitting its `Announcement` event, and a
  note announcer emitting the `N` bytes the same way.
- **Board**, the sender and payer of its own frame transactions:
  - `VERIFY` checks:
    - exactly one blob (TXPARAM `0x07`);
    - the packer's ECDSA signature over the blob's versioned hash and header;
    - one KZG opening of element 0 at `z = 1` against `BLOBHASH(0)` through the precompile;
    - a nonce key derived from the versioned hash (EIP-8250), so a blob is recorded once;
    - the fee, against the packer's deposit.
  - The `SENDER` frame records the versioned hash and the header. L1 keeps 32 bytes and a count
    for each blob.
- **Inclusion**, on the Board: anyone proves entry `i` of a recorded blob by one opening at the
  domain point of element `1 + i`, recomputed on chain from `i`, with `y` the entry's hash slot.
- **Archive**:
  - Archivers bond.
  - Anyone challenges an archiver over a recorded blob for a fee, at a point `z` drawn from the
    block hash after the challenge.
  - The archiver answers with `y` and a proof checked by the precompile against the recorded
    versioned hash. Answering at an unpredictable point takes the whole blob.
  - An unanswered challenge pays the bond to the challenger after `D` blocks.

### Path

Plain type-3 transactions and contract calls go to the chain. The blob-carrying frame
transactions are first sent to a skandha node at `ede942f`, and its answer is recorded, before they
go to the chain. That node's frame pool refuses any frame transaction with blobs (`ErrFrameBlobs`,
`packages/framepool/src/surface.ts`), so it is not the path for them.

Arm 5 reads its blobs back from the network if the test network serves sidecars. Otherwise it
reads them from the run's own record, checked against the versioned hashes on chain, and says
which.

## Predictions

1. **A log is floor-dominated.** A single ERC-8441 announcement through ERC-5564's `announce`
   costs the network's intrinsic gas plus 64 gas per calldata byte, within 2 percent, under
   EIP-7976's floor (Last Call), and between 85,000 and 115,000 gas in all. The intrinsic cost is
   measured in the run, because a probe's plain type-3 transaction used 12,000 gas rather than
   21,000.
2. **One blob, many entries.** 107 `S` or 105 `N` entries fit one blob, at 1,225 and 1,248 blob
   gas per entry, and the carrier's execution gas does not grow with the count.
3. **A contract posts its own blob.** The Board's frame transaction with one blob is mined. Its
   `VERIFY` frame stays inside EIP-8141's 100,000, between 55,000 and 75,000. It is refused before
   inclusion in three cases: with a header the blob does not open to, with a blob already
   recorded, and with no blob.
4. **The open node refuses it.** skandha at `ede942f` answers the blob-carrying frame transaction
   with `ErrFrameBlobs`.
5. **Inclusion is one opening.** A proof of entry `i` succeeds for under 150,000 gas. The same
   proof with one byte of the entry changed reverts.
6. **Keeping is enforceable.** An archiver holding the blob answers a challenge at a point it
   could not predict, in one transaction. An archiver without it does not answer and is slashed
   after `D` blocks. An answer with a wrong `y` reverts.
7. **Scanning finds every entry and nothing else.**
   - Every one of 40 entries addressed to our recipient is found among 10,000 `S` entries, and
     likewise among 10,000 `N` entries, with no false match.
   - Throughput per core in this repository's JavaScript is between 100 and 2,000 `S` entries
     per second, and at least as fast for `N`, which skips the ECDH.
8. **Blobs make griefing cheaper.** At the test network's and mainnet's prices read during the
   run, a fake entry in a blob costs its poster at least 50 times less than the same bytes as a
   log, while a scanner's cost per entry does not change. The ratio is reported as wei paid by the
   poster per millisecond spent by a scanner.

## What would show it wrong

| Prediction | Shown wrong by |
|---|---|
| 1 | a log announcement under 85,000 gas, or one not explained by the floor within 2 percent |
| 2 | fewer entries per blob than the layout allows, or a carrier whose gas grows with the count |
| 3 | the frame transaction refused by the chain, a `VERIFY` over 100,000, or any of the three bad posts mined |
| 4 | skandha accepting or relaying a blob-carrying frame transaction |
| 5 | a valid proof refused, a proof over a changed entry accepted, or a cost over 150,000 |
| 6 | a correct answer refused, a wrong one accepted, or an unanswered challenge that cannot be slashed |
| 7 | a missed entry, a false match, or a throughput outside the stated range |
| 8 | a blob entry costing more than a fiftieth of a log entry at either set of prices |

## Deviations, stated before the run

- **The packer is one key.** A deployment would let any packer post. Its signature only stops
  others from spending the Board's deposit.
- **Inside the blob window.** Blobs are kept for 4,096 epochs, about 18 days, and the challenges
  run inside that window. The mechanism does not depend on expiry; after it, the archiver is the
  only source.
- **Answering is not custody.** An archiver can fetch the blob from someone else when challenged.
  The challenge proves that somebody still has the blob, not who.
- **The recipients' keys are ours,** generated per the specification, and the scanner is this
  repository's JavaScript, not the scheme's Rust.
- **No delegated scanning, PIR or detection keys.** Scanning is the recipient's own, over every
  entry.

## Amendment 1, 2026-11-01, before run 1: the Board posts at its own nonce

Written after passes d1 to d4 and before the run that is reported. Nothing above is changed.

Pass d4 had the Board post its first blob, the 107 announcements, in a blob-carrying frame
transaction, and it was mined. The second post, the notes' blob, was accepted by the test
network's `eth_sendRawTransaction`, which returned its hash, and then disappeared: not in the pool,
never mined. A diagnostic on d4's Board then posted two small blobs in a row:
- the first was mined;
- the second was accepted and dropped three times over three minutes.

Each post had used a fresh EIP-8250 nonce key, which leaves the Board's account nonce unchanged.
The funder's two type-3 blob transactions, at rising account nonces, were both mined. The working
explanation is that the client keeps blob-carrying transactions by sender and account nonce, so a
second one at the same account nonce is dropped as stale. It is a hypothesis about the client,
which the next pass tests.

The change:
- The Board posts at its own nonce, nonce key 0, whose sequence is the account nonce.
- `VERIFY` refuses an already-recorded blob by reading the Board's own storage, which EIP-8141
  allows, instead of through a nonce key.
- Prediction 3's second refusal, "a blob already recorded", is now made by that storage read.

If the next pass also drops a second post, the hypothesis is wrong and that is recorded.
