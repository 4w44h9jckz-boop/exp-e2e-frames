# Experiment 17 (X12): ciphertexts in blobs, a data-availability layer for post-quantum payments

**Status: run 2026-11-01.** Pre-registered the same day, before any contract, runner or transaction,
and amended once before the run (Amendment 1). Predictions, what would show each wrong, and the
deviations are fixed; results are added below them and nothing above is edited after a run.

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

## Results, run 1

`results/1-first-run.json` (deployment d6, at `379a5fb`), and arm 5's
`results/1-first-run-scan.json`. The client is ethrex `v23.0.0-hegota-testnet-hotfix` at `64b8fc09`.
The two posted blobs' entries and every mined Board transaction are kept in
`test/fixtures/x12/1-first-run.json`. `test/x12.test.ts` checks four things offline:
- it rebuilds each blob to the versioned hash the Board recorded;
- it recovers the packer's signature on each post;
- it checks each post's opening at `z = 1` against its header;
- it checks archiver A's answer at its drawn point.

### Predictions

| # | Held? | What happened |
|---|---|---|
| 1 | **in part** | A log announcement cost 103,320 gas, inside 85,000 to 115,000. The 2 percent clause failed: the plain transfer's 12,000 is not the base for a contract call. Every floor-dominated call in the run cost exactly 15,000 + 64 x calldata bytes: two logs and two inclusion proofs, 1,252 to 1,412 bytes. The prediction's formula was 3.0 percent low. |
| 2 | yes | 107 announcements or 105 notes per blob, so 1,225 and 1,248 blob gas per entry. Each carrier's execution was 12,000 gas whatever it carried. |
| 3 | yes | Both Board posts were mined with one blob each. `VERIFY` used 59,387, inside 55,000 to 75,000. The wrong header, the recorded blob and the missing blob were each refused in `VERIFY` before inclusion. The recorded blob was refused by Amendment 1's storage read. |
| 4 | **in part** | skandha at `ede942f` refused the blob-carrying frame transaction, but with `ErrOversizedData`, not `ErrFrameBlobs`. Its size check runs before its blob check. |
| 5 | yes | Proofs of announcement 40 and note 50 cost 103,320 and 105,368 gas. The proof over announcement 40 with one byte changed reverted. |
| 6 | yes | A answered both challenges at points drawn from the challenge's own block, for 107,545 gas each. A wrong `y` reverted. B, which was never given the blob, did not answer and was slashed after five blocks, its bond moved to the challenger. |
| 7 | yes | 40 of 40 entries found in 10,000 of each kind, none missed, no false match. Announcements scanned at 256 per second per core (3.90 ms each), notes at 1,251 (0.80 ms). |
| 8 | yes | A blob entry cost its poster 325 to 578 times less than a log, at the test network's and mainnet's prices. |

### What one entry costs

Gas and blob gas are from the run. The wei columns price the test network's schedule at mainnet's
prices read during the run: base fee 34,561,475 wei and blob base fee 1,879,345 wei, at block
26,316,661. Mainnet's own schedule differs: an intrinsic 21,000, and a 40-per-byte floor until
EIP-7976. The scheme's measured 69,330 gas on Prague would put a log at about 388 times a blob entry
rather than 578.

| One announcement | Gas | Blob gas | Wei at mainnet prices |
|---|---:|---:|---:|
| as a log | 103,320 | 0 | 3,570,891,597,000 |
| in a blob, on a plain type-3 carrier | 112 (12,000 / 107) | 1,225 | 6,178,198,204 |
| in a blob the Board records | 4,921 (526,506 / 107) | 1,225 | |

| One encrypted note | Gas | Blob gas | Wei at mainnet prices |
|---|---:|---:|---:|
| as a log | 95,128 | 0 | 3,287,763,993,800 |
| in a blob, on a plain type-3 carrier | 114 (12,000 / 105) | 1,248 | 6,295,878,169 |
| in a blob the Board records | 4,082 (428,574 / 105) | 1,248 | |

Most of a Board post is state: 391,680 gas for the first post's four fresh slots and 293,760 for
the second's three. That is L1 keeping a versioned hash, a header and a recorded mark per blob,
plus the post count the first time. A board that kept only the hash and put the header in its
event would keep one slot per blob.

### What the other steps cost

| Step | Gas |
|---|---:|
| a Board post, `VERIFY` (one signature, one point evaluation, one storage read) | 59,387 |
| a Board post, `SENDER` (`record()`), execution | 59,045 |
| an inclusion proof of one announcement / one note | 103,320 / 105,368 |
| a challenge (first / later) | 475,102 / 377,194 |
| an archiver's answer | 107,545 |
| a slash | 46,629 |

The inclusion proofs are floor-dominated. The 50,000-gas point evaluation and the MODEXP for the
domain point do not add to the calldata floor of the entry the proof carries. A proof that carried
only the entry's hash would cost about the evaluation's 50,000 gas.

### Scanning, and griefing

On one core of an Intel Xeon at 2.10 GHz, under Node v22.22.0:

| | Announcements | Encrypted notes |
|---|---:|---:|
| entries scanned | 10,000 | 10,000 |
| ours found / missed / false matches | 40 / 0 / 0 | 40 / 0 / 0 |
| scan, per entry | 3.90 ms | 0.80 ms |
| scanned per second | 256 | 1,251 |
| making one, per entry | 4.76 ms | 1.33 ms |

An announcement costs a scanner one ECDH, one ML-KEM-768 decapsulation and SHA3 over about 2.4 KB.
A note costs one decapsulation. At one full blob of announcements every 12-second slot, *derived*:
- 770,400 announcements a day;
- 900 MiB to download;
- about 50 minutes of one core to scan.

| Per scanner-millisecond, at mainnet prices | Announcement | Note |
|---|---:|---:|
| what a poster pays for a fake entry as a log | 914,839,135,347 wei | 4,112,275,164,228 wei |
| the same in a blob | 1,582,814,081 wei | 7,874,769,442 wei |

In blobs, posting is 325 to 578 times cheaper and scanning costs the same, so a fake entry costs an
attacker 325 to 578 times less for the same work it gives scanners.

### Findings

- **A contract posted its own blob.** The Board was the sender and payer of a frame transaction
  carrying a blob, and its `VERIFY` checked the blob's header with one point evaluation against
  `BLOBHASH(0)`, inside EIP-8141's 100,000. L1 kept the versioned hash and checked the opening. The
  ciphertexts were never calldata.
- **The client drops a second blob-carrying post on a fresh nonce key.** With EIP-8250 keys the
  first post was mined and every second one was accepted and lost. At the account's own nonce both
  were mined. This is a finding about the client, recorded in Amendment 1.
- **The open node refuses blob-carrying frame transactions on size.** `ErrOversizedData` before
  `ErrFrameBlobs`, so the path for them is the chain's own pool.
- **Keeping is enforceable, and withholding is attributable.** A challenge at a point nobody knew in
  advance was answered by the archiver holding the blob and not by the one that held nothing, who
  was slashed. Unlike a private read, the data is public and its commitment is on chain, so failing
  to answer is evidence.
- **Scanning costs more than posting.** In a blob, a fake entry costs its poster about 1.6 gwei
  per millisecond of scanning it causes for an announcement and 7.9 gwei for a note, at mainnet
  prices, and every recipient scans every entry.
- **The test network serves no blob data through any API found.** Arm 5 read the blobs from the
  run's fixture and checked them against the versioned hashes on chain. A recipient on this network
  depends on someone keeping a copy from the start, which is what the Archive is for.

### Passes that stopped

| Pass | Stopped at | Fixed by |
|---|---|---|
| before d1 | reading prices: drpc's free plan refuses `eth_blobBaseFee` | mainnet prices from publicnode |
| d1 | the Board's deposit frame had no state gas for the fresh slot it writes | one slot's state gas |
| d2 | the first post's `SENDER` frame failed in simulation at 80,000 gas | raised to 200,000, which also failed (d3) |
| d3 | the same at 200,000: a simulation on d3 showed state gas for four fresh slots was needed, and the shortfall had spilled into execution | four slots' state, and the Board's floor raised to match |
| d4 | the second post was accepted and lost | Amendment 1 |
| d5 | the no-blob refusal hit the envelope's blob-fee rule; an archiver's answer failed the node's gas estimate | a zero blob fee; explicit gas on archivers' transactions |

### Transactions

| Step | Transaction | Block |
|---|---|---:|
| a log announcement | [`0x9ed72ed4...`](https://dora.privacy.ethrex.xyz/tx/0x9ed72ed4899908596f4452388e5f5df37d0149f9544a0b84c50bfe03bfd3e78f) | 642,082 |
| a log note | [`0xcf72272a...`](https://dora.privacy.ethrex.xyz/tx/0xcf72272a6b09148127d22a1a7b61432cb4b7ecfb7cbaed226d453a78fb5fcecb) | 642,085 |
| 107 announcements on a type-3 carrier | [`0xb71ea943...`](https://dora.privacy.ethrex.xyz/tx/0xb71ea943cc03be90404ac9b32cb77d567977d7e17fdf91ccccca4842007ae122) | 642,086 |
| 105 notes on a type-3 carrier | [`0x70e84114...`](https://dora.privacy.ethrex.xyz/tx/0x70e841149fedb26216396c07df2b9aa1eae64f7e3d433527cb9eff106ad8d15c) | 642,087 |
| the Board posts the announcements' blob | [`0x292b4f56...`](https://dora.privacy.ethrex.xyz/tx/0x292b4f56e2dc1a3143daf2b13d569aca0ec21fb572d194e4f4421c747cb2b704) | 642,091 |
| the Board posts the notes' blob | [`0xab867eea...`](https://dora.privacy.ethrex.xyz/tx/0xab867eea8658b57d1659431e8aada383d93add47a48d85127fc384e08836fb21) | 642,092 |
| inclusion of announcement 40 | [`0x4c782bc9...`](https://dora.privacy.ethrex.xyz/tx/0x4c782bc9546d9f02a490b0c03a2acfabd07fc75f61addf5fa5abe956705d4b7b) | 642,093 |
| inclusion of note 50 | [`0x58a17836...`](https://dora.privacy.ethrex.xyz/tx/0x58a1783650f79cdf77d5a5f2635aa91706828034ac7f7f928e586bdc04a064bd) | 642,094 |
| A challenged, then A answers | [`0x9c662248...`](https://dora.privacy.ethrex.xyz/tx/0x9c662248f6a6d3fda762dab3672d10cc0af0ff3e38c265aff66965da15846fc7), [`0xa2ee5345...`](https://dora.privacy.ethrex.xyz/tx/0xa2ee53454dff3ca5b429e51be16f23802d9265f82ae4f00699f2f81e39046ec9) | 642,095; 642,097 |
| B challenged, then B slashed | [`0xa6330db8...`](https://dora.privacy.ethrex.xyz/tx/0xa6330db8edc62c3c3270dcaa1d15c8f3c3619f0cdfed52644e3714b47ea30b5e), [`0x6f8e912d...`](https://dora.privacy.ethrex.xyz/tx/0x6f8e912d8875b28aaeaaa64776e5aeb786c4d4bdf1bd809b34dc3708a2ae299b) | 642,101; 642,109 |

The test network's relaunches void its hashes; the fixture keeps what each showed.

## Run 2, pre-registered 2026-11-03: behind ERC-5564's announcer

Pre-registered before any contract, runner or transaction for it. Nothing above this heading
changes; run 2's results are added below its predictions.

### The question

[ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) (Final) fixes one announcer per chain: "This
MUST be a singleton contract, with one instance per chain." Run 1 used blobs on their own, which
would give wallets a second place to watch. Run 2 asks whether blobs can be a second transport
behind the singleton instead, so that a wallet keeps watching one contract and still finds payments
in both.

Before writing this: the singleton's address,
`0x55649E01B5Df198D18D95b5cc5051630cfD45564`, holds 709 bytes of code on the test network, with
the same sha256 as on mainnet (read 2026-11-03 at test network block 671,390 and mainnet block
26,332,376). Run 2 uses it, not a copy.

### Design

- **The pointer.** When the board records a blob, its `SENDER` frame calls the singleton's
  `announce` once:
  - `schemeId` 3, the scheme of the entries inside;
  - `stealthAddress` zero, which no derived stealth address is;
  - `ephemeralPubKey` the blob's versioned hash and header, `vh(32) || header[1..31]`, 63 bytes;
  - `metadata` a zero byte where a view tag would be, then the board's post count as eight
    bytes, 9 bytes;
  - `caller` the board, filled in by the singleton.

  *Interpretation:* ERC-5564 says metadata "MUST include the view tag in the first byte". A
  pointer has no recipient and so no view tag; the zero byte is this run's choice, and a scanner
  recognises a pointer by `stealthAddress` zero and its 63-byte key before reading it. A separate
  scheme ID for pointers was not chosen: scheme IDs are assigned through the ERCs, and one would
  split a scheme's announcements across two IDs.
- **Entries carry their metadata.** A run 2 entry `S'` is
  `stealthAddress(20) || epk(33) || ct(1088) || len(1) || metadata(len)`, with the view tag as
  metadata's first byte, as ERC-5564 requires of a log. Every entry in run 2 carries ERC-5564's
  recommended 57 bytes: the view tag, a 4-byte function selector, a 20-byte token address and a
  32-byte amount. So `S'` is 1,199 bytes, a new payload kind `3` in the header, with the blob
  layout of run 1 unchanged.
- **The board.** Run 1's board with one change: the `SENDER` frame calls the singleton after
  recording. It posts at its own nonce, as Amendment 1 set.
- **Direct announcements** go through the singleton itself, as wallets send them today, with the
  same 57-byte metadata.
- **One scanner.** It reads the singleton's `Announcement` events with `schemeId` 3 over the run's
  block range, and for each one:
  - a direct announcement it trial-decrypts, as in run 1;
  - a pointer from a caller on its list of boards it resolves: it fetches the blob, checks that
    the blob's commitment hashes to the pointer's versioned hash and that the header matches, and
    scans the entries;
  - a pointer from any other caller it ignores, without fetching anything.

  Its list of boards holds one entry, run 2's board.

### Arms

1. Ten direct announcements through the singleton, five of them to our recipient `R`.
2. One blob of `S'` entries, 20 of them to `R`, posted by the board, which announces the pointer.
3. One pointer sent through the singleton by an account that is not a board, naming the same
   versioned hash.
4. Offline: the scanner given the blob with one byte changed; and run 1's scanner, which knows
   nothing of pointers, given every announcement of the run.

### Predictions

1. **The pointer is cheap.** The board's post with the pointer is mined. Its `VERIFY` frame costs
   within 2,000 gas of run 1's 59,387. Its `SENDER` frame's execution exceeds run 1's 59,045 by
   between 3,000 and 15,000 gas, and its state gas equals run 1's first post, 391,680, because the
   singleton writes no storage.
2. **A direct announcement is the floor.** Each direct announcement with 57 bytes of metadata
   costs exactly 105,368 gas, the test network's 15,000 plus 64 per calldata byte over 1,412
   bytes, as run 1 found for every floor-dominated call.
3. **More metadata, fewer entries.** 102 `S'` entries fit one blob, at 1,285 blob gas per entry,
   and every entry's metadata reads back from the blob byte for byte.
4. **One scanner finds both kinds.** Reading only the singleton's events, the scanner finds all
   25 of `R`'s entries, 5 direct and 20 in the blob, with no false match. Other people's
   scheme-3 announcements in the range, if any, are scanned and counted.
5. **The caller filters pointers.** The pointer from arm 3 is ignored with no blob fetched. The
   blob with a changed byte is rejected before any entry in it is scanned.
6. **An unaware scanner skips pointers.** Run 1's scanner finds `R`'s 5 direct entries, treats the
   pointer as a malformed scheme-3 announcement, and reports no false match.

### What would show it wrong

| Prediction | Shown wrong by |
|---|---|
| 1 | the post refused, `VERIFY` moved by more than 2,000, the `SENDER` increase outside 3,000 to 15,000, or state gas different from 391,680 |
| 2 | a direct announcement costing anything other than 105,368 |
| 3 | a capacity other than 102, or any metadata byte read back different |
| 4 | a missed entry or a false match |
| 5 | a fetch for arm 3's pointer, or a changed blob whose entries are scanned |
| 6 | run 1's scanner throwing, or reporting a match from the pointer |

### Deviations, stated before the run

- **The pointer's encoding is ours** (the interpretation above). ERC-5564 does not define one.
- **The board list is the scanner's configuration.** Who decides which boards a wallet follows
  decides which payments its users can find; run 2 does not answer that, and post 42 names it.
- **The blob is read from the run's own record** if the test network serves no blob data, as in
  run 1, and checked against the versioned hash on chain.
- **One packer key,** as in run 1.

## Results, run 2

Deployment `r2a`, run at `7a6bb24`, blocks 684,399 to 684,412. Record
`results/2-behind-the-announcer.json`, scan record `results/2-behind-the-announcer-scan.json`,
fixture `test/fixtures/x12/2-behind-the-announcer.json`. Nothing stopped: the run went through on
the first pass.

Before anything was sent, the singleton held 709 bytes of code on the test network (block
684,398) and on mainnet (block 26,339,357), with the same sha256, `97b1a2b6...52a1b17`.

### Predictions

| # | Prediction | Outcome |
|---|---|---|
| 1 | the pointer is cheap | **held.** `VERIFY` 59,402, 15 more than run 1's; `SENDER` execution 67,742, 8,697 more than run 1's 59,045; state 391,680, as run 1's first post |
| 2 | a direct announcement is the floor | **held.** All ten cost exactly 105,368 gas, over 1,412 bytes of calldata |
| 3 | more metadata, fewer entries | **held.** 102 entries of 1,199 bytes, 1,285 blob gas each; all 102 entries' metadata read back byte for byte |
| 4 | one scanner finds both kinds | **held.** Reading only the singleton's twelve events, it found 25 of 25: entries 1, 3, 5, 7 and 9 of the direct ones, and the 20 in the blob. No other scheme-3 announcement appeared in the range |
| 5 | the caller filters pointers | **held.** The spoofed pointer was ignored and nothing was fetched for it; the blob with one byte changed was rejected on its versioned hash, before any entry was scanned |
| 6 | an unaware scanner skips pointers | **held.** Run 1's scanner, over all twelve events, found the five direct entries, threw nothing, and matched neither pointer |

### What it costs

- **The pointer** is 8,697 execution gas in the board's `SENDER` frame: a call to a cold account,
  the call's 292 bytes, and a log of four topics. It writes no state.
- **A spoofed pointer** cost its sender 33,688 gas. A scanner that follows boards by `caller`
  spends one log read on it and fetches nothing.
- **A direct announcement with metadata** is 105,368 gas, 2,048 more than run 1's announcement
  with a one-byte metadata: the 32 bytes of calldata the 57-byte metadata adds over one byte, at
  64 gas each.
- **In the blob,** the metadata costs five entries per blob, 102 against 107.

### Transactions

| Step | Transaction | Block |
|---|---|---:|
| a direct announcement through the singleton, one of ten | [`0xf10242f7...`](https://dora.privacy.ethrex.xyz/tx/0xf10242f74e8775e0b091962d32cca46c07dcdddd4b4eafabedb321f9886f8e38) | 684,402 |
| board2 posts the blob and announces the pointer | [`0x0d4b7fa9...`](https://dora.privacy.ethrex.xyz/tx/0x0d4b7fa928f313fa82022ec9365b22445f0a1f7d07b1e76d79f86a27b7851c8c) | 684,411 |
| a pointer from an account that is not a board | [`0xd89e4f24...`](https://dora.privacy.ethrex.xyz/tx/0xd89e4f24d7df80ca621cfdf17fc44b67d8ebd0ccd039d3ce9936f2173f496115) | 684,412 |

The test network's relaunches void its hashes; the fixture keeps the board's post and every event.
